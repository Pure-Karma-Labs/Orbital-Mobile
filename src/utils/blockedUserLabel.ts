/**
 * The one place that turns a blocked user id into a display label (#908).
 *
 * Extracted from `settings/BlockedUsersScreen`'s private `useBlockedUserRows`
 * so the Blocked Users list and the in-DM blocked notice can never disagree
 * about what a blocked person is called.
 *
 * THE @-PREFIX INVARIANT (moved here from BlockedUsersScreen, #896). Ids
 * hydrated from the server carry no username, so they render as a
 * disambiguating `user-<first 8 of id>` label rather than a shared placeholder
 * handle. That fallback is not only a pre-hydration state: a user blocked from
 * an orbit the viewer has since left has no contact row to resolve against and
 * stays id-labelled permanently. Unresolved labels render WITHOUT the `@`
 * prefix so they can never be mistaken for a real handle — `resolved` is what
 * callers must gate the `@` on, and `label` already has it applied.
 */

import type { Contact } from '../types/store';

export interface BlockedUserLabel {
  /** Display-ready: `@name` when resolved, `user-xxxxxxxx` when not. */
  label: string;
  /** False when the label is id-derived — it is NOT a handle. */
  resolved: boolean;
}

/**
 * Resolve a blocked user's label.
 *
 * Lookup order: contacts → `blockedUserProfiles` → `fallbackUsername`.
 *
 * @param userId           - The blocked user's id.
 * @param contacts         - The contacts map (may be partial/undefined in mocks).
 * @param blockedUserProfiles - id → username captured at block time.
 * @param fallbackUsername - A last-resort username the CALLER knows is this
 *   user's handle. `deriveBlockedDmPeer` passes `Conversation.name` for direct
 *   rows only; Settings passes nothing, so its behaviour is unchanged.
 */
export function blockedUserLabel(
  userId: string,
  contacts: Record<string, Contact> | undefined,
  blockedUserProfiles: Record<string, string> | undefined,
  fallbackUsername?: string | null,
): BlockedUserLabel {
  // A corrupt persisted entry (non-string) must not throw in .slice — the
  // Blocked Users screen is the user's only way to undo a block.
  if (typeof userId !== 'string') {
    return { label: 'Unknown user', resolved: false };
  }

  const username =
    contacts?.[userId]?.username ??
    blockedUserProfiles?.[userId] ??
    (fallbackUsername != null && fallbackUsername !== '' ? fallbackUsername : undefined);

  return username != null
    ? { label: `@${username}`, resolved: true }
    : { label: `user-${userId.slice(0, 8)}`, resolved: false };
}
