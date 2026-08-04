/**
 * Notification settings sync (#449, hardened in #678).
 *
 * The single network owner for notification preferences and per-target mutes —
 * the notificationSlice actions it calls are pure store mutations.
 *
 * Sync model: server-authoritative overwrite, gated per call. The two GETs run
 * under Promise.allSettled so one failing endpoint never clobbers the other
 * half of the state, and a rejected half leaves the persisted state untouched
 * (it is NEVER reset to defaults on failure — that would silently unmute
 * everything on a flaky network). The replay queue is drained BEFORE the GETs
 * and whatever is still queued afterwards is overlaid on the snapshot, so a
 * server answer can never erase an intent the user has expressed and the server
 * has not yet accepted.
 *
 * Mute model: every toggle records a write-ahead intent in the persisted
 * `pendingMuteOps` queue and hands it to a per-target runner that drives the
 * server toward the LATEST intent — a double-tap coalesces into one request,
 * a genuine change of mind is sent in order with no overlap. Retryable
 * failures (offline, 5xx, 429) keep the optimistic state and leave the entry
 * queued for the next drain; 404 is terminal and reverts silently; only
 * genuinely unexpected rejections raise an Alert, and its text is always a
 * module-local constant — server-supplied strings never reach the UI.
 *
 * Prefs use the same coalescing runner but have NO replay queue (in-memory
 * intents only): an offline pref toggle rolls back silently.
 */

import { Alert, AppState as RNAppState } from 'react-native';
import * as Sentry from '@sentry/react-native';
import { useAppStore } from '../stores/useAppStore';
import {
  getNotificationMutes,
  getNotificationPrefs,
  muteTargetApi,
  unmuteTargetApi,
  updateNotificationPrefs,
} from './api/notificationSettings';
import { ApiError, AuthError, NotFoundError } from './api/errors';
import type {
  MuteTargetType,
  NotificationMute,
  NotificationPrefs,
} from '../types/api';
import type { PendingMuteOp } from '../types/store';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PREF_KEYS: (keyof NotificationPrefs)[] = [
  'newThread',
  'newReply',
  'newDm',
  'memberJoined',
];

const MUTE_TARGET_TYPES: MuteTargetType[] = ['thread', 'group'];

/**
 * The only strings this module shows a user.
 *
 * ApiError.message is a hardcoded classifier string ("Not found",
 * "Authentication required") and serverMessage is __DEV__-only, so echoing an
 * error today leaks nothing — but it is a standing invitation to leak the
 * moment anyone enriches a classifier string from a response body.
 */
const MUTE_FAILED_COPY = 'Could not update notifications for this. Please try again.';
const PREF_FAILED_COPY = 'Could not save that setting. Please try again.';

/**
 * Failed drains after which a queued mute is abandoned. Unbounded retries would
 * pin the sync overlay over server truth forever — the "UI that lies about
 * whether notifications are muted" this hardening exists to prevent.
 */
const MAX_MUTE_ATTEMPTS = 5;

/** Trailing debounce on the foreground-triggered sync. */
const DEBOUNCE_MS = 2_000;

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

/**
 * Bumped by clearNotificationSyncState(). Every runner and the drain re-read it
 * around each await and ABORT on mismatch — issuing no further requests and
 * writing nothing back. Filtering results instead of aborting would still let
 * an orphaned drain send the wiped account's target ids under the next
 * account's token.
 */
let epoch = 0;

/** Target ids with a live interactive runner. The drain skips these. */
const runners = new Set<string>();

/** Latest unconfirmed pref intent per key. In-memory only, by design (D2). */
const pendingPrefIntents = new Map<keyof NotificationPrefs, boolean>();

let draining = false;
let rerunRequested = false;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let appStateSubscription: { remove: () => void } | null = null;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Keep only known boolean pref keys.
 *
 * Guards the store against a partial or malformed response writing `undefined`
 * over a real boolean (which would read as "off" at the suppression check).
 */
function sanitizePrefs(raw: unknown): Partial<NotificationPrefs> {
  if (raw === null || typeof raw !== 'object') return {};
  const source = raw as Record<string, unknown>;
  const out: Partial<NotificationPrefs> = {};
  for (const key of PREF_KEYS) {
    if (typeof source[key] === 'boolean') out[key] = source[key] as boolean;
  }
  return out;
}

