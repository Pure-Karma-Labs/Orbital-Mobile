/**
 * The per-item media pipeline of the Meta import runner (#926, §4.10).
 *
 * One function does one post's media: for each `import_item_media` row, in
 * `ordinal` order, extract the archive entry, hand it to `uploadMedia` in
 * import mode, and record the result. It owns exactly two `importRepository`
 * writes — `markMediaUploaded` and `replaceMediaId` — and one network call of
 * its own, the complete-only retry described below; everything else about the
 * transport, the crypto and the archive policy belongs to somebody else.
 *
 * ## What this module decides, and what it refuses to decide
 *
 * It answers the questions that are LOCAL to one file: this entry cannot be
 * read, this entry turned out to be a video, this image is one the device
 * cannot sanitize, this `media_id` is burned. Those become a typed
 * {@link ImportMediaOutcome} the runner acts on without re-deriving anything.
 *
 * Everything whose answer is about the RUN rather than the file — a network
 * outage, a rate limit, an expired session, a 403 that is not an id binding, a
 * crypto pause — is rethrown UNCHANGED, because `classifyImportFailure` and
 * the runner own that taxonomy (§4.7) and a wrapper here would hide the class
 * they match on. {@link importMediaStage} tells the caller which stage to
 * classify the rethrow under.
 *
 * ## Two rules this file exists to enforce
 *
 *  1. **`release()` exactly once, in a `finally`.** An extracted entry is
 *     PLAINTEXT on disk and `release()` is the unlink of it on every path
 *     including abort (`resetImportRunnerState` aborts the controller precisely
 *     so these `finally` blocks run). `localWipe`'s phase-2 suffix sweep does
 *     also reach `-archive-staging.bin`, but only as a backstop: it is one
 *     non-recursive readDir, so it cannot see a file an extract inflates after
 *     the listing, and on the logout path nothing else deletes it.
 *  2. **A burned `media_id` is never retried in place.** The server keeps the
 *     first attempt's envelope and IV, so a retry under the same id assembles
 *     two ciphertexts into one undecryptable blob that is still charged to the
 *     member's lifetime allowance. `ImportMediaStagedError` means exactly
 *     "this id is burned, mint a fresh one", and this file is where that is
 *     spent — once.
 *
 *     What it does NOT mean is "try again now". The wrapper is added to every
 *     failure after an accepted chunk, so its CAUSE is what decides the next
 *     step: an id binding (403, a bare 409) is re-mintable here and retried
 *     once, while an import refusal — the orbit filled up, the lifetime
 *     allowance ran out, the session closed — is rebound and then handed BACK
 *     as {@link ImportMediaOutcome} `refused`, because parking, ending the run
 *     and pausing are the runner's decisions and re-uploading the file under a
 *     fresh id would spend the member's allowance on a refusal that has not
 *     changed.
 *
 *     **The one documented exception is `IMPORT_QUOTA_EXCEEDED` at media
 *     complete**, where the server refuses AFTER the point it would have
 *     discarded anything: `assertImportQuotaForMediaBytes` rolls back the media
 *     row and deletes the assembled blob but KEEPS the temp row, every chunk
 *     file and the open session (`importMediaUploadService.js`
 *     `handleImportComplete` step 7 and its catch, verified). The id is
 *     therefore not burned at all — it is STAGED — and the only call the file
 *     still owes is the settle. Rebinding there made the end-of-run pass
 *     re-extract, re-encrypt and re-upload the whole file, leaving two copies
 *     of it counted against the member's member-wide staged ceiling until the
 *     24 h sweep. So that one refusal keeps its `media_id` and records the
 *     (item, ordinal) in {@link ImportMediaRun.stagedComplete} instead.
 *
 * ## Handling classes
 *
 * `entry_id`, `media_id`, `import_id`, the staging path and the member's dates
 * never reach a log, a thrown message or telemetry: this module makes no log
 * call at all (the `meta-import-no-content-logging` invariant). The only label
 * that is persisted or uploaded is `extractImageEntry`'s post-extract
 * `contentType`, never `source_file` and never the archive's own file name.
 */

import { markMediaUploaded, replaceMediaId } from '../../database/repositories/importRepository';
import { generateUUID } from '../../utils/uuid';
// The media-complete route's own client, shared with the ordinary upload path
// rather than duplicated beside the six JSON routes in `api/imports.ts`: it is
// ONE route, `POST /api/imports/:importId/media/complete`, and a second client
// function for it would be a second place for its contract to drift.
import { completeImportUpload } from '../api/media';
import { isUploadCancellation, uploadMedia } from '../mediaUploadService';

