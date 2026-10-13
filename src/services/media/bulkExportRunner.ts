/**
 * bulkExportRunner — the "Save all" batch for File Library (#878 PR 2).
 *
 * The screen owns the conversation with the user (disclosure, confirm, the
 * storage block); this module owns the RUN. It takes a snapshot once, walks it
 * with two workers through `mediaExportService`, and publishes progress into a
 * vanilla zustand store the screen subscribes to.
 *
 * ## It holds no file name and no path
 *
 * Every entry here is a media ID. The row, its peer-supplied `file_name`, the
 * decrypted path and the display name all stay inside `mediaExportService`,
 * which is the one module allowed to touch them and the one the
 * `media-export-no-name-logging` invariant reads line by line. This file is in
 * that invariant's REQUIRED list too, so a debugging session cannot quietly
 * put a name on a log line here either.
 *
 * ## Why the snapshot is taken once
 *
 * The user confirmed a COUNT. If the run re-queried, a reply arriving mid-batch
 * would change what "37 items" meant after they had already agreed to it. The
 * snapshot is therefore the iterated set, the confirm Alert's number, and the
 * progress denominator — one list, three uses.
 *
 * ## Why it pauses in the background rather than stopping
 *
 * Under add-only photo access there is no way to ask the library "do you
 * already have this?", so a run that stopped and was re-run would save every
 * item again. Pausing is the only behaviour that does not create duplicates.
 * Only `background` pauses: iOS reports `inactive` while a permission dialog or
 * the document picker is on screen, and pausing for our own picker would
 * deadlock the run that is waiting for it. If iOS kills the app outright the
 * run is lost; the user starts it again.
 *
 * ## Wipe safety
 *
 * The run's AbortController is registered with `registerExportAbort`, so
 * `cancelAllExports()` — `localWipe` phase 1, synchronous, before `MEDIA_DIR`
 * is deleted — aborts it and bumps the epoch that `performExport` checks
 * immediately before every native write. Staged document entries are dropped
 * by the same call.
 */

import { AppState, Platform, type AppStateStatus } from 'react-native';
import { getFSInfo } from '@dr.pogodin/react-native-fs';
import { createStore } from 'zustand/vanilla';
import {
  getExportSnapshot,
  getMediaCount,
  type GetAllMediaOptions,
  type MediaExportAccessFilter,
} from '../../database/repositories/mediaRepository';
import { useAppStore } from '../../stores/useAppStore';
import {
  beginExportCaptureBudget,
  discardStagedBulkDocuments,
  endExportCaptureBudget,
  exportMediaItemInBulk,
  flushStagedBulkDocuments,
  registerExportAbort,
  stagedBulkDocumentCount,
  type BulkExportNeeds,
  type BulkExportPermission,
  type BulkItemResult,
  type ExportDestination,
} from '../mediaExportService';
import { resolveExportRoute } from './exportFileName';
import {
  BULK_EXPORT_DOWNLOAD_WARN_BYTES,
  BULK_EXPORT_MAX_ITEMS,
  DISK_HEADROOM_BYTES,
} from './mediaLimits';
import { formatMB } from '../../utils/formatBytes';

// ---------------------------------------------------------------------------
// Public state
// ---------------------------------------------------------------------------

/**
 * `done` holds until the user dismisses the summary card, so a run that
 * finished while they were on another screen still reports itself.
 */
export type BulkExportPhase = 'idle' | 'running' | 'paused' | 'done';

export interface BulkExportSummary {
  saved: number;
  skipped: number;
  failed: number;
  /** Where copies landed. Both are possible in one run (photos + documents). */
  destinations: readonly ExportDestination[];
  /** The batch stopped early because the device filled up. */
  stoppedForSpace: boolean;
  /** The user pressed Cancel, or a wipe aborted the run. */
  cancelled: boolean;
  /**
   * Cancel landed while the end-of-run document picker was already presented,
   * so the OS may have written some copies before we stopped waiting. A copy
   * cannot be recalled, and reporting those items as plainly "skipped" would
   * tell the user nothing landed when something might have.
   */
  cancelledMidFlush: boolean;
}

export interface BulkExportState {
  phase: BulkExportPhase;
  /** Items in the snapshot — the number the user confirmed. */
  total: number;
  /** Items finished, in any terminal sense. Never exceeds `total`. */
  completed: number;
  summary: BulkExportSummary | null;
}

