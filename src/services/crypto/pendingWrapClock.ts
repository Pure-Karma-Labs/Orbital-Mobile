/**
 * pendingWrapClock — when did this device start waiting for a group key?
 *
 * ## The invariant
 *
 * **A group with a usable key has no entry.** An entry means "this device has
 * no key for this group and is waiting for a member to wrap one", and it is
 * removed at every point where a key becomes usable (`contentCrypto`'s three
 * cache-population sites) and at every point where the account changes
 * (`clearContentCryptoInflight`, `localWipe`). Nothing else writes it.
 *
 * ## Why it is persisted
 *
 * After #915 a pending group shows "…being re-sent by another member. Please
 * try again in a moment." That promise is only true while some member can
 * actually re-wrap the key, and nothing can prove that: the server counts a
 * non-NULL holder row as a holder, but the holder's own envelope may be just as
 * dead. So the client bounds the promise by elapsed time
 * ({@link PENDING_WRAP_BOUND_MS}, 24h) and that clock has to survive relaunches
 * — a pending group is re-read on every launch, so a per-session timer would
 * restart before it ever expired (#937).
 *
 * ## Storage
 *
 * One MMKV string, `{ v, owner, since }`, read through
 * `stores/middleware/persistence` because `src/services/crypto/**` may not
 * import `react-native-mmkv` directly. The require is lazy and wrapped: this
 * module is reachable before bootstrap runs `initMMKV`, and the MMKV package
 * throws at IMPORT time when its Nitro host is absent.
 *
 * Group ids are the only content-adjacent values here, and they are exactly
 * what a wrapped-key row is keyed by on the server already. No key material,
 * no envelopes, no plaintext.
 *
 * ## Failure direction
 *
 * Every degraded path fails toward PENDING — "not past the bound". A device
 * that cannot read its clock, has no signed-in user, or holds an implausible
 * mark keeps the hopeful copy rather than declaring a key unrecoverable on the
 * strength of a broken clock.
 *
 * @module pendingWrapClock
 */

import { PENDING_WRAP_BOUND_MS } from './groupKeyErrors';
import { useAppStore } from '../../stores/useAppStore';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STORAGE_KEY = 'orbital:pending-wrap-since:v1';
const BLOB_VERSION = 1;

/**
 * Hard cap on tracked groups. At the cap new marks are REFUSED rather than
 * evicting an existing one: evicting would reset the clock of the oldest,
 * stuck group — the one the bound exists for — every time a new group went
 * pending. An untracked group just keeps the pending copy, which is the
 * pre-#937 behaviour.
 */
const MAX_ENTRIES = 256;

/**
 * Marks at or after this instant are plausible; anything earlier belongs to a
 * device whose clock had not synced yet (an Android cold boot can report 1970,
 * and 1970 is "past the bound" by half a century). Chosen as the start of the
 * year this code shipped in.
 */
const PLAUSIBILITY_FLOOR_MS = Date.UTC(2026, 0, 1);

// ---------------------------------------------------------------------------
// Storage access
// ---------------------------------------------------------------------------

interface RawStorage {
  getString(key: string): string | undefined;
  set(key: string, value: string): void;
  remove(key: string): void;
}

/**
 * The MMKV instance, or null when it is not usable yet. Never throws, so every
 * caller degrades to the in-memory mirror instead of failing a crypto path.
 */
function storage(): RawStorage | null {
  try {
    const persistence = require('../../stores/middleware/persistence') as {
      isMMKVInitialized: () => boolean;
      getMMKVInstance: () => RawStorage;
    };
    if (!persistence.isMMKVInitialized()) return null;
    return persistence.getMMKVInstance();
  } catch {
    return null;
  }
}