/** Build the store's muted-target map from the server's mute rows. */
function toMutedTargets(mutes: NotificationMute[]): Record<string, MuteTargetType> {
  const out: Record<string, MuteTargetType> = {};
  for (const mute of mutes) {
    if (
      typeof mute?.targetId === 'string' &&
      mute.targetId.length > 0 &&
      MUTE_TARGET_TYPES.includes(mute.targetType)
    ) {
      out[mute.targetId] = mute.targetType;
    }
  }
  return out;
}

function warn(scope: string, error: unknown): void {
  if (__DEV__) {
    const name = error instanceof Error ? error.name : 'unknown error';
    console.warn(`[NotificationSettings] ${scope} failed: ${name}`);
  }
}

/** How a failed mutation should be treated. */
type MuteFailure = 'retry' | 'auth' | 'terminal' | 'alert';

/**
 * Classify a failure once, for both the interactive runners and the drain.
 *
 * `isRetryable` is the wire layer's own judgment (NetworkError, 5xx, 429), so
 * reusing it avoids a second list of status codes that can drift from it.
 * 401/403 is evidence about the SESSION rather than the intent — client.ts
 * throws AuthError whenever no access token is present, so a drain racing token
 * clearing would otherwise discard every queued offline mute.
 * 404 is terminal: the target was TTL-reaped or membership is gone, which the
 * backend deliberately does not distinguish.
 */
function classifyFailure(error: unknown): MuteFailure {
  if (error instanceof AuthError) return 'auth';
  if (error instanceof ApiError && error.isRetryable) return 'retry';
  if (
    error instanceof NotFoundError ||
    (error instanceof ApiError && error.statusCode === 404)
  ) {
    return 'terminal';
  }
  return 'alert';
}

/** Alert with a module-local constant. Never takes an Error or a server string. */
function alertGeneric(copy: string): void {
  Alert.alert('Notification settings', copy);
}

// ---------------------------------------------------------------------------
// Mute failure policy
// ---------------------------------------------------------------------------

/**
 * Apply the failure policy for one mute intent and report the classification.
 *
 * 'retry'/'auth' keep BOTH the optimistic state and the queue entry — the
 * intent outlives the failure and the next drain replays it. 'terminal'/'alert'
 * revert the store to the value it held before this attempt.
 *
 * The queue entry is cleared here only on the interactive path; the drain
 * collects ids and clears them in one batched set(), because every set() on a
 * persisted key re-serializes the whole partialized blob into MMKV. An alert is
 * likewise interactive-only — the drain runs outside any user interaction.
 *
 * Caller must check the epoch before calling: this writes to the store.
 */
function handleMuteFailure(
  targetId: string,
  intent: PendingMuteOp,
  error: unknown,
  options: { interactive: boolean },
): MuteFailure {
  const kind = classifyFailure(error);
  warn(intent.muted ? 'mute' : 'unmute', error);
  if (kind === 'retry' || kind === 'auth') return kind;

  // Revert to the value held before THIS attempt. If the user toggled again
  // mid-flight that is one step stale — bounded, and the next sync settles it.
  const store = useAppStore.getState();
  if (intent.muted) store.removeMutedTarget(targetId);
  else store.addMutedTarget(targetId, intent.targetType);

  if (options.interactive) {
    store.clearPendingMuteOp(targetId);
    if (kind === 'alert') alertGeneric(MUTE_FAILED_COPY);
  }
  return kind;
}

/**
 * Abandon a queued intent after MAX_MUTE_ATTEMPTS failed drains.
 *
 * Reverts the store to the server-truthful value so the overlay stops pinning
 * an intent the server has never accepted, and leaves one id-free breadcrumb so
 * a systematically failing mute endpoint is visible in production.
 *
 * Does not clear the entry — the drain batches that.
 */
function abandonMuteOp(targetId: string, op: PendingMuteOp, error: unknown): void {
  const store = useAppStore.getState();
  if (op.muted) store.removeMutedTarget(targetId);
  else store.addMutedTarget(targetId, op.targetType);
  warn('mute replay give-up', error);
  Sentry.addBreadcrumb({
    category: 'notification-settings',
    message: 'mute replay abandoned after max attempts',
    level: 'warning',
    data: {
      attempts: op.attempts + 1,
      error: error instanceof Error ? error.name : 'unknown',
    },
  });
}

// ---------------------------------------------------------------------------
// Mute mutations
// ---------------------------------------------------------------------------

