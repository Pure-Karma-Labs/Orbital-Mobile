/**
 * "Is this DM's peer blocked?" for the render path and the imperative path
 * (#908).
 *
 * Both exports delegate to the pure `deriveBlockedDmPeer`, so a hook used in
 * render and a `getState()` read inside a callback can never disagree. Imports
 * the store directly, like `useBlockedSet`.
 */

import { useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../stores/useAppStore';
import { deriveBlockedDmPeer, type BlockedDmPeer } from '../utils/dmPeer';

/**
 * Subscribe to the blocked peer of a DM conversation.
 *
 * @param conversationId - The DM conversation id, or null (returns null).
 * @param hint - A peer id asserted by a DM-only route (ChatDetail's
 *   `route.params.recipientId`). Covers a conversation row missing from the
 *   store; never passed from a route that can carry an orbit id.
 */
export function useBlockedDmPeer(
  conversationId: string | null,
  hint?: string | null,
): BlockedDmPeer | null {
  const slices = useAppStore(
    useShallow((s) => ({
      conversations: s.conversations,
      contacts: s.contacts,
      blockedUserIds: s.blockedUserIds,
      blockedUserProfiles: s.blockedUserProfiles,
    })),
  );

  return useMemo(
    () => deriveBlockedDmPeer(slices, conversationId, hint),
    [slices, conversationId, hint],
  );
}

/** Imperative read, for callbacks and guards that must not re-render. */
export function getBlockedDmPeer(
  conversationId: string | null,
  hint?: string | null,
): BlockedDmPeer | null {
  return deriveBlockedDmPeer(useAppStore.getState(), conversationId, hint);
}
