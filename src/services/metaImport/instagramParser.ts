/**
 * The Instagram post parser (#925) — pure, and split across two files.
 *
 * Instagram's export puts a member's posts in one place and their only stable
 * identifier in another:
 *
 *  - **`posts_N.json`** (flat, under any of four wrapper prefixes) holds the
 *    CONTENT: the caption, the timestamps and the media uris. It carries no
 *    identifier of any kind.
 *  - **`posts.json`** (labelled, one file) holds an `fbid` per post inside a
 *    `label_values` display tree. It is read for that number and nothing else,
 *    and the parsed graph is dropped before any content file is opened.
 *
 * The two are joined by MEDIA BASENAME, not by timestamp: a single-media post
 * has no post-level timestamp in the flat file at all, and two posts a few
 * seconds apart would be indistinguishable. A basename is content, it is
 * unique within an export, and it is already what `source_item_id` frames.
 *
 * ## Why the fbid is worth this trouble
 *
 * Content-derived ids change when the content does. Instagram re-encodes media
 * filenames between exports more readily than Facebook, so an `fbid` — when we
 * can read one — is the identity that survives a member re-downloading their
 * archive next month. When `posts.json` is absent, over the byte cap, or
 * unreadable, every post falls back to a content frame; that flip is a real
 * behaviour change, recorded per post as `idScheme` and counted into the
 * summary so a duplicate-looking re-import is explainable after the fact.
 *
 * ## The caption field is called `title`
 *
 * Unlike Facebook's `title` — a localized sentence Facebook generated, which
 * this import never reads — Instagram's `title` IS the member's caption. On a
 * carousel it sits on the post; on a single-media post the post has no title
 * and the caption lives on `media[0].title`. Both are the member's words, and
 * both are imported.
 */

import { isImportableDate, mediaDateMs } from './dateBounds';
import {
  MAX_MEDIA_PER_POST,
  MAX_POSTS_PER_FILE,
  parseJsonSafely,
  pickArray,
  pickField,
  pickInteger,
  pickObject,
  pickString,
} from './jsonSafety';
import { basenameOfUri, buildSourceItemId } from './sourceItemId';
import { assembleBody } from './text';
import { ID_KIND_BY_SCHEME } from './types';

import type {
  FileIssueReason,
  IdKind,
  ParseFileContext,
  ParsedFile,
  ParsedSkip,
  RawParseResult,
} from './types';

/**
 * Media basename → the `fbid` that claims it, or `null` when more than one
 * does.
 *
 * The `null` sentinel is load-bearing. If two posts' trees name the same
 * basename, the file cannot tell us which post that media belongs to, and a
 * first-one-wins index would hand a post a CONFIDENTLY WRONG identity — the
 * one failure mode that survives into the server's dedup. A post touching an
 * ambiguous basename falls back to a content frame instead.
 */
export type FbidIndex = ReadonlyMap<string, string | null>;

export type FbidIndexResult =
  | { readonly ok: true; readonly index: FbidIndex }
  | { readonly ok: false; readonly reason: FileIssueReason };

/**
 * Node ceiling for the labelled-file walk, counted in CONTAINERS (objects and
 * arrays) — the only things that go on the stack.
 *
 * The file is already bounded at `MAX_JSON_BYTES` and the graph is acyclic, so
 * this cannot be hit by a real export; it exists so a crafted 12 MiB file of
 * one-character keys cannot turn a preflight into a hang. Over the ceiling the
 * whole index is refused rather than truncated: a PARTIAL index would still be
 * deterministic, but it would silently give some posts fbid ids and others
 * content ids depending on a walk order nobody can see.
 */
export const MAX_FBID_WALK_NODES = 1_000_000;

/** Everything `buildFbidIndex` takes besides the file's text. */
export interface FbidIndexOptions {
  /**
   * Override `MAX_FBID_WALK_NODES`.
   *
   * Exists so the refusal can be TESTED: the real ceiling needs a crafted
   * multi-megabyte file to reach, and a budget nobody has ever seen bite is a
   * budget that might be off by an order of magnitude in either direction.
   */
  readonly maxNodes?: number;
}