import type { PendingImportItem } from '../../database/repositories/importRepository';
import type { ImportItemMediaRow } from '../../types/database';
import type { ImportRefusal } from '../api/errors';
import type { ArchiveExtractOutcome, ArchiveImportSession } from './archiveAccess';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Which import media route a rethrown failure came from (§4.7).
 *
 * The taxonomy treats the two differently in exactly two places — an
 * `IMPORT_ALLOWANCE_EXCEEDED` is soft on the chunk route and closes the
 * session at media complete, and the network ladder is skipped on the chunk
 * route — so the distinction is carried rather than guessed at the call site.
 */
export type ImportMediaStage = 'media-chunk' | 'media-complete';

/**
 * Why one item's media could not be imported, as stored in
 * `import_items.error_code`.
 *
 * TWO VOCABULARIES, deliberately, both named by the plan:
 *
 *  - `IMPORT_MEDIA_*` are this runner's own codes for "the archive could not
 *    give us these bytes" (§4.10).
 *  - `image_too_large` / `unsupported_image_format` are `SkipReason` spellings
 *    (`metaImport/types.ts`), reused verbatim because the sanitizer's refusal
 *    is the SAME user-visible fact the parser's pre-pass reports under those
 *    names — discovered later, at upload time. #928 already owns copy for
 *    them, and both classify as `permanent`.
 */
export type ImportMediaFailureCode =
  /** The entry could not be extracted, or was extracted and changed underneath us. */
  | 'IMPORT_MEDIA_UNAVAILABLE'
  /** The server or this device refused the file type; nothing to retry. */
  | 'IMPORT_MEDIA_UNSUPPORTED'
  /** `ImageSanitizeError('too-many-pixels')` — over the pixel or strip ceiling. */
  | 'image_too_large'
  /** `ImageSanitizeError('unsupported-format')` — no decoder on this device. */
  | 'unsupported_image_format';

/**
 * What one item's media pipeline settled to.
 *
 * `uploaded` is the ONLY arm that makes the item batch-eligible (§4.10.6).
 */
export type ImportMediaOutcome =
  /** Every ordinal is on the server. */
  | { readonly kind: 'uploaded' }
  /**
   * A post-extract `ENTRY_IS_VIDEO`: the whole post is HELD, never failed.
   *
   * Reachable even for an entry #925's pre-pass classified as an image — the
   * head peek and the real inflation are two different reads — and the issue's
   * AC reports held video separately from failures, so the runner increments
   * its held counter and leaves the item alone.
   */
  | { readonly kind: 'held-video' }
  /** Permanent for this item: `applyBatchResults` writes `code`. */
  | { readonly kind: 'item-failed'; readonly code: ImportMediaFailureCode }
  /**
   * The run was reset or aborted. NOTHING was written and nothing may be:
   * rule 0 (§4.7) collapses every verdict to this one, including the writes
   * this module would otherwise have made.
   */
  | { readonly kind: 'cancelled' }
  /**
   * The one permitted fresh-`media_id` rebind has been spent and the file
   * failed again in the only way a fresh id could have fixed.
   *
   * The runner maps this to `job-terminal('FORBIDDEN')` (§4.7): per C4 a 403
   * on an import media route has three indistinguishable causes, and a fresh
   * id is the only text-free disambiguation there is. `error` is the raw
   * second failure, for classification and telemetry — never re-rendered.
   */
  | {
      readonly kind: 'fresh-id-exhausted';
      readonly stage: ImportMediaStage;
      readonly error: unknown;
    }
  /**
   * The server refused this upload AFTER accepting a chunk, for a reason that
   * is about the RUN or the ORBIT rather than the `media_id`: an
   * `IMPORT_QUOTA_EXCEEDED` at media complete, an `IMPORT_ALLOWANCE_EXCEEDED`
   * at either route, an `IMPORT_CLOSED`.
   *
   * The id has already been rebound (`replaceMediaId`), so the row is
   * re-uploadable under a fresh id whenever the run gets there — with the ONE
   * exception the module header spells out: a media-complete
   * `IMPORT_QUOTA_EXCEEDED` keeps its id and its staged chunks, and is settled
   * by a complete-only call on the end-of-run pass. Either way nothing here
   * retries it. `error` is the UNWRAPPED cause, for
   * `classifyImportFailure(error, {stage, …})`, whose answer is park-file,
   * `job-terminal('ALLOWANCE')`, `session-restart` or a pause. It is never
   * re-rendered and never logged.
   */
  | {
      readonly kind: 'refused';
      readonly stage: ImportMediaStage;
      readonly error: unknown;
    };

