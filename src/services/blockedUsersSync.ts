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
 * Prior art: conversationService.ts captureSession/isSessionStale (module-
 * private) and the notificationSettingsSync epoch; a fourth guard shape is
 * the threshold for extracting a shared helper.
 *
 * Two local snapshots: an unblock that lands while the GET is in flight must
 * be neither re-pushed (use the post-GET list) nor hydrated back (subtract
 * the union of both lists).
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

  const serverIds = rawServerIds.filter(isValidUUIDv4);
  const serverSet = new Set(serverIds);
  const localAfter = useAppStore.getState().blockedUserIds;
  const known = new Set([...localBefore, ...localAfter]);

  const localOnly = localAfter.filter((id) => !serverSet.has(id));
  const serverOnly = serverIds.filter((id) => !known.has(id));

  if (serverOnly.length > 0) {
    useAppStore.getState().hydrateBlockedUsers(serverOnly);
  }

  await Promise.allSettled(localOnly.map((id) => blockUserApi(id)));
}