/**
 * Drive the server toward the latest recorded intent for one target.
 *
 * SEEDED with the intent its caller recorded: at MAX_PENDING_MUTE_OPS the store
 * entry may not exist, and the tap's request must still be issued exactly once.
 *
 * Structurally similar to drivePref and deliberately NOT unified with it:
 * this one is persisted and retains its optimistic state on retryable failures,
 * drivePref is in-memory and rolls back on every failure.
 */
async function driveMute(targetId: string, seedIntent: PendingMuteOp): Promise<void> {
  runners.add(targetId);
  try {
    let intent: PendingMuteOp | undefined = seedIntent;
    for (;;) {
      if (!intent) break;
      const startEpoch = epoch;
      try {
        if (intent.muted) await muteTargetApi(targetId, intent.targetType);
        else await unmuteTargetApi(targetId);
      } catch (error) {
        if (epoch === startEpoch) {
          handleMuteFailure(targetId, intent, error, { interactive: true });
        }
        break;
      }
      if (epoch !== startEpoch) break; // wiped mid-flight — write nothing

      const latest: PendingMuteOp | undefined =
        useAppStore.getState().pendingMuteOps[targetId];
      if (!latest || latest.muted === intent.muted) {
        // Server now matches the latest intent.
        useAppStore.getState().clearPendingMuteOp(targetId);
        break;
      }
      intent = latest; // intent moved mid-flight — send the newer one
    }
  } finally {
    runners.delete(targetId);
  }
}

/**
 * Toggle the mute state of one target (thread id or group id).
 *
 * Optimistic and coalescing: the store flips and the intent is enqueued in one
 * write, then a per-target runner converges the server on it. Resolves once the
 * caller's own runner has settled; a reentrant call resolves immediately
 * because the live runner picks the new intent up from the store.
 *
 * Returns void — the pre-#678 boolean would have needed two different meanings
 * depending on runner ownership, and no caller reads it.
 */
export async function toggleMute(
  targetId: string,
  targetType: MuteTargetType,
): Promise<void> {
  const state = useAppStore.getState();
  const next = state.mutedTargets[targetId] === undefined;
  const intent: PendingMuteOp = {
    targetType,
    muted: next,
    // Unauthenticated toggles are unreachable from the UI; an empty owner
    // simply never matches a real userId, so such an entry is discarded rather
    // than replayed.
    ownerUserId: state.userId ?? '',
    attempts: 0,
  };

  // Write-ahead: a crash between here and the response still replays.
  state.applyMuteIntent(targetId, intent);

  // Issuing a second request here IS the double-tap divergence this replaces.
  if (runners.has(targetId)) return;
  await driveMute(targetId, intent);
}

// ---------------------------------------------------------------------------
// Pref mutations
// ---------------------------------------------------------------------------

/**
 * Drive one pref key to its latest intent.
 *
 * Same shape as driveMute and deliberately NOT shared with it — see driveMute.
 *
 * @param serverValue the value the server is believed to hold right now; the
 *                    rollback anchor, advanced after every confirmation.
 */
async function drivePref(
  key: keyof NotificationPrefs,
  serverValue: boolean,
): Promise<void> {
  let believed = serverValue;
  try {
    for (;;) {
      const intent = pendingPrefIntents.get(key);
      if (intent === undefined) break;
      const startEpoch = epoch;

      let response: unknown;
      try {
        response = await updateNotificationPrefs({
          [key]: intent,
        } as Partial<NotificationPrefs>);
      } catch (error) {
        if (epoch !== startEpoch) return; // wiped mid-flight — write nothing
        warn('pref update', error);
        useAppStore
          .getState()
          .setNotificationPrefs({ [key]: believed } as Partial<NotificationPrefs>);
        if (classifyFailure(error) === 'alert') alertGeneric(PREF_FAILED_COPY);
        return;
      }
      if (epoch !== startEpoch) return;

      // Apply ONLY the key this call owns. The PUT returns the whole pref set,
      // and applying all of it makes a slow response for one key visibly revert
      // a fast one for another.
      const confirmed = sanitizePrefs(response);
      believed = typeof confirmed[key] === 'boolean' ? (confirmed[key] as boolean) : intent;
      const latest = pendingPrefIntents.get(key);
      // Converged: the intent did not move while this request was in flight.
      // The loop turns on the INTENT moving, never on the server disagreeing —
      // re-sending because the response differs from what we asked would spin
      // forever against a server that will not take the value.
      if (latest === undefined || latest === intent) {
        useAppStore
          .getState()
          .setNotificationPrefs({ [key]: believed } as Partial<NotificationPrefs>);
        break;
      }
    }
  } finally {
    pendingPrefIntents.delete(key);
  }
}