/** Everything the pipeline needs from the live run. */
export interface ImportMediaRun {
  /** The OPEN server session's id. */
  readonly importId: string;
  /** Must name the same orbit as `importId`'s session (the server checks). */
  readonly groupId: string;
  /** The live archive session. Re-opened lazily by the runner on resume. */
  readonly session: ArchiveImportSession;
  /** Aborted by `resetImportRunnerState`, which is what runs the `finally`s. */
  readonly signal: AbortSignal;
  /**
   * Rule 0 (§4.7): `false` once this run's token is stale.
   *
   * Re-checked before EVERY `importRepository` write in this file, not once at
   * the top: `localWipe` awaits between its phase 1 and `deleteAllImportJobs`,
   * so an in-flight continuation really is scheduled in that window.
   */
  isCurrentRun(): boolean;
  /**
   * `${itemId}:${ordinal}` for every row whose chunks are ALL on the server
   * under the row's current `media_id`, with only the media-complete call left
   * to make.
   *
   * Exactly one refusal puts a key here — `IMPORT_QUOTA_EXCEEDED` at media
   * complete, which keeps the temp row, its chunks and the session (see the
   * module header, rule 2) — and the end-of-run pass is what reads it: the key
   * turns a whole re-upload into the single call the file is actually missing.
   *
   * Owned by the RUN and never persisted. Every staged row is bound to one
   * server session, so the runner drops the whole set wherever it restarts
   * that session, and a later launch re-uploads from scratch (the old session's
   * temp row answers the chunk route 403, which this file rebinds).
   *
   * `media_id` is deliberately not part of the key: the row's own id is what
   * the retry settles, and a key that carried it would miss the row after any
   * rebind.
   */
  readonly stagedComplete: Set<string>;
  /** Seam for tests. Production mints ids only with `generateUUID` (#921). */
  newMediaId?(): string;
}

// ---------------------------------------------------------------------------
// declared_bytes headroom (§4.5, from the #992 review)
// ---------------------------------------------------------------------------

/**
 * The archive reader's image entry cap, 50 MiB
 * (`rust/orbital_archive_reader/src/limits.rs` `KIND_CAPS`).
 *
 * `ArchiveEntry.declaredSize` is the ZIP central directory's uncompressed
 * size: unvalidated, export-controlled, and overstatable by a crafted archive.
 * Clamping each item to the cap is what stops one lying record from inflating
 * the whole estimate without bound (§4.5.2).
 */
export const ARCHIVE_IMAGE_ENTRY_MAX_BYTES = 50 * 1024 * 1024;

/**
 * Re-encode headroom for one imported image.
 *
 * The import path forces a q0.9 re-encode (#918), and re-compressing an
 * already-compressed export JPEG at that quality can produce MORE bytes than
 * it consumed — Meta's exports are already compressed and mostly inside the
 * 2048 px cap, so most of them are never downscaled to pay for it.
 *
 * 1.5 is a bound, not a measurement, and the direction is chosen on purpose.
 * Under-declaring is what hurts: `bytes_used` settles on the MEASURED
 * ciphertext at media complete, and an overrun of the 2 GiB lifetime ceiling
 * there closes the session hard
 * (`importService.js` `lockAllowanceForMediaBytes`, verified). Over-declaring
 * only costs reservation headroom at start, and a reference ~94 MB Instagram
 * export estimates at ~141 MB — about 7% of the ceiling — so the margin cannot
 * by itself turn a legitimate archive into a preflight refusal.
 */
export const IMPORT_REENCODE_HEADROOM = 1.5;

/**
 * Per-file AES-256-CBC + HMAC framing: IV(16) + up to 16 bytes of PKCS7 pad +
 * HMAC(32). The server charges the ciphertext, not the plaintext.
 */
export const IMPORT_CIPHERTEXT_OVERHEAD_BYTES = 64;