/**
 * Build the basename → fbid index from the labelled `posts.json`.
 *
 * The walk is iterative and generic: it descends every own property of every
 * object under one top-level element and records the `uri` of every item in
 * every `media` array it meets. The real file hangs a post's cover media at
 * `label_values[].media[]` and its carousel children three levels deeper at
 * `label_values[].dict[].dict[].media[]`, and Instagram has moved them before.
 * A walk that knew the path would silently lose one depth — and losing the
 * children means every carousel falls back to a content id for no visible
 * reason — so the path is not hard-coded.
 *
 * Sensitive subtrees are gone before this runs: `parseJsonSafely`'s reviver
 * deleted them at parse time.
 */
export function buildFbidIndex(
  labelledText: string,
  options: FbidIndexOptions = {},
): FbidIndexResult {
  const parsed = parseJsonSafely(labelledText);
  if (!parsed.ok) return { ok: false, reason: parsed.reason };

  const root = pickArray(parsed.value);
  if (root === null) return { ok: false, reason: 'json_unparseable' };

  const index = new Map<string, string | null>();
  let budget = options.maxNodes ?? MAX_FBID_WALK_NODES;

  /** Worth descending into: an object or an array, never a scalar leaf. */
  const isContainer = (value: unknown): boolean => typeof value === 'object' && value !== null;

  const claim = (uri: string, fbid: string): void => {
    const name = basenameOfUri(uri);
    if (name.length === 0) return;
    const existing = index.get(name);
    if (existing === undefined) index.set(name, fbid);
    else if (existing !== fbid) index.set(name, null);
  };

  for (const element of root) {
    const fbid = pickString(pickField(element, 'fbid'));
    if (fbid === null || fbid.length === 0) continue;

    const stack: unknown[] = [element];
    while (stack.length > 0) {
      if (budget-- <= 0) return { ok: false, reason: 'json_too_large' };
      const node = stack.pop();

      const array = pickArray(node);
      if (array !== null) {
        // Only containers go on the stack. A scalar leaf — and a label tree is
        // mostly strings — has nothing under it, so pushing one buys a pop and
        // two failed type tests and spends a node of the budget. The real file
        // is ~3× more leaves than containers, so charging them would make the
        // ceiling bite three times sooner than its own docblock claims, and
        // tripping it flips EVERY Instagram post to a content-derived id.
        for (const item of array) {
          if (isContainer(item)) stack.push(item);
        }
        continue;
      }

      const object = pickObject(node);
      if (object === null) continue;

      for (const key of Object.keys(object)) {
        const value = object[key];
        if (key === 'media') {
          const items = pickArray(value);
          if (items !== null) {
            for (const item of items) {
              const uri = pickString(pickField(item, 'uri'));
              if (uri !== null) claim(uri, fbid);
            }
          }
        }
        if (isContainer(value)) stack.push(value);
      }
    }
  }

  return { ok: true, index };
}

/** What the flat file states about one post's media. */
interface IgMediaScan {
  /** Uris in STORED order — what the id and the join see. */
  readonly storedUris: string[];
  readonly storedDates: (number | null)[];
  /** `media[0].title`, the caption of a single-media post. */
  readonly firstTitle: string | null;
  /** `media[0].creation_timestamp` in SECONDS — a single post's only date. */
  readonly firstSeconds: number | null;
  /** A `media` field that is not a usable list. Fails the post closed. */
  readonly broken: boolean;
}

