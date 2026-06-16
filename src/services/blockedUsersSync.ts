/**
 * Blocked users sync — reconciles local blocked list with server on login.
 *
 * Local-only blocks are pushed to the server; server-only blocks are
 * removed (local state is authoritative). Uses Promise.allSettled so
 * individual API failures do not abort the entire sync.
 */

import { useAppStore } from '../stores/useAppStore';
import { blockUserApi, unblockUserApi, getBlockedUsers } from './api/users';

export async function syncBlockedUsers(): Promise<void> {
  const { blockedUserIds } = useAppStore.getState();
  const localSet = new Set(blockedUserIds);

  const { blockedUserIds: serverIds } = await getBlockedUsers();
  const serverSet = new Set(serverIds);

  // Local-only blocks → push to server
  const localOnly = blockedUserIds.filter((id) => !serverSet.has(id));
  // Server-only blocks → remove from server (local is authoritative)
  const serverOnly = serverIds.filter((id) => !localSet.has(id));

  await Promise.allSettled([
    ...localOnly.map((id) => blockUserApi(id)),
    ...serverOnly.map((id) => unblockUserApi(id)),
  ]);
}
