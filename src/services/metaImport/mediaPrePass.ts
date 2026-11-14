/**
 * The media pre-pass: the one place a post's media may earn an import licence
 * (#925, hold obligation #983).
 *
 * A Meta export's post JSON names its media by `uri`. Nothing about that name
 * is evidence: the entry may be absent, outside the allowlist, listed but
 * unreadable, a video under a photo's extension, or a format this app cannot
 * handle. So the pre-pass turns every named uri into ONE of two answers,
 * through the archive policy layer and nothing else:
 *
 *  1. `resolveFileMedia` — uri strings to `UriResolution`s, in bounded chunks
 *     (`resolveMediaUris` is synchronous, uncapped and not abortable, so the
 *     chunking is what keeps a 25,000-uri file from blocking the JS thread for
 *     one unbroken stretch).
 *  2. `peekMediaEntries` — one SEQUENTIAL `peekEntryKind` per distinct entry
 *     id, memoised per file and charged against a run-wide budget.
 *  3. `classifyMediaItem` — the resolution + the peek verdict to a decision.
 *     The ONLY `import-image` licence in this module, and in the parser, is
 *     the guarded return in that function.
 *  4. `foldPostMediaDecisions` — the per-post verdict: ANY hold holds the
 *     WHOLE post. A post is never partially imported.
 *
 * ## Why a positive image peek is the only licence
 *
 * `archiveAccess.peekEntryKind`'s contract (a) is explicit: a skip is NEVER
 * proof of "not a video", and neither is `URI_UNRESOLVED` nor
 * `ENTRY_SNIFF_INDETERMINATE` — the sniff recognises ISO-BMFF video only, so a
 * WebM or MKV arrives as "unrecognised", not as "video". The hold table below
 * is therefore built the other way round from the usual: everything holds
 * except `{ok: true, kind: 'image'}`.
 *
 * ## Throw policy
 *
 * `resolveMediaUris` and `peekEntryKind` throws are NEVER caught into a
 * decision. An `ARCHIVE_BUSY` or an `ARCHIVE_ACCESS_LOST` is a run-level fact
 * that `parseArchive` dispatches on `ARCHIVE_ERROR_DISPOSITIONS` (pause,
 * repick or abort); swallowing one here would turn a resumable pause into a
 * permanent "we could not read your photo", which is a silent data loss the
 * member can never undo. There is no `catch` in this file.
 *
 * ## No content type leaves the pre-pass
 *
 * `peekEntryKind`'s `contentType` is advisory — it describes 128 bytes that
 * were never written to disk (contract (b)). The only label that may be
 * persisted or uploaded is `extractImageEntry`'s post-extract one, so
 * `ParsedMedia` carries an entry id and a date and nothing else.
 */

import { ArchiveReaderError } from './archiveAccess';

import type {
  ArchiveCallOptions,
  ArchiveEntryKindOutcome,
  ArchiveImportSession,
  UriResolution,
} from './archiveAccess';
import type { FileIssueReason, ParsedMedia, SkipReason } from './types';

// ---------------------------------------------------------------------------
// Caps
// ---------------------------------------------------------------------------

/**
 * The most media uris one JSON file may name before the file is refused.
 *
 * `MAX_POSTS_PER_FILE` is 20,000 and `MAX_MEDIA_PER_POST` is 50 (plan §5), so
 * a hostile file could name a million uris and `resolveMediaUris` would walk
 * every one of them synchronously. 25,000 is 500 posts at the 50-media
 * ceiling, or 6,000+ posts of a realistic export — far above anything the two
 * real sample exports produce (871 FB posts / 352 IG posts).
 *
 * Over the cap the file is NOT parsed for media: the caller raises the
 * `json_too_many_media` file issue and holds that file's posts
 * `media_unreadable`, because a post whose media could not be classified has
 * no licence to import any of it.
 */
export const MAX_MEDIA_URIS_PER_FILE = 25_000;