function scanMedia(element: unknown, nowUtcDay: string): IgMediaScan {
  const storedUris: string[] = [];
  const storedDates: (number | null)[] = [];
  let firstTitle: string | null = null;
  let firstSeconds: number | null = null;

  const empty = { storedUris, storedDates, firstTitle, firstSeconds };
  const field = pickField(element, 'media');
  if (field === undefined) return { ...empty, broken: false };

  const items = pickArray(field);
  if (items === null) return { ...empty, broken: true };

  for (const item of items) {
    const uri = pickString(pickField(item, 'uri'));
    if (uri === null || uri.length === 0) {
      return { storedUris, storedDates, firstTitle, firstSeconds, broken: true };
    }
    const seconds = pickInteger(pickField(item, 'creation_timestamp'));
    if (storedUris.length === 0) {
      firstTitle = pickString(pickField(item, 'title'));
      firstSeconds = seconds;
    }
    storedUris.push(uri);
    // Bounds-checked (`mediaDateMs`); `firstSeconds` above keeps the RAW
    // value, because the post-level fallback runs it through the post's own
    // `isImportableDate` and a date that is nonsense for the post is an
    // `invalid_timestamp` skip, not a silently missing one.
    storedDates.push(mediaDateMs(seconds, nowUtcDay));
  }

  return { storedUris, storedDates, firstTitle, firstSeconds, broken: false };
}

/**
 * The fbid this post's media agree on, or `null`.
 *
 * "Agree" means: at least one basename was found in the index, every basename
 * that was found resolved to the SAME fbid, and none of them was ambiguous.
 * Anything else — no media at all, no hit, two different fbids, a basename two
 * posts claim — falls back to a content frame. Partial agreement is not
 * agreement: a carousel whose children belong to two posts is a file we do not
 * understand, and understanding it wrongly costs the member a duplicate.
 */
function joinFbid(uris: readonly string[], fbidIndex: FbidIndex | null): string | null {
  if (fbidIndex === null) return null;
  let agreed: string | null = null;
  for (const uri of uris) {
    const hit = fbidIndex.get(basenameOfUri(uri));
    if (hit === undefined) continue;
    if (hit === null) return null;
    if (agreed === null) agreed = hit;
    else if (agreed !== hit) return null;
  }
  return agreed;
}

/**
 * `idKind` is passed EXPLICITLY here, unlike the Facebook parser's helper: an
 * Instagram skip may carry either a platform frame or a content one, and
 * inferring "content" from a non-null id would quietly mislabel every held
 * post that did join an fbid.
 */
function skip(
  ctx: ParseFileContext,
  sourceIndex: number,
  reason: ParsedSkip['reason'],
  sourceItemId: Uint8Array | null,
  idKind: IdKind | null,
  originalDate: number | null,
): ParsedSkip {
  return {
    outcome: 'skip',
    source: 'instagram',
    sourceFile: ctx.sourceFile,
    sourceIndex,
    sourceItemId,
    idKind,
    originalDate,
    reason,
  };
}

