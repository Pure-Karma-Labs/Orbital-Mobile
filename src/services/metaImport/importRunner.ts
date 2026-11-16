/**
 * importRunner — the resumable Meta import run (#926 §4.2–§4.13).
 *
 * This is the only entry point #928's screens have into the import. It owns
 * the public API, the published store, the phase machine, the pause set and
 * its wake-ups, AppState, the launch-time resume, cancellation and the wipe
 * reset. Everything below it is a step it calls and never re-derives:
 * `parseArchive` reads the archive, `importMedia` does one post's files,
 * `importBatch` builds and applies one POST, `importErrors` says what a
 * failure means, and `importRepository` is the only writer of local state.
 *
 * ## The store is a PROJECTION of SQLite
 *
 * `bulkExportStore` **is** its run — a snapshot in memory, lost on a process
 * kill. `importStore` is not: `import_jobs` / `import_items` are the truth and
 * the store is re-derived from them at launch ({@link resumeImportAtLaunch}).
 * Nothing here may decide from the store what it could decide from the
 * repository, which is why `phase` starts `'hydrating'` — orbit settings must
 * be able to tell "nothing is running" from "we have not looked yet".
 *
 * The scaffolding is deliberately IDENTICAL in shape to `bulkExportRunner`
 * (vanilla `createStore`, a 250 ms throttled emission with an
 * identity-preserving `sameState`, an immediate flush on phase / summary /
 * pause changes, AppState attached lazily, a synchronous production reset).
 * Two copies is below this project's extraction threshold; the THIRD vanilla
 * store runner extracts the shared scaffolding, and keeping this one
 * structurally the same is what makes that extraction mechanical (§4.1).
 *
 * ## Rule 0 — the run token comes first
 *
 * Every classification and every repository write re-checks that the work
 * still belongs to the live run. {@link resetImportRunnerState} bumps the
 * token and aborts the controller SYNCHRONOUSLY, after which every verdict
 * collapses to `cancelled`: no item write, no `finishImportJob`, no Sentry
 * event. That is what keeps an ordinary logout — where
 * `closeAllImportKeySessions()` and `abortAllArchiveSessions()` both run above
 * our reset, raising errors that would otherwise classify `terminal-for-run` —
 * from writing `failed` and reporting it.
 *
 * A user CANCEL is not a reset: it aborts the run's work but must still write
 * `finishImportJob(jobId, 'cancelled')` and show a summary. The two are told
 * apart by WHICH question a call site asks — {@link stopped} (token or abort,
 * for work) versus {@link wiped} (token only, for the finishing writes).
 *
 * ## No raw group key, no archive strings
 *
 * Title, body and the import-meta envelope are sealed only through
 * `ImportKeySession`, which is also the only module allowed to read the live
 * group key (ESLint forbids `contentCrypto` here outright). Nothing in this
 * file logs, throws or reports an archive path, an entry id, an import key, a
 * media id, a post body or a key fingerprint: the Sentry payload is counts and
 * closed client enums, screened by `meta-import-no-content-logging`.
 */

import { AppState, type AppStateStatus } from 'react-native';
import { createStore } from 'zustand/vanilla';

import {
  countImportItemsByStatus,
  countImportSkipsByReason,
  createImportJob,
  deleteImportJob,
  finishImportJob,
  getActiveImportJob,
  getImportJob,
  getPendingImportItems,
  getSkippedItems,
  insertImportItems,
  markItemsUploading,
  requeueImportItems,
  setArchiveBookmark,
  setImportJobParsed,
  startImportJob,
} from '../../database/repositories/importRepository';
import { deriveAuthPhase } from '../../navigation/authPhase';
import { useAppStore } from '../../stores/useAppStore';
import { generateUUID } from '../../utils/uuid';
import { NotFoundError } from '../api/errors';
import {
  completeImport,
  getGroupImports,
  getImportSession,
  startImport,
  submitImportBatch,
} from '../api/imports';
import { fulfillPendingWraps } from '../conversationService';
import { openImportKeySession } from '../crypto/importCrypto';
import { captureError } from '../telemetry';
import { loadThreadsForGroup } from '../threadService';
import { openArchiveSession, pickArchiveParts, releaseArchiveParts } from './archiveAccess';
import {
  applyBatchOutcome,
  assembleBatch,
  batchSizeLimit,
  buildImportItem,
  claimBatch,
  failImportItems,
  halveBatchSize,
  isBatchHalvingExhausted,
  isItemBatchEligible,
  mapBatchResults,
  preflightImportItem,
  releaseBatchClaim,
} from './importBatch';
import { CHUNK_ALLOWANCE_PAUSE_MS, classifyImportFailure, isRunStale } from './importErrors';
import { estimateImportBytes, importMediaStage, uploadImportItemMedia } from './importMedia';
import { parseArchive } from './parseArchive';

import type {
  PendingImportItem,
  SkippedImportItem,
  TerminalImportJobStatus,
} from '../../database/repositories/importRepository';
import type { ImportJobRow } from '../../types/database';
import type { ImportAllowance, ImportLimits } from '../../types/api';
import type { ImportKeySession } from '../crypto/importCrypto';
import type { ArchiveImportSession, ArchivePartToken } from './archiveAccess';
import type { BuiltImportItem } from './importBatch';
import type {
  ImportFailureContext,
  ImportStage,
  ImportTerminalCode,
  ImportVerdict,
  PauseCause,
  RunGuard,
} from './importErrors';
import type { ImportItemInsert } from '../../database/repositories/importRepository';
import type { ImportSource, ParseProgress, ParseSummary, SkipReason } from './types';

export type { PauseCause } from './importErrors';

// ---------------------------------------------------------------------------
// Public state (§4.3)
// ---------------------------------------------------------------------------

/**
 * `hydrating` until {@link resumeImportAtLaunch} settles, `done` until the
 * summary is dismissed.
 */
export type ImportPhase =
  'hydrating' | 'idle' | 'parsing' | 'ready' | 'running' | 'paused' | 'done';

/** What the member is told the run achieved. Counts and client enums only. */
export interface ImportSummary {
  readonly created: number;
  readonly duplicate: number;
  readonly failed: number;
  /** Posts held for video, at parse time and at extract time together. */
  readonly heldVideo: number;
  /** Exhaustive, with `duplicate_in_archive` folded in by the repository. */
  readonly skippedByReason: Readonly<Record<SkipReason, number>>;
  /** Still queued when the run stopped: an allowance refusal or a terminal. */
  readonly notSubmitted: number;
  /** A client enum from `IMPORT_TERMINAL_CODES`, never server text. */
  readonly errorCode: ImportTerminalCode | null;
  readonly cancelled: boolean;
}

/**
 * What #928 shows before anything is uploaded (§4.2).
 *
 * `summary` is the parse's own answer and is `null` on a preflight REBUILT
 * from SQLite at launch — the `ParseSummary` is not persisted, and
 * synthesising a fake one would hand the screen invented file issues and date
 * bounds. The facts #928 needs in both cases are carried directly:
 * {@link importable}, {@link skippedByReason} and {@link heldVideo}.
 */
export interface ImportPreflight {
  readonly summary: ParseSummary | null;
  readonly allowance: ImportAllowance;
  readonly limits: ImportLimits;
  /** From `Conversation.contentRetentionDays`; null when the orbit keeps all. */
  readonly contentRetentionDays: number | null;
  readonly importable: number;
  readonly remainingPosts: number;
  readonly estimatedBytes: number;
  readonly remainingBytes: number;
  /** Set ⇒ the run is REFUSED and no session was started (§4.5). */
  readonly overAllowance: 'posts' | 'bytes' | null;
  /**
   * `importable < 1` ⇒ the run is REFUSED, for the other reason (§4.5).
   *
   * A separate flag rather than a third `overAllowance` value: this is not an
   * allowance fact, nothing about the member's limits would change it, and
   * #928's copy for it says something else entirely ("there is nothing here to
   * migrate", with the skip list next to it). Widening the union would also
   * make every reader of `overAllowance` handle a case that has no
   * `remainingPosts`/`remainingBytes` meaning.
   *
   * It is a refusal because `declared_posts` must be `1..1000`: a video-only
   * Instagram export would otherwise send `declared_posts: 0`, be answered
   * `400 IMPORT_DECLARED_INVALID`, and surface as `job-terminal('CLIENT_BUG')`
   * plus a Sentry event for an archive that is simply empty of posts we can
   * take.
   */
  readonly nothingToImport: boolean;
  readonly heldVideo: number;
  readonly skippedByReason: Readonly<Record<SkipReason, number>>;
}

export interface ImportRunnerState {
  readonly phase: ImportPhase;
  readonly jobId: string | null;
  readonly conversationId: string | null;
  readonly source: ImportSource | null;
  readonly preflight: ImportPreflight | null;
  readonly needsRepick: boolean;
  readonly total: number;
  readonly created: number;
  readonly duplicate: number;
  readonly failed: number;
  readonly skipped: number;
  readonly heldVideo: number;
  readonly mediaDone: number;
  readonly mediaTotal: number;
  readonly parseProgress: ParseProgress | null;
  /**
   * A precedence-ordered SET, not one slot. Empty ⇒ not paused.
   *
   * Seven causes (#928 needs copy for each): `needs_repick` — only
   * {@link repickArchiveParts} clears it; `key_pending` — a group-key wrap is
   * still pending; `archive_retry` — a retryable archive-reader failure;
   * `rate_limited` — a 429's own `Retry-After`; `allowance_wait` — the
   * chunk-route import allowance ceiling, backed off and bounded (its
   * exhaustion is `errorCode: 'ALLOWANCE'`); `network` — connectivity, cleared
   * by the foreground as well as by its timer; `background` — the app is
   * suspended.
   */
  readonly pauseCauses: readonly PauseCause[];
  readonly resumeAtMs: number | null;
  readonly summary: ImportSummary | null;
  readonly errorCode: ImportTerminalCode | null;
}

/** What {@link pickAndStartParse} answers. A refusal is typed, never a throw. */
export type PickParseResult =
  | { readonly kind: 'preflight'; readonly preflight: ImportPreflight }
  | { readonly kind: 'cancelled' }
  | {
      readonly kind: 'refused';
      readonly reason: 'job-running';
      readonly conversationId: string;
    };

/** What {@link repickArchiveParts} answers (§4.2). */
export type RepickResult = 'resumed' | 'different-archive' | 'cancelled';

/** What {@link probeImportAvailability} answers. */
export interface ImportAvailability {
  readonly available: boolean;
  readonly allowance: ImportAllowance | null;
  readonly limits: ImportLimits | null;
}

const NO_PAUSE: readonly PauseCause[] = Object.freeze([]);

const INITIAL_STATE: ImportRunnerState = Object.freeze({
  phase: 'hydrating' as ImportPhase,
  jobId: null,
  conversationId: null,
  source: null,
  preflight: null,
  needsRepick: false,
  total: 0,
  created: 0,
  duplicate: 0,
  failed: 0,
  skipped: 0,
  heldVideo: 0,
  mediaDone: 0,
  mediaTotal: 0,
  parseProgress: null,
  pauseCauses: NO_PAUSE,
  resumeAtMs: null,
  summary: null,
  errorCode: null,
});

/**
 * The run's published state. A vanilla store, read with
 * `useStore(importStore, …)`: the run outlives every screen, so its state
 * cannot live in a hook, and a vanilla store gives the stable snapshot
 * identity `useSyncExternalStore` needs.
 *
 * NOT persisted. It is re-derived from SQLite instead, which is the one source
 * that survives a process kill.
 */
export const importStore = createStore<ImportRunnerState>(() => INITIAL_STATE);

// ---------------------------------------------------------------------------
// Throttled emission (mirrors bulkExportRunner:132-192)
// ---------------------------------------------------------------------------

const EMIT_INTERVAL_MS = 250;

let draft: ImportRunnerState = INITIAL_STATE;
let emitTimer: ReturnType<typeof setTimeout> | null = null;

function sameState(a: ImportRunnerState, b: ImportRunnerState): boolean {
  return (
    a.phase === b.phase &&
    a.jobId === b.jobId &&
    a.conversationId === b.conversationId &&
    a.source === b.source &&
    a.preflight === b.preflight &&
    a.needsRepick === b.needsRepick &&
    a.total === b.total &&
    a.created === b.created &&
    a.duplicate === b.duplicate &&
    a.failed === b.failed &&
    a.skipped === b.skipped &&
    a.heldVideo === b.heldVideo &&
    a.mediaDone === b.mediaDone &&
    a.mediaTotal === b.mediaTotal &&
    a.parseProgress === b.parseProgress &&
    a.pauseCauses === b.pauseCauses &&
    a.resumeAtMs === b.resumeAtMs &&
    a.summary === b.summary &&
    a.errorCode === b.errorCode
  );
}

/**
 * Publish the draft, or confirm there is nothing to publish.
 *
 * The equality check keeps the store's snapshot IDENTITY stable across a
 * no-op update: `useSyncExternalStore` re-renders on identity, so emitting an
 * equal-but-new object per item would re-render every subscriber for nothing.
 */
function flushEmission(): void {
  if (emitTimer !== null) {
    clearTimeout(emitTimer);
    emitTimer = null;
  }
  const current = importStore.getState();
  if (sameState(draft, current)) {
    draft = current;
    return;
  }
  importStore.setState(draft, true);
  draft = importStore.getState();
}

