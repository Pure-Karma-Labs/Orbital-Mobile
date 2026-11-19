/**
 * The Meta-import failure taxonomy (#926 §4.7) — PURE and SILENT.
 *
 * ## The contract the runner (#926 B3) relies on
 *
 * `classifyImportFailure(e, ctx)` is a total function from (error, context) to
 * one {@link ImportVerdict}. It has no side effects, no state, no clock of its
 * own (pass `ctx.nowMs` to pin `pause.untilMs`), and **zero log, breadcrumb or
 * Sentry calls** — it is on `ME_SILENT_FILES` in the security-invariant
 * screen, because every error it inspects may carry a staging path, an entry
 * id or a post body in its message. Nothing it returns is a string the server
 * wrote: the verdict codes are the two frozen client registries below.
 *
 * Retry BUDGETS and timer LADDERS are the runner's, not this module's: the
 * classifier is told how many attempts a stage has already spent
 * (`ctx.stageAttempt`, `ctx.busyAttempt`) and answers `retry-same-call` with
 * the delay for THAT attempt, or `pause` once the budget is gone. That keeps
 * every "how long do we wait" number in one table ({@link
 * NETWORK_STAGE_LADDER_MS} and friends) while the counting stays where the
 * loop is.
 *
 * ## Rule 0 — the run token comes first
 *
 * {@link isRunStale} is checked here before anything else is inspected, and
 * the runner MUST check it again immediately before every `importRepository`
 * write (`importBatch`'s writers do exactly that). When the run has been reset
 * — `resetImportRunnerState` from `localWipe`/`keyRecovery`, or a user cancel
 * — EVERY verdict collapses to `cancelled`: no job write, no `finishImportJob`,
 * no telemetry. This is what keeps an ordinary logout from writing `failed`
 * and capturing a Sentry event: `closeAllImportKeySessions()` and
 * `abortAllArchiveSessions()` both run above our reset and raise errors that
 * would otherwise classify `terminal-for-run`.
 *
 * ## Why cancellation is matched structurally
 *
 * `isUploadCancellation` lives in `mediaUploadService`, whose module graph
 * reaches `contentCrypto` → `useAppStore` → MMKV/nitro: importing it here
 * would drag that chain into every suite that touches the taxonomy (§4.16
 * "Mock locations" allows matching on shape for exactly this reason). So the
 * two cancellation shapes are matched directly — the shared
 * `UPLOAD_CANCELLED_MESSAGE` sentinel from its zero-import leaf module, and
 * the `code === 'ECANCELLED'` form that `isCancellation` (transcoder) and
 * `isArchiveCancellation` (archive reader) both answer to. The sentinel is
 * IMPORTED, never re-spelled, so the two can never drift.
 */

import { ARCHIVE_ERROR_DISPOSITIONS } from './archiveAccess';
import {
  AuthError,
  ConflictError,
  NetworkError,
  NotFoundError,
  QuotaExceededError,
  RateLimitError,
  ServerError,
  ValidationError,
} from '../api/errors';
import { classifyImportCryptoError } from '../crypto/importCrypto';
import { UPLOAD_CANCELLED_MESSAGE } from '../media/uploadCancellation';

import type { ArchiveErrorCode } from './archiveAccess';
import type { ImportSource } from './types';

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/**
 * Where the failure happened. The same error means different things per stage:
 * a 403 on a media route is a re-mintable binding, a 403 on the batch route is
 * lost membership.
 */
export type ImportStage =
  'start' | 'batch' | 'media-chunk' | 'media-complete' | 'complete' | 'archive' | 'crypto';

/**
 * The pause set (§4.3.1), in precedence order. Declared HERE rather than in
 * the runner because the classifier is the only producer of six of the seven —
 * `background` is AppState's and is never a verdict.
 *
 * `allowance_wait` is the chunk-route `IMPORT_ALLOWANCE_EXCEEDED` wait and
 * nothing else. It is its own cause rather than a `network` pause with a
 * deadline because the two differ in every way that matters to the loop: it is
 * not a failure to reach the server, the foreground wake-up must not shorten
 * it, and its budget is small and ends in `ALLOWANCE` rather than `NETWORK`.
 * Re-using `network` for it is what let a persistent refusal retry forever
 * (#993 fold round, blocker 3).
 */
export type PauseCause =
  | 'needs_repick'
  | 'key_pending'
  | 'archive_retry'
  | 'rate_limited'
  | 'allowance_wait'
  | 'network'
  | 'background';

