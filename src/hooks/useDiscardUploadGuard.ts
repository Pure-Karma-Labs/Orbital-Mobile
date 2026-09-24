/**
 * useDiscardUploadGuard -- confirm before leaving a composer that would lose an
 * upload (#722).
 *
 * Two states arm the guard:
 * - `uploading`: the batch is still in flight, and leaving aborts it
 *   (useMediaUploadProgress's unmount abort), so the post is never created.
 * - `unsent`: the upload finished but the create failed, so the screen holds
 *   media ids that only this screen session can still attach.
 *
 * Mechanics worth knowing before editing:
 * - `usePreventRemove` feeds native-stack's `preventNativeDismiss`. On iOS a
 *   swipe-back snaps back first and the prompt arrives via the cancelled-dismiss
 *   `pop()`.
 * - Re-dispatching the SAME `data.action` object is what lets the navigation
 *   through: React Navigation tags the action with a visited-route-keys set, so
 *   a copy would be prevented all over again. A fresh back press builds a new
 *   action and prompts again -- which is why the one-shot ref below is scoped to
 *   a single open alert, not to the screen's lifetime.
 * - Not guarded: the post-upload create call (a single unabortable POST) and a
 *   self-cancel via the composer's X.
 */

import { useCallback, useEffect, useRef } from 'react';
import { Alert } from 'react-native';
import { useNavigation, usePreventRemove } from '@react-navigation/native';
import type { NavigationAction } from '@react-navigation/routers';

export interface UseDiscardUploadGuardOptions {
  /** An upload is in flight and has not already been told to stop. */
  uploading: boolean;
  /** Uploaded-but-unattached media is being held (post-failure retry state). */
  unsent: boolean;
  /** What the user would lose, used in the prompt copy. */
  noun: 'reply' | 'post' | 'message';
  /** Cancel the upload and drop the reuse cache. Called before the dispatch. */
  onDiscard: () => void;
}

export function useDiscardUploadGuard({
  uploading,
  unsent,
  noun,
  onDiscard,
}: UseDiscardUploadGuardOptions): void {
  const navigation = useNavigation();

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Latest-callback ref: the guard callback is re-registered on copy changes
  // only, so a fresh onDiscard identity must not force a resubscribe.
  const onDiscardRef = useRef(onDiscard);
  useEffect(() => {
    onDiscardRef.current = onDiscard;
  }, [onDiscard]);

  /**
   * One-shot latch. Android's hardware back fires per press, so mashing it
   * would otherwise stack an alert per press. Both buttons release it, and so
   * does the unmounted early return -- a latched ref on a dead screen would
   * survive nothing, but releasing it keeps the two exits symmetrical.
   */
  const alertOpenRef = useRef(false);

  const handlePreventedRemove = useCallback(
    ({ data }: { data: { action: NavigationAction } }) => {
      if (alertOpenRef.current) return;
      alertOpenRef.current = true;

      const title = uploading ? 'Discard upload?' : `Discard unsent ${noun}?`;
      const message = uploading
        ? `Your media is still uploading. If you leave now, the upload is cancelled and your ${noun} won't be sent.`
        : 'Your attached media will be discarded.';

      Alert.alert(title, message, [
        {
          text: uploading ? 'Keep uploading' : 'Keep editing',
          style: 'cancel',
          onPress: () => {
            alertOpenRef.current = false;
          },
        },
        {
          text: 'Discard',
          style: 'destructive',
          onPress: () => {
            alertOpenRef.current = false;
            // The alert outlives the screen: an upload that finishes while it
            // is open can navigate away (Compose replaces itself with the new
            // thread). Dispatching from a dead screen would pop whatever is
            // there now.
            if (!mountedRef.current) return;
            onDiscardRef.current();
            navigation.dispatch(data.action);
          },
        },
      ]);
    },
    [navigation, noun, uploading],
  );

  usePreventRemove(uploading || unsent, handlePreventedRemove);
}