/**
 * Merge into the draft. Progress is throttled; a PHASE, SUMMARY or PAUSE
 * change is emitted at once — those drive copy and a card, and a quarter
 * second of "still running" after a pause reads as a stuck UI.
 */
function update(patch: Partial<ImportRunnerState>, immediate: boolean): void {
  draft = { ...draft, ...patch };
  if (immediate) {
    flushEmission();
    return;
  }
  if (emitTimer === null) {
    emitTimer = setTimeout(() => {
      emitTimer = null;
      flushEmission();
    }, EMIT_INTERVAL_MS);
  }
}

// ---------------------------------------------------------------------------
// Ladders and budgets (§4.3.1)
// ---------------------------------------------------------------------------

/**
 * What actually clears a pending group-key wrap: `PENDING_CACHE_TTL_MS` in
 * `crypto/contentCrypto.ts`.
 *
 * Re-stated rather than imported because `metaImport/` may not import
 * `contentCrypto` at all (the ESLint fence in `.eslintrc.js` — a runner that
 * held raw key bytes across an await would encrypt under 32 zero bytes). The
 * number is a retry cadence, not a protocol constant: being wrong by a few
 * seconds costs one extra wait.
 */
const KEY_PENDING_RETRY_MS = 30_000;

/** Pending-wrap waits before the run gives up (§4.3.1). */
const KEY_PENDING_MAX_ATTEMPTS = 6;

/** `archive_retry`: 1 s → 5 s → 30 s, then 30 s. */
const ARCHIVE_PAUSE_LADDER_MS: readonly number[] = Object.freeze([1_000, 5_000, 30_000]);

const ARCHIVE_PAUSE_MAX_ATTEMPTS = 5;

/** `network`: 5 s → 15 s → 60 s, then 60 s, plus an AppState `active` wake. */
const NETWORK_PAUSE_LADDER_MS: readonly number[] = Object.freeze([5_000, 15_000, 60_000]);

const NETWORK_PAUSE_MAX_ATTEMPTS = 10;

/** A 429 whose `Retry-After` we could not read. */
const DEFAULT_RATE_LIMIT_MS = 60_000;

/**
 * `allowance_wait`: the chunk-route allowance ceiling, backed off to the
 * deadline the taxonomy names and then given up on.
 *
 * Small, and deliberately so. Waiting is not what clears that ceiling — the
 * staged bytes it counts are freed by a media complete, by a hard overrun, by
 * `importSessionCleanup` after hours of silence, or by the 24 h sweep, and a
 * refusal driven by settled `bytes_used` never clears at all. Three waits is
 * the "maybe another upload of ours just completed" benefit; a fourth refusal
 * means the member is out of allowance, which is `ALLOWANCE`.
 */
const ALLOWANCE_WAIT_MAX_ATTEMPTS = 3;

/** Parsed items buffered per `insertImportItems` transaction (#921). */
const PARSE_FLUSH_SIZE = 100;

/** Precedence order; the first non-empty cause drives #928's copy. */
const PAUSE_PRECEDENCE: readonly PauseCause[] = Object.freeze([
  'needs_repick',
  'key_pending',
  'archive_retry',
  'rate_limited',
  'allowance_wait',
  'network',
  'background',
]);

/**
 * Which terminal code a cause becomes when its budget runs out, and how many
 * waits that budget is.
 *
 * One table, keyed by cause, read UNCONDITIONALLY: a cause that is absent here
 * is one whose only exit is a member action or the server's own clock
 * (`needs_repick`, `background`, `rate_limited`). Keying the budget on anything
 * other than the cause — on whether the pause carried a deadline, say — is what
 * let a repeating refusal pause forever (#993 fold round, blocker 3).
 */
const PAUSE_BUDGET_CODE: Readonly<
  Partial<Record<PauseCause, { readonly code: ImportTerminalCode; readonly max: number }>>
> = Object.freeze({
  key_pending: { code: 'KEY_PENDING', max: KEY_PENDING_MAX_ATTEMPTS },
  archive_retry: { code: 'ARCHIVE', max: ARCHIVE_PAUSE_MAX_ATTEMPTS },
  allowance_wait: { code: 'ALLOWANCE', max: ALLOWANCE_WAIT_MAX_ATTEMPTS },
  network: { code: 'NETWORK', max: NETWORK_PAUSE_MAX_ATTEMPTS },
});

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

interface ActiveRun {
  readonly token: number;
  readonly jobId: string;
  readonly conversationId: string;
  readonly source: ImportSource;
  readonly controller: AbortController;
  limits: ImportLimits;
  keySession: ImportKeySession | null;
  archive: ArchiveImportSession | null;
  /** The OPEN server session, in memory: `session_id` is only writable at start. */
  importId: string | null;
  declaredPosts: number;
  declaredBytes: number;
  /** Current batch size after any halving. */
  batchSize: number;
  pauseCauses: Set<PauseCause>;
  pauseTimers: Map<PauseCause, ReturnType<typeof setTimeout>>;
  pauseAttempts: Map<PauseCause, number>;
  pauseWaiters: Array<() => void>;
  resumeAtMs: number | null;
  appStateSub: { remove: () => void } | null;
  /** True while a picker THIS runner opened is on screen (§4.3.1). */
  pickerOpen: boolean;
  created: number;
  duplicate: number;
  failed: number;
  mediaDone: number;
  /**
   * Items parked in `uploading` for the held-video hold; never requeued.
   *
   * ALSO the held-video counter: `heldVideo` is `held.size` wherever it is
   * published, never a second number kept beside it. A standalone counter
   * double-counted every post that was held, requeued by a session restart and
   * then held again (#993 fold round) — the two could only agree for as long
   * as nobody cleared the set.
   */
  held: Set<string>;
  /** Items parked for the single end-of-run `IMPORT_QUOTA_EXCEEDED` retry. */
  parked: Set<string>;
  /**
   * `importMedia`'s staged-complete ledger: `${itemId}:${ordinal}` for every
   * media row whose chunks are all on the server, awaiting only the settle.
   *
   * Lives on the run because every staged row is bound to ONE server session:
   * {@link restartServerSession} drops it with the park set, and a fresh launch
   * starts empty and re-uploads.
   */
  stagedMedia: Set<string>;
  endOfRunPass: boolean;
  /** Consecutive cycles that drained nothing. Two in a row is a stuck loop. */
  idleCycles: number;
  clientBugCount: number;
  terminal: ImportTerminalCode | null;
  cancelled: boolean;
  /**
   * The SERVER has finished this session (`IMPORT_CLOSED` + `completed`, or a
   * launch-time GET that answered `completed`).
   *
   * The one honest way to settle `completed` with work still queued: no further
   * write will ever be accepted on that session, so the queue cannot drain and
   * saying so is not a bug. {@link undrainedWork} is checked against this.
   */
  serverFinished: boolean;
  settled: boolean;
}

let run: ActiveRun | null = null;

/**
 * The live run token (rule 0). Bumped by {@link resetImportRunnerState} and by
 * every run start, so a continuation scheduled under the old token writes
 * nothing.
 */
let liveToken = 0;

/** `GET /api/groups/:id/imports`, cached per app session per orbit (§4.2). */
const probeCache = new Map<string, ImportAvailability>();

/**
 * The wake-up for a pause raised BEFORE a run existed.
 *
 * Two gates can pause with no `ActiveRun` to hang a timer on:
 * `openImportKeySession` throwing `PendingWrapError`, and the launch-time
 * per-session GET failing with something retryable. A pause without a wake-up
 * is a run that stalls invisibly (§6) — and worse, the job row stays
 * `in_progress`, so `pickAndStartParse` refuses with `job-running` until the
 * app is relaunched. So the retry lives at module scope, bounded by the same
 * budget the equivalent running pause gets, and clears when a run starts and on
 * every reset.
 */
let preRunTimer: ReturnType<typeof setTimeout> | null = null;
let preRunAttempts = 0;
let preRunCause: PauseCause | null = null;

function clearPreRunRetry(): void {
  if (preRunTimer !== null) {
    clearTimeout(preRunTimer);
    preRunTimer = null;
  }
  preRunAttempts = 0;
  preRunCause = null;
}

/**
 * Clear the pre-run retry only if it is waiting on THIS cause.
 *
 * A successful `openImportKeySession` ends a `key_pending` wait and says
 * nothing about a `network` one — and resetting the counter on every pass
 * through a gate that is not the one that failed is an unbounded retry loop
 * wearing a budget.
 */
function clearPreRunRetryFor(cause: PauseCause): void {
  if (preRunCause === cause) clearPreRunRetry();
}

/**
 * Publish a pre-run pause for `job`, carrying the job's identity, and arm the
 * wake-up.
 *
 * The identity matters: #928 renders the paused card from the store, and a
 * pause with no `jobId` is a spinner with nothing behind it and no retry.
 */
function pauseJobBeforeRun(job: ImportJobRow, cause: PauseCause): void {
  update(
    {
      phase: 'paused',
      jobId: job.id,
      conversationId: job.conversation_id,
      source: job.source,
      pauseCauses: Object.freeze([cause] as PauseCause[]),
      needsRepick: false,
      summary: null,
      errorCode: null,
    },
    true,
  );
  schedulePreRunRetry(cause);
}

function schedulePreRunRetry(cause: PauseCause): void {
  if (preRunTimer !== null) return;
  // The same budget table the running pause set uses; a cause with no budget
  // there (`rate_limited`) still gets a bounded number of pre-run wake-ups,
  // because nothing else is driving this gate.
  const max = PAUSE_BUDGET_CODE[cause]?.max ?? NETWORK_PAUSE_MAX_ATTEMPTS;
  if (preRunAttempts >= max) {
    // The budget is spent. The JOB is untouched — nothing was started and
    // nothing written — so the honest state is "not running"; the next launch
    // tries again, and `resumeImport()` retries now.
    clearPreRunRetry();
    update({ phase: 'idle', pauseCauses: NO_PAUSE, needsRepick: false }, true);
    return;
  }
  const ms = pauseDelayMs(cause, preRunAttempts, undefined) ?? KEY_PENDING_RETRY_MS;
  preRunAttempts += 1;
  preRunCause = cause;
  preRunTimer = setTimeout(() => {
    preRunTimer = null;
    void resumeImportAtLaunch().catch(() => {
      // Re-entering the same gate; a second failure re-arms the timer.
    });
  }, ms);
}

/**
 * Failure codes already reported in this run's capture window, or null when no
 * window is open.
 *
 * One archive can fail thousands of items the same way; without a budget a
 * single systemic failure is thousands of identical Sentry events. Mirrors
 * `mediaExportService`'s per-run budget (the third such budget extracts a
 * shared `captureBudget(name)` — two is below the threshold, §4.1).
 */
let capturedImportCodes: Set<string> | null = null;

function beginImportCaptureBudget(): void {
  capturedImportCodes = new Set<string>();
}

function endImportCaptureBudget(): void {
  capturedImportCodes = null;
}

/**
 * Report one run failure, at most once per code per run (§4.13).
 *
 * The payload is counts and closed client enums. No archive path, entry id,
 * import key, media id, session id, post body, file name, member date or key
 * fingerprint may appear here in either spelling — that list is pinned by
 * `meta-import-no-content-logging`, which reads this file line by line.
 */
function captureImportFailure(r: ActiveRun, stage: ImportStage, code: ImportTerminalCode): void {
  if (capturedImportCodes !== null) {
    if (capturedImportCodes.has(code)) return;
    capturedImportCodes.add(code);
  }
  captureError(new Error('meta import failed'), {
    tags: {
      import_source: r.source,
      import_stage: stage,
      import_code: code,
    },
    extra: {
      created: r.created,
      failed: r.failed,
      batch_size: r.batchSize,
    },
  });
}

// ---------------------------------------------------------------------------
// Rule 0 — guards
// ---------------------------------------------------------------------------

/**
 * The guard for WORK: it carries the abort signal, so a user cancel collapses
 * every item write and every classification to `cancelled`.
 */
function workGuard(r: ActiveRun): RunGuard {
  return {
    run: r.token,
    currentRun: () => liveToken,
    signal: r.controller.signal,
  };
}

/** True once this run's work must stop: reset, cancel or abort. */
function stopped(r: ActiveRun): boolean {
  return r !== run || isRunStale(workGuard(r));
}

/**
 * True once this run has been RESET rather than merely cancelled: write
 * nothing at all, not even the terminal status.
 *
 * The token only, deliberately — no signal. A user cancel aborts the work but
 * must still write `finishImportJob(jobId, 'cancelled')` and publish a
 * summary; a wipe must leave no trace. The wipe bumps {@link liveToken}, the
 * cancel does not, and that is the whole difference.
 */
function wiped(r: ActiveRun): boolean {
  return r.token !== liveToken;
}

/** `setTimeout` as a promise that also settles on abort. */
function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    let settled = false;
    const done = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(done, ms);
    if (typeof signal.addEventListener === 'function') {
      signal.addEventListener('abort', done, { once: true });
    }
  });
}

// ---------------------------------------------------------------------------
// The pause set and its wake-ups (§4.3.1)
// ---------------------------------------------------------------------------

function pauseList(r: ActiveRun): readonly PauseCause[] {
  if (r.pauseCauses.size === 0) return NO_PAUSE;
  return PAUSE_PRECEDENCE.filter((cause) => r.pauseCauses.has(cause));
}