/**
 * Uris handed to ONE synchronous `resolveMediaUris` call.
 *
 * "≤500 posts' worth" (plan §4) expressed as a uri count: a Facebook post in
 * the real samples carries at most a handful of attachments, so 2,000 uris is
 * 500 posts at four media each. A file that really does carry 50 media on
 * every post splits those posts across calls, which is harmless — resolution
 * is per-uri and 1:1, and the caller reassembles by index, not by post.
 *
 * The point of the ceiling is the JS thread: `resolveMediaUris` is
 * synchronous, cross-part and not abortable (#920 F7), so the chunk size IS
 * the granularity at which an abort can be observed and the event loop given a
 * turn.
 */
export const MAX_URIS_PER_RESOLVE_CALL = 2_000;

/**
 * Distinct `peekEntryKind` calls permitted across a whole run.
 *
 * Each peek inflates up to 128 bytes through the FFI and shares Rust's four
 * job slots with the import run. `MAX_POSTS_PER_RUN` is 50,000, so this is one
 * peek per post before the budget bites — reached only by an archive built to
 * reach it. Media beyond the budget is held `media_unreadable` (never
 * imported): running out of budget is "we could not look", which the hold
 * table already answers.
 *
 * The counter lives in a `PeekBudget` the CALLER owns, because the budget is
 * run-wide while the memo is per file.
 */
export const MAX_PEEKS_PER_RUN = 50_000;

// ---------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------

/**
 * Why a post's media holds the whole post.
 *
 * `Extract` from `SkipReason` rather than a free-standing union: a hold reason
 * that is not a skip reason could never be reported to #928, and a rename on
 * either side is then a compile error instead of an uncategorised row.
 */
export type HoldReason = Extract<
  SkipReason,
  | 'held_video'
  | 'unsupported_image_format'
  | 'image_too_large'
  | 'media_missing'
  | 'media_unsupported_reference'
  | 'media_unreadable'
>;

/**
 * The import licence, as its own type alias.
 *
 * Deliberately NOT spelled inline in `MediaDecision`: invariant 29.8 clause 3
 * counts the literal `decision: 'import-image'` across this whole file and
 * requires EXACTLY ONE — the guarded return in `classifyMediaItem`. A type
 * declaration spelling the same token would force that clause down to "at most
 * two", and the second occurrence it then tolerated could be another return.
 */
type ImportImage = 'import-image';

/** One media item's verdict. */
export type MediaDecision =
  | { readonly decision: ImportImage; readonly entryId: string }
  | { readonly decision: 'hold'; readonly reason: HoldReason };

/**
 * One media item's verdict plus the date its JSON stated.
 *
 * The date never influences the decision — it rides along because the fold
 * builds `ParsedMedia` and the pre-pass is the only pass over the list.
 */
export interface PostMediaItem {
  readonly result: MediaDecision;
  /** Media creation time, epoch ms UTC, when the export stated one. */
  readonly originalDate: number | null;
}

/** The per-post verdict. `hold` carries the reason the whole post is skipped. */
export type PostMediaFold =
  | { readonly outcome: 'import'; readonly media: readonly ParsedMedia[] }
  | { readonly outcome: 'hold'; readonly reason: HoldReason };

/**
 * Which hold the member is told about when a post has several.
 *
 * Lowest number wins. The order is "most explanatory first": a video is a
 * complete, honest answer ("Orbital imports photos"), an unsupported format is
 * specific, an over-size image is equally specific, a missing file is
 * actionable ("select every ZIP part"), and `media_unreadable` is the residual
 * — so it must never mask one of the others. Only `<` is compared, so the
 * numbering is order-preserving and may be renumbered freely.
 *
 * `image_too_large` cannot be produced by this pre-pass today — it is a
 * sanitize-time verdict from the upload path (#918/#926) — so its entry exists
 * for exhaustiveness, and its number becomes live only if a future pre-pass
 * learns to refuse by declared dimensions.
 */
