import type { StateCreator } from 'zustand';
import type { AppState, BlockedUsersSlice } from '../../types/store';
import { blockUserApi, unblockUserApi } from '../../services/api/users';
import { NetworkError } from '../../services/api/errors';
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
  blockedUsersGeneration: 0,

  // Actions
  // The optimistic `set` stays SYNCHRONOUS — the UI must hide the content on
  // the same tick. The returned promise only reports when the API settled, so
  // `services/blockedContentRefresh.ts` knows when the server has stopped
  // answering with pre-block per-viewer values (#897). It never rejects.
  blockUser: (userId, username) => {
    const { blockedUserIds, blockedUserProfiles } = get();
    if (blockedUserIds.includes(userId)) return Promise.resolve(); // Idempotent
    set(
      {
        blockedUserIds: [...blockedUserIds, userId],
        blockedUserProfiles: { ...blockedUserProfiles, [userId]: username },
        blockedUsersGeneration: get().blockedUsersGeneration + 1,
      },
      false,
      'blockedUsers/blockUser',
    );
    return blockUserApi(userId).catch((e: unknown) => {
      if (__DEV__) console.warn('[BlockedUsers] blockUser API failed:', e instanceof Error ? e.message : e);
    });
  },

  unblockUser: (userId) => {
    const { blockedUserIds, blockedUserProfiles, userId: sessionUserId } = get();
    if (!blockedUserIds.includes(userId)) return Promise.resolve(); // No-op for unknown
    const savedName = blockedUserProfiles[userId];
    const updated = { ...blockedUserProfiles };
    delete updated[userId];
    set(
      {
        blockedUserIds: blockedUserIds.filter((id) => id !== userId),
        blockedUserProfiles: updated,
        blockedUsersGeneration: get().blockedUsersGeneration + 1,
      },
      false,
      'blockedUsers/unblockUser',
    );
    return unblockUserApi(userId).catch((e: unknown) => {
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
            blockedUsersGeneration: s.blockedUsersGeneration + 1,
          },
          false,
          'blockedUsers/unblockUserRollback',
        );
      }
      // NetworkError is a modelled transient state the rollback already handles,
      // not a fault worth a Sentry event (inviteCreateErrors.ts precedent).
      if (!(e instanceof NetworkError)) {
        captureError(e, { tags: { feature: 'blocking', op: 'unblock' } });
      }
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
      {
        blockedUserIds: [...blockedUserIds, ...newIds],
        blockedUsersGeneration: get().blockedUsersGeneration + 1,
      },
      false,
      'blockedUsers/hydrateBlockedUsers',
    );
    // Evict cached media for the newly learned ids, AFTER the set so the new
    // blocked set is already in force for anything the eviction wakes up
    // (#897, ordering per the #906 review).
    //
    // Honest about its reach: at both bootstrap call sites the store holds no
    // threads or replies yet, so the author lookup resolves nothing and this
    // evicts nothing. READ-TIME filtering is the real cross-device guard —
    // `hydrateMediaFromLocal`'s author filter and the grid's
    // `excludeAuthorIds`. This loop only matters for an in-session re-sync,
    // where a gallery or grid page is already seeded.
    get().removeMediaForAuthors(newIds);
  },
});
