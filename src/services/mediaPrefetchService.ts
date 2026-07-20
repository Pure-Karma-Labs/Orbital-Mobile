/**
 * Media prefetch service — background drain of pending media downloads.
 *
 * Triggers:
 * - Post-bootstrap (initial drain)
 * - Tail of processMediaMetadata (covers all 7 call sites via lazy import)
 * - App foreground (own AppState listener, mirrors websocketManager shape)
 *
 * Drain logic:
 * - Queries DB for pending downloads WITH keys+digest (excludes keyless, digestless,
 *   failed, unavailable, downloaded)
 * - Excludes video parent rows until #458 PR 3 (thumbnails still drain); oldest first
 * - Batch limit ~25
 * - Fires downloadAndDecryptMedia per item — service semaphore (max 3) + inflight
 *   dedup throttle; 404s self-classify to 'unavailable' via W4 and drop out of
 *   next batch
 * - Module-level single-flight flag + trailing debounce
 *
 * [panel L1] isDatabaseInitialized() guard as first line in both
 * getPendingDownloadsWithKeys (repo) and drainPendingMediaDownloads.
 */

import { AppState as RNAppState } from 'react-native';
import { isDatabaseInitialized } from '../database/connection';
import { getPendingDownloadsWithKeys } from '../database/repositories/mediaRepository';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DRAIN_BATCH_LIMIT = 25;
const DEBOUNCE_MS = 2_000;

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let draining = false;
let rerunRequested = false;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let appStateSubscription: { remove: () => void } | null = null;

// ---------------------------------------------------------------------------
// Core drain
// ---------------------------------------------------------------------------

/**
 * Drain pending media downloads in a single-flight loop.
 * Re-runs once if a new drain was requested while the current batch was in flight.
 */
export async function drainPendingMediaDownloads(): Promise<void> {
  // [panel L1] Metro Fast Refresh can reset the db singleton
  if (!isDatabaseInitialized()) return;

  if (draining) {
    rerunRequested = true;
    return;
  }

  draining = true;
  try {
    const rows = getPendingDownloadsWithKeys(DRAIN_BATCH_LIMIT);
    if (rows.length === 0) return;

    // Lazy import to avoid import cycle (threadService -> mediaPrefetchService -> mediaDownloadService)
    const { downloadAndDecryptMedia } = await import('./mediaDownloadService');

    // Fire all downloads concurrently — the service's semaphore (max 3) + inflight
    // dedup throttle them. .catch(() => {}) swallows per-item failures (404s self-classify
    // to 'unavailable' via W4 and drop out of next batch).
    await Promise.all(
      rows.map((row) => downloadAndDecryptMedia(row.id).catch(() => {})),
    );
  } finally {
    draining = false;
    if (rerunRequested) {
      rerunRequested = false;
      // Recurse for one more batch (tail of rerun chain)
      drainPendingMediaDownloads().catch(() => {});
    }
  }
}

// ---------------------------------------------------------------------------
// Scheduling — trailing debounce
// ---------------------------------------------------------------------------

/**
 * Schedule a pending media drain with a ~2s trailing debounce.
 * Safe to call frequently (processMediaMetadata fires for every media batch).
 */
export function schedulePendingMediaDrain(): void {
  if (debounceTimer !== null) {
    clearTimeout(debounceTimer);
  }
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    drainPendingMediaDownloads().catch(() => {});
  }, DEBOUNCE_MS);
}

// ---------------------------------------------------------------------------
// AppState listener — foreground drain
// ---------------------------------------------------------------------------

/**
 * Register an AppState listener that triggers a drain when the app returns
 * to the foreground. Mirrors the websocketManager.ts:227-249 shape.
 * Idempotent — multiple calls are no-ops.
 */
export function registerForegroundDrain(): void {
  if (appStateSubscription) return;

  appStateSubscription = RNAppState.addEventListener('change', (nextState) => {
    if (nextState === 'active') {
      schedulePendingMediaDrain();
    }
  });
}

/**
 * Remove the AppState listener. Called on logout/cleanup.
 */
export function unregisterForegroundDrain(): void {
  if (appStateSubscription) {
    appStateSubscription.remove();
    appStateSubscription = null;
  }
}

/**
 * Reset all module-level prefetch state. Called from `localWipe()` on logout.
 *
 * Clears flags (`draining`, `rerunRequested`), cancels the debounce timer,
 * and removes the AppState foreground-drain subscription.
 *
 * **Mid-flight drain semantics:** If a `drainPendingMediaDownloads()` batch is
 * already executing when this is called, the in-flight `Promise.all` will still
 * complete (the network requests are already dispatched). However, because
 * `draining` is reset to `false`, the completion handler will skip the rerun
 * branch. At worst, one overlapping drain could start post-login, bounded by
 * the `isDatabaseInitialized()` guard.
 */
export function clearPrefetchState(): void {
  draining = false;
  rerunRequested = false;
  if (debounceTimer !== null) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  unregisterForegroundDrain();
}