/** The causes a verdict can carry. */
export type ClassifiedPauseCause = Exclude<PauseCause, 'background'>;

/**
 * Per-ITEM failure codes this client writes to `import_items.error_code`.
 *
 * Frozen and client-defined: these never come from the server (the server's
 * three per-item codes are `IMPORT_ITEM_CODES` in `./importBatch`), so a
 * widened server vocabulary can never reach the member-facing copy in
 * `src/screens/import/importCopy.ts` through here.
 * `QUOTA` is the one that is not permanent — the orbit was full at media
 * complete, and importing again later can succeed.
 *
 * `IMPORT_MEDIA_TOO_LARGE` is kept APART from `IMPORT_MEDIA_UNSUPPORTED`
 * (#928 gap 8) because the two are different facts to the member — a photo
 * over the pixel ceiling versus a format this device has no decoder for — and
 * #918's D12 requires the first to have its own copy. Folding them lost that
 * copy before it could ever be shown.
 */
export const IMPORT_ITEM_FAILURE_CODES = Object.freeze({
  IMPORT_ITEM_INVALID: 1,
  IMPORT_ITEM_TOO_LARGE: 1,
  IMPORT_MEDIA_UNSUPPORTED: 1,
  IMPORT_MEDIA_TOO_LARGE: 1,
  IMPORT_MEDIA_UNAVAILABLE: 1,
  QUOTA: 1,
});

export type ImportItemFailureCode = keyof typeof IMPORT_ITEM_FAILURE_CODES;

/**
 * Run-terminal codes — `ImportSummary.errorCode` and the `import_code` Sentry
 * tag. Client enums, never server text.
 *
 * `KEY_PENDING`, `NETWORK` and `ARCHIVE` are raised by the RUNNER when a pause
 * budget is exhausted (§4.3.1), not only by the classifier — as is `ALLOWANCE`,
 * when the `allowance_wait` budget runs out. They live in the same registry
 * because they end up in the same field.
 */
export const IMPORT_TERMINAL_CODES = Object.freeze({
  ALLOWANCE: 1,
  ARCHIVE: 1,
  AUTH: 1,
  CLIENT_BUG: 1,
  CRYPTO: 1,
  FORBIDDEN: 1,
  IMPORTS_UNAVAILABLE: 1,
  KEY_PENDING: 1,
  NETWORK: 1,
  ORBIT_FULL: 1,
  /**
   * The member has an open import of the OTHER source in this orbit (#996).
   *
   * Raised by the RUNNER, never by the classifier: the server's refusal is
   * `IMPORT_IN_PROGRESS` either way, and only the runner knows which source
   * IT is importing. There is one open session per member per orbit across
   * sources (B#352), so this is the honest answer to "yours is busy", and
   * never a reason to adopt or to close the other session unasked.
   */
  OTHER_IMPORT_OPEN: 1,
  REFUSED: 1,
  SESSION_CLOSED: 1,
});

export type ImportTerminalCode = keyof typeof IMPORT_TERMINAL_CODES;

/**
 * What the runner should do next.
 *
 * - `cancelled` — stop, write nothing, capture nothing (rule 0).
 * - `pause` — add the cause to the pause set; `untilMs` is set only when a
 *   deadline is named (429 `Retry-After`, the soft chunk allowance's back-off)
 *   and governs the DELAY only, never the cause's budget.
 * - `retry-same-call` — the same call again after `delayMs`, no pause, no
 *   budget beyond the one the context reported.
 * - `item-failed` — this post is done; the run continues.
 * - `file-fresh-id` — mint a new `media_id` (`replaceMediaId`) and re-upload
 *   this file. Never a retry under the same id.
 * - `park-file` — leave the file for the single end-of-run `complete` pass.
 * - `batch-halve` — resubmit half the batch.
 * - `session-restart` — `POST start` again, requeue `uploading`, resubmit.
 * - `adopt-session` — the member already has an open session; take it over
 *   (`importId` is absent on the 23505 insert race → re-read the preflight).
 * - `finish-completed` — the server considers this session finished; finish
 *   locally as `completed`.
 * - `job-terminal` — the run is over with this code; created posts are kept.
 */