/**
 * Set one notification preference.
 *
 * Optimistic per key: flips locally, PUTs just that key, then applies just that
 * key from the response. Rejections roll back that key alone; only unexpected
 * ones alert, with module-local copy.
 */
export async function setPref(
  key: keyof NotificationPrefs,
  value: boolean,
): Promise<void> {
  const previous = useAppStore.getState().notificationPrefs[key];
  if (previous === value) return;

  useAppStore.getState().setNotificationPrefs({ [key]: value } as Partial<NotificationPrefs>);

  // Presence in the intent map doubles as "a runner owns this key".
  const alreadyDriving = pendingPrefIntents.has(key);
  pendingPrefIntents.set(key, value);
  if (alreadyDriving) return;

  await drivePref(key, previous);
}

// ---------------------------------------------------------------------------
// Replay queue
// ---------------------------------------------------------------------------

/** One pass over the queue. Never throws. */
async function drainOnce(): Promise<void> {
  const startEpoch = epoch;
  const currentUserId = useAppStore.getState().userId;
  const snapshot = Object.keys(useAppStore.getState().pendingMuteOps);
  const clearedIds: string[] = [];

  for (const targetId of snapshot) {
    if (epoch !== startEpoch) return; // wiped mid-drain — issue nothing further
    if (runners.has(targetId)) continue; // an interactive runner owns this target

    const op: PendingMuteOp | undefined = useAppStore.getState().pendingMuteOps[targetId];
    if (!op || !MUTE_TARGET_TYPES.includes(op.targetType)) {
      // Converged while we were awaiting, or malformed from an older build.
      if (op) clearedIds.push(targetId);
      continue;
    }

    // A queue that outlived its account (interrupted key recovery deletes
    // lastUserId without running localWipe) must never be replayed under
    // another user's JWT.
    if (op.ownerUserId !== currentUserId) {
      clearedIds.push(targetId);
      continue;
    }

    try {
      if (op.muted) await muteTargetApi(targetId, op.targetType);
      else await unmuteTargetApi(targetId);
    } catch (error) {
      if (epoch !== startEpoch) return;
      const kind = handleMuteFailure(targetId, op, error, { interactive: false });
      if (kind === 'terminal' || kind === 'alert') {
        clearedIds.push(targetId);
        continue;
      }
      if (kind === 'auth') break; // session problem, not intent — retain everything
      // 'retry': the rest of the queue is presumably failing the same way.
      if (op.attempts + 1 >= MAX_MUTE_ATTEMPTS) {
        abandonMuteOp(targetId, op, error);
        clearedIds.push(targetId);
      } else {
        useAppStore.getState().bumpPendingMuteAttempts(targetId);
      }
      break;
    }

    if (epoch !== startEpoch) return;
    clearedIds.push(targetId);
  }

  if (clearedIds.length > 0) {
    useAppStore.getState().clearPendingMuteOps(clearedIds);
  }
}

/**
 * Replay queued mute intents, one at a time, then clear what converged.
 *
 * Single-flight; never throws. Entries left undrained stay unsuppressed
 * server-side (filterPushRecipients reads notification_mutes) until the next
 * drain — login, key recovery, or a foreground transition.
 */
export async function drainPendingMuteOps(): Promise<void> {
  if (draining) {
    rerunRequested = true;
    return;
  }
  draining = true;
  try {
    do {
      rerunRequested = false;
      await drainOnce();
    } while (rerunRequested);
  } catch (error) {
    warn('mute replay', error);
  } finally {
    draining = false;
  }
}

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------

/**
 * Pull both halves of the notification settings and overwrite local state.
 *
 * Called fire-and-forget beside syncBlockedUsers after login and after key
 * recovery. Never throws — callers attach .catch() for logging only.
 *
 * The drain runs FIRST so a queued offline intent reaches the server before the
 * server's answer is treated as truth; the overlay afterwards is the belt to
 * that suspenders, covering anything still queued when the GETs return.
 */
