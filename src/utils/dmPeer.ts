/**
 * DM peer resolution — the SINGLE path from a conversation id to the other
 * member's user id, and the single derivation of "is this DM's peer blocked"
 * (#908).
 *
 * Nothing else may re-derive either answer. Every surface that hides a blocked
 * peer (Chats list, New Chat, Chat detail, the composers, File Library chips)
 * and the service-layer send refusal in `threadService` go through these two
 * functions, so the render path and the send path cannot drift. `useAppStore`
 * is deliberately NOT imported here: this module is pure, which is what lets
 * the service, the hook and the tests all call it the same way.
 *
 * FAIL-OPEN vs FAIL-CLOSED is two separate decisions:
 * - Visibility fails OPEN. A row whose peer cannot be resolved stays visible;
 *   hiding a conversation the user may legitimately own is worse than showing
 *   one row too many.
 * - Sending fails CLOSED at the service layer (threadService / startDm), which
 *   resolves through this same derivation. The remaining windows where a send
 *   can still get through are: a DM row persisted before #908 whose peer is
 *   also missing from contacts and whose block was made offline (an online
 *   block refreshes the DM list and backfills `peerUserId`), and an unknown DM
 *   row that is absent from the store with no peer contact either. The backend
 *   403 follow-up is the backstop for both.
 */

import type { Contact, Conversation } from '../types/store';
import { blockedUserLabel } from './blockedUserLabel';

export interface BlockedDmPeer {
  peerId: string;
  /** Display-ready label — `@name` only when resolved (see blockedUserLabel). */
  label: string;
  labelResolved: boolean;
}

/**
 * The slices this derivation reads. Every field is optional on purpose: a
 * screen test with a partial store mock must degrade to "not blocked" rather
 * than throw. A full `AppState` is assignable to it.
 */
export interface BlockedDmPeerState {
  conversations?: Record<string, Conversation>;
  contacts?: Record<string, Contact>;
  blockedUserIds?: string[];
  blockedUserProfiles?: Record<string, string>;
}

/**
 * Resolve the peer user id of a DM conversation, or null when it is not a DM
 * or the peer cannot be determined.
 *
 * Precedence, in order:
 *  1. A row that exists and is NOT `type: 'direct'` resolves to null. An orbit
 *     id is never reverse-looked-up to a member.
 *  2. `conv.peerUserId` (written by `mapDmResponse` and `startDm`).
 *  3. The contact reverse-scan by conversation id, which works with or without
 *     the row. When the row is MISSING, the scan is accepted only if exactly
 *     one contact lists the id: a DM id lives on exactly one contact, while an
 *     orbit id lives on many, so an unknown orbit row can never resolve to an
 *     arbitrary member.
 *  4. `hint` — the caller's assertion of DM intent. Only DM-only routes pass
 *     one (ChatDetail's `route.params.recipientId`), and step 1 has already
 *     rejected a known non-DM row.
 *
 * @param conversationId - The conversation id. Keyed off the id, not the row,
 *   so a missing row is still resolvable.
 * @param conv  - The row from the store, or undefined when absent.
 * @param contacts - The contacts map.
 * @param hint  - A peer id asserted by a DM-only route, if any.
 */
export function resolveDmPeerId(
  conversationId: string | null,
  conv: Conversation | undefined,
  contacts: Record<string, Contact> | undefined,
  hint?: string | null,
): string | null {
  if (!conversationId) return null;

  if (conv !== undefined && conv.type !== 'direct') return null;

  if (conv?.peerUserId) return conv.peerUserId;

  let match: string | null = null;
  let matchCount = 0;
  for (const contact of Object.values(contacts ?? {})) {
    if (contact?.conversationIds?.includes(conversationId)) {
      matchCount++;
      if (match === null) match = contact.id;
    }
  }
  // With the row present we know it is a DM, so the first match is the peer.
  // Without it, only an unambiguous single match is trustworthy.
  if (match !== null && (conv !== undefined || matchCount === 1)) return match;

  return hint ?? null;
}

/**
 * Derive the blocked peer of a DM conversation, or null when there is none.
 *
 * Returns null immediately when nothing is blocked, which is the case for
 * nearly every session, so every call site can run this on every render.
 */
export function deriveBlockedDmPeer(
  state: BlockedDmPeerState,
  conversationId: string | null,
  hint?: string | null,
): BlockedDmPeer | null {
  const blockedUserIds = state.blockedUserIds;
  if (!blockedUserIds || blockedUserIds.length === 0) return null;
  if (!conversationId) return null;

  const conv = state.conversations?.[conversationId];
  const peerId = resolveDmPeerId(conversationId, conv, state.contacts, hint);
  if (!peerId) return null;
  if (!blockedUserIds.includes(peerId)) return null;

  // `Conversation.name` IS the peer's username for a direct row (mapDmResponse
  // writes `recipient.username`, as does startDm), so using it as the label
  // fallback keeps the "`@` only when resolved" invariant from #896 — it is a
  // real handle, not an id. Never pass it for a non-direct row, where the name
  // is the orbit's.
  const fallbackUsername = conv?.type === 'direct' ? conv.name : null;
  const { label, resolved } = blockedUserLabel(
    peerId,
    state.contacts,
    state.blockedUserProfiles,
    fallbackUsername,
  );

  return { peerId, label, labelResolved: resolved };
}
