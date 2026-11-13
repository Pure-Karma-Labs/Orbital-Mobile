/**
 * The Facebook post parser (#925) — pure, and deliberately narrow.
 *
 * Text in, decisions out: this module never touches the archive session, never
 * resolves a uri and never peeks a byte. It turns one post JSON file into
 * `RawParsedPost`s (each carrying its raw media uris for the pre-pass) and
 * `ParsedSkip`s. `parseArchive` owns everything that needs the archive.
 *
 * ## Schema-pick, never cast
 *
 * Every field is read through `jsonSafety`'s pick helpers against an ALLOWLIST
 * of four things: `timestamp`, `data[].post`, `attachments[].data[0].media.uri`
 * (+ its `creation_timestamp`), and `attachments[].data[0].external_context.
 * url`. A cast would be a promise about a file the member downloaded from a
 * third party; these are checks, and anything that is not the shape asked for
 * becomes a skip reason rather than a `TypeError` three frames later.
 *
 * ## Four fields that exist in every real export and are NEVER read
 *
 *  - The post's generated sentence (`title`). Facebook writes a localized
 *    "<name> shared a post" there for content from someone else's timeline or
 *    from a group. Alex settled this on 2026-11-12: such posts are imported as
 *    the member's own, and the ONLY thing that would have marked them is that
 *    sentence — so reading it could only produce an English-shaped guess about
 *    a string that is localized. It is not in the pick schema at all.
 *  - Tagged people. Other members' names are not this member's content to
 *    import, and #925's own `noExifLeak` test greps this file to prove the
 *    field name appears nowhere outside a comment.
 *  - A link's display name and publisher. Only the url is imported (Alex,
 *    2026-11-12), because the other two are Facebook's rendering of someone
 *    else's page, not words the member wrote.
 *  - Per-media captions and descriptions, and the whole EXIF/camera subtree,
 *    which `pruningReviver` has already deleted before this module runs.
 *
 * ## Shapes this fails closed on
 *
 * An attachment that claims `media` but has no usable `uri` string makes the
 * whole post `malformed_post`. The alternative — importing the post without
 * that photo — is a SILENT partial import, which is the one outcome #983's
 * hold obligation exists to prevent. The same stance covers a post with more
 * than `MAX_MEDIA_PER_POST` items and text above `RAW_TEXT_MAX_UNITS`.
 */

import { isImportableDate, mediaDateMs } from './dateBounds';
import {
  MAX_JSON_DEPTH,
  MAX_MEDIA_PER_POST,
  MAX_POSTS_PER_FILE,
  parseJsonSafely,
  pickArray,
  pickField,
  pickInteger,
  pickObject,
  pickString,
} from './jsonSafety';
import { buildSourceItemId } from './sourceItemId';
import { assembleBody } from './text';
import { ID_KIND_BY_SCHEME } from './types';

import type { ParseFileContext, ParsedFile, ParsedSkip, RawParseResult } from './types';

/**
 * The only link form imported: an absolute http(s) url.
 *
 * Case-sensitive on purpose. Meta writes lowercase schemes, the url is
 * embedded VERBATIM in both the body and `source_item_id`, and a matcher that
 * accepted `HTTPS://` would make the identity of a post depend on a
 * case-folding rule rather than on the archive's bytes. Anything else —
 * `javascript:`, a bare domain, a relative path — is simply not a link, and a
 * post left with nothing else becomes `empty_post`.
 */
const HTTP_URL = /^https?:\/\//;

/** The attachment payloads #925 recognises. Everything else is ignored. */
const MEDIA_KEY = 'media';
const LINK_KEY = 'external_context';
/**
 * Attachment kinds that are never imported (Alex, 2026-10-19/26).
 *
 * A life event or an event RSVP is not a post the member wrote, and both carry
 * place/coordinate subtrees that `pruningReviver` has already dropped. They
 * are tracked only so that a post consisting of nothing else can be reported
 * as `unsupported_post_type` rather than as an empty post the member would not
 * recognise.
 */