function releaseWaiters(r: ActiveRun): void {
  const waiters = r.pauseWaiters;
  r.pauseWaiters = [];
  for (const resolve of waiters) resolve();
}

function clearPauseTimer(r: ActiveRun, cause: PauseCause): void {
  const timer = r.pauseTimers.get(cause);
  if (timer !== undefined) {
    clearTimeout(timer);
    r.pauseTimers.delete(cause);
  }
}

/** Publish the pause set, and release the loop when it has emptied. */
function publishPauseState(r: ActiveRun): void {
  const causes = pauseList(r);
  if (causes.length === 0) {
    update({ phase: 'running', pauseCauses: NO_PAUSE, resumeAtMs: null, needsRepick: false }, true);
    r.resumeAtMs = null;
    releaseWaiters(r);
    return;
  }
  update(
    {
      phase: 'paused',
      pauseCauses: causes,
      resumeAtMs: r.resumeAtMs,
      // One source for the flag #928's re-pick prompt is gated on: it is the
      // pause set's own membership, never a second variable to keep in step.
      needsRepick: causes.includes('needs_repick'),
    },
    true,
  );
}

function dropPause(r: ActiveRun, cause: PauseCause): void {
  if (!r.pauseCauses.delete(cause)) return;
  clearPauseTimer(r, cause);
  publishPauseState(r);
}

/**
 * The delay a cause's next wake-up timer runs for, or `null` for a cause whose
 * only exit is a member action ({@link repickArchiveParts}, foreground).
 */
function pauseDelayMs(
  cause: PauseCause,
  attempt: number,
  untilMs: number | undefined,
): number | null {
  // A deadline names the DELAY and nothing else: whatever ladder the cause
  // would otherwise take, a pause that carries one is waited out to it. The
  // chunk-route `IMPORT_ALLOWANCE_EXCEEDED` is the one that does — retrying it
  // on the 5 s connectivity ladder would spend round trips re-learning the
  // same refusal (§4.5.6). What ENDS that wait is the cause's own budget in
  // {@link addPause}, never this number.
  if (untilMs !== undefined && cause !== 'needs_repick' && cause !== 'background') {
    return Math.max(0, untilMs - Date.now());
  }

  switch (cause) {
    case 'key_pending':
      return KEY_PENDING_RETRY_MS;
    case 'archive_retry':
      return ARCHIVE_PAUSE_LADDER_MS[Math.min(attempt, ARCHIVE_PAUSE_LADDER_MS.length - 1)];
    case 'network':
      return NETWORK_PAUSE_LADDER_MS[Math.min(attempt, NETWORK_PAUSE_LADDER_MS.length - 1)];
    case 'rate_limited':
      // A 429 whose `Retry-After` the transport could not read.
      return DEFAULT_RATE_LIMIT_MS;
    case 'allowance_wait':
      // Only ever raised WITH a deadline (handled above); this is the belt for
      // a caller that ever raises it without one.
      return CHUNK_ALLOWANCE_PAUSE_MS;
    default:
      // `needs_repick` has no timer at all, and `background` wakes on AppState.
      return null;
  }
}

/**
 * Add a pause cause, spend one of its attempts, and arm its wake-up.
 *
 * Returns the terminal code the cause's budget ran out with, or null. The
 * budget is counted HERE rather than in the classifier because the classifier
 * is pure: it answers "this is a network pause", and how many of those a run
 * tolerates is the loop's business (§4.3.1).
 */
function addPause(r: ActiveRun, cause: PauseCause, untilMs?: number): ImportTerminalCode | null {
  const attempt = r.pauseAttempts.get(cause) ?? 0;
  // Keyed on the CAUSE alone. A deadline the server named changes how long we
  // wait, never how many times we are willing to: exempting a deadline-bearing
  // pause from its budget made a repeating chunk-allowance refusal immortal
  // (the pump checks `isPaused` before its no-progress guard, so that guard
  // never sees it either).
  const budget = PAUSE_BUDGET_CODE[cause];
  if (budget !== undefined) {
    if (attempt >= budget.max) return budget.code;
    r.pauseAttempts.set(cause, attempt + 1);
  }
  r.pauseCauses.add(cause);
  if (untilMs !== undefined) r.resumeAtMs = untilMs;

  clearPauseTimer(r, cause);
  const ms = pauseDelayMs(cause, attempt, untilMs);
  if (ms !== null) {
    r.pauseTimers.set(
      cause,
      setTimeout(() => {
        if (r !== run) return;
        dropPause(r, cause);
      }, ms),
    );
  }
  publishPauseState(r);
  return null;
}

function isPaused(r: ActiveRun): boolean {
  return r.pauseCauses.size > 0;
}

/**
 * Release a paused loop once a terminal was raised from OUTSIDE it.
 *
 * {@link repickArchiveParts} runs while the pump is parked in
 * {@link waitUntilResumed} on `needs_repick`, whose only exit is a member
 * action. A terminal verdict raised there would otherwise leave the run paused
 * for ever with `terminal` set: nothing clears that cause, so nothing releases
 * the waiters, so the run never settles and never reports.
 */
function wakeForTerminal(r: ActiveRun): void {
  if (r.terminal === null) return;
  for (const cause of [...r.pauseTimers.keys()]) clearPauseTimer(r, cause);
  r.pauseCauses.clear();
  releaseWaiters(r);
}

function waitUntilResumed(r: ActiveRun): Promise<void> {
  if (!isPaused(r) || stopped(r)) return Promise.resolve();
  return new Promise<void>((resolve) => {
    r.pauseWaiters.push(resolve);
  });
}

/**
 * Only `background` pauses for AppState.
 *
 * `inactive` is what iOS reports while OUR OWN document picker or a permission
 * alert is on screen, and pausing for that would stall the run that is waiting
 * for the picker.
 */
function isBackgrounded(status: AppStateStatus): boolean {
  return status === 'background';
}

function attachAppState(r: ActiveRun): void {
  if (isBackgrounded(AppState.currentState ?? 'active')) addPause(r, 'background');
  r.appStateSub = AppState.addEventListener('change', (next: AppStateStatus) => {
    if (r !== run) return;
    if (isBackgrounded(next)) {
      // Our own picker takes the foreground on Android (SAF emits
      // `onHostPause`), and pausing for it would release the loop's waiters
      // against a dead archive session when the member comes back.
      if (r.pickerOpen) return;
      addPause(r, 'background');
      return;
    }
    if (next !== 'active') return;
    // Foreground is the `network` wake-up as well as `background`'s (§4.3.1):
    // a connection that died while suspended is back by the time we are.
    //
    // `allowance_wait` is deliberately NOT dropped here: coming back to the app
    // says nothing about the orbit's staged bytes, and shortening that wait
    // would spend a whole upload re-learning the same refusal.
    dropPause(r, 'background');
    dropPause(r, 'network');
  });
}

function detachAppState(r: ActiveRun): void {
  r.appStateSub?.remove();
  r.appStateSub = null;
}

// ---------------------------------------------------------------------------
// Verdicts
// ---------------------------------------------------------------------------

/** What the caller does next with its own step. */
type Step =
  /** The step is finished; go back to the loop. */
  | 'continue'
  /** The run is over (terminal, cancelled or wiped). */
  | 'stop'
  /** Run the same call again; the delay has already been waited out. */
  | 'retry';

function failRunWith(r: ActiveRun, code: ImportTerminalCode, stage: ImportStage): Step {
  r.terminal = code;
  if (!wiped(r)) captureImportFailure(r, stage, code);
  return 'stop';
}

/** The classifier's context for one failure, with this run's own counters. */
function failureContext(
  r: ActiveRun,
  stage: ImportStage,
  extra?: {
    stageAttempt?: number;
    busyAttempt?: number;
    endOfRunPass?: boolean;
  },
): ImportFailureContext {
  return {
    ...workGuard(r),
    stage,
    createdItems: r.created,
    clientBugCount: r.clientBugCount,
    endOfRunPass: r.endOfRunPass || extra?.endOfRunPass === true,
    ...(extra?.stageAttempt === undefined ? {} : { stageAttempt: extra.stageAttempt }),
    ...(extra?.busyAttempt === undefined ? {} : { busyAttempt: extra.busyAttempt }),
  };
}

/**
 * Apply one verdict that is not specific to its caller.
 *
 * `batch-halve` is deliberately NOT handled here: only the batch step knows
 * what to re-claim, and routing it through a shared dispatcher would hide the
 * requeue. Every other arm means the same thing wherever it came from —
 * including `IMPORT_CLOSED`, which the media routes raise too (§1.4 C4), which
 * is why `session-restart` / `finish-completed` must be reachable from the
 * media path and not only from the batch path.
 */
async function applyVerdict(
  r: ActiveRun,
  verdict: ImportVerdict,
  stage: ImportStage,
  options?: { itemId?: string; stageAttempt?: number },
): Promise<Step> {
  const itemId = options?.itemId;
  switch (verdict.kind) {
    case 'cancelled':
      return 'stop';

    case 'pause': {
      const exhausted = addPause(r, verdict.cause, verdict.untilMs);
      return exhausted === null ? 'continue' : failRunWith(r, exhausted, stage);
    }

    case 'retry-same-call':
      await delay(verdict.delayMs, r.controller.signal);
      return stopped(r) ? 'stop' : 'retry';

    case 'item-failed':
      if (itemId !== undefined) {
        if (verdict.code === 'IMPORT_ITEM_INVALID') r.clientBugCount += 1;
        const write = failImportItems(r.jobId, [{ itemId, code: verdict.code }], workGuard(r));
        if (write.kind === 'cancelled') return 'stop';
        if (write.kind === 'ok') r.failed += 1;
      }
      return 'continue';

    case 'park-file':
      // The orbit was full at media complete, where the refusal can mean count
      // rather than bytes (F4): hold the item out of the queue and give it one
      // end-of-run pass before charging it to the member.
      if (itemId !== undefined && parkItem(r, itemId)) r.parked.add(itemId);
      return 'continue';

    case 'file-fresh-id':
      // `importMedia` consumes every legitimate rebind itself and never hands
      // one back; reaching here means the two layers disagreed about a shape.
      // Charge the item rather than rebinding a `media_id` outside the one
      // module allowed to, and keep the run alive.
      return applyVerdict(r, { kind: 'item-failed', code: 'IMPORT_MEDIA_UNAVAILABLE' }, stage, {
        ...(itemId === undefined ? {} : { itemId }),
      });

    case 'adopt-session': {
      const importId = verdict.importId ?? (await lookupOpenSessionId(r));
      if (importId === null) return failRunWith(r, 'REFUSED', stage);
      // The id we already hold is not an adoption: answering `retry` for it
      // would re-POST at the same session that just refused us, as fast as the
      // loop can go. The server has told us nothing new, so stop.
      if (importId === r.importId) return failRunWith(r, 'REFUSED', stage);
      r.importId = importId;
      return 'retry';
    }

    case 'session-restart':
      return restartServerSession(r, options?.stageAttempt ?? 0);

    case 'finish-completed':
      // The server considers the session finished; finish locally too. The flag
      // is what makes `completed` honest with items still queued: nothing we
      // could send would be accepted, so this is not an undrained run
      // ({@link undrainedWork}).
      r.serverFinished = true;
      return 'stop';

    case 'batch-halve':
      // Only the batch step can act on this (see the note above). Anywhere
      // else a too-large body is not something we can make smaller.
      return failRunWith(r, 'REFUSED', stage);

    case 'job-terminal':
      return failRunWith(r, verdict.code, stage);
  }
}

/** Classify a thrown failure and act on it, in one call. */
async function handleFailure(
  r: ActiveRun,
  e: unknown,
  stage: ImportStage,
  options?: { itemId?: string; stageAttempt?: number; busyAttempt?: number },
): Promise<Step> {
  const verdict = classifyImportFailure(
    e,
    failureContext(r, stage, {
      ...(options?.stageAttempt === undefined ? {} : { stageAttempt: options.stageAttempt }),
      ...(options?.busyAttempt === undefined ? {} : { busyAttempt: options.busyAttempt }),
    }),
  );
  return applyVerdict(r, verdict, stage, {
    ...(options?.itemId === undefined ? {} : { itemId: options.itemId }),
    ...(options?.stageAttempt === undefined ? {} : { stageAttempt: options.stageAttempt }),
  });
}

/**
 * Park one item out of the pending queue without failing it.
 *
 * `uploading` is the only parking space the schema has, and it is the right
 * one: `getPendingImportItems` cannot see it, `finishImportJob` drops its
 * body, and a later resume's `requeueImportItems({from:'uploading'})` brings
 * it back — which is exactly what a held post should do (one extract, held
 * again) and what a quota-parked file should do (retry when space frees).
 */
function parkItem(r: ActiveRun, itemId: string): boolean {
  if (isRunStale(workGuard(r))) return false;
  return markItemsUploading(r.jobId, [itemId]) === 1;
}

// ---------------------------------------------------------------------------
// The server session
// ---------------------------------------------------------------------------

/** The member's open session on this orbit, from a fresh preflight GET. */
async function lookupOpenSessionId(r: ActiveRun): Promise<string | null> {
  try {
    const preflight = await getGroupImports(r.conversationId);
    return preflight.openImport?.importId ?? null;
  } catch {
    // The adoption path already knows the member has a session; failing to
    // learn its id is a pause-or-stop decision the next call will make.
    return null;
  }
}

