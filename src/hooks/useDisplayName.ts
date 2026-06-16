/**
 * Resolves a display name for a given author at render time.
 *
 * Reads from the Zustand contacts store so that display name changes
 * (including real-time WebSocket `display_name_changed` events)
 * propagate to all visible UI without prop drilling.
 *
 * Returns a primitive string — no useShallow needed.
 */

import { useAppStore } from '../stores';

/**
 * @param authorId   - UUID of the author, or null/undefined for deleted users
 * @param fallbackUsername - the raw username to fall back to if no display name is set
 */
export function useDisplayName(
  authorId: string | null | undefined,
  fallbackUsername: string,
): string {
  return useAppStore((s) => {
    if (!authorId) return 'Deleted User';
    if (authorId === s.userId) return s.displayName ?? fallbackUsername;
    return s.contacts[authorId]?.displayName ?? fallbackUsername;
  });
}