const UNSUPPORTED_KEYS = ['life_event', 'event'] as const;

interface AttachmentScan {
  readonly mediaUris: string[];
  readonly mediaDates: (number | null)[];
  readonly linkUrl: string | null;
  readonly sawUnsupported: boolean;
  /** An attachment that claimed media we could not name. Fails the post closed. */
  readonly broken: boolean;
}

/**
 * Walk `attachments[].data[0]`.
 *
 * ONLY element 0 of each attachment's `data`, which is the shape every
 * observed export uses (one payload per attachment, the array being Meta's
 * generic container). Walking the whole array would invent media for shapes we
 * have never seen.
 */
function scanAttachments(post: unknown, nowUtcDay: string): AttachmentScan {
  const mediaUris: string[] = [];
  const mediaDates: (number | null)[] = [];
  let linkUrl: string | null = null;
  let sawUnsupported = false;
  let broken = false;

  const attachments = pickArray(pickField(post, 'attachments'));
  if (attachments === null) {
    return { mediaUris, mediaDates, linkUrl, sawUnsupported, broken };
  }

  for (const attachment of attachments) {
    const data = pickArray(pickField(attachment, 'data'));
    if (data === null || data.length === 0) continue;
    const payload = pickObject(data[0]);
    if (payload === null) continue;

    const media = pickField(payload, MEDIA_KEY);
    if (media !== undefined) {
      const uri = pickString(pickField(media, 'uri'));
      if (uri === null || uri.length === 0) {
        broken = true;
        continue;
      }
      mediaUris.push(uri);
      mediaDates.push(mediaDateMs(pickInteger(pickField(media, 'creation_timestamp')), nowUtcDay));
      continue;
    }

    const link = pickField(payload, LINK_KEY);
    if (link !== undefined) {
      // First accepted url wins. A post with two shared links is a shape no
      // observed export produces, and appending both would put a second url in
      // the body — and in the identity — on a guess.
      if (linkUrl === null) {
        const url = pickString(pickField(link, 'url'));
        if (url !== null && HTTP_URL.test(url)) linkUrl = url;
      }
      continue;
    }

    for (const key of UNSUPPORTED_KEYS) {
      if (pickField(payload, key) !== undefined) {
        sawUnsupported = true;
        break;
      }
    }
  }

  return { mediaUris, mediaDates, linkUrl, sawUnsupported, broken };
}

/**
 * Join the post's own words.
 *
 * Facebook splits a post's text across `data[]` entries (a status plus an
 * edit, typically). They are joined with a BLANK line, which is how the member
 * would have seen them, and the join happens BEFORE `assembleBody` so the raw
 * length floor applies to the whole thing.
 */
function collectText(post: unknown): string {
  const data = pickArray(pickField(post, 'data'));
  if (data === null) return '';
  const parts: string[] = [];
  for (const element of data) {
    const text = pickString(pickField(element, 'post'));
    if (text !== null && text.length > 0) parts.push(text);
  }
  return parts.join('\n\n');
}

function skip(
  ctx: ParseFileContext,
  sourceIndex: number,
  reason: ParsedSkip['reason'],
  sourceItemId: Uint8Array | null,
  originalDate: number | null,
): ParsedSkip {
  return {
    outcome: 'skip',
    source: 'facebook',
    sourceFile: ctx.sourceFile,
    sourceIndex,
    sourceItemId,
    // Facebook has exactly one identity scheme, so the kind follows the id:
    // present whenever a frame was minted, null for the refusals that precede
    // one. (Instagram's parser, which has two, passes it explicitly.)
    idKind: sourceItemId === null ? null : ID_KIND_BY_SCHEME.content,
    originalDate,
    reason,
  };
}