function parseInstagramPost(
  element: unknown,
  sourceIndex: number,
  ctx: ParseFileContext,
  fbidIndex: FbidIndex | null,
): RawParseResult {
  if (pickObject(element) === null) {
    return skip(ctx, sourceIndex, 'malformed_post', null, null, null);
  }

  const scan = scanMedia(element, ctx.nowUtcDay);
  if (scan.broken || scan.storedUris.length > MAX_MEDIA_PER_POST) {
    return skip(ctx, sourceIndex, 'malformed_post', null, null, null);
  }

  // A carousel carries its own `creation_timestamp`; a single-media post has
  // none at all and the media's own time is the only one stated, so the
  // fallback reads the first stored element.
  const postSeconds = pickInteger(pickField(element, 'creation_timestamp'));
  const seconds = postSeconds ?? scan.firstSeconds;
  if (seconds === null) {
    return skip(ctx, sourceIndex, 'missing_timestamp', null, null, null);
  }
  const originalDate = seconds * 1000;
  if (!isImportableDate(originalDate, ctx.nowUtcDay)) {
    return skip(ctx, sourceIndex, 'invalid_timestamp', null, null, null);
  }

  // The caption: the post's own `title` when it has one, else — and only for a
  // single-media post — the media's. A carousel's per-child titles are not
  // captions, they are Instagram's per-item labels.
  const postTitle = pickString(pickField(element, 'title'));
  const caption =
    postTitle !== null && postTitle.length > 0
      ? postTitle
      : scan.storedUris.length === 1 && scan.firstTitle !== null
        ? scan.firstTitle
        : '';

  const assembled = assembleBody({
    rawText: caption,
    ...(ctx.bodyMaxChars === undefined ? {} : { maxChars: ctx.bodyMaxChars }),
  });
  if (!assembled.ok && assembled.reason === 'malformed_post') {
    return skip(ctx, sourceIndex, 'malformed_post', null, null, originalDate);
  }

  const fbid = joinFbid(scan.storedUris, fbidIndex);
  let sourceItemId =
    fbid === null ? null : buildSourceItemId({ kind: 'platform', platformId: fbid });
  const idScheme = sourceItemId === null ? 'content' : 'fbid';
  const idKind = ID_KIND_BY_SCHEME[idScheme];
  if (sourceItemId === null) {
    // The content frame is the fallback for BOTH "no fbid" and "an fbid that
    // is not strictly encodable": the fbid is auxiliary, and refusing a post
    // over it would lose content we can identify perfectly well by its bytes.
    sourceItemId = buildSourceItemId({
      kind: 'content',
      timestampSeconds: seconds,
      text: assembled.idText,
      linkUrl: null,
      mediaUris: scan.storedUris,
    });
  }
  if (sourceItemId === null) {
    return skip(ctx, sourceIndex, 'malformed_post', null, null, originalDate);
  }

  if (!assembled.ok) {
    return skip(ctx, sourceIndex, 'text_too_long', sourceItemId, idKind, originalDate);
  }

  if (assembled.body.length === 0 && scan.storedUris.length === 0) {
    return skip(ctx, sourceIndex, 'empty_post', sourceItemId, idKind, originalDate);
  }

  // The STORED order is the order we import (Alex, 2026-11-12). An earlier
  // draft reversed a carousel's children on the belief that Instagram stores
  // them backwards; re-reading the real sample killed that belief — the
  // children's `creation_timestamp`s are all equal (the upload instant, not
  // per-photo capture times) and their filenames are not ordered either, so
  // the export states NOTHING about display order and a reversal would be a
  // coin flip dressed up as a fix. Half of all carousels would come out
  // backwards instead of half coming out right.
  //
  // The identity is unaffected either way (`source_item_id` sorts basenames),
  // so this is observable only as the order the member sees in a carousel.
  // The scan's arrays are handed on directly, as the Facebook parser does:
  // the scan is per-post and nothing reads it afterwards, so a copy would be
  // two allocations per post to protect nobody.
  return {
    outcome: 'post',
    source: 'instagram',
    sourceFile: ctx.sourceFile,
    sourceIndex,
    sourceItemId,
    idScheme,
    originalDate,
    body: assembled.body,
    mediaUris: scan.storedUris,
    mediaDates: scan.storedDates,
  };
}

/**
 * Parse one flat Instagram content file.
 *
 * `fbidIndex` is `null` whenever the labelled file was absent, over the byte
 * cap or unreadable — every post then takes a content-derived id. The file
 * issue for that is raised by the caller, which is what read the file.
 */
export function parseInstagramFlatFile(
  text: string,
  ctx: ParseFileContext,
  fbidIndex: FbidIndex | null,
): ParsedFile {
  const parsed = parseJsonSafely(text);
  if (!parsed.ok) return { ok: false, reason: parsed.reason };

  const root = pickArray(parsed.value);
  if (root === null) return { ok: false, reason: 'json_unparseable' };
  if (root.length > MAX_POSTS_PER_FILE) return { ok: false, reason: 'archive_too_large' };

  const items: RawParseResult[] = root.map((element, index) =>
    parseInstagramPost(element, index, ctx, fbidIndex),
  );
  return { ok: true, items };
}