export type ImportVerdict =
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'pause'; readonly cause: ClassifiedPauseCause; readonly untilMs?: number }
  | { readonly kind: 'retry-same-call'; readonly delayMs: number }
  | { readonly kind: 'item-failed'; readonly code: ImportItemFailureCode }
  | { readonly kind: 'file-fresh-id' }
  | { readonly kind: 'park-file' }
  | { readonly kind: 'batch-halve' }
  | { readonly kind: 'session-restart' }
  | {
      readonly kind: 'adopt-session';
      readonly importId?: string;
      /**
       * The open session's source, when the server named it.
       *
       * The classifier stays SOURCE-BLIND: it reports what the refusal said
       * and the runner compares against its own source. Undefined means the
       * server did not say — which the runner must treat as foreign, because
       * adopting an unconfirmed session spends the wrong allowance bucket.
       */
      readonly source?: ImportSource;
    }
  | { readonly kind: 'finish-completed' }
  | { readonly kind: 'job-terminal'; readonly code: ImportTerminalCode };

// ---------------------------------------------------------------------------
// Rule 0 — the run token
// ---------------------------------------------------------------------------

/**
 * The run identity every classification and every repository write is checked
 * against.
 *
 * `currentRun` is a GETTER, not a value: the runner's token changes under an
 * await (that is the whole point of rule 0), so a snapshot taken when the
 * guard was built would be exactly the stale read this is meant to catch.
 * `signal` is the same fact from the other direction — `resetImportRunnerState`
 * aborts the controller synchronously.
 */
export interface RunGuard {
  /** The token the work was started under. */
  readonly run: number;
  /** Reads the runner's live token. Must be side-effect free. */
  readonly currentRun: () => number;
  readonly signal?: AbortSignal;
}

/** True when this work no longer belongs to the live run (rule 0). */
export function isRunStale(guard: RunGuard): boolean {
  return guard.currentRun() !== guard.run || guard.signal?.aborted === true;
}

/** Everything the classifier needs besides the error itself. */
export interface ImportFailureContext extends RunGuard {
  readonly stage: ImportStage;
  /**
   * Retries already spent at this stage on this attempt chain (0-based). Drives
   * {@link NETWORK_STAGE_LADDER_MS}; omitted means 0.
   */
  readonly stageAttempt?: number;
  /** `ARCHIVE_BUSY` in-place attempts already spent (0-based). */
  readonly busyAttempt?: number;
  /**
   * Items this job has already created server-side. A `requires-repick`
   * archive error is a re-pick prompt only while this is 0 — otherwise the run
   * is terminal and the created posts are kept (§4.7, one disposition).
   */
  readonly createdItems?: number;
  /** True inside the single end-of-run retry pass for a parked file. */
  readonly endOfRunPass?: boolean;
  /**
   * `IMPORT_ITEM_INVALID`-class verdicts already returned in this run, NOT
   * counting the one being classified. The
   * {@link CLIENT_BUG_THRESHOLD}-th such verdict is itself
   * `job-terminal('CLIENT_BUG')`: three items the server calls malformed is a
   * payload bug, not bad data.
   */
  readonly clientBugCount?: number;
  /** Clock injection, so `pause.untilMs` is testable without fake timers. */
  readonly nowMs?: number;
}

// ---------------------------------------------------------------------------
// Ladders and budgets (the numbers; the counting is the runner's)
// ---------------------------------------------------------------------------

/**
 * `start`/`batch`/`media-complete`/`complete` retry in place up to three times
 * before pausing: those four calls carry no inner retry of their own.
 * `media-chunk` is NOT on this ladder — `uploadMedia` already spent its three
 * attempts, and each outer retry would re-extract, re-sanitize and re-encrypt
 * the whole file.
 */
export const NETWORK_STAGE_LADDER_MS: readonly number[] = Object.freeze([1_000, 2_000, 4_000]);

/** `ARCHIVE_BUSY` means all four Rust job slots are taken; it clears in ms. */
export const ARCHIVE_BUSY_RETRY_MS = 100;

/** After this many in-place `ARCHIVE_BUSY` retries, pause instead. */
export const ARCHIVE_BUSY_MAX_ATTEMPTS = 10;

/** What a 429 with no usable `Retry-After` is worth. */
export const DEFAULT_RATE_LIMIT_PAUSE_MS = 60_000;