const INITIAL_STATE: BulkExportState = {
  phase: 'idle',
  total: 0,
  completed: 0,
  summary: null,
};

/**
 * The run's state. A vanilla store, read with `useStore(bulkExportStore, …)`:
 * the run outlives the screen, so its state cannot live in a hook, and a
 * vanilla store gives the stable snapshot identity `useSyncExternalStore`
 * demands without hand-rolling one.
 *
 * NOT persisted. A run cannot survive a process restart (the staged paths and
 * the AbortController are both in-memory), so a persisted progress bar would
 * come back attached to nothing.
 */
export const bulkExportStore = createStore<BulkExportState>(() => INITIAL_STATE);

// ---------------------------------------------------------------------------
// Throttled emission
// ---------------------------------------------------------------------------

/** Minimum gap between progress emissions. */
const EMIT_INTERVAL_MS = 250;

/** The newest values, which may be ahead of what subscribers have seen. */
let draft: BulkExportState = INITIAL_STATE;
let emitTimer: ReturnType<typeof setTimeout> | null = null;

function sameState(a: BulkExportState, b: BulkExportState): boolean {
  return (
    a.phase === b.phase &&
    a.total === b.total &&
    a.completed === b.completed &&
    a.summary === b.summary
  );
}

/**
 * Publish the draft, or confirm there is nothing to publish.
 *
 * The equality check is what keeps the store's snapshot IDENTITY stable across
 * a no-op update: `useSyncExternalStore` re-renders on identity, so emitting an
 * equal-but-new object on every item would re-render the whole File Library
 * grid for nothing.
 */
function flushEmission(): void {
  if (emitTimer !== null) {
    clearTimeout(emitTimer);
    emitTimer = null;
  }
  const current = bulkExportStore.getState();
  if (sameState(draft, current)) {
    // Re-pin the draft to the published object so identity cannot drift.
    draft = current;
    return;
  }
  bulkExportStore.setState(draft, true);
  draft = bulkExportStore.getState();
}

/**
 * Merge into the draft. Progress is throttled; a PHASE or SUMMARY change is
 * emitted at once — those drive an announcement and a card, and a quarter of a
 * second of "still running" after a run has finished reads as a stuck UI.
 */
function update(patch: Partial<BulkExportState>, immediate: boolean): void {
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
// Snapshot
// ---------------------------------------------------------------------------

/** The grid's active filters and sort, which the batch inherits exactly. */
export interface BulkExportFilters {
  contentTypeFilter: 'image' | 'video' | 'document' | null;
  conversationId: string | null;
  sortBy: 'date' | 'size';
  sortOrder: 'asc' | 'desc';
}

export interface BulkExportPlan {
  /** The iterated set, in grid order. Length is the confirmed count. */
  ids: string[];
  count: number;
  totalBytes: number;
  toDownloadBytes: number;
  /**
   * The largest single item still to be downloaded. Each in-flight download
   * holds its ciphertext staging file AND its plaintext `.tmp` at once, so the
   * run's transient peak is `2 x WORKER_COUNT x this`.
   */
  maxItemBytes: number;
  /** Server-evicted with no local copy: nothing to save, so never attempted. */
  unavailableCount: number;
  /** Orphaned, blocked-author, refused-type, or past the item bound. */
  excludedCount: number;
  needs: BulkExportNeeds;
}

/** Longest we will wait for persisted membership before refusing to start. */
const HYDRATION_TIMEOUT_MS = 5000;

/**
 * Wait until the persisted store has rehydrated.
 *
 * `conversations` (the export access list) and `blockedUserIds` (the bulk-only
 * exclusion) both ride the SAME persisted blob, and both read as EMPTY before
 * it lands. An empty conversation list fails closed — the snapshot is empty and
 * "Nothing to save" — but an empty blocked list fails OPEN: a batch taken in
 * that window would save media from someone the user blocked. So this gate is
 * mandatory, and a timeout REFUSES the run rather than proceeding without it.
 *
 * MMKV is synchronous and `bootstrap.ts` awaits `persist.rehydrate()`, so in
 * practice this resolves on the first tick. It is also the awaited tick that
 * lets the tap render its dimmed, disabled "Save all" button before the DB
 * work starts — there is no spinner in that slot, just the disabled state.
 */
async function waitForPersistedMembership(): Promise<boolean> {
  const persist = useAppStore.persist as typeof useAppStore.persist | undefined;
  if (!persist || typeof persist.hasHydrated !== 'function') {
    // No persist middleware at all (a store double in a test): there is no
    // hydration step to wait for, so there is no window to fail open in.
    await Promise.resolve();
    return true;
  }
  if (persist.hasHydrated()) {
    await Promise.resolve();
    return true;
  }
  return new Promise<boolean>((resolve) => {
    let settled = false;
    let unsubscribe: (() => void) | undefined;
    const settle = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe?.();
      resolve(ok);
    };
    const timer = setTimeout(() => settle(false), HYDRATION_TIMEOUT_MS);
    unsubscribe = persist.onFinishHydration(() => settle(true));
  });
}