/** One element of the top-level array. */
function parseFacebookPost(
  element: unknown,
  sourceIndex: number,
  ctx: ParseFileContext,
): RawParseResult {
  if (pickObject(element) === null) {
    return skip(ctx, sourceIndex, 'malformed_post', null, null);
  }

  const seconds = pickInteger(pickField(element, 'timestamp'));
  if (seconds === null) {
    return skip(ctx, sourceIndex, 'missing_timestamp', null, null);
  }
  const originalDate = seconds * 1000;
  if (!isImportableDate(originalDate, ctx.nowUtcDay)) {
    // No id and no date: a post the server would refuse has no identity worth
    // minting, and a nonsense date is not a date to show anybody.
    return skip(ctx, sourceIndex, 'invalid_timestamp', null, null);
  }

  const scan = scanAttachments(element, ctx.nowUtcDay);
  if (scan.broken || scan.mediaUris.length > MAX_MEDIA_PER_POST) {
    return skip(ctx, sourceIndex, 'malformed_post', null, originalDate);
  }

  const assembled = assembleBody({
    rawText: collectText(element),
    linkUrl: scan.linkUrl,
    ...(ctx.bodyMaxChars === undefined ? {} : { maxChars: ctx.bodyMaxChars }),
  });
  if (!assembled.ok && assembled.reason === 'malformed_post') {
    return skip(ctx, sourceIndex, 'malformed_post', null, originalDate);
  }

  // Minted BEFORE the outcome is decided, from the PRE-NFC repaired text, so a
  // post that is skipped today and imported after a fix has the same identity
  // — which is what lets #921 persist a held item's `import_key` at parse time.
  const sourceItemId = buildSourceItemId({
    kind: 'content',
    timestampSeconds: seconds,
    text: assembled.idText,
    linkUrl: scan.linkUrl,
    mediaUris: scan.mediaUris,
  });
  if (sourceItemId === null) {
    // Not strictly encodable (a lone surrogate): framing would stop being
    // injective, so the post cannot be given an identity at all.
    return skip(ctx, sourceIndex, 'malformed_post', null, originalDate);
  }

  if (!assembled.ok) {
    return skip(ctx, sourceIndex, 'text_too_long', sourceItemId, originalDate);
  }

  if (assembled.body.length === 0 && scan.mediaUris.length === 0) {
    const reason = scan.sawUnsupported ? 'unsupported_post_type' : 'empty_post';
    return skip(ctx, sourceIndex, reason, sourceItemId, originalDate);
  }

  return {
    outcome: 'post',
    source: 'facebook',
    sourceFile: ctx.sourceFile,
    sourceIndex,
    sourceItemId,
    idScheme: 'content',
    originalDate,
    body: assembled.body,
    mediaUris: scan.mediaUris,
    mediaDates: scan.mediaDates,
  };
}

/**
 * Parse one Facebook post file.
 *
 * File-level failures produce NO items:
 *  - a depth or parse failure comes straight from `parseJsonSafely`;
 *  - a top level that is not an array is `json_unparseable` — it parsed, but it
 *    is not a Facebook post file, and guessing at some other container is how
 *    a parser ends up reading a file it was never pointed at;
 *  - more than `MAX_POSTS_PER_FILE` elements is `archive_too_large`, the same
 *    "this is bigger than we handle, and you are being told" contract the
 *    run-wide file cap uses.
 */
export function parseFacebookFile(text: string, ctx: ParseFileContext): ParsedFile {
  const parsed = parseJsonSafely(text, MAX_JSON_DEPTH, {
    depthScanned: ctx.depthScanned === true,
  });
  if (!parsed.ok) return { ok: false, reason: parsed.reason };

  const root = pickArray(parsed.value);
  if (root === null) return { ok: false, reason: 'json_unparseable' };
  if (root.length > MAX_POSTS_PER_FILE) return { ok: false, reason: 'archive_too_large' };

  const items: RawParseResult[] = root.map((element, index) =>
    parseFacebookPost(element, index, ctx),
  );
  return { ok: true, items };
}
