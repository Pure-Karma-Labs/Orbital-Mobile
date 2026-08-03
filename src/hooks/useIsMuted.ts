/**
 * Per-target mute lookup (#449).
 *
 * Deliberately returns a BOOLEAN rather than the mute map itself: list rows are
 * memoized, and selecting `s.mutedTargets` would re-render every visible row
 * whenever any single target's mute state changed. A boolean selector only
 * re-renders the row whose own target flipped.
 *
 * Kept in its own module (rather than beside useMuteActions) so that memoized
 * row components can read mute state without pulling the notification settings
 * network layer into their import graph.
 */

import { useAppStore } from '../stores';

export function useIsMuted(targetId: string | null | undefined): boolean {
  return useAppStore((s) => (targetId != null && s.mutedTargets[targetId] != null));
}