function snapshotOptions(filters: BulkExportFilters): GetAllMediaOptions {
  return {
    // The snapshot query takes its own LIMIT; these two are unused by it and
    // only present because the filter builder is shared with the grid.
    limit: 0,
    offset: 0,
    sortBy: filters.sortBy,
    sortOrder: filters.sortOrder,
    contentTypeFilter: filters.contentTypeFilter,
    conversationId: filters.conversationId,
  };
}

/**
 * Decide what a "Save all" would do, without doing any of it.
 *
 * Returns null when the run must not be offered at all: persisted membership
 * never arrived. Everything else — including "nothing matches" — comes back as
 * a plan the caller renders.
 */
export async function prepareBulkExport(
  filters: BulkExportFilters,
): Promise<BulkExportPlan | null> {
  if (!(await waitForPersistedMembership())) return null;

  const state = useAppStore.getState();
  const access: MediaExportAccessFilter = {
    conversationIds: Object.keys(state.conversations),
    blockedAuthorIds: state.blockedUserIds,
  };

  const options = snapshotOptions(filters);
  const rows = getExportSnapshot(options, access, BULK_EXPORT_MAX_ITEMS);
  const matching = getMediaCount(options);
  const accessible = getMediaCount(options, access);

  const ids: string[] = [];
  const needs: BulkExportNeeds = { photo: false, document: false };
  let totalBytes = 0;
  let toDownloadBytes = 0;
  let maxItemBytes = 0;
  let unavailableCount = 0;
  let refusedCount = 0;

  for (const row of rows) {
    const route = resolveExportRoute(row.content_type);
    if (route.kind === 'refused') {
      // Peer-crafted types (our composer only posts photos and videos). The
      // single-item path refuses them the same way.
      refusedCount += 1;
      continue;
    }

    // A local copy wins over the server's eviction (the File Library grid's
    // own D10 rule) and over a stale `download_state` — `recoverStalePaths`
    // exists because the column lags the filesystem after a restore.
    const hasLocal = row.has_local === 1;
    if (!hasLocal && row.download_state === 'unavailable') {
      // Evicted server-side with nothing on disk: there is nothing to save,
      // so it is reported up front rather than attempted and 404'd.
      unavailableCount += 1;
      continue;
    }

    ids.push(row.id);
    const size = Number.isFinite(row.file_size) && row.file_size > 0 ? row.file_size : 0;
    totalBytes += size;
    if (!hasLocal) {
      toDownloadBytes += size;
      maxItemBytes = Math.max(maxItemBytes, size);
    }
    if (route.kind === 'photo') needs.photo = true;
    else needs.document = true;
  }

  const excludedByAccess = Math.max(0, matching - accessible);
  const pastBound = Math.max(0, accessible - rows.length);

  return {
    ids,
    count: ids.length,
    totalBytes,
    toDownloadBytes,
    maxItemBytes,
    unavailableCount,
    excludedCount: excludedByAccess + refusedCount + pastBound,
    needs,
  };
}

// ---------------------------------------------------------------------------
// Free space
// ---------------------------------------------------------------------------

/** Two: enough to hide one item's latency behind another's, few enough that
 *  the JS thread still renders. Native writes are serialized downstream. */
const WORKER_COUNT = 2;

export interface BulkExportSpace {
  ok: boolean;
  requiredBytes: number;
  freeBytes: number;
}