/**
 * `IMPORT_CLOSED` + `abandoned`: open a fresh session and resubmit.
 *
 * The new id is held in MEMORY only. `startImportJob` is guarded by
 * `status = 'ready'` and this job is `in_progress`, so there is no writer for
 * a second session id — and that is harmless: a relaunch re-reads the stale
 * `session_id`, the server answers `abandoned`, and this path runs again.
 * Already-created posts come back `duplicate`, and completed media is adopted.
 *
 * **Answers `retry` only when the session id actually CHANGED.** A `retry`
 * verdict on the start call means "this call may be repeated", never "a session
 * exists": offline, a `NetworkError` classifies `retry-same-call` while
 * `r.importId` still holds the closed id, and reporting success there would
 * re-POST the batch at a dead session, get `IMPORT_CLOSED` again and restart
 * again — a ~1 s loop for as long as the device is offline, which no pause
 * budget and no no-progress guard can see. So the start ladder is spent HERE,
 * under the caller's own attempt counter, and the caller is handed the pause
 * (`continue`) or the terminal (`stop`) the taxonomy produced.
 *
 * The one way forward without our own start succeeding is the adopt-session
 * arm, which proves it by changing the id.
 */
async function restartServerSession(r: ActiveRun, stageAttempt: number): Promise<Step> {
  const closed = r.importId;

  for (let attempt = stageAttempt; ; attempt++) {
    if (stopped(r)) return 'stop';
    try {
      const started = await startImport(r.conversationId, {
        declaredPosts: r.declaredPosts,
        declaredBytes: r.declaredBytes,
      });
      r.importId = started.importId;
      r.limits = started.limits;
      break;
    } catch (e) {
      const step = await handleFailure(r, e, 'start', { stageAttempt: attempt });
      if (r.importId !== null && r.importId !== closed) break;
      if (step !== 'retry') return step;
    }
  }

  if (isRunStale(workGuard(r))) return 'stop';
  const requeued = requeueImportItems(r.jobId, { from: 'uploading' });
  if (requeued > 0) {
    // Held and quota-parked posts went back into the queue with everything
    // else: a held post is held again on its next extract (one peek each), and
    // a parked one is retried now rather than in the end-of-run pass. Both
    // sets must be dropped, or the summary would keep subtracting rows that
    // are no longer parked anywhere — and because `held.size` IS the held-video
    // count, dropping the set is also what stops the re-hold from counting the
    // same post twice.
    r.held.clear();
    r.parked.clear();
  }
  // Unconditional, requeue or not: every staged row was bound to the session
  // this call just closed, so none of them can be settled any more. The chunk
  // route answers 403 for a temp row bound elsewhere, which `importMedia`
  // rebinds — a stale key here would spend a complete call to learn that.
  r.stagedMedia.clear();
  return 'retry';
}

/**
 * Make sure the run has an OPEN server session, starting one if the job has
 * not got there yet.
 *
 * `openImport` from the preflight is adopted rather than raced: only one
 * session per member per orbit may be open, so starting a second is a 409 we
 * can see coming.
 *
 * **Both ladders are spent in-frame, and the verdict is RETURNED**, exactly as
 * in {@link restartServerSession} and for the same reason. A `NetworkError` or
 * a 5xx on the start call classifies `retry-same-call`, and a 429 on the
 * preflight GET classifies `pause`: neither names a terminal code, so reporting
 * "no session" to the caller handed {@link settleRun} a run with
 * `terminal === null` — which {@link terminalStatusFor} calls `completed`. A
 * failed start therefore reported a SUCCESSFUL import with every item still
 * pending (#993 fold round, blocker 1).
 *
 * `continue` means "the session is open"; `stop` is a terminal or a cancel. A
 * pause is waited out HERE rather than returned, because there is nothing
 * further up this path that could re-enter the start call: the pump has not
 * begun. The cause's own budget is what makes that wait terminate.
 */
async function ensureServerSession(r: ActiveRun, job: ImportJobRow): Promise<Step> {
  if (job.session_id !== null) {
    r.importId = job.session_id;
    return 'continue';
  }

  for (;;) {
    await waitUntilResumed(r);
    if (stopped(r)) return 'stop';

    const step = await openServerSession(r);
    if (step !== 'continue') return step;
    if (r.importId !== null) return 'continue';
    // A pause was raised (and not exhausted): wait it out and ask again.
    if (!isPaused(r)) return failRunWith(r, 'CLIENT_BUG', 'start');
  }
}

/**
 * One attempt at the preflight-GET-then-start ladder, both spent in place.
 *
 * Answers `continue` with `r.importId` set once the session is open, `continue`
 * with it still null when a pause was raised, and `stop` on a terminal or a
 * cancel.
 */
async function openServerSession(r: ActiveRun): Promise<Step> {
  let importId: string | null = null;

  for (let attempt = 0; ; attempt++) {
    if (stopped(r)) return 'stop';
    try {
      const preflight = await getGroupImports(r.conversationId);
      r.limits = preflight.limits;
      if (preflight.openImport !== null && preflight.openImport.status === 'open') {
        importId = preflight.openImport.importId;
      }
      break;
    } catch (e) {
      const step = await handleFailure(r, e, 'start', { stageAttempt: attempt });
      if (step !== 'retry') return step;
    }
  }

  if (importId === null) {
    for (let attempt = 0; ; attempt++) {
      if (stopped(r)) return 'stop';
      try {
        const started = await startImport(r.conversationId, {
          declaredPosts: r.declaredPosts,
          declaredBytes: r.declaredBytes,
        });
        importId = started.importId;
        r.limits = started.limits;
        break;
      } catch (e) {
        const step = await handleFailure(r, e, 'start', { stageAttempt: attempt });
        // The adopt-session arm is the one way forward without our own start
        // succeeding, and it proves it by setting an id: this job had none.
        if (r.importId !== null) {
          importId = r.importId;
          break;
        }
        if (step !== 'retry') return step;
      }
    }
  }

  if (isRunStale(workGuard(r))) return 'stop';
  // The job is `ready` here, so this is the ONE moment the session id is
  // persistable. A `false` means the job moved underneath us: re-read, never
  // write on top of it.
  if (!startImportJob(r.jobId, { sessionId: importId })) return 'stop';
  r.importId = importId;
  return 'continue';
}

// ---------------------------------------------------------------------------
// The archive session, re-opened lazily
// ---------------------------------------------------------------------------