/**
 * The soft chunk-route `IMPORT_ALLOWANCE_EXCEEDED` wait: the session stays
 * open, so a retry is worth making — but WAITING is not what clears it.
 *
 * `assertChunkAllowanceCeiling` sums `temp_uploads.total_size_bytes` over every
 * session the member owns in that orbit plus the settled
 * `import_allowances.bytes_used`. Those temp rows are released by an import
 * media COMPLETE (it settles the bytes and deletes the row), by a hard overrun
 * at complete (which also closes the session), by `importSessionCleanup`'s
 * hourly pass after `IMPORT_SESSION_TIMEOUT_HOURS` of total silence (6 h by
 * default), or by `mediaCleanup`'s 24 h sweep. Nothing frees them in 30 s, and
 * a refusal driven by settled `bytes_used` never clears at all.
 *
 * So this number is a BACK-OFF, not a recovery time: it is long enough not to
 * spend round trips re-learning the same refusal, and the runner's
 * `allowance_wait` budget is what makes the wait terminate.
 */
export const CHUNK_ALLOWANCE_PAUSE_MS = 30_000;

/**
 * The item-invalid verdict count at which the run is a client bug, not bad
 * data: the THIRD such verdict is the terminal one.
 */
export const CLIENT_BUG_THRESHOLD = 3;

// ---------------------------------------------------------------------------
// Shape predicates
// ---------------------------------------------------------------------------

/** A property read that is safe on primitives, null and cross-realm objects. */
function prop(e: unknown, key: string): unknown {
  if (typeof e !== 'object' || e === null) return undefined;
  return (e as Record<string, unknown>)[key];
}

/**
 * Both cancellation shapes, in one place: our own upload sentinel and the
 * `ECANCELLED` code that the transcoder and the archive reader share. See the
 * module header for why this is matched rather than imported.
 */
export function isImportCancellation(e: unknown): boolean {
  if (e instanceof Error && e.message === UPLOAD_CANCELLED_MESSAGE) return true;
  return prop(e, 'code') === 'ECANCELLED';
}

/**
 * A BARE 413 — the backend's JSON body parser refusing the body (since B#355
 * the batch route parses in-router after `authenticate` with a 10 MB limit;
 * the other import POSTs 100 KB; everything else under /api and /v1 1 MB),
 * which on a batch path means "halve", not "the orbit is full".
 *
 * Named rather than inlined because the distinction is invisible at the call
 * site: the import routes never 413 for a quota (they refuse with a 409
 * `IMPORT_QUOTA_EXCEEDED`), so a `QuotaExceededError` with no parsed `quota`
 * is the JSON body limit and nothing else.
 */
export function isPayloadTooLarge(e: unknown): boolean {
  return e instanceof QuotaExceededError && e.quota === undefined;
}

/** An `ArchiveReaderError`'s code, matched by `name` (§4.16 mock locations). */
function archiveErrorCode(e: unknown): ArchiveErrorCode | undefined {
  if (prop(e, 'name') !== 'ArchiveReaderError') return undefined;
  const code = prop(e, 'code');
  if (typeof code !== 'string') return undefined;
  return Object.prototype.hasOwnProperty.call(ARCHIVE_ERROR_DISPOSITIONS, code)
    ? (code as ArchiveErrorCode)
    : undefined;
}

/** Stages that belong to ONE item; a failure here can be charged to that item. */
function isItemScopedStage(stage: ImportStage): boolean {
  return (
    stage === 'batch' ||
    stage === 'media-chunk' ||
    stage === 'media-complete' ||
    stage === 'archive' ||
    stage === 'crypto'
  );
}

/** A media route, where a 403 or a plain 409 is a re-mintable id binding. */
function isMediaStage(stage: ImportStage): boolean {
  return stage === 'media-chunk' || stage === 'media-complete';
}

// ---------------------------------------------------------------------------
// Verdict constructors (so a verdict is never a bare object literal)
// ---------------------------------------------------------------------------

const CANCELLED: ImportVerdict = Object.freeze({ kind: 'cancelled' });

function pause(cause: ClassifiedPauseCause, untilMs?: number): ImportVerdict {
  return untilMs === undefined ? { kind: 'pause', cause } : { kind: 'pause', cause, untilMs };
}

function terminal(code: ImportTerminalCode): ImportVerdict {
  return { kind: 'job-terminal', code };
}

function itemFailed(code: ImportItemFailureCode): ImportVerdict {
  return { kind: 'item-failed', code };
}

/**
 * The "the payload was wrong" arm, shared by an unrecognised `ValidationError`
 * and by an error this taxonomy has no arm for at all: charge it to the item
 * while the run can still make progress, and call the run a client bug once
 * three items have gone the same way.
 */
function invalidOrClientBug(ctx: ImportFailureContext): ImportVerdict {
  if ((ctx.clientBugCount ?? 0) + 1 >= CLIENT_BUG_THRESHOLD || !isItemScopedStage(ctx.stage)) {
    return terminal('CLIENT_BUG');
  }
  return itemFailed('IMPORT_ITEM_INVALID');
}