export async function syncNotificationSettings(): Promise<void> {
  const startEpoch = epoch;
  await drainPendingMuteOps();

  const [prefsResult, mutesResult] = await Promise.allSettled([
    getNotificationPrefs(),
    getNotificationMutes(),
  ]);

  // A wipe landed while the GETs were in flight: the responses belong to the
  // previous account and must never repopulate the freshly cleared store.
  if (epoch !== startEpoch) return;

  const store = useAppStore.getState();

  if (prefsResult.status === 'fulfilled') {
    // The GET always returns the full key set, so a merge is an overwrite.
    const prefs = sanitizePrefs(prefsResult.value);
    // Unconfirmed intents win: a sync landing between an optimistic flip and
    // its confirmation must not visibly revert the flip.
    for (const [key, value] of pendingPrefIntents) prefs[key] = value;
    store.setNotificationPrefs(prefs);
  } else {
    warn('prefs sync', prefsResult.reason);
  }

  if (mutesResult.status === 'fulfilled') {
    const mutes = Array.isArray(mutesResult.value?.mutes) ? mutesResult.value.mutes : [];
    const snapshot = toMutedTargets(mutes);
    // A fulfilled GET implies a live session, so a mismatched owner here is a
    // queue that outlived its account: delete it, never apply it.
    const currentUserId = store.userId;
    const staleIds: string[] = [];
    for (const [targetId, op] of Object.entries(useAppStore.getState().pendingMuteOps)) {
      if (op.ownerUserId !== currentUserId) {
        staleIds.push(targetId);
        continue;
      }
      if (op.muted) snapshot[targetId] = op.targetType;
      else delete snapshot[targetId];
    }
    if (staleIds.length > 0) store.clearPendingMuteOps(staleIds);
    store.setMutedTargets(snapshot);
  } else {
    warn('mutes sync', mutesResult.reason);
  }
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/**
 * Reset all module-level sync state. Called from localWipe() and from the
 * key-recovery local wipe.
 *
 * Bumping `epoch` ABORTS every in-flight runner and the drain: they issue no
 * further requests and write nothing back. An orphaned rollback here would call
 * addMutedTarget on a freshly wiped store, writing the previous account's
 * thread id into the next account's persisted state — the exact leak
 * resetNotificationSettings() exists to prevent.
 *
 * The AppState listener is deliberately NOT removed. It is registered once per
 * process from bootstrap and nothing re-registers it, so unregistering here
 * would kill foreground sync for the rest of the process after any
 * logout→login. An orphaned listener is harmless: the scheduled callback
 * early-returns when unauthenticated.
 */
export function clearNotificationSyncState(): void {
  epoch += 1;
  runners.clear();
  pendingPrefIntents.clear();
  draining = false;
  rerunRequested = false;
  if (debounceTimer !== null) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
}

/**
 * Schedule a sync with a ~2s trailing debounce. Safe to call frequently.
 *
 * DEBT-155: this is the third copy of the drain-scheduler shell
 * (mediaPrefetchService, mediaArchiveConfirmService are the others). Extracting
 * a shared createDrainScheduler is a filed follow-up — cited here rather than
 * silently ratified.
 */
export function scheduleNotificationSettingsSync(): void {
  if (debounceTimer !== null) {
    clearTimeout(debounceTimer);
  }
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    // Bootstrap registers the listener before login, and the listener survives
    // logout — an unauthenticated sync would just burn 401s.
    if (!useAppStore.getState().isAuthenticated) return;
    syncNotificationSettings().catch(() => {});
  }, DEBOUNCE_MS);
}

/**
 * Register an AppState listener that syncs when the app returns to foreground.
 * Idempotent — multiple calls are no-ops.
 *
 * Backend#239 seam: when `notification_settings_changed` ships it is a UNICAST
 * event (KNOWN_UNICAST_TYPES, websocket/messageHandler.ts) whose handler calls
 * scheduleNotificationSettingsSync() — same shape as
 * retryAllPendingNameDecrypts() off handleConnectionAck.
 */
export function registerForegroundNotificationSettingsSync(): void {
  if (appStateSubscription) return;

  appStateSubscription = RNAppState.addEventListener('change', (nextState) => {
    if (nextState === 'active') {
      scheduleNotificationSettingsSync();
    }
  });
}

/**
 * Remove the AppState listener.
 *
 * Tests only — the production wipe path deliberately leaves it registered
 * (see clearNotificationSyncState).
 */
export function unregisterForegroundNotificationSettingsSync(): void {
  if (appStateSubscription) {
    appStateSubscription.remove();
    appStateSubscription = null;
  }
}
