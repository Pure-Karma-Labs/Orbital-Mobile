import type { StateCreator } from 'zustand';
import type { AppState, BlockedUsersSlice } from '../../types/store';
import { blockUserApi, unblockUserApi } from '../../services/api/users';

export const createBlockedUsersSlice: StateCreator<
  AppState,
  [['zustand/devtools', never]],
  [],
  BlockedUsersSlice
> = (set, get) => ({
  // Initial state
  blockedUserIds: [],
  blockedUserProfiles: {},

  // Actions
  blockUser: (userId, username) => {
    const { blockedUserIds, blockedUserProfiles } = get();
    if (blockedUserIds.includes(userId)) return; // Idempotent
    set(
      {
        blockedUserIds: [...blockedUserIds, userId],
        blockedUserProfiles: { ...blockedUserProfiles, [userId]: username },
      },
      false,
      'blockedUsers/blockUser',
    );
    blockUserApi(userId).catch((e: unknown) => {
      if (__DEV__) console.warn('[BlockedUsers] blockUser API failed:', e instanceof Error ? e.message : e);
    });
  },

  unblockUser: (userId) => {
    const { blockedUserIds, blockedUserProfiles } = get();
    if (!blockedUserIds.includes(userId)) return; // No-op for unknown
    const updated = { ...blockedUserProfiles };
    delete updated[userId];
    set(
      {
        blockedUserIds: blockedUserIds.filter((id) => id !== userId),
        blockedUserProfiles: updated,
      },
      false,
      'blockedUsers/unblockUser',
    );
    unblockUserApi(userId).catch((e: unknown) => {
      if (__DEV__) console.warn('[BlockedUsers] unblockUser API failed:', e instanceof Error ? e.message : e);
    });
  },

  resetBlockedUsers: () => {
    set(
      { blockedUserIds: [], blockedUserProfiles: {} },
      false,
      'blockedUsers/resetBlockedUsers',
    );
  },

  hydrateBlockedUsers: (serverBlockedIds) => {
    const { blockedUserIds, blockedUserProfiles } = get();
    const localSet = new Set(blockedUserIds);
    const newIds = serverBlockedIds.filter((id) => !localSet.has(id));
    if (newIds.length === 0) return;
    const updatedProfiles = { ...blockedUserProfiles };
    for (const id of newIds) {
      updatedProfiles[id] = updatedProfiles[id] ?? 'Unknown';
    }
    set(
      {
        blockedUserIds: [...blockedUserIds, ...newIds],
        blockedUserProfiles: updatedProfiles,
      },
      false,
      'blockedUsers/hydrateBlockedUsers',
    );
  },
});