/**
 * Is there room for this batch?
 *
 * Three terms, and each one is real:
 *  - `toDownloadBytes` — every item not already local is written into
 *    `MEDIA_DIR` and KEPT there (it is the app's durable archive).
 *  - `totalBytes` — then EVERY item is COPIED again by the OS (PhotoKit
 *    duplicates the asset into the library; MediaStore streams a second
 *    file). Counting only the downloads would let a run of already-downloaded
 *    media fill the device.
 *  - `2 x WORKER_COUNT x maxItemBytes` — the TRANSIENT peak. Each in-flight
 *    download holds its ciphertext staging file and its plaintext `.tmp`
 *    simultaneously for the whole of decrypt pass 2, and two run at once.
 *    Omitting it let an approved batch stop for space mid-run near the limit,
 *    and a re-run duplicates everything already saved because add-only photo
 *    access cannot detect duplicates (#889 review).
 *
 * A `getFSInfo` failure is not a refusal. The per-item download preflight does
 * its own space check and surfaces `noSpace`, which stops the batch — so the
 * worst case is the block arriving one item late instead of up front.
 */
export async function checkBulkExportSpace(
  plan: Pick<BulkExportPlan, 'toDownloadBytes' | 'totalBytes' | 'maxItemBytes'>,
): Promise<BulkExportSpace> {
  const transientPeak = 2 * WORKER_COUNT * Math.max(0, plan.maxItemBytes);
  const requiredBytes =
    Math.max(0, plan.toDownloadBytes) +
    Math.max(0, plan.totalBytes) +
    transientPeak +
    DISK_HEADROOM_BYTES;
  try {
    const { freeSpace } = await getFSInfo();
    const free = Number.isFinite(freeSpace) ? freeSpace : 0;
    return { ok: free >= requiredBytes, requiredBytes, freeBytes: free };
  } catch {
    return { ok: true, requiredBytes, freeBytes: 0 };
  }
}

// ---------------------------------------------------------------------------
// Copy
// ---------------------------------------------------------------------------

/** "1 item" / "37 items". Exported because the a11y announcements need it. */
export function pluralItems(n: number): string {
  return n === 1 ? '1 item' : `${n} items`;
}

/** "12 of 37 items" — the progress panel's label. */
export function describeBulkProgress(state: BulkExportState): string {
  return `${Math.min(state.completed, state.total)} of ${pluralItems(state.total)}`;
}

/** The confirm Alert's body. Title is fixed; everything variable is here. */
export function describeBulkConfirm(plan: BulkExportPlan): string {
  const lines = [
    `Save ${pluralItems(plan.count)} (≈${formatMB(plan.totalBytes)})? ` +
      'The originals stay in Orbital.',
  ];

  const skipped = plan.excludedCount + plan.unavailableCount;
  if (skipped > 0) {
    lines.push(`${pluralItems(skipped)} can't be saved and will be skipped.`);
  }

  if (plan.toDownloadBytes > BULK_EXPORT_DOWNLOAD_WARN_BYTES) {
    lines.push(
      `About ${formatMB(plan.toDownloadBytes)} will be downloaded first; ` +
        'on mobile data this can use a lot of your allowance.',
    );
  }

  return lines.join('\n\n');
}

