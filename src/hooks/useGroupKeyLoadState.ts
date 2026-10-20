/**
 * The group-key read-surface state pair (#912) and its error routing, shared by
 * every screen that loads content behind a group key.
 *
 * ThreadsScreen, ChatDetailScreen and ThreadDetailScreen each carried their own
 * copy of the same three things: the `keyPending` / `keyFailureMessage` pair,
 * the reset-on-id effect, and the `isGroupKeyPending` → `groupKeyFailureCopy` →
 * fall-through routing. #940 adds a SECOND call site per screen (pull-to-refresh
 * used to swallow key errors, so a stale banner survived the pull that was
 * meant to re-classify it), which would have taken the routing from three copies
 * to six. One hook instead.
 *
 * The screens keep their own render branches: the three surfaces disagree about
 * what a pending key looks like (a blank body, an empty-state replacement, a
 * list footer), and that disagreement is deliberate. Only the state and its
 * routing are shared.
 *
 * @module useGroupKeyLoadState
 */

import { useCallback, useEffect, useState } from 'react';
import { groupKeyFailureCopy, isGroupKeyPending } from '../utils/groupKeyErrorCopy';

export interface GroupKeyLoadState {
  /** The transient "a peer is re-wrapping this key" banner. */
  keyPending: boolean;
  /** Copy for every other group-key outcome, or null. Never set with `keyPending`. */
  keyFailureMessage: string | null;
  /**
   * The key opened, so whatever state this screen was in is over. Called on a
   * load or refresh SUCCESS only — clearing at the start of a load would flash
   * the create-first empty state on every reload attempt.
   */
  clearKeyState: () => void;
  /**
   * Route a load rejection. Returns whether it was a group-key error, so the
   * caller can decide what to do with everything else: ThreadDetail falls
   * through to its "Could not load thread" text, and the two list screens stay
   * silent because their stale content is still visible and a network blip must
   * not claim to be a key problem.
   */
  applyKeyLoadError: (e: unknown) => boolean;
}

/**
 * @param resetKey - The id this state belongs to (an orbit, a DM conversation
 *   or a thread). A change clears both values: all three screens stay MOUNTED
 *   across a switch, so without this, orbit A's banner sat over orbit B —
 *   indefinitely, if B's own load then failed for a non-key reason, since the
 *   values clear only on a success.
 *
 *   Deliberately NOT keyed on the heal generation: a heal bump re-runs the
 *   screen's load, and clearing there would flash the empty state on every
 *   reload attempt.
 */
export function useGroupKeyLoadState(resetKey?: string | null): GroupKeyLoadState {
  const [keyPending, setKeyPending] = useState(false);
  const [keyFailureMessage, setKeyFailureMessage] = useState<string | null>(null);

  // Both callbacks are STABLE (the setters are, and the deps are empty). The
  // screens list them in load-effect and useCallback deps, where a fresh
  // identity per render would re-run the load on every render.
  const clearKeyState = useCallback(() => {
    setKeyPending(false);
    setKeyFailureMessage(null);
  }, []);

  const applyKeyLoadError = useCallback((e: unknown): boolean => {
    if (isGroupKeyPending(e)) {
      setKeyPending(true);
      setKeyFailureMessage(null);
      return true;
    }
    const copy = groupKeyFailureCopy(e);
    if (copy) {
      // #937: past the 24h bound the crypto layer raises `stale_pending`
      // instead of PendingWrapError, so this branch is also what takes the
      // transient banner back down.
      setKeyPending(false);
      setKeyFailureMessage(copy.message);
      return true;
    }
    return false;
  }, []);

  useEffect(() => {
    clearKeyState();
  }, [resetKey, clearKeyState]);

  return { keyPending, keyFailureMessage, clearKeyState, applyKeyLoadError };
}