/**
 * Estimated committed bytes for ONE imported media entry, for `declared_bytes`
 * (#926 §4.5, owned here because the formula is a property of this pipeline).
 *
 * `estimateImportBytes(entry.declaredSize)`, summed over the media of
 * importable posts whose `entry.skip === null`, is the preflight estimate. Held
 * posts contribute nothing (#921): they are never submitted.
 *
 * The formula is `ceil(min(declaredSize, 50 MiB) * 1.5) + 64`: clamp the
 * unvalidated declared size, add re-encode headroom, add the ciphertext
 * framing. A non-finite or non-positive input contributes the framing alone,
 * so a garbled central-directory record can neither inflate the sum nor make
 * it negative.
 */
export function estimateImportBytes(declaredSize: number): number {
  if (!Number.isFinite(declaredSize) || declaredSize <= 0) {
    return IMPORT_CIPHERTEXT_OVERHEAD_BYTES;
  }
  const clamped = Math.min(declaredSize, ARCHIVE_IMAGE_ENTRY_MAX_BYTES);
  return Math.ceil(clamped * IMPORT_REENCODE_HEADROOM) + IMPORT_CIPHERTEXT_OVERHEAD_BYTES;
}

// ---------------------------------------------------------------------------
// Error shapes, matched by NAME
// ---------------------------------------------------------------------------
//
// Every check below reads `e.name` (and a prod-retained field) rather than
// using `instanceof`. That is the repo's standing rule for errors whose module
// a suite may replace with a factory mock — `mediaUploadService` is exactly
// such a module here — and it is also what keeps this file from importing the
// upload service's class table just to compare against it.

/** `name` of an error object, or undefined for anything that is not one. */
function nameOf(e: unknown): string | undefined {
  if (e === null || typeof e !== 'object') return undefined;
  const name = (e as { name?: unknown }).name;
  return typeof name === 'string' ? name : undefined;
}

/** The `ImportRefusal` a 409 `IMPORT_REFUSED` carries, if this is one. */
function refusalOf(e: unknown): ImportRefusal | undefined {
  if (e === null || typeof e !== 'object') return undefined;
  const refusal = (e as { importRefusal?: unknown }).importRefusal;
  return refusal !== null && typeof refusal === 'object' ? (refusal as ImportRefusal) : undefined;
}

/** HTTP status of an `ApiError`, or undefined. */
function statusOf(e: unknown): number | undefined {
  if (e === null || typeof e !== 'object') return undefined;
  const status = (e as { statusCode?: unknown }).statusCode;
  return typeof status === 'number' ? status : undefined;
}

/**
 * The typed error an `ImportMediaStagedError` wrapped, or `undefined` for
 * anything that is not one.
 *
 * The ONE owner of that unwrap. It lives here rather than in `importErrors`
 * because this file is the only caller — the taxonomy never sees the wrapper,
 * since every path below either spends the rebind or reports the cause — and
 * because `importErrors` reaches `importCrypto` → `useAppStore` → MMKV, a
 * module graph this file and its suite must stay out of.
 *
 * The wrapper means "a chunk was accepted under this `media_id`, so the id is
 * burned". It says nothing about WHY, which is why the cause is what every
 * decision below is made on.
 */
function stagedUploadCause(e: unknown): unknown {
  if (nameOf(e) !== 'ImportMediaStagedError') return undefined;
  return (e as { cause?: unknown }).cause;
}

/**
 * The item-level code for a sanitizer refusal, or undefined when the error is
 * not one.
 *
 * `reason` is `ImageSanitizeError`'s closed union, so the two mapped arms are
 * exhaustive today; an unrecognised future reason still fails the item rather
 * than escaping as an unclassifiable run failure.
 */
function sanitizeFailureCode(e: unknown): ImportMediaFailureCode | undefined {
  if (nameOf(e) !== 'ImageSanitizeError') return undefined;
  const reason = (e as { reason?: unknown }).reason;
  if (reason === 'too-many-pixels') return 'image_too_large';
  if (reason === 'unsupported-format') return 'unsupported_image_format';
  return 'IMPORT_MEDIA_UNSUPPORTED';
}

/**
 * The item-level code for a refusal of THIS FILE, or undefined when the
 * failure is about the run and belongs to `classifyImportFailure`.
 *
 *  - `ImportMediaUnsupportedError`: `uploadMedia` refused before any work
 *    (video, which the extract table should already have held).
 *  - `ValidationError` with reason `IMPORT_MEDIA_TYPE_UNSUPPORTED`: the server
 *    refused the content type. Terminal for the file, never for the run
 *    (§1.4). Other `ValidationError` reasons are NOT mapped here — a shape or
 *    class refusal is a client bug with its own ≥3 → `CLIENT_BUG` ladder.
 */