/** One sentence per fact, in the order the user cares about. */
export function describeBulkSummary(summary: BulkExportSummary): string {
  const parts: string[] = [];

  if (summary.saved > 0) {
    const where = summary.destinations.includes('photos')
      ? summary.destinations.includes('files')
        ? 'Photos and Files'
        : 'Photos'
      : 'Files';
    parts.push(`Saved ${pluralItems(summary.saved)} to ${where}.`);
  } else {
    parts.push('Nothing was saved.');
  }

  if (summary.skipped > 0) {
    parts.push(`${pluralItems(summary.skipped)} skipped.`);
  }
  if (summary.failed > 0) {
    parts.push(`${pluralItems(summary.failed)} couldn't be saved.`);
  }
  if (summary.stoppedForSpace) {
    parts.push('Stopped — not enough storage.');
  } else if (summary.cancelledMidFlush) {
    // A picker that was already on screen may have written before we stopped
    // waiting for it, and a copy cannot be recalled.
    parts.push('Cancelled — some copies may already have been saved.');
  } else if (summary.cancelled) {
    parts.push('Cancelled.');
  }

  return parts.join(' ');
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

interface ActiveRun {
  ids: readonly string[];
  /** Items re-queued once after failing while the app was backgrounded. */
  retry: string[];
  requeued: Set<string>;
  cursor: number;
  controller: AbortController;
  unregisterAbort: () => void;
  photosToFiles: boolean;
  batchDocuments: boolean;
  saved: number;
  skipped: number;
  failed: number;
  /** Staged for the end-of-run picker: counted as done, not yet as saved. */
  deferred: number;
  destinations: Set<ExportDestination>;
  stoppedForSpace: boolean;
  cancelled: boolean;
  /** True while the end-of-run document picker is presented. */
  flushing: boolean;
  /** Cancel landed while `flushing` was true. */
  cancelledMidFlush: boolean;
  appActive: boolean;
  appStateSub: { remove: () => void } | null;
  resumeWaiters: Array<() => void>;
}

let run: ActiveRun | null = null;

function completedCount(r: ActiveRun): number {
  return r.saved + r.skipped + r.failed + r.deferred;
}

function releaseWaiters(r: ActiveRun): void {
  const waiters = r.resumeWaiters;
  r.resumeWaiters = [];
  for (const resolve of waiters) resolve();
}

/**
 * Only `background` pauses. `inactive` is what iOS reports while OUR OWN
 * document picker or permission alert is on screen, and treating that as a
 * pause would stall the run that is waiting for the picker to settle.
 */
function isPausedState(status: AppStateStatus): boolean {
  return status === 'background';
}

function attachAppState(r: ActiveRun): void {
  r.appActive = !isPausedState(AppState.currentState ?? 'active');
  r.appStateSub = AppState.addEventListener('change', (next: AppStateStatus) => {
    if (r !== run) return;
    const active = !isPausedState(next);
    if (active === r.appActive) return;
    r.appActive = active;
    if (active) {
      update({ phase: 'running' }, true);
      releaseWaiters(r);
    } else {
      update({ phase: 'paused' }, true);
    }
  });
}

function detachAppState(r: ActiveRun): void {
  r.appStateSub?.remove();
  r.appStateSub = null;
}

function waitUntilActive(r: ActiveRun): Promise<void> {
  if (r.appActive || r.controller.signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    r.resumeWaiters.push(resolve);
  });
}

function takeNext(r: ActiveRun): string | undefined {
  const retried = r.retry.shift();
  if (retried !== undefined) return retried;
  if (r.cursor >= r.ids.length) return undefined;
  const id = r.ids[r.cursor];
  r.cursor += 1;
  return id;
}

/**
 * Fold one item's outcome into the run.
 *
 * `wasActive` is the app state at the moment the item STARTED: an item that
 * began while the app was foregrounded and failed after it went to background
 * is exactly the case the one-shot re-queue exists for (iOS suspends sockets
 * on background, so the download dies through no fault of the file).
 */
function applyResult(
  r: ActiveRun,
  id: string,
  result: BulkItemResult,
  wasActive: boolean,
): void {
  const wentBackground = !wasActive || !r.appActive;
  const retryable =
    result.outcome === 'failed' ||
    result.outcome === 'unavailable' ||
    (result.outcome === 'cancelled' && !r.controller.signal.aborted);

  if (wentBackground && retryable && !r.requeued.has(id)) {
    r.requeued.add(id);
    r.retry.push(id);
    return;
  }

  switch (result.outcome) {
    case 'saved':
      r.saved += 1;
      r.destinations.add(result.destination);
      break;
    case 'deferred':
      r.deferred += 1;
      break;
    case 'noSpace':
      // The device is full. Every remaining item would fail the same way, and
      // each attempt costs a download.
      r.stoppedForSpace = true;
      r.failed += 1;
      break;
    case 'cancelled':
      // Our own abort is not a per-item outcome — the summary says "Cancelled".
      if (!r.controller.signal.aborted) r.skipped += 1;
      break;
    case 'unavailable':
    case 'notAllowed':
    case 'unsupported':
    case 'corrupt':
      r.skipped += 1;
      break;
    case 'permission':
    case 'failed':
      r.failed += 1;
      break;
  }

  update({ completed: completedCount(r) }, false);
}

