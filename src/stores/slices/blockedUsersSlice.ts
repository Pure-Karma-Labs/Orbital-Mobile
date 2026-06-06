import type { StateCreator } from 'zustand';
import type { AppState, BlockedUsersSlice } from '../../types/store';

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
  },

  resetBlockedUsers: () => {
    set(
      { blockedUserIds: [], blockedUserProfiles: {} },
      false,
      'blockedUsers/resetBlockedUsers',
    );
  },
});