function fileRefusalCode(e: unknown): ImportMediaFailureCode | undefined {
  const sanitize = sanitizeFailureCode(e);
  if (sanitize !== undefined) return sanitize;
  if (nameOf(e) === 'ImportMediaUnsupportedError') return 'IMPORT_MEDIA_UNSUPPORTED';
  if (
    nameOf(e) === 'ValidationError' &&
    (e as { reason?: unknown }).reason === 'IMPORT_MEDIA_TYPE_UNSUPPORTED'
  ) {
    return 'IMPORT_MEDIA_UNSUPPORTED';
  }
  return undefined;
}

/**
 * True when this failure is about the `media_id` BINDING — the one class a
 * fresh id can actually fix, and therefore the only class retried in place.
 *
 *  - A 403 on a media route: per C4 it is another member's temp row, a row
 *    bound to a different session, or lost membership, and no server text
 *    separates them. A fresh id resolves the first two.
 *  - A plain 409 `CONFLICT` with no `IMPORT_REFUSED` details: the media id is
 *    taken.
 *
 * Deliberately NOT here: `ImportMediaStagedError`. The wrapper says the id is
 * burned, not what went wrong — so it is unwrapped first
 * ({@link stagedUploadCause}) and this predicate is asked about its CAUSE.
 * An import refusal that arrives wrapped is rebound and reported, never
 * retried (see the module header, rule 2).
 */
function isIdBindingFailure(e: unknown): boolean {
  if (nameOf(e) === 'AuthError' && statusOf(e) === 403) return true;
  if (nameOf(e) === 'ConflictError' && refusalOf(e) === undefined) return true;
  return false;
}

/**
 * Which stage to classify a rethrown media failure under (§4.7).
 *
 * `uploadMedia` runs the chunk loop and the complete call behind ONE promise
 * and does not report which one rejected, so the stage is read off the error
 * itself — positively where the server's own details distinguish the routes,
 * and conservatively otherwise:
 *
 *  - `IMPORT_ALLOWANCE_EXCEEDED` with `stagedBytes`/`projectedBytes` is the
 *    CHUNK ceiling (`assertChunkAllowanceCeiling`, which sends both); the same
 *    code with neither is `lockAllowanceForMediaBytes` at media complete,
 *    which sends `allowance` alone and has already closed the session. Both
 *    verified in `importService.js`.
 *  - `IMPORT_QUOTA_EXCEEDED` with `sizeBytes` is `assertImportQuotaForMediaBytes`,
 *    which exists only on the complete path (the chunk route takes no quota
 *    lock at all).
 *  - Everything else defaults to `media-chunk`, which is the conservative
 *    answer: that stage has NO outer retry ladder, so defaulting there can
 *    never add a retry that re-extracts, re-sanitizes and re-encrypts a whole
 *    file. A complete-stage failure mis-stamped `media-chunk` still reaches
 *    the same pause, one ladder short.
 *
 * `ImportMediaStagedError` is unwrapped first ({@link stagedUploadCause}): it
 * is a wrapper this client adds, and the server's details are on its cause.
 * Callers that have already unwrapped may pass the cause itself.
 */
export function importMediaStage(e: unknown): ImportMediaStage {
  const cause = stagedUploadCause(e);
  const refusal = refusalOf(cause === undefined ? e : cause);
  if (refusal !== undefined) {
    if (refusal.code === 'IMPORT_ALLOWANCE_EXCEEDED') {
      return refusal.stagedBytes === undefined && refusal.projectedBytes === undefined
        ? 'media-complete'
        : 'media-chunk';
    }
    if (refusal.code === 'IMPORT_QUOTA_EXCEEDED' && refusal.sizeBytes !== undefined) {
      return 'media-complete';
    }
  }
  return 'media-chunk';
}

// ---------------------------------------------------------------------------
// The pipeline
// ---------------------------------------------------------------------------

/** Outcomes that stop the item: everything except a finished ordinal. */
const UPLOADED: ImportMediaOutcome = { kind: 'uploaded' };
const CANCELLED: ImportMediaOutcome = { kind: 'cancelled' };