async function worker(r: ActiveRun): Promise<void> {
  for (;;) {
    if (r !== run || r.controller.signal.aborted || r.stoppedForSpace) return;
    // The pause is checked BEFORE the queue, so a run whose last item finishes
    // while the app is in the background stays `paused` with completed ===
    // total and settles on resume. That is the behaviour we want: the
    // end-of-run document picker cannot present in the background, and an
    // accessibility announcement nobody is there to hear is worse than a late
    // one.
    await waitUntilActive(r);
    if (r !== run || r.controller.signal.aborted || r.stoppedForSpace) return;

    const id = takeNext(r);
    if (id === undefined) return;

    const wasActive = r.appActive;
    let result: BulkItemResult;
    try {
      result = await exportMediaItemInBulk(id, r.controller.signal, {
        photosToFiles: r.photosToFiles,
        batchDocuments: r.batchDocuments,
      });
    } catch {
      // exportMediaItemInBulk is documented never to throw; if it ever does,
      // one item must not take the batch down.
      result = { outcome: 'failed' };
    }
    if (r !== run) return;
    applyResult(r, id, result, wasActive);
  }
}

/**
 * Publish the summary and release everything the run held.
 *
 * Split out of `finishRun` because `cancelBulkExport` needs it too: an iOS
 * document picker is a native modal JS cannot dismiss, so a picker that never
 * settles would otherwise leave `finishRun` awaiting forever and the progress
 * panel on screen with nothing behind it. Idempotent through `r !== run`.
 */
function settleRun(r: ActiveRun): void {
  if (r !== run) return;

  const summary: BulkExportSummary = {
    saved: r.saved,
    skipped: r.skipped,
    failed: r.failed,
    destinations: Array.from(r.destinations),
    stoppedForSpace: r.stoppedForSpace,
    cancelled: r.cancelled || r.controller.signal.aborted,
    cancelledMidFlush: r.cancelledMidFlush,
  };

  detachAppState(r);
  releaseWaiters(r);
  r.unregisterAbort();
  endExportCaptureBudget();
  run = null;

  update(
    { phase: 'done', completed: Math.min(completedCount(r), r.ids.length), summary },
    true,
  );
}

async function finishRun(r: ActiveRun): Promise<void> {
  if (r !== run) return;

  // The one iOS picker for the whole batch, after every other write.
  if (r.deferred > 0) {
    if (r.controller.signal.aborted) {
      discardStagedBulkDocuments();
      r.skipped += r.deferred;
      r.deferred = 0;
    } else {
      const staged = r.deferred;
      r.flushing = true;
      const flush = await flushStagedBulkDocuments();
      // Cancel may have settled this run while the picker was up.
      if (r !== run) return;
      r.flushing = false;
      r.deferred = 0;
      if (flush.outcome === 'saved') {
        r.saved += flush.count;
        r.destinations.add('files');
      } else if (flush.outcome === 'failed') {
        r.failed += flush.count;
      } else {
        r.skipped += flush.count;
      }
      // A wipe can empty the staging list between staging and here, in which
      // case `flush.count` is short of what we staged. The difference was
      // never presented, so it is skipped.
      r.skipped += Math.max(0, staged - flush.count);
    }
  } else if (stagedBulkDocumentCount() > 0) {
    // Defensive: staging must never outlive the run that filled it.
    discardStagedBulkDocuments();
  }

  settleRun(r);
}

/**
 * Start the batch. Returns false when there is nothing to run or a run is
 * already in flight — the caller has already shown the disclosure, taken the
 * snapshot, checked space, confirmed the count and acquired the permission.
 */
