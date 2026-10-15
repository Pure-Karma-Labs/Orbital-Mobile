/**
 * Blocked users sync — reconciles the local blocked list with the server
 * on login and on every cold start (restoreSession → postAuthBootstrap).
 * ADDITIVE in both directions (#896).
 *
 * Local-only blocks are pushed up; server-only blocks are hydrated DOWN into
 * local state. This sync never deletes a server row: an explicit per-user
 * unblock (Blocked Users screen → unblockUser) is the only delete path.
 * It used to treat local state as authoritative, which meant logout (or a
 * reinstall) emptied the persisted list and the next login unblocked every
 * user on the server.
 *
 * Union-wins is the deliberate failure mode for a safety feature: a lost
 * unblock is recoverable from Settings, a silently lost block is not.
 *
 * Session guard: the response is WRITTEN to the store, so a logout/login
 * landing while the GET is in flight must not merge account A's blocks into
 * account B's state. clearAuth() runs in localWipe phase 1, before the
 * blocked-list reset, so a userId snapshot sees every account switch.
 * The guard protects the READ side strictly; the push side is weaker by
 * construction, because the pushes are only DISPATCHED after the guard and
 * client.ts reads the token per request — a full account switch landing inside
 * that microtask would send them under the new token. A session-scoped request
 * option (token pinned at dispatch) is the real fix, not a second snapshot.
 * Prior art: conversationService.ts captureSession/isSessionStale (module-
 * private) and the notificationSettingsSync epoch; with this module's snapshot
 * and the slice's unblock-rollback session check that is four guard shapes, so
 * the extraction threshold is MET — a shared helper is a tracked follow-up.
 *
 * Two local snapshots: an unblock that lands while the GET is in flight must
 * be neither re-pushed (use the post-GET list) nor hydrated back (subtract
 * the union of both lists). A DELETE already in flight when the sync starts is
 * not covered and resolves union-wins: the block is resurrected locally and the
 * user re-unblocks — the deliberate safe direction.
 */

import { useAppStore } from '../stores/useAppStore';
import { blockUserApi, getBlockedUsers } from './api/users';
import { isValidUUIDv4 } from '../utils/uuid';

export async function syncBlockedUsers(): Promise<void> {
  const { blockedUserIds: localBefore, userId } = useAppStore.getState();
  if (!userId) {
    if (__DEV__) console.warn('[BlockedUsersSync] no session — skipped');
    return;
  }

  const { blockedUserIds: rawServerIds } = await getBlockedUsers();

  // #896 session guard — see header.
  if (useAppStore.getState().userId !== userId) {
    if (__DEV__) console.warn('[BlockedUsersSync] session changed mid-sync — dropped');
    return;
  }

  // The backend's UUID gate on these ids is deliberately shape-only (the
  // genesis id is not a v4, #251), so this strict v4 filter is a strict subset
  // by design: a legitimate non-v4 id would be dropped here, never a junk one
  // admitted. Warn on the COUNT only — ids are never logged.
  const serverIds = rawServerIds.filter(isValidUUIDv4);
  if (__DEV__ && rawServerIds.length !== serverIds.length) {
    console.warn(
      `[BlockedUsersSync] dropped ${rawServerIds.length - serverIds.length} malformed server id(s)`,
    );
  }
  const serverSet = new Set(serverIds);
  const localAfter = useAppStore.getState().blockedUserIds;
  const known = new Set([...localBefore, ...localAfter]);

  // Malformed local ids are not pushed either (the PUT would 400). The store is
  // left alone — this module never prunes local state.
  const localOnly = localAfter.filter((id) => isValidUUIDv4(id) && !serverSet.has(id));
  const serverOnly = serverIds.filter((id) => !known.has(id));

  if (serverOnly.length > 0) {
    useAppStore.getState().hydrateBlockedUsers(serverOnly);
  }

  await Promise.allSettled(localOnly.map((id) => blockUserApi(id)));
}