/** Rule 0 plus the abort check, in the one place both are asked. */
function stopped(run: ImportMediaRun): boolean {
  return run.signal.aborted || !run.isCurrentRun();
}

/**
 * The upload's file name, built from OUR ids and the sniffed type.
 *
 * Never from the archive: `source_file` is LOCAL-UI-class (F18) and must not
 * reach the encrypted envelope, which is append-only once posted.
 * `uploadMedia` re-labels the extension to match the bytes the sanitizer
 * actually wrote, so this is a canonical starting point, not a claim.
 */
export function importMediaFileName(mediaId: string, contentType: string): string {
  return `${mediaId}.${contentType === 'image/png' ? 'png' : 'jpg'}`;
}

/**
 * Epoch-ms date for the envelope, with the precedence `ImportMetaV1` pins: a
 * media item's own date wins, falling back to the post's.
 *
 * Narrowed to a safe integer because `uploadMedia` rejects anything else with
 * a plain `Error` that the taxonomy cannot classify — one poisoned row would
 * then stop the whole archive. `importRepository` already binds only safe
 * integers, so this is defence in depth; a value that fails it contributes NO
 * date rather than a substituted one (fabricating provenance would seal a
 * false date into an append-only envelope).
 */
function envelopeDate(media: ImportItemMediaRow, item: PendingImportItem): number | null {
  const date = media.original_date ?? item.original_date;
  return date !== null && Number.isSafeInteger(date) ? date : null;
}

/**
 * Extract one entry, allowing ONE bounded re-extract for `ENTRY_CORRUPT`.
 *
 * `ENTRY_CORRUPT` out of `extractImageEntry` is the re-stat disagreeing with
 * the staged size — the reaper, a wipe or another writer moved underneath us —
 * so a second attempt is worth exactly one try. Every other skip is a settled
 * fact about the entry and is never retried.
 *
 * Archive-wide failures (`ARCHIVE_BUSY`, `ARCHIVE_READ_FAILED`,
 * `ARCHIVE_SESSION_CLOSED`, …) are THROWN by the session and propagate: they
 * are run-level, with their own ladders and pauses in §4.3.1.
 */
async function extractWithOneRetry(
  run: ImportMediaRun,
  entryId: string,
): Promise<ArchiveExtractOutcome> {
  const first = await run.session.extractImageEntry(entryId, { signal: run.signal });
  if (first.ok || first.skip !== 'ENTRY_CORRUPT') return first;
  return run.session.extractImageEntry(entryId, { signal: run.signal });
}

/** The skip table of §4.10.2, as the one place a skip code becomes a verdict. */
function skipOutcome(skip: string): ImportMediaOutcome {
  if (skip === 'ENTRY_IS_VIDEO') return { kind: 'held-video' };
  return { kind: 'item-failed', code: 'IMPORT_MEDIA_UNAVAILABLE' };
}

/** The {@link ImportMediaRun.stagedComplete} key for one (item, ordinal). */
function stagedKey(itemId: string, ordinal: number): string {
  return `${itemId}:${ordinal}`;
}

/**
 * Settle a row the server already holds every chunk of: ONE call, no extract,
 * no sanitize, no re-encrypt, no bytes.
 *
 * Reached only for a key the quota park left in `stagedComplete`, i.e. on the
 * end-of-run pass. The wire contract is the same one `uploadMedia` ends on —
 * `POST /api/imports/:importId/media/complete` with `{media_id}`, 201 on the
 * settle and 200 on the idempotent repeat, both of which mean the bytes are
 * committed and the ordinal is done.
 *
 * `'rebind'` is the one answer that is not an outcome: the server has proved
 * the staged row is NOT there to settle, so the caller mints a fresh id and
 * uploads the file the long way.
 */
