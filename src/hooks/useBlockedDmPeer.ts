/**
 * "Is this DM's peer blocked?" for the render path and the imperative path,
 * plus the shared false -> true transition latch (#908).
 *
 * Every export delegates to the pure `deriveBlockedDmPeer`, so a hook used in
 * render and a `getState()` read inside a callback can never disagree. Imports
 * the store directly, like `useBlockedSet`.
 */

import { useEffect, useRef } from 'react';
import { AccessibilityInfo } from 'react-native';
import { useIsFocused } from '@react-navigation/native';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../stores/useAppStore';
import { deriveBlockedDmPeer, type BlockedDmPeer, type DmPeerOptions } from '../utils/dmPeer';

/**
 * Subscribe to the blocked peer of a DM conversation.
 *
 * Selects the DERIVED value, not the slices it reads: `deriveBlockedDmPeer`
 * short-circuits on an empty block list, so running it inside the selector is
 * near-free, and `useShallow` then compares the small `{ peerId, label }`
 * result. Subscribing to the raw `conversations`/`contacts` maps instead would
 * re-render every mounted DM screen on each `bumpLastMessageAt`, unread write
 * or one-row-at-a-time DM refresh.
 *
 * @param conversationId - The DM conversation id, or null (returns null).
 * @param options - `hint` (a peer id asserted by a DM-only route, e.g.
 *   ChatDetail's `route.params.recipientId`) and/or `dmIntent` (the caller
 *   asserts the id is a DM). Both unlock the missing-row contact scan; see
 *   `resolveDmPeer`.
 */
export function useBlockedDmPeer(
  conversationId: string | null,
  options?: DmPeerOptions,
): BlockedDmPeer | null {
  const hint = options?.hint ?? null;
  const dmIntent = options?.dmIntent === true;
  return useAppStore(useShallow((s) => deriveBlockedDmPeer(s, conversationId, { hint, dmIntent })));
}

/** Imperative read, for callbacks and guards that must not re-render. */
export function getBlockedDmPeer(
  conversationId: string | null,
  options?: DmPeerOptions,
): BlockedDmPeer | null {
  return deriveBlockedDmPeer(useAppStore.getState(), conversationId, options);
}

/**
 * Run `onBlock` and announce ONCE on the false -> true edge of a block.
 *
 * Latched on a ref, not on `blockedPeer` identity: that object is rebuilt
 * whenever the label changes, so an identity-keyed effect would re-fire on
 * unrelated store writes. The latch resets on true -> false, so a re-block
 * re-fires.
 *
 * `onBlock` is read from a latest-ref, so a caller may pass an inline closure
 * without destabilising the effect. It runs UNCONDITIONALLY — the screens' own
 * resets (clearing a reply target, cancelling an upload, dismissing the
 * keyboard) must happen whether or not the screen is on top. Only the VoiceOver
 * announcement is gated on focus, because ThreadDetail, ChatDetail and the
 * composer can all be mounted on the same stack and would otherwise speak the
 * same sentence two or three times.
 */
export function useBlockedPeerTransition(
  blockedPeer: BlockedDmPeer | null,
  onBlock?: () => void,
): void {
  const isBlocked = blockedPeer != null;
  const isFocused = useIsFocused();

  // Render-synced mirrors: the effect runs after a commit, where values
  // captured in its closure would be a render behind.
  const labelRef = useRef<string | null>(null);
  labelRef.current = blockedPeer?.label ?? null;
  const focusedRef = useRef(isFocused);
  focusedRef.current = isFocused;
  const onBlockRef = useRef(onBlock);
  onBlockRef.current = onBlock;

  const wasBlockedRef = useRef(false);
  useEffect(() => {
    if (!isBlocked) {
      wasBlockedRef.current = false;
      return;
    }
    if (wasBlockedRef.current) return;
    wasBlockedRef.current = true;
    onBlockRef.current?.();
    if (!focusedRef.current) return;
    AccessibilityInfo.announceForAccessibility(
      `You blocked ${labelRef.current ?? 'this person'}. Sending is turned off.`,
    );
  }, [isBlocked]);
}