/** An `ArchiveReaderError`'s code, matched by name (§4.16 mock locations). */
function archiveErrorCode(e: unknown): string | undefined {
  if (e === null || typeof e !== 'object') return undefined;
  if ((e as { name?: unknown }).name !== 'ArchiveReaderError') return undefined;
  const code = (e as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

function parsePartTokens(json: string | null): readonly ArchivePartToken[] | null {
  if (json === null) return null;
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? (parsed as ArchivePartToken[]) : null;
  } catch {
    // A bookmark we cannot read is a bookmark we do not have.
    return null;
  }
}

/** Persist `JSON.stringify(session.parts)` when it differs from the stored value. */
function persistBookmark(
  r: ActiveRun,
  session: ArchiveImportSession,
  stored: string | null,
): boolean {
  const json = JSON.stringify(session.parts);
  if (json === stored) return true;
  if (isRunStale(workGuard(r))) return false;
  // A `false` means the job left the active statuses underneath us: stop and
  // re-read rather than putting a capability handle back on a dead job.
  return setArchiveBookmark(r.jobId, json);
}

/**
 * The archive session for the next media item, opened on first use.
 *
 * A text-only tail therefore resumes with no picker prompt and no archive
 * session at all, which is the whole reason this is lazy (§4.9.5).
 */
async function ensureArchiveSession(r: ActiveRun): Promise<ArchiveImportSession | null> {
  if (r.archive !== null) return r.archive;

  const job = getImportJob(r.jobId);
  const stored = job?.archive_bookmark ?? null;
  const tokens = parsePartTokens(stored);
  if (tokens === null || tokens.length === 0) {
    // No bookmark and media still to upload: only a re-pick can supply one,
    // and only while nothing has been created (§4.7, one disposition).
    await applyVerdict(
      r,
      r.created === 0
        ? { kind: 'pause', cause: 'needs_repick' }
        : { kind: 'job-terminal', code: 'ARCHIVE' },
      'archive',
    );
    return null;
  }

  for (let attempt = 0; ; attempt++) {
    if (stopped(r)) return null;
    try {
      const session = await openArchiveSession(tokens, { signal: r.controller.signal });
      if (!persistBookmark(r, session, stored)) {
        session.close();
        return null;
      }
      r.archive = session;
      return session;
    } catch (e) {
      // The step is acted on rather than dropped: `ARCHIVE_BUSY` answers
      // `retry-same-call` (all four Rust job slots are taken, it clears in ms)
      // and the attempt counter is what bounds it. Dropping the step turned
      // that into one open per pump cycle, which the no-progress guard called a
      // CLIENT_BUG after two.
      const step = await handleFailure(r, e, 'archive', {
        stageAttempt: attempt,
        busyAttempt: attempt,
      });
      if (step !== 'retry') return null;
    }
  }
}

// ---------------------------------------------------------------------------
// One item's media (§4.10)
// ---------------------------------------------------------------------------

/**
 * Run one post's media pipeline.
 *
 * Returns the {@link Step} the pump must act on — never a bare boolean. Every
 * other outcome (failed, held, parked, paused) has already been applied and
 * answers `continue`, after which the loop re-reads the queue; `stop` is a
 * terminal, a cancel, or the server telling us the session is finished.
 *
 * The media routes raise `IMPORT_CLOSED` too (§1.4 C4), so `finish-completed`
 * and `session-restart` are reachable from here. Discarding this step left the
 * media path cycling until the no-progress guard called it a CLIENT_BUG, where
 * the batch path settled `completed` (#993 fold round).
 */
async function runMediaForItem(r: ActiveRun, item: PendingImportItem): Promise<Step> {
  const session = await ensureArchiveSession(r);
  if (session === null || r.importId === null) return r.terminal === null ? 'continue' : 'stop';

  for (let attempt = 0; ; attempt++) {
    if (stopped(r)) return 'stop';
    // Re-read per attempt rather than captured once: a `session-restart` or an
    // `adopt-session` verdict between two attempts changes the session this
    // file must be uploaded to, and the old id is closed.
    const importId = r.importId;
    if (importId === null) return 'stop';

    let outcome;
    try {
      outcome = await uploadImportItemMedia(item, {
        importId,
        groupId: r.conversationId,
        session,
        signal: r.controller.signal,
        isCurrentRun: () => r === run && !wiped(r),
        stagedComplete: r.stagedMedia,
      });
    } catch (e) {
      // `importMedia` rethrows exactly the failures that are about the RUN;
      // the stage comes off the error because `uploadMedia` runs the chunk
      // loop and the complete call behind one promise.
      const step = await handleFailure(r, e, importMediaStage(e), {
        itemId: item.id,
        stageAttempt: attempt,
        busyAttempt: attempt,
      });
      if (step === 'retry') continue;
      return step;
    }

    switch (outcome.kind) {
      case 'uploaded':
        r.mediaDone += item.media.length;
        update({ mediaDone: r.mediaDone }, false);
        return 'continue';

      case 'held-video':
        // The issue's AC reports held video separately from failures, so the
        // post is parked rather than failed — and it is parked out of the
        // queue so one held post cannot stall the drain.
        //
        // The count is `held.size`, so it cannot drift from the set it is
        // meant to describe: a post that is requeued by a session restart and
        // held again leaves the set once and re-enters it once, where a
        // standalone counter was incremented twice for one post.
        if (parkItem(r, item.id)) {
          r.held.add(item.id);
          update({ heldVideo: r.held.size }, false);
        }
        return 'continue';

      case 'item-failed': {
        if (isRunStale(workGuard(r))) return 'stop';
        const write = failImportItems(
          r.jobId,
          [{ itemId: item.id, code: itemCodeFor(outcome.code) }],
          workGuard(r),
        );
        if (write.kind === 'ok') {
          r.failed += 1;
          update({ failed: r.failed }, false);
        }
        return 'continue';
      }

      case 'cancelled':
        return 'stop';

      case 'fresh-id-exhausted':
        // Per C4 a 403 on an import media route has three indistinguishable
        // causes; the one fresh id answered the two that are recoverable.
        return failRunWith(r, 'FORBIDDEN', outcome.stage);

      case 'refused': {
        // The server took a chunk and then refused the upload for a reason
        // about the RUN or the ORBIT. `importMedia` has rebound the burned id,
        // so the row is re-uploadable — which is exactly why this must NOT
        // retry in this loop: `item` still carries the old `media_id`. The
        // taxonomy answers park-file (the end-of-run pass re-reads the row),
        // `job-terminal('ALLOWANCE')`, a pause, a session restart, or
        // `finish-completed` — and that last one is why the step is RETURNED:
        // dropping it made the media path cycle to CLIENT_BUG where the batch
        // path settled `completed`.
        const step = await handleFailure(r, outcome.error, outcome.stage, {
          itemId: item.id,
          stageAttempt: attempt,
        });
        // `retry` would re-POST this item's stale `media_id`; the pump re-reads
        // the page instead.
        return step === 'retry' ? 'continue' : step;
      }
    }
  }
}

/**
 * `importMedia`'s codes, narrowed to the ones this client writes.
 *
 * Its two `SkipReason` spellings (`image_too_large`,
 * `unsupported_image_format`) are the parser's names for the same
 * user-visible fact, reused on purpose — but `applyBatchResults` takes our own
 * registry, so they are mapped to the one entry that means "the device or the
 * server refused this file type".
 */
function itemCodeFor(code: string): 'IMPORT_MEDIA_UNSUPPORTED' | 'IMPORT_MEDIA_UNAVAILABLE' {
  return code === 'IMPORT_MEDIA_UNAVAILABLE'
    ? 'IMPORT_MEDIA_UNAVAILABLE'
    : 'IMPORT_MEDIA_UNSUPPORTED';
}

// ---------------------------------------------------------------------------
// One batch (§4.6)
// ---------------------------------------------------------------------------

/** Seal the eligible items, or charge the ones that cannot be sealed. */
async function buildBatchItems(
  r: ActiveRun,
  items: readonly PendingImportItem[],
): Promise<{ built: BuiltImportItem[]; step: Step }> {
  const built: BuiltImportItem[] = [];
  const session = r.keySession;
  if (session === null) return { built, step: 'stop' };

  for (const item of items) {
    if (stopped(r)) return { built, step: 'stop' };

    const narrowed = preflightImportItem(item, r.limits);
    if (!narrowed.ok) {
      const step = await applyVerdict(r, { kind: 'item-failed', code: narrowed.code }, 'batch', {
        itemId: item.id,
      });
      if (step === 'stop') return { built, step };
      continue;
    }

    try {
      const outcome = await buildImportItem(narrowed.item, session, r.limits);
      if (outcome.ok) {
        built.push(outcome.built);
        continue;
      }
      const step = await applyVerdict(r, { kind: 'item-failed', code: outcome.code }, 'batch', {
        itemId: item.id,
      });
      if (step === 'stop') return { built, step };
    } catch (e) {
      // Crypto errors propagate out of `buildImportItem` on purpose: a pending
      // wrap is a pause, a changed key ends the run, and neither is an item
      // failure.
      const step = await handleFailure(r, e, 'crypto', { itemId: item.id });
      return { built, step: step === 'retry' ? 'continue' : step };
    }
  }

  return { built, step: 'continue' };
}

/** POST one claimed batch, retrying in place while the ladder allows it. */
async function submitClaimedBatch(r: ActiveRun, batch: readonly BuiltImportItem[]): Promise<Step> {
  for (let attempt = 0; ; attempt++) {
    if (stopped(r) || r.importId === null) return 'stop';

    try {
      const response = await submitImportBatch(r.importId, {
        items: batch.map((b) => b.wire),
      });
      const mapped = mapBatchResults(batch, response.results);
      const applied = applyBatchOutcome(r.jobId, mapped.applied, workGuard(r));
      if (applied.kind === 'cancelled') return 'stop';

      r.created += mapped.created;
      r.duplicate += mapped.duplicate;
      r.failed += mapped.failed;
      update({ created: r.created, duplicate: r.duplicate, failed: r.failed }, false);

      // Items the response said nothing about are still `uploading` and are
      // ours to requeue — a resubmitted post the server already took comes
      // back `duplicate`, which is what the `import_key` dedup is for.
      releaseBatchClaim(r.jobId, mapped.unanswered, workGuard(r));
      return 'continue';
    } catch (e) {
      const verdict = classifyImportFailure(
        e,
        failureContext(r, 'batch', { stageAttempt: attempt }),
      );
      if (verdict.kind === 'batch-halve') return 'retry';
      const step = await applyVerdict(r, verdict, 'batch', { stageAttempt: attempt });
      if (step === 'retry') continue;
      return step;
    }
  }
}

/**
 * Halve the batch, or charge the one item that cannot be made smaller.
 *
 * The size stays halved for the rest of the run rather than ratcheting back
 * up: nothing about the archive changed, and oscillating around the limit
 * would spend a round trip per batch to re-learn the same answer.
 */
async function halveOrFail(r: ActiveRun, batch: readonly BuiltImportItem[]): Promise<Step> {
  releaseBatchClaim(
    r.jobId,
    batch.map((b) => b.itemId),
    workGuard(r),
  );

  if (!isBatchHalvingExhausted(r.batchSize)) {
    r.batchSize = halveBatchSize(r.batchSize);
    return 'retry';
  }

  const first = batch[0];
  if (first === undefined) return 'stop';
  return applyVerdict(r, { kind: 'item-failed', code: 'IMPORT_ITEM_TOO_LARGE' }, 'batch', {
    itemId: first.itemId,
  });
}

/** Claim, submit and apply one batch out of the built set. */
async function submitBuiltItems(r: ActiveRun, built: readonly BuiltImportItem[]): Promise<Step> {
  let remaining = built;

  for (;;) {
    if (stopped(r)) return 'stop';

    const { batch } = assembleBatch(remaining, {
      maxItems: batchSizeLimit(r.limits, r.batchSize),
    });
    if (batch.length === 0) return 'continue';

    const claim = claimBatch(r.jobId, batch, workGuard(r));
    if (claim.kind === 'cancelled') return 'stop';
    // A short claim means some of these rows are no longer pending: this
    // batch is stale by definition, so re-read instead of sending it.
    if (claim.kind === 'stale') return 'continue';

    const step = await submitClaimedBatch(r, batch);
    if (step !== 'retry') {
      // A pause leaves the batch CLAIMED, and `getPendingImportItems` cannot
      // see an `uploading` row — the loop would read an empty page and call
      // the job drained. So the claim goes back in the queue and the items are
      // rebuilt after the wake-up. A terminal or cancelled run deliberately
      // leaves them claimed: they are the summary's `notSubmitted`.
      if (isPaused(r)) {
        releaseBatchClaim(
          r.jobId,
          batch.map((b) => b.itemId),
          workGuard(r),
        );
      }
      return step;
    }

    const halved = await halveOrFail(r, batch);
    if (halved === 'stop') return 'stop';
    if (halved === 'continue') {
      // The single over-size item was charged to the member; drop it and
      // carry on with the rest.
      remaining = remaining.filter((b) => b.itemId !== batch[0]?.itemId);
    }
  }
}

// ---------------------------------------------------------------------------
// The pump
// ---------------------------------------------------------------------------

function nextPendingItems(r: ActiveRun): PendingImportItem[] {
  return getPendingImportItems(r.jobId, batchSizeLimit(r.limits, r.batchSize));
}

/**
 * Upload the media of every item in the page that still needs it.
 *
 * The page is re-read afterwards rather than mutated in place: `importMedia`
 * may have rebound a `media_id` (`replaceMediaId`), and submitting the stale
 * one would attach a file the server does not have under that id.
 */
async function runMediaPhase(r: ActiveRun, page: readonly PendingImportItem[]): Promise<Step> {
  for (const item of page) {
    if (stopped(r)) return 'stop';
    if (r.terminal !== null) return 'stop';
    // A pause raised on an earlier item means the loop must unwind and wait,
    // not push the next file at a server that just refused one.
    if (isPaused(r)) return 'continue';
    if (isItemBatchEligible(item)) continue;
    if ((await runMediaForItem(r, item)) === 'stop') return 'stop';
  }
  return r.terminal === null ? 'continue' : 'stop';
}

/** One cycle: media for a page, then one or more batches out of it. */
async function runCycle(r: ActiveRun): Promise<Step> {
  const page = nextPendingItems(r);
  if (page.length === 0) return 'continue';

  const media = await runMediaPhase(r, page);
  if (media === 'stop') return 'stop';
  if (isPaused(r) || stopped(r)) return 'continue';

  const fresh = nextPendingItems(r).filter(isItemBatchEligible);
  if (fresh.length === 0) return 'continue';

  try {
    // The pin is re-verified per item inside `sealContent`; this is the cheap
    // gate that stops a whole batch being built under a key that has moved.
    await r.keySession?.verifyGroupKeyPin();
  } catch (e) {
    const step = await handleFailure(r, e, 'crypto');
    return step === 'stop' ? 'stop' : 'continue';
  }

  const { built, step } = await buildBatchItems(r, fresh);
  if (step === 'stop') return 'stop';
  if (built.length === 0) return 'continue';
  return submitBuiltItems(r, built);
}

/**
 * Drain the job: media, batches, pauses, and the one end-of-run pass for files
 * the orbit had no room for.
 */
async function pumpRun(r: ActiveRun): Promise<void> {
  for (;;) {
    await waitUntilResumed(r);
    if (stopped(r) || r.terminal !== null) return;

    const before = countPending(r);
    const step = await runCycle(r);
    if (step === 'stop') return;

    if (isPaused(r)) continue;
    const after = countPending(r);
    if (after > 0 && after === before) {
      // Every item in a cycle either becomes submittable, is failed, or is
      // parked OUT of the pending queue, so an unchanged queue with no pause
      // means the loop cannot make progress. One such cycle is survivable —
      // a stale claim re-reads the same page — two in a row is a bug, and
      // spinning on it would burn the member's battery in silence.
      r.idleCycles += 1;
      if (r.idleCycles >= 2) {
        failRunWith(r, 'CLIENT_BUG', 'batch');
        return;
      }
      continue;
    }
    r.idleCycles = 0;
    if (after > 0) continue;

    if (r.parked.size > 0 && !r.endOfRunPass) {
      startEndOfRunPass(r);
      continue;
    }
    return;
  }
}

function countPending(r: ActiveRun): number {
  return countImportItemsByStatus(r.jobId).pending;
}

/**
 * The single end-of-run retry for files parked on `IMPORT_QUOTA_EXCEEDED`.
 *
 * `endOfRunPass` is what turns the next quota refusal into
 * `item-failed('QUOTA')` instead of another park, so the pass can run exactly
 * once (F4: the refusal can mean media COUNT, in which case waiting never
 * helps).
 */
function startEndOfRunPass(r: ActiveRun): void {
  r.endOfRunPass = true;
  const parked = [...r.parked];
  r.parked.clear();
  if (isRunStale(workGuard(r))) return;
  requeueImportItems(r.jobId, { from: 'uploading', itemIds: parked });
}

// ---------------------------------------------------------------------------
// Completion (§4.12)
// ---------------------------------------------------------------------------

function buildSummary(r: ActiveRun): ImportSummary {
  const counts = countImportItemsByStatus(r.jobId);
  const skips = countImportSkipsByReason(r.jobId);
  // `uploading` is the schema's only parking space, so it holds three
  // different facts at once: a batch claim the run never sent, a post held for
  // video, and a file parked for the orbit's quota. Only the FIRST of those is
  // deducted here, via `r.held`, because only a held post has a line of its
  // own; counting it twice would tell the member that more posts did not
  // migrate than there are posts.
  //
  // A quota park is NOT deducted, and that is the fix for the vanishing rows
  // (#993 fold round): a terminal that arrives before the end-of-run pass
  // leaves those rows parked and unreported, so they were subtracted from
  // `notSubmitted` and appeared on no line at all. Still-parked IS still
  // queued — the row stays `uploading`, which a later resume requeues — so the
  // honest line for it is `notSubmitted`, and that makes this identical to
  // {@link undrainedWork}: both exempt `r.held` and nothing else, so the six
  // lines sum to the importable total in every ending.
  return {
    created: counts.created,
    duplicate: counts.duplicate,
    failed: counts.failed,
    // Parse-time holds and the post-extract ones are the same fact to the
    // member, reported separately from failures per the issue AC. `held.size`,
    // never a counter beside it: see {@link ActiveRun.held}.
    heldVideo: skips.held_video + r.held.size,
    skippedByReason: skips,
    notSubmitted: Math.max(0, counts.pending + counts.uploading - r.held.size),
    errorCode: r.terminal,
    cancelled: r.cancelled,
  };
}

function terminalStatusFor(r: ActiveRun): TerminalImportJobStatus {
  if (r.cancelled) return 'cancelled';
  return r.terminal === null ? 'completed' : 'failed';
}

/**
 * Items this run would still have to send before `completed` is true.
 *
 * `completed` is a claim about the QUEUE, not about having reached the end of a
 * function — and {@link terminalStatusFor} answers `completed` for ANY run that
 * reaches it with no terminal code, which is how four different dropped
 * verdicts each reported a failed import as a success (#993 rounds 1 and 2).
 *
 * `uploading` is the schema's only parking space, so the held set is subtracted
 * from it: a post held for video is reported on its own line and is not work
 * this run can do. Everything else that is still `uploading` — a batch claim
 * that was never sent, a quota park the end-of-run pass never reached — is
 * undrained work, and so is anything still `pending`.
 *
 * Deliberately the SAME arithmetic as {@link buildSummary}'s `notSubmitted`:
 * the number the member is shown and the number that decides whether
 * `completed` is honest must not be able to disagree.
 */
function undrainedWork(r: ActiveRun): number {
  const counts = countImportItemsByStatus(r.jobId);
  return counts.pending + Math.max(0, counts.uploading - r.held.size);
}

/**
 * The fail-safe: a run that did not drain and has no verdict of its own is a
 * client bug, never a success.
 *
 * This is the CLASS fix for the dropped-verdict family. Every caller of
 * {@link settleRun} is meant to have set `terminal`, `cancelled` or
 * `serverFinished` before it gets here; one that has not, with work still in
 * the queue, is reporting a success it cannot support, and the next dropped
 * verdict would do it again. `CLIENT_BUG` is deliberately the code: the member
 * sees "something went wrong, nothing was lost" and the job row is `failed`,
 * which `requeueImportItems` can resume — and one Sentry event names the seam.
 */
function assertDrainedOrFail(r: ActiveRun): void {
  if (r.terminal !== null || r.cancelled || r.serverFinished) return;
  if (undrainedWork(r) === 0) return;
  r.terminal = 'CLIENT_BUG';
}

/**
 * Release everything the run held and publish the summary.
 *
 * Order is load-bearing: release the archive parts BEFORE `finishImportJob`,
 * which NULLs the bookmark, so a terminal job never leaves a grant behind with
 * no record of which parts it held. The key session closes last, in a
 * `finally` that also covers the abort path.
 *
 * Once the run has been RESET this writes nothing at all — no `complete`, no
 * `finishImportJob`, no summary, no Sentry event (rule 0).
 *
 * {@link assertDrainedOrFail} runs immediately before the status is written: a
 * caller that arrives here with no verdict and work still queued gets `failed`,
 * never `completed`.
 */
async function settleRun(r: ActiveRun): Promise<void> {
  if (r.settled) return;
  r.settled = true;

  const archive = r.archive;
  r.archive = null;

  try {
    if (archive !== null) {
      const parts = archive.parts;
      archive.close();
      if (!wiped(r)) {
        await releaseArchiveParts(parts).catch(() => {
          // A grant we cannot release is `releaseAllPersistedParts`'s problem
          // on the next wipe; it must not stop the run from finishing.
        });
      }
    }

    if (wiped(r)) return;

    // EVERY settled run with a session completes it, not just the successful
    // one (§4.12). An open session's `declared_bytes` is reserved against the
    // ORBIT's quota — other members' uploads are refused on it — until the
    // member completes it or B#318's GC reaps it up to six hours later, so a
    // cancel or a terminal failure that walks away is a lien on the orbit for
    // no reason. A session that is no longer open answers 409 `IMPORT_CLOSED`,
    // which the classifier already owns.
    //
    // A RESET run never gets here: the `wiped` guard above is what keeps a
    // logout or a wipe from making any network call at all (rule 0).
    if (r.importId !== null) {
      if (r.cancelled) {
        // On the cancelled path the courtesy still goes out, but it is NOT
        // awaited: the response can no longer change this run's verdict (a
        // cancel stays a cancel), and offline the member would watch the
        // summary sit behind the transport's 15 s timeout.
        void completeImport(r.importId).catch(() => {
          // Best effort. B#318's GC reaps the session either way.
        });
      } else {
        try {
          await completeImport(r.importId);
        } catch (e) {
          // A session the server already finished is still a finished import.
          const verdict = classifyImportFailure(e, failureContext(r, 'complete'));
          // Only when the run had no verdict of its own: the reason the run
          // stopped is the one the member is shown.
          if (verdict.kind === 'job-terminal' && r.terminal === null) {
            r.terminal = verdict.code;
          } else if (verdict.kind === 'finish-completed') {
            r.serverFinished = true;
          }
        }
      }
    }

    if (wiped(r)) return;

    assertDrainedOrFail(r);
    const summary = buildSummary(r);
    finishImportJob(r.jobId, terminalStatusFor(r));
    if (r.terminal !== null && !r.cancelled) {
      captureImportFailure(r, 'complete', r.terminal);
    }

    update(
      {
        phase: 'done',
        summary,
        created: summary.created,
        duplicate: summary.duplicate,
        failed: summary.failed,
        heldVideo: summary.heldVideo,
        skipped: counted(summary.skippedByReason),
        errorCode: summary.errorCode,
        pauseCauses: NO_PAUSE,
        resumeAtMs: null,
        needsRepick: false,
      },
      true,
    );

    // The `import_completed` broadcast only lands if the socket is up, so the
    // refetch is a belt. #927 adds the WS case; `loadThreadsForGroup` is
    // idempotent, so the two cannot double-apply.
    void loadThreadsForGroup(r.conversationId).catch(() => {
      // Nothing the member can act on: the threads arrive on the next open.
    });
  } finally {
    r.keySession?.close();
    r.keySession = null;
    detachAppState(r);
    for (const cause of r.pauseTimers.keys()) clearPauseTimer(r, cause);
    releaseWaiters(r);
    endImportCaptureBudget();
    // This run spent part of the member's lifetime allowance, so the cached
    // `GET /imports` answer for this orbit is now stale by exactly what it
    // created. A second import in the same app session would otherwise be
    // gated against the PRE-run `posts_used`, pass preflight, and then be
    // refused at start with `IMPORT_ALLOWANCE_EXCEEDED` — a terminal plus a
    // Sentry event for a condition the preflight exists to catch.
    probeCache.delete(r.conversationId);
    if (r === run) run = null;
  }
}

function counted(byReason: Readonly<Record<SkipReason, number>>): number {
  return Object.values(byReason).reduce((sum, n) => sum + n, 0);
}

// ---------------------------------------------------------------------------
// Starting a run
// ---------------------------------------------------------------------------

function newRun(
  job: ImportJobRow,
  limits: ImportLimits,
  keySession: ImportKeySession | null,
): ActiveRun {
  liveToken += 1;
  return {
    token: liveToken,
    jobId: job.id,
    conversationId: job.conversation_id,
    source: job.source,
    controller: new AbortController(),
    limits,
    keySession,
    archive: null,
    importId: job.session_id,
    declaredPosts: job.declared_posts ?? 0,
    declaredBytes: job.declared_bytes ?? 0,
    batchSize: batchSizeLimit(limits),
    pauseCauses: new Set<PauseCause>(),
    pauseTimers: new Map(),
    pauseAttempts: new Map(),
    pauseWaiters: [],
    resumeAtMs: null,
    appStateSub: null,
    pickerOpen: false,
    created: 0,
    duplicate: 0,
    failed: 0,
    mediaDone: 0,
    held: new Set<string>(),
    parked: new Set<string>(),
    stagedMedia: new Set<string>(),
    endOfRunPass: false,
    idleCycles: 0,
    clientBugCount: 0,
    terminal: null,
    cancelled: false,
    serverFinished: false,
    settled: false,
  };
}

/**
 * Run one job from its current status to a terminal one.
 *
 * Never rejects: a failure becomes a terminal code on the summary, because the
 * two callers ({@link confirmAndRunImport} and {@link resumeImportAtLaunch})
 * are both fire-and-forget and a rejection would only become a log line.
 */
async function runJob(
  job: ImportJobRow,
  limits: ImportLimits,
  keySession: ImportKeySession,
): Promise<void> {
  const r = newRun(job, limits, keySession);
  run = r;
  beginImportCaptureBudget();
  // A run exists, so every pre-run wait is over: the gate that was being
  // retried got through, and its counter must not carry into the next launch.
  clearPreRunRetry();

  const counts = countImportItemsByStatus(job.id);
  update(
    {
      phase: 'running',
      jobId: job.id,
      conversationId: job.conversation_id,
      source: job.source,
      needsRepick: false,
      total: job.declared_posts ?? importableTotal(counts),
      created: counts.created,
      duplicate: counts.duplicate,
      failed: counts.failed,
      skipped: counted(countImportSkipsByReason(job.id)),
      pauseCauses: NO_PAUSE,
      resumeAtMs: null,
      summary: null,
      errorCode: null,
    },
    true,
  );
  r.created = counts.created;
  r.duplicate = counts.duplicate;
  r.failed = counts.failed;
  // AFTER the initial publish, which would otherwise overwrite a `background`
  // pause this adds for a run started while the app is already suspended.
  attachAppState(r);

  // A courtesy to OTHER pending members, never awaited and never the fix for
  // our own `key_pending`: a pending member's own `getPendingWraps` is
  // answered 403 and swallowed, so this cannot clear our wrap (§4.8).
  void fulfillPendingWraps().catch(() => {
    // Fire-and-forget by contract.
  });

  try {
    if ((await ensureServerSession(r, job)) === 'stop') {
      await settleRun(r);
      return;
    }
    // A kill between `markItemsUploading` and `applyBatchResults` leaves rows
    // `getPendingImportItems` can never see again, so this runs BEFORE the
    // first page is read.
    if (!isRunStale(workGuard(r))) requeueImportItems(r.jobId, { from: 'uploading' });
    await pumpRun(r);
  } catch (e) {
    // The classification still runs — a cancel must stay a cancel, and a
    // `PendingWrapError` that escaped is not a client bug — but its STEP is
    // worthless here: the pump has already unwound, so there is nothing left to
    // retry and no loop to pause into.
    await handleFailure(r, e, 'batch');
    if (r.terminal === null && !r.cancelled && !wiped(r)) {
      // Whatever it was, it escaped every step that had an answer for it.
      // Leaving `terminal` null here is what let a thrown TypeError settle as a
      // successful import (#993 fold round, blocker 2).
      failRunWith(r, 'CLIENT_BUG', 'batch');
    }
  }
  await settleRun(r);
}

function importableTotal(counts: Record<string, number>): number {
  return (
    (counts.pending ?? 0) +
    (counts.uploading ?? 0) +
    (counts.created ?? 0) +
    (counts.duplicate ?? 0) +
    (counts.failed ?? 0)
  );
}

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

function retentionDaysFor(conversationId: string): number | null {
  return useAppStore.getState().conversations[conversationId]?.contentRetentionDays ?? null;
}

/**
 * Turn an allowance plus a count into the preflight, including the §4.5
 * refusal: an archive over the REMAINING lifetime allowance is refused whole.
 *
 * Nothing is trimmed. The caps are per-(orbit, member) LIFETIME caps, so
 * partially submitting an over-size archive would spend the member's remaining
 * allowance on an arbitrary subset and leave them unable to import the rest
 * anywhere.
 */
function buildPreflight(args: {
  conversationId: string;
  allowance: ImportAllowance;
  limits: ImportLimits;
  importable: number;
  estimatedBytes: number;
  heldVideo: number;
  skippedByReason: Readonly<Record<SkipReason, number>>;
  summary: ParseSummary | null;
}): ImportPreflight {
  const remainingPosts = Math.max(0, args.allowance.postsLimit - args.allowance.postsUsed);
  const remainingBytes = Math.max(0, args.allowance.bytesLimit - args.allowance.bytesUsed);
  const overAllowance =
    args.importable > remainingPosts
      ? 'posts'
      : args.estimatedBytes > remainingBytes
        ? 'bytes'
        : null;

  return {
    summary: args.summary,
    allowance: args.allowance,
    limits: args.limits,
    contentRetentionDays: retentionDaysFor(args.conversationId),
    importable: args.importable,
    remainingPosts,
    estimatedBytes: args.estimatedBytes,
    remainingBytes,
    overAllowance,
    nothingToImport: args.importable < 1,
    heldVideo: args.heldVideo,
    skippedByReason: args.skippedByReason,
  };
}

/**
 * Is this preflight something a run can be started from?
 *
 * One predicate for the two refusals, so the three places that must agree —
 * `parseIntoJob`'s `setImportJobParsed`, `pickAndStartParse`'s release arm and
 * {@link confirmAndRunImport}'s guard — cannot drift apart. Neither refusal
 * starts a server session, writes a terminal code or reports anything: the
 * member is told what the archive holds and offered a different export.
 */
function isPreflightRunnable(preflight: ImportPreflight): boolean {
  return preflight.overAllowance === null && !preflight.nothingToImport;
}

/** The preflight for a `ready` job, rebuilt from SQLite plus a fresh GET. */
async function rebuildPreflight(job: ImportJobRow): Promise<ImportPreflight | null> {
  let allowance: ImportAllowance;
  let limits: ImportLimits;
  try {
    const response = await getGroupImports(job.conversation_id);
    allowance = response.allowance;
    limits = response.limits;
  } catch {
    // Without a fresh allowance there is nothing honest to show; #928 offers
    // the job again on the next launch.
    return null;
  }

  const counts = countImportItemsByStatus(job.id);
  const skips = countImportSkipsByReason(job.id);
  return buildPreflight({
    conversationId: job.conversation_id,
    allowance,
    limits,
    importable: job.declared_posts ?? importableTotal(counts),
    estimatedBytes: job.declared_bytes ?? 0,
    heldVideo: skips.held_video,
    skippedByReason: skips,
    summary: null,
  });
}

// ---------------------------------------------------------------------------
// Public API (§4.2)
// ---------------------------------------------------------------------------

/**
 * Is importing available in this orbit, and under what allowance?
 *
 * The flag gate sits ABOVE `authenticate`, so a server with `IMPORTS_ENABLED`
 * off answers 404 byte-identically to an unknown route — and the flag is off
 * in production today. Without this probe every member on 1.7.8 would cross
 * orbit settings, the how-to screen and the OS picker before finding out.
 *
 * Cached per app session per orbit, and cleared by
 * {@link resetImportRunnerState} so the next account on this device re-probes.
 * A 404 is cached; anything else PROPAGATES, because caching a transient
 * network failure as "unavailable" would hide the feature until the next
 * launch.
 */
export async function probeImportAvailability(conversationId: string): Promise<ImportAvailability> {
  const cached = probeCache.get(conversationId);
  if (cached !== undefined) return cached;

  try {
    const response = await getGroupImports(conversationId);
    const available: ImportAvailability = {
      available: true,
      allowance: response.allowance,
      limits: response.limits,
    };
    probeCache.set(conversationId, available);
    return available;
  } catch (e) {
    if (e instanceof NotFoundError) {
      const unavailable: ImportAvailability = {
        available: false,
        allowance: null,
        limits: null,
      };
      probeCache.set(conversationId, unavailable);
      return unavailable;
    }
    throw e;
  }
}

/**
 * Pick an archive, parse it, and answer with the preflight.
 *
 * `createImportJob` throws when a non-terminal job exists — one import at a
 * time per device — so that refusal is TYPED here rather than surfacing as an
 * unhandled rejection after the member has already chosen their files.
 */
export async function pickAndStartParse(args: {
  conversationId: string;
  source: ImportSource;
}): Promise<PickParseResult> {
  const existing = getActiveImportJob();
  if (existing !== null) {
    return { kind: 'refused', reason: 'job-running', conversationId: existing.conversation_id };
  }

  let tokens: readonly ArchivePartToken[] | null;
  try {
    tokens = await pickArchiveParts();
  } catch {
    // `PICKER_BUSY` and a cancelled picker are the same thing to the caller:
    // nothing was chosen, and there is no run to pause.
    return { kind: 'cancelled' };
  }
  if (tokens === null || tokens.length === 0) return { kind: 'cancelled' };

  const jobId = generateUUID();
  let archive: ArchiveImportSession | null = null;
  let keySession: ImportKeySession | null = null;
  let created = false;

  try {
    archive = await openArchiveSession(tokens);
    // Opened BEFORE the job row, because `key_fingerprint` is NOT NULL from
    // creation: a `ready` job's stored identities carry the generation stamp
    // they were derived under (#921).
    keySession = await openImportKeySession({
      groupId: args.conversationId,
      source: args.source,
    });

    createImportJob({
      id: jobId,
      conversationId: args.conversationId,
      source: args.source,
      keyFingerprint: keySession.keyFingerprint,
      createdAt: Date.now(),
    });
    created = true;
    setArchiveBookmark(jobId, JSON.stringify(archive.parts));

    update(
      {
        phase: 'parsing',
        jobId,
        conversationId: args.conversationId,
        source: args.source,
        preflight: null,
        needsRepick: false,
        total: 0,
        created: 0,
        duplicate: 0,
        failed: 0,
        skipped: 0,
        heldVideo: 0,
        mediaDone: 0,
        mediaTotal: 0,
        parseProgress: null,
        pauseCauses: NO_PAUSE,
        resumeAtMs: null,
        summary: null,
        errorCode: null,
      },
      true,
    );

    const preflight = await parseIntoJob({
      jobId,
      conversationId: args.conversationId,
      source: args.source,
      archive,
      keySession,
    });
    if (preflight === null) return { kind: 'cancelled' };

    if (!isPreflightRunnable(preflight)) {
      // §4.5.4: refuse the archive whole — over the remaining allowance, or
      // with nothing importable in it at all. No server session was started,
      // so the refusal consumes none of the member's allowance.
      await releaseArchiveParts(archive.parts).catch(() => {});
      archive.close();
      archive = null;
      finishImportJob(jobId, 'cancelled');
    }

    update({ phase: 'ready', preflight, total: preflight.importable }, true);
    return { kind: 'preflight', preflight };
  } catch {
    // Every parse failure is the same thing to the member at this point: the
    // archive could not be read, and nothing has been uploaded. The job row is
    // dropped rather than left for a resume that would re-pick anyway.
    if (created) deleteImportJob(jobId);
    update({ phase: 'idle', jobId: null, preflight: null, parseProgress: null }, true);
    return { kind: 'cancelled' };
  } finally {
    keySession?.close();
    if (archive !== null) {
      archive.close();
      if (getImportJob(jobId) === null) {
        await releaseArchiveParts(tokens).catch(() => {});
      }
    }
  }
}

/**
 * Parse one archive into the job, accumulating the preflight as it goes.
 *
 * `declaredSize` is summed only for the media of IMPORTABLE posts whose entry
 * the listing did not skip — the one moment both facts are in hand — and each
 * contribution is clamped and given re-encode headroom by
 * `estimateImportBytes`, because the central directory's uncompressed size is
 * unvalidated and export-controlled.
 */
async function parseIntoJob(args: {
  jobId: string;
  conversationId: string;
  source: ImportSource;
  archive: ArchiveImportSession;
  keySession: ImportKeySession;
}): Promise<ImportPreflight | null> {
  const declaredByEntry = new Map<string, number>();
  for (const entry of args.archive.entries) {
    if (entry.skip === null) declaredByEntry.set(entry.entryId, entry.declaredSize);
  }

  const buffer: ImportItemInsert[] = [];
  let ordinal = 0;
  let estimatedBytes = 0;

  const flush = (): void => {
    if (buffer.length === 0) return;
    insertImportItems(args.jobId, buffer);
    buffer.length = 0;
  };

  const summary = await parseArchive(args.archive, {
    source: args.source,
    deriveImportKey: (sourceItemId) => args.keySession.deriveImportKey(sourceItemId),
    onItem: async (item, importKey) => {
      const index = ordinal;
      ordinal += 1;
      if (item.outcome === 'import') {
        for (const media of item.media) {
          const declared = declaredByEntry.get(media.entryId);
          if (declared !== undefined) estimatedBytes += estimateImportBytes(declared);
        }
        buffer.push({
          id: generateUUID(),
          ordinal: index,
          importKey,
          status: 'pending',
          skipReason: null,
          originalDate: item.originalDate,
          body: item.body,
          sourceFile: item.sourceFile,
          sourceIndex: item.sourceIndex,
          idKind: item.idKind,
          media: item.media.map((media, i) => ({
            ordinal: i,
            mediaId: generateUUID(),
            entryId: media.entryId,
            originalDate: media.originalDate,
          })),
        });
      } else {
        buffer.push({
          id: generateUUID(),
          ordinal: index,
          importKey,
          status: 'skipped',
          skipReason: item.reason,
          originalDate: item.originalDate,
          body: null,
          sourceFile: item.sourceFile,
          sourceIndex: item.sourceIndex,
          idKind: item.idKind,
        });
      }
      if (buffer.length >= PARSE_FLUSH_SIZE) flush();
    },
    onProgress: (progress: ParseProgress) => {
      update({ parseProgress: progress }, false);
    },
  });
  flush();

  const probe = await probeImportAvailability(args.conversationId);
  if (probe.allowance === null || probe.limits === null) return null;

  const skips = countImportSkipsByReason(args.jobId);
  const preflight = buildPreflight({
    conversationId: args.conversationId,
    allowance: probe.allowance,
    limits: probe.limits,
    importable: summary.importable,
    estimatedBytes,
    heldVideo: skips.held_video,
    skippedByReason: skips,
    summary,
  });

  if (isPreflightRunnable(preflight)) {
    // A `false` means the job left `parsing` underneath us — cancelled from
    // the UI, or wiped — and writing anyway would resurrect it.
    if (
      !setImportJobParsed(args.jobId, {
        declaredPosts: preflight.importable,
        declaredBytes: Math.floor(preflight.estimatedBytes),
      })
    ) {
      return null;
    }
  }

  return preflight;
}

/**
 * Start the run the member just confirmed.
 *
 * Resolves when the run has SETTLED, which for a paused run means after the
 * pause clears or the run is cancelled or reset. It never rejects: call it
 * fire-and-forget and read progress from {@link importStore}.
 */
export async function confirmAndRunImport(): Promise<void> {
  if (run !== null) return;
  const job = getActiveImportJob();
  if (job === null || job.status !== 'ready') return;
  // A refused preflight — over the remaining allowance, or with nothing
  // importable in it — already finished its job as `cancelled`. This is both
  // the belt for that and the whole gate for a `ready` job rebuilt at launch,
  // whose counts can leave nothing to submit: `declared_posts` must be
  // `1..1000`, so running it would be answered `IMPORT_DECLARED_INVALID`.
  const preflight = draft.preflight;
  if (preflight !== null && !isPreflightRunnable(preflight)) return;
  await enterJob(job, { autoStart: true });
}

/**
 * Clear the pause causes a member action can clear, and retry now.
 *
 * `background` and `needs_repick` are deliberately untouched: the first clears
 * when the app comes forward, the second only through
 * {@link repickArchiveParts}. `rate_limited` and `allowance_wait` are not ours
 * to shorten either — the first is the server's own wait, and the second is a
 * ceiling that a sooner retry can only re-learn.
 */
export function resumeImport(): void {
  const r = run;
  if (r === null) {
    // A pause raised before the run existed — a pending wrap, or a launch-time
    // session GET that failed retryably. The exit is the launch path itself,
    // re-entered now instead of on its timer, and the member's tap is new
    // information, so the budget starts again.
    //
    // `rate_limited` is excluded for the same reason it is below: the wait is
    // the server's own and is not ours to shorten.
    if (preRunCause !== null && preRunCause !== 'rate_limited') {
      clearPreRunRetry();
      void resumeImportAtLaunch().catch(() => {
        // The gate re-arms its own timer on a second failure.
      });
    }
    return;
  }
  dropPause(r, 'network');
  dropPause(r, 'archive_retry');
  dropPause(r, 'key_pending');
}

/**
 * Re-pick the archive for a run paused on `needs_repick`.
 *
 * The acceptance rule is the archive reader's own: the new parts are accepted
 * only if the session OPENS without `ARCHIVE_CHANGED` — the tokens carry
 * per-part fingerprints, so "is this the same archive" is a question only the
 * reader can answer. A different archive RESTARTS the job rather than being
 * continued against stored `entryId`s, which are content-derived per part and
 * meaningless against other bytes.
 */
export async function repickArchiveParts(): Promise<RepickResult> {
  const r = run;
  if (r === null) return 'cancelled';

  r.pickerOpen = true;
  let tokens: readonly ArchivePartToken[] | null;
  try {
    tokens = await pickArchiveParts();
  } catch {
    return 'cancelled';
  } finally {
    r.pickerOpen = false;
  }
  if (tokens === null || tokens.length === 0) return 'cancelled';

  let session: ArchiveImportSession;
  try {
    session = await openArchiveSession(tokens, { signal: r.controller.signal });
  } catch (e) {
    const code = archiveErrorCode(e);
    if (code === 'ARCHIVE_CHANGED' || code === 'ARCHIVE_ACCESS_LOST') {
      await restartForDifferentArchive(r);
      return 'different-archive';
    }
    // The verdict's own step is `stop` or `continue` and there is no loop here
    // to hand it to — but a TERMINAL raised while the pump is parked on
    // `needs_repick` must release that park, or the run hangs paused for ever.
    await handleFailure(r, e, 'archive');
    wakeForTerminal(r);
    return 'cancelled';
  }

  const stored = getImportJob(r.jobId)?.archive_bookmark ?? null;
  if (!persistBookmark(r, session, stored)) {
    session.close();
    return 'cancelled';
  }

  r.archive?.close();
  r.archive = session;
  dropPause(r, 'needs_repick');
  return 'resumed';
}

/**
 * A re-pick that produced a DIFFERENT archive: drop the job whole.
 *
 * Stored `entryId`s are content-derived per part, so none of them addresses
 * anything in the new files. #928 offers a fresh pick, which re-parses; posts
 * already created come back `duplicate` from the `import_key` dedup.
 */
async function restartForDifferentArchive(r: ActiveRun): Promise<void> {
  const stored = getImportJob(r.jobId)?.archive_bookmark ?? null;
  const parts = parsePartTokens(stored);
  r.archive?.close();
  r.archive = null;
  if (parts !== null) await releaseArchiveParts(parts).catch(() => {});
  if (!wiped(r)) deleteImportJob(r.jobId);

  r.terminal = null;
  r.cancelled = true;
  r.settled = true;
  detachAppState(r);
  for (const cause of [...r.pauseTimers.keys()]) clearPauseTimer(r, cause);
  r.pauseCauses.clear();
  r.keySession?.close();
  r.keySession = null;
  r.controller.abort();
  releaseWaiters(r);
  endImportCaptureBudget();
  run = null;
  update({ ...INITIAL_STATE, phase: 'idle' }, true);
}

/**
 * Stop the run. Posts already created stay created — a thread cannot be
 * recalled — so the summary reports what landed rather than claiming the run
 * was undone.
 *
 * NOT a wipe: the terminal status and the summary are still written, which is
 * the whole difference between this and {@link resetImportRunnerState}.
 */
export function cancelImport(): void {
  const r = run;
  if (r === null) return;
  r.cancelled = true;
  r.controller.abort();
  for (const cause of [...r.pauseTimers.keys()]) clearPauseTimer(r, cause);
  r.pauseCauses.clear();
  releaseWaiters(r);
}

/** Clear the summary card. No-op unless a finished run is being reported. */
export function dismissImportSummary(): void {
  if (draft.phase !== 'done') return;
  update({ ...INITIAL_STATE, phase: 'idle' }, true);
}

/**
 * What did NOT migrate, as an item list (Alex, 2026-10-26): members see WHAT
 * was skipped, not just how many.
 *
 * Wrapped here so no screen reaches into `importRepository`. The rows carry
 * `source_file`, which is LOCAL-UI-class: it may be rendered and must never be
 * logged, uploaded or put in an envelope.
 */
export function getImportSkipDetails(reason?: SkipReason): SkippedImportItem[] {
  const jobId = draft.jobId;
  if (jobId === null) return [];
  return getSkippedItems(jobId, reason);
}

/**
 * Re-derive the store from SQLite at launch, and auto-resume an in-flight run.
 *
 * **Gated on the authenticated phase.** `postAuthBootstrap` runs inside
 * `restoreSession` before the navigator picks a phase, and `key-recovery`,
 * `key-conflict` and `terms-required` each replace the whole UI — so a resume
 * there would upload media behind a gate where the member has no progress
 * indicator and no cancel. The store still LEAVES `'hydrating'` on every path,
 * including this early return, because "not checked yet" and "nothing running"
 * must be distinguishable.
 */
export async function resumeImportAtLaunch(): Promise<void> {
  const state = useAppStore.getState();
  const phase = deriveAuthPhase({
    // The navigator's own `restoreDone` is local to `AppContent`; by the time
    // this runs, restore is what called us.
    restoreDone: true,
    isAuthenticated: state.isAuthenticated,
    needsTermsAcceptance: state.needsTermsAcceptance,
    identityKeyConflict: state.identityKeyConflict,
    keyRecoveryInProgress: state.keyRecoveryInProgress,
  });
  if (phase !== 'authenticated') {
    update({ phase: 'idle' }, true);
    return;
  }

  if (run !== null) return;
  const job = getActiveImportJob();
  if (job === null) {
    update({ ...INITIAL_STATE, phase: 'idle' }, true);
    return;
  }
  await enterJob(job, { autoStart: false });
}

/**
 * The fingerprint gate, the status dispatch, and the run (§4.4, §4.9).
 *
 * One function for both entry points so the gate cannot drift: `autoStart`
 * only decides what a `ready` job does — present itself, or run.
 */
async function enterJob(job: ImportJobRow, options: { autoStart: boolean }): Promise<void> {
  let keySession: ImportKeySession | null = null;
  try {
    keySession = await openImportKeySession({
      groupId: job.conversation_id,
      source: job.source,
    });
  } catch {
    // `PendingWrapError` / `GroupKeyUnwrapError`: the open threw, so there is
    // no session to close and the job is untouched. The 30 s pending-cache
    // self-heal is the wake-up (§4.3.1), armed here because there is no run
    // to hang the timer on yet.
    pauseJobBeforeRun(job, 'key_pending');
    return;
  }
  clearPreRunRetryFor('key_pending');

  // The stamp belongs to the key generation the identities were derived under.
  // A mismatch means this device's key has changed: `close()` runs BEFORE the
  // job is dropped, so the session never outlives the job it was rejected for.
  if (keySession.keyFingerprint !== job.key_fingerprint) {
    try {
      const parts = parsePartTokens(job.archive_bookmark);
      keySession.close();
      keySession = null;
      if (parts !== null) await releaseArchiveParts(parts).catch(() => {});
      deleteImportJob(job.id);
    } finally {
      keySession?.close();
    }
    update({ ...INITIAL_STATE, phase: 'idle' }, true);
    return;
  }

  try {
    if (job.status === 'parsing') {
      // A parse that never finished has no resumable state: the items it had
      // written are a prefix of an archive we would have to re-read anyway.
      const parts = parsePartTokens(job.archive_bookmark);
      if (parts !== null) await releaseArchiveParts(parts).catch(() => {});
      deleteImportJob(job.id);
      update({ ...INITIAL_STATE, phase: 'idle' }, true);
      return;
    }

    if (job.status === 'ready') {
      if (!options.autoStart) {
        const preflight = await rebuildPreflight(job);
        update(
          {
            phase: preflight === null ? 'idle' : 'ready',
            jobId: job.id,
            conversationId: job.conversation_id,
            source: job.source,
            preflight,
            total: preflight?.importable ?? 0,
            skipped: counted(countImportSkipsByReason(job.id)),
          },
          true,
        );
        return;
      }
      const limits = draft.preflight?.limits ?? (await rebuildPreflight(job))?.limits;
      // No fresh allowance means nothing honest to run against. The job is
      // untouched; `phase` still LEAVES `'hydrating'` so the UI can tell
      // "nothing running" from "not checked yet" (§4.3).
      if (limits === undefined) {
        update({ phase: 'idle' }, true);
        return;
      }
      const session = keySession;
      keySession = null;
      await runJob(job, limits, session);
      return;
    }

    // `in_progress`: the per-session GET is mandatory. The group preflight
    // cannot report an abandon (`openImport` is null either way), and an
    // abandoned session has released its staged uploads.
    const sessionId = job.session_id;
    if (sessionId === null) {
      const limits = (await rebuildPreflight(job))?.limits;
      if (limits === undefined) {
        update({ phase: 'idle' }, true);
        return;
      }
      const live = keySession;
      keySession = null;
      await runJob(job, limits, live);
      return;
    }

    let limits: ImportLimits;
    let status: string;
    try {
      const session = await getImportSession(sessionId);
      limits = session.limits;
      status = session.status;
    } catch (e) {
      // A 403 or 404 here is terminal: the session is not ours, or imports are
      // not available on this server at all.
      const held = keySession;
      keySession = null;
      await failJobBeforeRun(job, held, e);
      return;
    }

    if (status === 'closed') {
      const held = keySession;
      keySession = null;
      await failJobBeforeRun(job, held, null, 'SESSION_CLOSED');
      return;
    }

    const live = keySession;
    keySession = null;
    if (status === 'completed') {
      await finishJobWithoutRun(job, live);
      return;
    }
    // `abandoned` is handled by the run itself: the first write answers
    // `IMPORT_CLOSED` and `session-restart` opens a fresh session.
    await runJob(job, limits, live);
  } finally {
    keySession?.close();
  }
}

/**
 * The launch-time session GET failed, or answered `closed`.
 *
 * **Settles the job only when the classification is TERMINAL.** The verdict
 * computed for the error is the whole decision here: a `NetworkError` or a 5xx
 * classifies `retry-same-call` and a 429 classifies `pause('rate_limited')`,
 * and neither names a terminal code — so settling on them would finish the job
 * as `completed` (nothing set `r.terminal`, and `newRun` seeds `importId` from
 * `session_id`, so it would even POST `complete` and publish a summary with
 * `errorCode: null`) for an import that has not run and whose items are all
 * still pending.
 *
 * For those the job row is left exactly as it is and the store publishes a
 * PAUSE carrying the job's identity and the cause, with a bounded wake-up
 * armed — the same shape as the pre-run `key_pending` arm, and for the same
 * reason: the row stays `in_progress`, so `pickAndStartParse` rightly refuses
 * with `job-running`, and publishing `idle` instead left #928 with nothing to
 * render and no way to retry before the next relaunch. `resumeImport()`
 * re-enters this gate immediately.
 *
 * A cancelled classification publishes `idle` and arms nothing: under rule 0
 * there is nothing to wait for.
 */
async function failJobBeforeRun(
  job: ImportJobRow,
  keySession: ImportKeySession | null,
  error: unknown,
  code?: ImportTerminalCode,
): Promise<void> {
  const verdict = code === undefined ? launchVerdict(error) : null;
  const terminalCode = code ?? (verdict?.kind === 'job-terminal' ? verdict.code : null);
  if (terminalCode === null) {
    keySession?.close();
    const cause = launchPauseCause(verdict);
    if (cause === null) {
      update({ ...INITIAL_STATE, phase: 'idle' }, true);
      return;
    }
    pauseJobBeforeRun(job, cause);
    return;
  }

  const r = newRun(job, draft.preflight?.limits ?? FALLBACK_LIMITS, keySession);
  run = r;
  beginImportCaptureBudget();
  r.terminal = terminalCode;
  if (!wiped(r)) captureImportFailure(r, 'start', terminalCode);
  await settleRun(r);
}

/**
 * The verdict for a launch-time failure, classified with no `ActiveRun`.
 *
 * Deliberately so: there is nothing to settle unless the answer is terminal,
 * and building a run first is what made the discarded-verdict bug possible. The
 * guard is therefore the live token compared with itself — rule 0 has nothing
 * to collapse here, since this path writes nothing at all until a terminal is
 * in hand.
 */
function launchVerdict(error: unknown): ImportVerdict {
  return classifyImportFailure(error, {
    run: liveToken,
    currentRun: () => liveToken,
    stage: 'start',
  });
}

/**
 * The pre-run pause a non-terminal launch verdict waits on, or `null` when
 * there is nothing to wait for.
 *
 * `retry-same-call` (a `NetworkError` or a 5xx) becomes `network`: at this
 * point there is no stage loop to spend its ladder in, so the pause set's own
 * ladder and budget are what bound it.
 */
function launchPauseCause(verdict: ImportVerdict | null): PauseCause | null {
  if (verdict === null) return null;
  if (verdict.kind === 'pause') return verdict.cause;
  if (verdict.kind === 'retry-same-call') return 'network';
  // `cancelled` (rule 0) and the item/batch arms, which a session GET cannot
  // honestly produce: there is no bounded wait that would make either true.
  return null;
}

/** The server already finished this session; finish locally and report it. */
async function finishJobWithoutRun(
  job: ImportJobRow,
  keySession: ImportKeySession | null,
): Promise<void> {
  const r = newRun(job, draft.preflight?.limits ?? FALLBACK_LIMITS, keySession);
  // No `complete` call: the server has already finished this session, and a
  // second one would be a 200 that fires no broadcast anyway.
  r.importId = null;
  // Nothing we could send would be accepted, so items still queued are not
  // undrained work and `completed` is the honest status (see
  // {@link assertDrainedOrFail}).
  r.serverFinished = true;
  run = r;
  beginImportCaptureBudget();
  await settleRun(r);
}

/**
 * The server's own defaults, for the two paths that must settle a job without
 * having read `limits` from a live response.
 *
 * Only ever used to build a run that writes a terminal status and no payload,
 * so no value here can reach the wire.
 *
 * MIRRORS, and is not the source of truth for, `Orbital-Backend`'s
 * `src/config/imports.js` (`batchMax`, `mediaPerItemMax`, `metaMaxBytes`,
 * `minDate`, `mediaContentClasses`) and `src/config/contentLimits.js`
 * (`ivMax` = IV_MAX, `titleMax` = THREAD_TITLE_MAX, `bodyMax` =
 * THREAD_BODY_MAX), which `limitsWire()` advertises on every start response.
 * There is no drift detector across the repo boundary, and there does not need
 * to be: a live run always uses the ADVERTISED limits, and if these ever go
 * stale the only consequence is that a job already heading for a terminal
 * status is measured against last release's numbers.
 */
const FALLBACK_LIMITS: ImportLimits = Object.freeze({
  batchMax: 50,
  mediaPerItemMax: 100,
  metaMaxBytes: 1024,
  ivMax: 64,
  titleMax: 10_000,
  bodyMax: 100_000,
  minDate: '2004-01-01',
  mediaContentClasses: ['image' as const],
});

// ---------------------------------------------------------------------------
// Teardown (§4.13)
// ---------------------------------------------------------------------------

/**
 * Drop every piece of run state, including the published store.
 *
 * PRODUCTION, not a test seam: `localWipe` phase 1 and
 * `keyRecoveryService`'s pre-`fullCryptoWipe` arm both call it.
 *
 * **Synchronous, and it aborts the run's `AbortController` first.** That abort
 * is what runs each item's `finally`, where `archiveAccess`'s `release()` is
 * the TIMELY unlink of extracted plaintext. `localWipe`'s phase-2 suffix sweep
 * is the backstop and does match `-archive-staging.bin`, but it is one
 * non-recursive readDir: a file inflated after that listing survives it. An
 * `await` here would hand control back to the run being torn down, which then
 * gets to write exactly such a file.
 *
 * Bumping {@link liveToken} is rule 0's switch: every verdict after this is
 * `cancelled`, so the torn-down run writes no `failed` row, no
 * `finishImportJob` and no Sentry event on an ordinary logout. That bump is
 * also why `localWipe` calls this ABOVE `deleteAllImportJobs()`: below it, a
 * run one microtask from a repository write would write item rows against a
 * job the wipe has already deleted, and report the failure as terminal.
 */
export function resetImportRunnerState(): void {
  const r = run;
  run = null;
  liveToken += 1;

  if (r !== null) {
    r.settled = true;
    detachAppState(r);
    for (const cause of [...r.pauseTimers.keys()]) clearPauseTimer(r, cause);
    r.pauseCauses.clear();
    releaseWaiters(r);
    try {
      r.controller.abort();
    } catch {
      // An AbortController that throws on abort is not worth failing a wipe.
    }
    try {
      r.keySession?.close();
    } catch {
      // Best effort per session, same posture as `closeAllImportKeySessions`.
    }
    r.keySession = null;
    try {
      r.archive?.close();
    } catch {
      // The native session is aborted by `abortAllArchiveSessions` above us.
    }
    r.archive = null;
  }

  endImportCaptureBudget();
  clearPreRunRetry();
  // The next account on this device must re-probe: the allowance is
  // per-(orbit, member) and this one's is none of their business.
  probeCache.clear();
  if (emitTimer !== null) {
    clearTimeout(emitTimer);
    emitTimer = null;
  }
  importStore.setState(INITIAL_STATE, true);
  draft = importStore.getState();
}

/** Test alias for the production reset (`resetXForTesting` convention). */
export function resetImportRunnerForTesting(): void {
  resetImportRunnerState();
}