function currentUserId(): string | null {
  try {
    return useAppStore.getState().userId ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** groupId → epoch ms of the FIRST mark. Mirrors the persisted blob. */
const since = new Map<string, number>();

/** The user the mirror belongs to, set when (and only when) the blob loads. */
let owner: string | null = null;

/** False until a load has actually happened — the retry condition. */
let loaded = false;

/**
 * Bring the mirror up to date for the signed-in user, loading the blob the
 * first time both MMKV and a userId are available.
 *
 * Deliberately retryable: the first group key can be touched before bootstrap
 * finishes `initMMKV` and before `setUser`, and a one-shot module-scope load
 * would make the clock silently non-persistent for the rest of the session.
 *
 * @returns the signed-in userId, or null when there is none.
 */
function ensureLoaded(): string | null {
  const userId = currentUserId();

  // Owner re-check on EVERY access, not just at load: an account switch that
  // did not route through a wipe would otherwise keep the previous account's
  // clock. Only a DEFINITE mismatch counts — a null userId is "not known yet",
  // which happens on every pre-`setUser` touch and must not discard anything.
  if (userId !== null && owner !== null && userId !== owner) {
    since.clear();
    owner = null;
    loaded = false;
  }

  if (loaded) return userId;
  // Not ready: this call uses the memory-only mirror and the next one retries.
  if (userId === null) return null;
  const mmkv = storage();
  if (mmkv === null) return userId;

  owner = userId;
  loaded = true;
  const preloadMarks = since.size > 0;
  mergeStoredBlob(mmkv, userId);
  // Marks taken while the clock was memory-only are now attributable and
  // storable, so write them through rather than losing them at the next launch.
  if (preloadMarks) persist();
  return userId;
}

/**
 * Merge the persisted blob into the mirror. The EARLIER of the two marks wins,
 * which is the same "first mark wins" rule {@link notePendingWrap} applies and
 * is order-independent: the stored mark usually predates this session, but a
 * memory-only mark taken before the load may predate a stale stored one.
 */
function mergeStoredBlob(mmkv: RawStorage, userId: string): void {
  let raw: string | undefined;
  try {
    raw = mmkv.getString(STORAGE_KEY);
  } catch {
    // Unreadable storage: keep the mirror, stay loaded, write through later.
    return;
  }
  if (raw === undefined) return;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Corrupt blob — drop it rather than guessing what it meant.
    discard(mmkv);
    return;
  }
  if (parsed == null || typeof parsed !== 'object') {
    discard(mmkv);
    return;
  }
  const blob = parsed as { v?: unknown; owner?: unknown; since?: unknown };
  if (blob.v !== BLOB_VERSION) {
    discard(mmkv);
    return;
  }
  // A definite owner mismatch: the blob belongs to another account on this
  // device. Nothing in it is meaningful here, and keeping it would leak one
  // account's group ids into another's clock.
  if (typeof blob.owner !== 'string' || blob.owner !== userId) {
    discard(mmkv);
    return;
  }
  if (blob.since == null || typeof blob.since !== 'object') {
    discard(mmkv);
    return;
  }

  const stored = blob.since as Record<string, unknown>;
  for (const groupId of Object.keys(stored)) {
    const value = stored[groupId];
    // Only finite numbers survive; plausibility is judged against `now` at the
    // point of use, which this function does not have.
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    const existing = since.get(groupId);
    if (existing === undefined) {
      if (since.size >= MAX_ENTRIES) break;
      since.set(groupId, value);
    } else if (value < existing) {
      since.set(groupId, value);
    }
  }
}

/** Drop the stored blob and the mirror together. */
function discard(mmkv: RawStorage): void {
  since.clear();
  try {
    mmkv.remove(STORAGE_KEY);
  } catch {
    // Memory-only from here; the next write replaces it anyway.
  }
}

/** Write the mirror. A no-op while the clock is memory-only. */
function persist(): void {
  if (!loaded || owner === null) return;
  const mmkv = storage();
  if (mmkv === null) return;
  const record: Record<string, number> = {};
  for (const [groupId, at] of since) {
    record[groupId] = at;
  }
  try {
    mmkv.set(STORAGE_KEY, JSON.stringify({ v: BLOB_VERSION, owner, since: record }));
  } catch {
    // Storage failures never break a crypto path; the mirror still holds.
  }
}

/** A mark that could have been taken by a correctly-set clock. */
function isPlausible(at: number, now: number): boolean {
  return Number.isFinite(at) && at >= PLAUSIBILITY_FLOOR_MS && at <= now;
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

/**
 * Record that this device is waiting for a wrap for `groupId`.
 *
 * The FIRST mark wins: the bound measures how long the wait has lasted, so a
 * later read of the same pending group must not restart it. An implausible
 * existing mark (below the floor, or in the future) is the exception — it is
 * replaced with `now`, because it describes a clock, not a wait.
 */
export function notePendingWrap(groupId: string, now: number): void {
  ensureLoaded();
  const existing = since.get(groupId);
  if (existing !== undefined && isPlausible(existing, now)) return;
  if (existing === undefined && since.size >= MAX_ENTRIES) return;
  since.set(groupId, now);
  persist();
}

/**
 * Has this group been waiting for longer than {@link PENDING_WRAP_BOUND_MS}?
 *
 * False for an unmarked group, for a device with no signed-in user, and for an
 * implausible mark — which is re-marked from `now`, so a clock jump costs the
 * user one more bound window rather than an unrecoverable conversation.
 */
export function isPendingWrapPastBound(groupId: string, now: number): boolean {
  const userId = ensureLoaded();
  if (userId === null) return false;
  const at = since.get(groupId);
  if (at === undefined) return false;
  if (!isPlausible(at, now)) {
    since.set(groupId, now);
    persist();
    return false;
  }
  return now - at >= PENDING_WRAP_BOUND_MS;
}

/**
 * Forget the wait for one group. Called wherever a key becomes usable, which
 * is what keeps the module invariant true.
 *
 * O(1) and silent when there is no entry — the common case, since every
 * successful key read passes through here.
 */
export function clearPendingWrap(groupId: string): void {
  ensureLoaded();
  if (!since.delete(groupId)) return;
  persist();
}

/**
 * Drop every group that is not in `keepGroupIds`.
 *
 * Called with the SERVER's group list: a group the user was removed from (or
 * that was dissolved) stops being returned, and that is the only signal the
 * client gets. Without it, a removed group's mark would sit in the blob until
 * the account was wiped.
 */
export function prunePendingWraps(keepGroupIds: Iterable<string>): void {
  ensureLoaded();
  if (since.size === 0) return;
  const keep = new Set(keepGroupIds);
  let changed = false;
  for (const groupId of Array.from(since.keys())) {
    if (keep.has(groupId)) continue;
    since.delete(groupId);
    changed = true;
  }
  if (changed) persist();
}

/**
 * Drop the whole clock, in memory and on disk.
 *
 * UNCONDITIONAL — never gated on a userId or on the loaded flag. It runs
 * during account teardown, where `userId` has usually already been cleared,
 * and a clear that quietly did nothing there would hand the next account the
 * previous one's group ids. Marking the clock unloaded is part of the contract:
 * a later access reloads from storage (now empty) under the new owner.
 */
export function clearAllPendingWraps(): void {
  since.clear();
  owner = null;
  loaded = false;
  const mmkv = storage();
  if (mmkv === null) return;
  try {
    mmkv.remove(STORAGE_KEY);
  } catch {
    // The mirror is empty either way; a reload would re-read a stale blob,
    // which `prunePendingWraps` and the owner check both correct.
  }
}

/** @internal Test-only: drop the in-memory mirror without touching storage. */
export function _resetPendingWrapClockForTesting(): void {
  since.clear();
  owner = null;
  loaded = false;
}

/** @internal Test-only: the mirror, as a plain object. */
export function _getPendingWrapMirrorForTesting(): Record<string, number> {
  const record: Record<string, number> = {};
  for (const [groupId, at] of since) {
    record[groupId] = at;
  }
  return record;
}