/** `NetworkError`/`ServerError`: the per-stage ladder, then a pause. */
function networkVerdict(ctx: ImportFailureContext): ImportVerdict {
  if (ctx.stage === 'media-chunk') return pause('network');
  const attempt = ctx.stageAttempt ?? 0;
  const delayMs = NETWORK_STAGE_LADDER_MS[attempt];
  return delayMs === undefined ? pause('network') : { kind: 'retry-same-call', delayMs };
}

/** The archive reader's four dispositions, plus `ARCHIVE_BUSY`'s in-place arm. */
function archiveVerdict(code: ArchiveErrorCode, ctx: ImportFailureContext): ImportVerdict {
  if (code === 'ARCHIVE_BUSY') {
    return (ctx.busyAttempt ?? 0) < ARCHIVE_BUSY_MAX_ATTEMPTS
      ? { kind: 'retry-same-call', delayMs: ARCHIVE_BUSY_RETRY_MS }
      : pause('archive_retry');
  }
  switch (ARCHIVE_ERROR_DISPOSITIONS[code]) {
    case 'retryable-pause':
      return pause('archive_retry');
    case 'requires-repick':
      // ONE disposition for `requires-repick`, used at resume time too
      // (§4.9.5): a re-pick can only rescue a job that has created nothing,
      // because stored `entryId`s are content-derived per part.
      return (ctx.createdItems ?? 0) === 0 ? pause('needs_repick') : terminal('ARCHIVE');
    case 'user-action':
      // `ECANCELLED` was handled above; `PICKER_BUSY` belongs to the pick call
      // and can never be a running-job pause. Reaching here is a caller bug,
      // and a run that cannot read its archive is over.
      return terminal('ARCHIVE');
    default:
      return terminal('ARCHIVE');
  }
}

/** The 409 `IMPORT_REFUSED` table (§4.7), by code and stage. */
function refusalVerdict(e: ConflictError, ctx: ImportFailureContext): ImportVerdict {
  const refusal = e.importRefusal;
  if (refusal === undefined) {
    // A plain 409 with no refusal details. On a media route that is the
    // `media_id` collision (§1.4) → fresh id. Nowhere else emits one.
    return isMediaStage(ctx.stage) ? { kind: 'file-fresh-id' } : terminal('REFUSED');
  }

  switch (refusal.code) {
    case 'IMPORT_IN_PROGRESS': {
      // Both fields together or neither (B#352's 23505 arm looks the winning
      // session up and sends `{}` when it has already gone). Each is passed
      // through only when present, so the runner can tell "not stated" from
      // "stated and different".
      const adopt: { kind: 'adopt-session'; importId?: string; source?: ImportSource } = {
        kind: 'adopt-session',
      };
      if (refusal.importId !== undefined) adopt.importId = refusal.importId;
      if (refusal.source !== undefined) adopt.source = refusal.source;
      return adopt;
    }

    case 'IMPORT_CLOSED':
      if (refusal.closedStatus === 'abandoned') return { kind: 'session-restart' };
      if (refusal.closedStatus === 'completed') return { kind: 'finish-completed' };
      // `closed`, a missing status, `open` (a server bug) and a status this
      // build does not know all mean the same thing to us: this session will
      // never accept another write, and we must not invent a recovery for it.
      return terminal('SESSION_CLOSED');

    case 'IMPORT_ALLOWANCE_EXCEEDED':
      // Soft on the chunk route only: nothing is closed, so a backed-off retry
      // is worth making. Its own cause, with its own small budget, because
      // waiting is not what clears this ceiling (see
      // {@link CHUNK_ALLOWANCE_PAUSE_MS}). Everywhere else the server has
      // closed the session (§4.5.6/§4.5.7).
      return ctx.stage === 'media-chunk'
        ? pause('allowance_wait', (ctx.nowMs ?? Date.now()) + CHUNK_ALLOWANCE_PAUSE_MS)
        : terminal('ALLOWANCE');

    case 'IMPORT_QUOTA_EXCEEDED':
      // At media complete the count-vs-bytes ambiguity (F4) means "retry when
      // space frees" is not always true: park the file, retry `complete` once
      // at end of run, then charge it to the item.
      if (ctx.stage === 'media-complete') {
        return ctx.endOfRunPass === true ? itemFailed('QUOTA') : { kind: 'park-file' };
      }
      return terminal('ORBIT_FULL');

    default:
      return terminal('REFUSED');
  }
}