async function completeStagedOrdinal(
  item: PendingImportItem,
  media: ImportItemMediaRow,
  run: ImportMediaRun,
  key: string,
): Promise<ImportMediaOutcome | 'rebind'> {
  try {
    await completeImportUpload(run.importId, media.media_id);
  } catch (e) {
    if (run.signal.aborted || isUploadCancellation(e)) return CANCELLED;

    // The row this key stood for is gone, or was never this session's. All
    // three shapes are verified in `handleImportComplete`: a 404 when neither
    // a temp row nor our own media row exists, the 403 of the symmetric
    // import_id/user binding, and the bare 409 of an upload that was torn down
    // and restarted. None of them is settleable, so re-upload from scratch.
    if (nameOf(e) === 'NotFoundError' || isIdBindingFailure(e)) {
      run.stagedComplete.delete(key);
      return 'rebind';
    }

    const refusal = refusalOf(e);
    if (refusal !== undefined) {
      if (refusal.code !== 'IMPORT_QUOTA_EXCEEDED') {
        // Every other import refusal has taken the row with it: the allowance
        // overrun COMMITS the temp row's deletion and closes the session, and a
        // closed session will never accept this id again. Rebind now, so that
        // whatever the runner decides next is looking at a row that can be
        // re-uploaded rather than one pointing at bytes nobody can settle.
        run.stagedComplete.delete(key);
        if (stopped(run)) return CANCELLED;
        replaceMediaId(item.id, media.ordinal, (run.newMediaId ?? generateUUID)());
      }
      // A SECOND `IMPORT_QUOTA_EXCEEDED` keeps both the id and the key: the
      // runner is in its end-of-run pass, where the taxonomy answers
      // `item-failed('QUOTA')` rather than another park.
      return { kind: 'refused', stage: 'media-complete', error: e };
    }

    // Network, a 429, a 5xx, a shape refusal: the taxonomy owns every one of
    // them, and the row stays staged — nothing consumed it, so a later pass
    // through here is still one call away from settling it.
    throw e;
  }

  run.stagedComplete.delete(key);
  // Rule 0 as everywhere else: the bytes are committed, but a reset run writes
  // nothing. The next run re-reads the row and re-uploads.
  if (stopped(run)) return CANCELLED;
  markMediaUploaded(item.id, media.ordinal);
  return UPLOADED;
}

/**
 * One (item, ordinal): extract → upload → mark, with at most one fresh-id
 * rebind.
 *
 * The loop body runs at most twice, and the second pass exists only for an
 * id-BINDING failure (403, a bare 409) — the one class a fresh id can fix. It
 * re-extracts deliberately: the staging file was released in the first pass's
 * `finally`, and a staging path is only valid until the next reaper pass
 * anyway.
 *
 * A row the quota park left STAGED skips all of that on its first pass: the
 * bytes are already on the server, so the only call owed is the settle
 * ({@link completeStagedOrdinal}). The upload path below is re-entered from
 * there only if that call proves the staged row is gone, which spends the one
 * rebind the same way an id-binding failure would.
 */