const HOLD_PRIORITY: Readonly<Record<HoldReason, number>> = {
  held_video: 0,
  unsupported_image_format: 1,
  image_too_large: 2,
  media_missing: 3,
  media_unsupported_reference: 4,
  media_unreadable: 5,
};

// ---------------------------------------------------------------------------
// 1. Resolution
// ---------------------------------------------------------------------------

/** Just the slice of the session this module resolves through. */
export type MediaResolvingSession = Pick<ArchiveImportSession, 'resolveMediaUris'>;

/** Just the slice of the session this module peeks through. */
export type MediaPeekingSession = Pick<ArchiveImportSession, 'peekEntryKind'>;

export type FileMediaResolution =
  | { readonly ok: true; readonly resolutions: readonly UriResolution[] }
  | { readonly ok: false; readonly issue: Extract<FileIssueReason, 'json_too_many_media'> };

/**
 * Resolve one FILE's media uris, in chunks, 1:1 and in order.
 *
 * The returned array is index-aligned with `uris` — that alignment is how the
 * caller gets back from a resolution to the post that named it, so it is
 * asserted rather than assumed: a resolver that returned a short array would
 * otherwise shift every subsequent post's media onto the wrong post, and the
 * wrong photos would be imported into the wrong thread. A mismatch is a bug in
 * a layer below this one, so it is `ARCHIVE_INTERNAL`, not a skip.
 */
export async function resolveFileMedia(
  session: MediaResolvingSession,
  uris: readonly string[],
  options: ArchiveCallOptions = {},
): Promise<FileMediaResolution> {
  if (uris.length > MAX_MEDIA_URIS_PER_FILE) {
    return { ok: false, issue: 'json_too_many_media' };
  }

  const out: UriResolution[] = [];
  for (let at = 0; at < uris.length; at += MAX_URIS_PER_RESOLVE_CALL) {
    throwIfAborted(options.signal);
    // Between chunks only: a single-chunk file (every realistic export) pays
    // no extra tick, and a 25,000-uri one gives the UI twelve turns.
    if (at > 0) await yieldToEventLoop();

    const chunk = uris.slice(at, at + MAX_URIS_PER_RESOLVE_CALL);
    const resolved = session.resolveMediaUris(chunk);
    if (resolved.length !== chunk.length) {
      throw new ArchiveReaderError('ARCHIVE_INTERNAL');
    }
    for (const resolution of resolved) out.push(resolution);
  }

  if (out.length !== uris.length) {
    throw new ArchiveReaderError('ARCHIVE_INTERNAL');
  }
  return { ok: true, resolutions: out };
}

// ---------------------------------------------------------------------------
// 2. Peek
// ---------------------------------------------------------------------------

/**
 * The run-wide distinct-peek counter.
 *
 * Mutable and owned by `parseArchive` (one per run), deliberately NOT a module
 * global: a module global would leak across runs and across tests, and two
 * concurrent parses would silently share a budget.
 */
export interface PeekBudget {
  remaining: number;
}

export function createPeekBudget(limit: number = MAX_PEEKS_PER_RUN): PeekBudget {
  return { remaining: limit };
}

/**
 * Per-FILE peek state: the memo, plus a reference to the run-wide budget.
 *
 * The memo is per file because that is the parser's only file-scoped state
 * (plan §1): entry ids are stable within a session, but a file's media list is
 * the natural lifetime, and holding every peek verdict of a 200-file run would
 * be an unbounded accumulator of exactly the kind the plan review rejected.
 */
export interface FilePeekScope {
  readonly budget: PeekBudget;
  readonly peeked: Map<string, ArchiveEntryKindOutcome>;
}

export function createFilePeekScope(budget: PeekBudget): FilePeekScope {
  return { budget, peeked: new Map() };
}