// ---------------------------------------------------------------------------
// The classifier
// ---------------------------------------------------------------------------

/**
 * One verdict per failure. Pure, silent, total — an error with no arm is the
 * {@link invalidOrClientBug} arm, never a throw.
 *
 * Arm order is load-bearing and follows §4.7 top to bottom: rule 0,
 * cancellation, crypto, the staged-media wrapper, the archive reader, then the
 * HTTP taxonomy. Crypto sits above the HTTP arms because a `PendingWrapError`
 * must pause rather than fail an item, and the staged-media wrapper sits above
 * the archive and HTTP arms because its verdict does not depend on what it
 * wrapped.
 */
export function classifyImportFailure(e: unknown, ctx: ImportFailureContext): ImportVerdict {
  // Rule 0 — before anything about `e` is inspected.
  if (isRunStale(ctx)) return CANCELLED;

  if (isImportCancellation(e)) return CANCELLED;

  const crypto = classifyImportCryptoError(e);
  if (crypto === 'retryable-pause') return pause('key_pending');
  if (crypto !== null) return terminal('CRYPTO');

  // The server already holds a chunk under this `media_id`, so the envelope and
  // IV it has are THIS attempt's: a retry in place would assemble two
  // ciphertexts into one undecryptable, allowance-charged blob.
  //
  // `importMedia` unwraps this wrapper itself and never rethrows it, so this
  // arm is the backstop for a wrapper that arrived with no cause to unwrap:
  // the runner's `file-fresh-id` arm charges the item and keeps the run alive,
  // which is the right answer for two layers disagreeing about a shape.
  if (prop(e, 'name') === 'ImportMediaStagedError') return { kind: 'file-fresh-id' };

  const archiveCode = archiveErrorCode(e);
  if (archiveCode !== undefined) return archiveVerdict(archiveCode, ctx);

  if (e instanceof RateLimitError) {
    const waitMs = e.retryAfterMs ?? DEFAULT_RATE_LIMIT_PAUSE_MS;
    return pause('rate_limited', (ctx.nowMs ?? Date.now()) + waitMs);
  }

  if (e instanceof ConflictError) return refusalVerdict(e, ctx);

  if (e instanceof AuthError) {
    if (e.statusCode === 401) return terminal('AUTH');
    // 403 has three indistinguishable causes on a media route (C4): another
    // user's temp row, a row bound to a different session, or lost membership.
    // One fresh id answers the first two; a second 403 means the third — and
    // the rebind BUDGET has exactly one owner, `importMedia`, which spends it
    // in place and answers `fresh-id-exhausted` when it is gone. So there is no
    // attempt count to read here: a media-stage 403 that reaches the classifier
    // at all is a shape the two layers disagree about, and the runner charges
    // that to the item rather than rebinding an id outside the one module
    // allowed to.
    if (isMediaStage(ctx.stage)) return { kind: 'file-fresh-id' };
    return terminal('FORBIDDEN');
  }

  // A flag-off server answers 404 byte-identically to an unknown session, so
  // there is nothing to distinguish and nothing to retry.
  if (e instanceof NotFoundError) return terminal('IMPORTS_UNAVAILABLE');

  if (isPayloadTooLarge(e)) {
    return ctx.stage === 'batch' ? { kind: 'batch-halve' } : terminal('REFUSED');
  }
  if (e instanceof QuotaExceededError) {
    // A 413 WITH a parsed quota is the ordinary orbit-storage refusal.
    return isMediaStage(ctx.stage) ? itemFailed('QUOTA') : terminal('ORBIT_FULL');
  }

  if (e instanceof ValidationError) {
    switch (e.reason) {
      case 'IMPORT_BATCH_TOO_LARGE':
        return { kind: 'batch-halve' };
      case 'IMPORT_MEDIA_TYPE_UNSUPPORTED':
        return itemFailed('IMPORT_MEDIA_UNSUPPORTED');
      case 'IMPORT_DECLARED_INVALID':
        // We computed `declared_posts`/`declared_bytes` ourselves, so the
        // server refusing them is our bug and no retry changes it.
        return terminal('CLIENT_BUG');
      default:
        // Includes `INVALID_CONTENT_CLASS` and every shape/multer refusal,
        // both of which arrive with `reason === undefined`.
        return invalidOrClientBug(ctx);
    }
  }

  if (e instanceof NetworkError || e instanceof ServerError) return networkVerdict(ctx);

  return invalidOrClientBug(ctx);
}