export function startBulkExport(
  plan: BulkExportPlan,
  permission: BulkExportPermission,
): boolean {
  if (run !== null) return false;
  if (plan.ids.length === 0) return false;
  if (!permission.granted) return false;

  // A previous run that was cancelled mid-flush, or killed by a wipe, can have
  // left entries staged. They point at decrypted files chosen under a
  // different snapshot, so this run must never present them.
  discardStagedBulkDocuments();
  // One Sentry event per failure CODE for this whole run, not one per item.
  beginExportCaptureBudget();

  const controller = new AbortController();
  const r: ActiveRun = {
    ids: plan.ids.slice(),
    retry: [],
    requeued: new Set<string>(),
    cursor: 0,
    controller,
    unregisterAbort: registerExportAbort(controller),
    photosToFiles: permission.photosToFiles,
    // Android's document route is a silent write to Download/Orbital, so there
    // is nothing to batch; on iOS every write is a picker presentation.
    batchDocuments: Platform.OS === 'ios',
    saved: 0,
    skipped: 0,
    failed: 0,
    deferred: 0,
    destinations: new Set<ExportDestination>(),
    stoppedForSpace: false,
    cancelled: false,
    flushing: false,
    cancelledMidFlush: false,
    appActive: true,
    appStateSub: null,
    resumeWaiters: [],
  };
  run = r;

  // A wipe aborts through `cancelAllExports()`, which never calls this module.
  // Without this listener a paused worker would sit in `waitUntilActive`
  // forever instead of unwinding.
  const onAbort = (): void => {
    releaseWaiters(r);
  };
  if (typeof controller.signal.addEventListener === 'function') {
    controller.signal.addEventListener('abort', onAbort, { once: true });
  }

  attachAppState(r);
  update(
    { phase: r.appActive ? 'running' : 'paused', total: r.ids.length, completed: 0, summary: null },
    true,
  );

  const workers: Array<Promise<void>> = [];
  for (let i = 0; i < WORKER_COUNT; i++) workers.push(worker(r));
  void Promise.all(workers).then(
    () => finishRun(r),
    () => finishRun(r),
  );

  return true;
}

/**
 * Stop the batch. Items already saved stay saved — a copy cannot be recalled,
 * which is why the summary reports what landed rather than claiming the run
 * was undone.
 */
export function cancelBulkExport(): void {
  const r = run;
  if (r === null) return;
  r.cancelled = true;
  discardStagedBulkDocuments();
  r.controller.abort();
  releaseWaiters(r);

  if (r.flushing) {
    // The document picker is up, and nothing in JS can dismiss it. Settle the
    // run now rather than leaving the progress panel waiting on a promise that
    // may never resolve. `finishRun` sees `r !== run` when (or if) the picker
    // returns. The entries are counted skipped because we stopped waiting for
    // them — but the OS may already have written some, which is why the
    // summary says so rather than claiming nothing landed.
    r.cancelledMidFlush = true;
    r.skipped += r.deferred;
    r.deferred = 0;
    r.flushing = false;
    settleRun(r);
  }
}

/** Clear the summary card. No-op unless a finished run is being reported. */
export function dismissBulkExportSummary(): void {
  if (draft.phase !== 'done') return;
  update({ phase: 'idle', total: 0, completed: 0, summary: null }, true);
}

// ---------------------------------------------------------------------------
// Teardown
// ---------------------------------------------------------------------------

/**
 * Drop every piece of run state, including the published store.
 *
 * PRODUCTION, not a test seam: `localWipe` phase 1 calls it beside
 * `cancelAllExports()`. The store is module state that survives a logout
 * (nothing reloads the JS bundle), so without this the next account to sign in
 * on this device would be shown the previous account's summary card — "Saved
 * 35 items to Photos" for photos it has never seen. Pinned by
 * `media-export-wipe-wired`.
 *
 * Synchronous, for the same reason `cancelAllExports()` is: an await here
 * hands control back to the run being torn down.
 *
 * Detaching AppState and nulling `run` before releasing the waiters is what
 * makes a leaked worker harmless — `worker` and `finishRun` both re-check
 * `r !== run` after every await.
 */
export function resetBulkExportState(): void {
  const r = run;
  run = null;
  if (r !== null) {
    detachAppState(r);
    releaseWaiters(r);
    r.unregisterAbort();
    try {
      r.controller.abort();
    } catch {
      // An AbortController that throws on abort is not worth failing a reset.
    }
  }
  endExportCaptureBudget();
  discardStagedBulkDocuments();
  if (emitTimer !== null) {
    clearTimeout(emitTimer);
    emitTimer = null;
  }
  bulkExportStore.setState(INITIAL_STATE, true);
  draft = bulkExportStore.getState();
}

/** Test alias for the production reset (`resetXForTesting` convention). */
export function resetBulkExportForTesting(): void {
  resetBulkExportState();
}