/**
 * A peek verdict, or `null` when the run-wide budget could not cover it.
 *
 * `null` is NOT "nothing was wrong": it means the item was never classified,
 * which the hold table answers with `media_unreadable`.
 */
export type MediaPeek = ArchiveEntryKindOutcome | null;

/**
 * Peek every distinct entry id, SEQUENTIALLY (contract (d)).
 *
 * Sequential is not a performance choice: Rust has four job slots that the
 * import run itself shares, and a parallel fan-out over a 25,000-media file
 * would starve the extracts. Each distinct id is peeked at most once per file
 * (the memo) and charged to the budget once.
 *
 * The budget is decremented BEFORE the await, so an entry whose peek throws
 * has still spent its charge — otherwise a session failing on every call would
 * spin the whole run against an undiminished budget.
 */
export async function peekMediaEntries(
  session: MediaPeekingSession,
  entryIds: readonly string[],
  scope: FilePeekScope,
  options: ArchiveCallOptions = {},
): Promise<ReadonlyMap<string, MediaPeek>> {
  const out = new Map<string, MediaPeek>();
  for (const entryId of entryIds) {
    if (out.has(entryId)) continue;

    const memoised = scope.peeked.get(entryId);
    if (memoised !== undefined) {
      out.set(entryId, memoised);
      continue;
    }
    if (scope.budget.remaining <= 0) {
      out.set(entryId, null);
      continue;
    }

    throwIfAborted(options.signal);
    scope.budget.remaining -= 1;
    const outcome = await session.peekEntryKind(entryId, options);
    scope.peeked.set(entryId, outcome);
    out.set(entryId, outcome);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 3. Classification — the one import licence
// ---------------------------------------------------------------------------

/**
 * Decide ONE media item: import it, or hold the post it belongs to.
 *
 * Both switches are exhaustive over their skip union with an `assertNever`
 * tail, so a new code added by Rust or by the sniff table is a COMPILE error
 * here rather than a silent fall-through — and the fall-through would be the
 * dangerous direction, because an unclassified item must hold.
 *
 * `ENTRY_UNSUPPORTED_IMAGE_FORMAT` is kept for exhaustiveness but is
 * unreachable from `peekEntryKind` today (verified 2026-11-12):
 * `sniffContentType` returns only `image/*`, `video/*` or `null`, so
 * `classifySniff`'s non-image branch cannot fire and an SVG or any other
 * non-media head comes back `ENTRY_SNIFF_INDETERMINATE` ⇒ `media_unreadable`.
 * (An AVIF is NOT in that set: it sniffs as `image/avif`, so it is importable
 * here and is decided at sanitize time, where the platform either decodes it
 * or refuses it as a format.)
 * The live producers are the UPLOAD-time `sanitizeStillImage` refusals
 * (#918/#926), which happen long after this pre-pass: `'unsupported-format'`
 * ⇒ `unsupported_image_format`, `'too-many-pixels'` ⇒ `image_too_large`.
 *
 * No `catch`: see the throw policy in this module's header.
 */
export function classifyMediaItem(resolution: UriResolution, peek: MediaPeek): MediaDecision {
  if (!resolution.ok) {
    switch (resolution.skip) {
      // The target may exist in a ZIP part the member did not select, so this
      // is the one hold class that is worth retrying with a fuller selection.
      case 'URI_UNRESOLVED':
      case 'URI_AMBIGUOUS':
        return { decision: 'hold', reason: 'media_missing' };
      // The reference itself is the problem — re-running changes nothing.
      case 'URI_INVALID':
      case 'URI_OUTSIDE_ALLOWLIST':
      case 'URI_UNSUPPORTED_KIND':
        return { decision: 'hold', reason: 'media_unsupported_reference' };
      default:
        return assertNever(resolution.skip);
    }
  }

  // The budget ran out before this item could be looked at: never classified,
  // so never importable.
  if (peek === null) return { decision: 'hold', reason: 'media_unreadable' };

  if (peek.ok && peek.kind === 'image') {
    return { decision: 'import-image', entryId: resolution.entryId };
  }
  // The only other `ok` arm. A listed video wins before a listing skip is
  // consulted (contract (e)), so this is also how a video the archive could
  // not read arrives.
  if (peek.ok) return { decision: 'hold', reason: 'held_video' };

  switch (peek.skip) {
    // Unreachable from `peekEntryKind` (it maps this verdict to
    // `{ok: true, kind: 'video'}`), but video evidence either way.
    case 'ENTRY_IS_VIDEO':
      return { decision: 'hold', reason: 'held_video' };
    case 'ENTRY_UNSUPPORTED_IMAGE_FORMAT':
      return { decision: 'hold', reason: 'unsupported_image_format' };
    // Everything else — including `ENTRY_SNIFF_INDETERMINATE`, which is where
    // WebM, MKV and every exotic still format land — is "we could not tell".
    case 'ENTRY_SNIFF_INDETERMINATE':
    case 'ENTRY_PATH_INVALID':
    case 'ENTRY_PATH_TRAVERSAL':
    case 'ENTRY_SYMLINK':
    case 'ENTRY_SPECIAL_FILE':
    case 'ENTRY_ENCRYPTED':
    case 'ENTRY_NESTED_ARCHIVE':
    case 'ENTRY_UNSUPPORTED_METHOD':
    case 'ENTRY_DUPLICATE':
    case 'ENTRY_OVER_CAP':
    case 'ENTRY_RATIO_EXCEEDED':
    case 'ENTRY_CORRUPT':
    case 'ENTRY_KIND_NOT_ENABLED':
    case 'ENTRY_KIND_MISMATCH':
    case 'ENTRY_NOT_UTF8':
    case 'ENTRY_NOT_ALLOWLISTED':
      return { decision: 'hold', reason: 'media_unreadable' };
    default:
      return assertNever(peek.skip);
  }
}

// ---------------------------------------------------------------------------
// 4. The whole-post fold
// ---------------------------------------------------------------------------

/**
 * Fold one post's media decisions into the post's own outcome.
 *
 * ANY hold holds the WHOLE post (Alex, 2026-10-19: never a partial post). A
 * post with no media at all folds to `import` with an empty list — "nothing to
 * hold" is not "something went wrong"; whether such a post has a body worth
 * importing is the parser's question, not this one.
 */
export function foldPostMediaDecisions(items: readonly PostMediaItem[]): PostMediaFold {
  let held: HoldReason | null = null;
  const media: ParsedMedia[] = [];

  for (const item of items) {
    if (item.result.decision === 'hold') {
      const reason = item.result.reason;
      if (held === null || HOLD_PRIORITY[reason] < HOLD_PRIORITY[held]) held = reason;
      continue;
    }
    media.push({ entryId: item.result.entryId, originalDate: item.originalDate });
  }

  if (held !== null) return { outcome: 'hold', reason: held };
  return { outcome: 'import', media };
}

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

/**
 * The compile-time exhaustiveness tail.
 *
 * Throws `ARCHIVE_INTERNAL` rather than returning a hold, because reaching it
 * means the union and this switch disagree at RUNTIME — a state no fold can
 * describe. `ArchiveReaderError` carries a code and never interpolates its
 * input, so nothing about the member's archive reaches the message.
 */
function assertNever(_value: never): never {
  throw new ArchiveReaderError('ARCHIVE_INTERNAL');
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw new ArchiveReaderError('ECANCELLED');
}

/**
 * Give the JS thread a turn.
 *
 * `setTimeout(0)` rather than a resolved promise: a microtask does NOT let the
 * UI run, and the whole reason the resolve loop is chunked is that
 * `resolveMediaUris` is synchronous.
 */
function yieldToEventLoop(): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}
