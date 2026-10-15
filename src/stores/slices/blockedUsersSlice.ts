import type { StateCreator } from 'zustand';
import type { AppState, BlockedUsersSlice } from '../../types/store';
import { blockUserApi, unblockUserApi } from '../../services/api/users';
import { captureError } from '../../services/telemetry';

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
    const { blockedUserIds, blockedUserProfiles, userId: sessionUserId } = get();
    if (!blockedUserIds.includes(userId)) return; // No-op for unknown
    const savedName = blockedUserProfiles[userId];
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
      // #896: the sync no longer deletes server rows, so a failed DELETE must
      // not leave local state ahead of the server (the next cold-start sync
      // would silently resurrect the block). Roll the optimistic removal back
      // so the row returns and the user can retry. Same session only — after a
      // logout/account switch the id belongs to someone else's state.
      const s = get();
      if (s.userId !== sessionUserId) return;
      if (!s.blockedUserIds.includes(userId)) {
        set(
          {
            blockedUserIds: [...s.blockedUserIds, userId],
            blockedUserProfiles:
              savedName === undefined
                ? s.blockedUserProfiles
                : { ...s.blockedUserProfiles, [userId]: savedName },
          },
          false,
          'blockedUsers/unblockUserRollback',
        );
      }
      captureError(e, { tags: { feature: 'blocking', op: 'unblock' } });
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
    const { blockedUserIds } = get();
    const localSet = new Set(blockedUserIds);
    const newIds = serverBlockedIds.filter((id) => !localSet.has(id));
    if (newIds.length === 0) return;
    // #896: ids only — blockedUserProfiles is left untouched. GET /blocked
    // carries no usernames, and a shared 'Unknown' placeholder would render as
    // a real handle ("Unblock @Unknown?"). The screen falls back to a
    // disambiguating user-<id prefix> label when no profile/contact exists.
    set(
      { blockedUserIds: [...blockedUserIds, ...newIds] },
      false,
      'blockedUsers/hydrateBlockedUsers',
    );
  },
});
