/**
 * Media archive-confirm service — background sweep confirming durable local copies.
 *
 * Triggers:
 * - Post-bootstrap (initial drain via scheduleArchiveConfirmDrain)
 * - Immediately after a successful download (fire-and-forget confirmArchived)
 * - App foreground (own AppState listener)
 *
 * Drain logic:
 * - Queries DB for downloaded media without archive_confirmed=1
 * - SEQUENTIAL (for-of, await each) — respects backend 300/15min per-user limiter
 * - Batch limit 100 (one-third of backend cap)
 * - Stops immediately on transient error (does NOT honor rerunRequested after error-stop)
 * - Terminal statuses (404/403) mark confirmed and continue
 * - Module-level single-flight flag + trailing debounce
 */

import { AppState as RNAppState } from 'react-native';
import { isDatabaseInitialized } from '../database/connection';
import {
  getUnconfirmedDownloadedMedia,
  setArchiveConfirmed,
  getMedia,
} from '../database/repositories/mediaRepository';
import { archiveConfirm } from './api/media';
import { NotFoundError, AuthError } from './api/errors';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DRAIN_BATCH_LIMIT = 100;
const DEBOUNCE_MS = 2_000;

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let draining = false;
let rerunRequested = false;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let appStateSubscription: { remove: () => void } | null = null;

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

export type ConfirmResult = 'confirmed' | 'terminal' | 'transient';

// ---------------------------------------------------------------------------
// Single-item confirm
// ---------------------------------------------------------------------------

/**
 * Confirm a single media item's archive status with the backend.
 *
 * NEVER throws — all errors are swallowed and logged in __DEV__.
 *
 * Returns:
 * - 'confirmed' — API 200 or already flagged locally
 * - 'terminal' — 404 (deleted server-side) or 403 (left group); flag set to stop retry
 * - 'transient' — network/auth/rate-limit/server error; flag stays 0 for retry
 */
export async function confirmArchived(mediaId: string): Promise<ConfirmResult> {
  try {
    // Short-circuit: already confirmed locally
    if (isDatabaseInitialized()) {
      const row = getMedia(mediaId);
      if (row?.archive_confirmed === 1) {
        return 'confirmed';
      }
    }

    await archiveConfirm(mediaId);
    setArchiveConfirmed(mediaId);
    return 'confirmed';
  } catch (e: unknown) {
    // Terminal: media deleted server-side (404)
    if (e instanceof NotFoundError) {
      setArchiveConfirmed(mediaId);
      return 'terminal';
    }

    // Terminal: left group (403)
    if (e instanceof AuthError && e.statusCode === 403) {
      setArchiveConfirmed(mediaId);
      return 'terminal';
    }

    // Transient: everything else (401, NetworkError, 429, 5xx, unknown)
    if (__DEV__) {
      console.warn(
        '[archiveConfirm] transient error for',
        mediaId,
        e instanceof Error ? e.message : e,
      );
    }
    return 'transient';
  }
}

// ---------------------------------------------------------------------------
// Batch drain
// ---------------------------------------------------------------------------

/**
 * Drain pending archive confirms sequentially.
 *
 * Single-flight + rerunRequested (prefetch pattern), but SEQUENTIAL per item.
 * Stops the drain immediately on 'transient' and does NOT honor rerunRequested
 * after an error-stop.
 */
export async function drainPendingArchiveConfirms(): Promise<void> {
  if (!isDatabaseInitialized()) return;

  if (draining) {
    rerunRequested = true;
    return;
  }

  draining = true;
  let errorStopped = false;
  try {
    const rows = getUnconfirmedDownloadedMedia(DRAIN_BATCH_LIMIT);
    if (rows.length === 0) return;

    for (const row of rows) {
      const result = await confirmArchived(row.id);
      if (result === 'transient') {
        errorStopped = true;
        break;
      }
      // 'confirmed' / 'terminal' → continue
    }
  } finally {
    draining = false;
    if (rerunRequested && !errorStopped) {
      rerunRequested = false;
      drainPendingArchiveConfirms().catch(() => {});
    } else {
      rerunRequested = false;
    }
  }
}

// ---------------------------------------------------------------------------
// Scheduling — trailing debounce
// ---------------------------------------------------------------------------

/**
 * Schedule a pending archive-confirm drain with a ~2s trailing debounce.
 * Safe to call frequently.
 */
export function scheduleArchiveConfirmDrain(): void {
  if (debounceTimer !== null) {
    clearTimeout(debounceTimer);
  }
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    drainPendingArchiveConfirms().catch(() => {});
  }, DEBOUNCE_MS);
}

// ---------------------------------------------------------------------------
// AppState listener — foreground drain
// ---------------------------------------------------------------------------

/**
 * Register an AppState listener that triggers a drain when the app returns
 * to the foreground. Mirrors mediaPrefetchService shape.
 * Idempotent — multiple calls are no-ops.
 */
export function registerForegroundConfirmDrain(): void {
  if (appStateSubscription) return;

  appStateSubscription = RNAppState.addEventListener('change', (nextState) => {
    if (nextState === 'active') {
      scheduleArchiveConfirmDrain();
    }
  });
}

/**
 * Remove the AppState listener. Called on logout/cleanup.
 */
export function unregisterForegroundConfirmDrain(): void {
  if (appStateSubscription) {
    appStateSubscription.remove();
    appStateSubscription = null;
  }
}

/**
 * Reset all module-level archive-confirm state. Called from `localWipe()` on logout.
 *
 * Clears flags, cancels the debounce timer, and removes the AppState subscription.
 *
 * Mid-flight safety: this resets `draining` without awaiting an in-flight drain.
 * That is safe only because the logout path never restarts the drain after
 * cleanup — an orphaned drain fails 'transient' once auth is cleared and stops.
 */
export function clearArchiveConfirmState(): void {
  draining = false;
  rerunRequested = false;
  if (debounceTimer !== null) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  unregisterForegroundConfirmDrain();
}