async function uploadOneOrdinal(
  item: PendingImportItem,
  media: ImportItemMediaRow,
  run: ImportMediaRun,
): Promise<ImportMediaOutcome> {
  const mintId = run.newMediaId ?? generateUUID;
  let mediaId = media.media_id;
  const key = stagedKey(item.id, media.ordinal);

  for (let attempt = 0; attempt < 2; attempt++) {
    if (stopped(run)) return CANCELLED;

    if (run.stagedComplete.has(key)) {
      const settled = await completeStagedOrdinal(item, media, run, key);
      if (settled !== 'rebind') return settled;
      if (stopped(run)) return CANCELLED;
      // Not settleable: the staged row is gone, so this is a fresh upload of
      // the whole file and it needs an id nothing is bound to.
      mediaId = mintId();
      replaceMediaId(item.id, media.ordinal, mediaId);
    }

    const extracted = await extractWithOneRetry(run, media.entry_id);
    if (!extracted.ok) return skipOutcome(extracted.skip);

    let failure: unknown;
    try {
      if (stopped(run)) return CANCELLED;
      await uploadMedia({
        fileUri: `file://${extracted.path}`,
        // The post-extract sniff: the only label that may be uploaded.
        mimeType: extracted.contentType,
        fileName: importMediaFileName(mediaId, extracted.contentType),
        groupId: run.groupId,
        importOriginalCreatedAt: envelopeDate(media, item),
        // The caller-supplied id, reused across uploadMedia's OWN retries and
        // replaced here (never reused) once a chunk has been accepted.
        import: { importId: run.importId, mediaId, contentClass: 'image' },
        signal: run.signal,
      });
    } catch (e) {
      failure = e;
    } finally {
      // EXACTLY ONCE, on every path including abort and including the throw
      // below: `release()` is the only unlink of the extracted plaintext.
      extracted.release();
    }

    if (failure === undefined) {
      // Rule 0 again: the bytes are on the server, but a reset run must write
      // nothing at all. The next run re-reads the row and re-uploads; the
      // staged bytes under the old id are the server's to GC.
      if (stopped(run)) return CANCELLED;
      markMediaUploaded(item.id, media.ordinal);
      return UPLOADED;
    }

    // ONE unwrap, in one place: after an accepted chunk every failure arrives
    // wrapped, and the wrapper's `name` says only that the id is burned. Every
    // question below is asked about the CAUSE.
    const stagedCause = stagedUploadCause(failure);
    const staged = stagedCause !== undefined;
    const cause = staged ? stagedCause : failure;

    if (run.signal.aborted || isUploadCancellation(cause)) return CANCELLED;

    const code = fileRefusalCode(cause);
    // Permanent for the file whether or not an id was burned: a failed item is
    // never re-submitted, so there is nothing to rebind for.
    if (code !== undefined) return { kind: 'item-failed', code };

    if (isIdBindingFailure(cause)) {
      if (attempt > 0) {
        // The one rebind is spent and the file failed the same way again.
        return {
          kind: 'fresh-id-exhausted',
          stage: importMediaStage(cause),
          error: cause,
        };
      }

      if (stopped(run)) return CANCELLED;
      mediaId = mintId();
      // Resets `upload_state` to `pending`, so a crash between here and the
      // retry leaves the row re-uploadable under the NEW id.
      replaceMediaId(item.id, media.ordinal, mediaId);
      continue;
    }

    // About the RUN, and no chunk was accepted: the runner's taxonomy owns it
    // and a wrapper here would hide the class it matches on.
    if (!staged) throw cause;

    if (stopped(run)) return CANCELLED;

    const stage = importMediaStage(cause);
    if (stage === 'media-complete' && refusalOf(cause)?.code === 'IMPORT_QUOTA_EXCEEDED') {
      // The orbit was full at media complete, the one refusal that keeps the
      // temp row, every chunk file and the session (module header, rule 2). The
      // id is STAGED rather than burned: record the settle it still owes and
      // leave the row alone. Rebinding here is what made the end-of-run pass
      // re-upload the whole file, with both copies counted against the member's
      // member-wide staged ceiling until the 24 h sweep.
      run.stagedComplete.add(key);
      return { kind: 'refused', stage, error: cause };
    }

    // The id IS burned, so the row must point at a fresh one before anybody
    // re-uploads it — but WHEN that happens is the runner's call, and for an
    // orbit that is full or an allowance that is spent it must not be now.
    replaceMediaId(item.id, media.ordinal, mintId());
    return { kind: 'refused', stage, error: cause };
  }

  // Unreachable: the loop either returns or throws on both passes. Returning
  // `cancelled` rather than falling off the end keeps the function total.
  return CANCELLED;
}

/**
 * Upload every not-yet-uploaded media item of one post, in `ordinal` order.
 *
 * Stops at the FIRST non-`uploaded` outcome: an item is batch-eligible only
 * when every ordinal is uploaded (§4.10.6), so there is nothing to gain from
 * uploading the rest of a post that is already held or failed — and bytes
 * uploaded for an item that is never submitted are charged to the member's
 * lifetime allowance and never refunded.
 *
 * A text-only post (`item.media` empty) resolves `uploaded` without touching
 * the archive, which is what lets a text-only tail resume with no archive
 * session at all.
 *
 * @returns the item's media verdict. `uploaded` is the only arm that makes the
 *   item submittable; see {@link ImportMediaOutcome} for what the runner does
 *   with the others. Anything NOT in that union is rethrown raw — classify it
 *   with `classifyImportFailure(e, {stage: importMediaStage(e), …})`.
 */
export async function uploadImportItemMedia(
  item: PendingImportItem,
  run: ImportMediaRun,
): Promise<ImportMediaOutcome> {
  // Sorted here rather than trusted: `getPendingImportItems` orders by
  // ordinal, but the envelope's media order is what #927 renders and a caller
  // assembling rows by hand must not be able to change it.
  const media = [...item.media].sort((a, b) => a.ordinal - b.ordinal);

  for (const row of media) {
    // The request-saving cache (#921): already on the server under this id,
    // with its envelope and attachment key, so re-uploading would pay twice
    // for nothing.
    if (row.upload_state === 'uploaded') continue;

    const outcome = await uploadOneOrdinal(item, row, run);
    if (outcome.kind !== 'uploaded') return outcome;
  }

  return UPLOADED;
}
