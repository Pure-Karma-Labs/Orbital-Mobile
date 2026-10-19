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
 *   resolves through this same derivation.
 *
 * The windows where a send can still get through, all of which need the
 * conversation row to be unhelpful AND the block to have been made offline (an
 * online block refreshes the DM list and backfills `peerUserId`):
 *  1. A DM row persisted before #908 (no `peerUserId`) whose peer is also
 *     missing from contacts.
 *  2. A DM row that is absent from the store altogether. The send path cannot
 *     assert `dmIntent` (`postReply` and `createNewThread` take a group id that
 *     may be an orbit's), so the missing-row contact scan is not available to
 *     it — see `resolveDmPeerId`. Refusing there would refuse legitimate
 *     replies into a two-member ORBIT whose row had not loaded, which is the
 *     worse failure.
 * Closing these needs a server-side refusal; there is no client-side fix that
 * does not also break orbit replies.
 */

import type { Contact, Conversation } from '../types/store';
import { blockedUserLabel } from './blockedUserLabel';

export interface BlockedDmPeer {
  peerId: string;
  /** Display-ready label — `@name` only when resolved (see blockedUserLabel). */
  label: string;
}

/**
 * How a peer id was resolved. Only `deriveBlockedDmPeer` consumes this, to
 * decide whether the row's own `name` is a trustworthy label for it.
 */
export type DmPeerSource = 'row' | 'contact' | 'hint';

export interface DmPeerResolution {
  peerId: string;
  source: DmPeerSource;
}

/**
 * What the caller knows about the conversation id it is handing in.
 *
 * `dmIntent` is an ASSERTION, not a hint: "this id came from a DM-only route
 * or a DM-only list, so it cannot be an orbit". Only callers that can honestly
 * make that claim pass it — see `resolveDmPeerId`.
 */
export interface DmPeerOptions {
  /** A peer id asserted by a DM-only route (ChatDetail's `recipientId`). */
  hint?: string | null;
  /** The caller asserts this conversation id is a DM. */
  dmIntent?: boolean;
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
 *  3. The contact reverse-scan by conversation id. With the row PRESENT we
 *     already know it is a DM, so the first match is the peer. With the row
 *     ABSENT the scan runs only when the caller asserts DM intent (`dmIntent`,
 *     or a `hint`, which is itself a DM-only assertion). `hydrateContactsFromOrbits`
 *     writes the orbit id onto every co-member's contact, so a two-member ORBIT
 *     also yields exactly one match — an unambiguous match is therefore NOT on
 *     its own evidence of a DM, and callers that cannot tell the two apart
 *     (ThreadDetail, `postReply`, `createNewThread`) must get null instead.
 *  4. `hint` — the caller's assertion of DM intent. Only DM-only routes pass
 *     one (ChatDetail's `route.params.recipientId`), and step 1 has already
 *     rejected a known non-DM row.
 *
 * @param conversationId - The conversation id. Keyed off the id, not the row,
 *   so a missing row is still resolvable.
 * @param conv  - The row from the store, or undefined when absent.
 * @param contacts - The contacts map.
 * @param options - `hint` and/or `dmIntent`; see `DmPeerOptions`.
 */
export function resolveDmPeer(
  conversationId: string | null,
  conv: Conversation | undefined,
  contacts: Record<string, Contact> | undefined,
  options?: DmPeerOptions,
): DmPeerResolution | null {
  if (!conversationId) return null;

  if (conv !== undefined && conv.type !== 'direct') return null;

  if (conv?.peerUserId) return { peerId: conv.peerUserId, source: 'row' };

  const hint = options?.hint ?? null;
  // A hint IS an assertion of DM intent: only DM-only routes carry one.
  const dmIntent = options?.dmIntent === true || hint !== null;

  if (conv !== undefined || dmIntent) {
    for (const contact of Object.values(contacts ?? {})) {
      if (contact?.conversationIds?.includes(conversationId)) {
        return { peerId: contact.id, source: 'contact' };
      }
    }
  }

  return hint !== null ? { peerId: hint, source: 'hint' } : null;
}

/** `resolveDmPeer` without the source — the common case. */
export function resolveDmPeerId(
  conversationId: string | null,
  conv: Conversation | undefined,
  contacts: Record<string, Contact> | undefined,
  options?: DmPeerOptions,
): string | null {
  return resolveDmPeer(conversationId, conv, contacts, options)?.peerId ?? null;
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
  options?: DmPeerOptions,
): BlockedDmPeer | null {
  const blockedUserIds = state.blockedUserIds;
  if (!blockedUserIds || blockedUserIds.length === 0) return null;
  if (!conversationId) return null;

  const conv = state.conversations?.[conversationId];
  const resolution = resolveDmPeer(conversationId, conv, state.contacts, options);
  if (!resolution) return null;
  const { peerId, source } = resolution;
  if (!blockedUserIds.includes(peerId)) return null;

  // `Conversation.name` IS the peer's username for a direct row (mapDmResponse
  // writes `recipient.username`, as does startDm), so using it as the label
  // fallback keeps the "`@` only when resolved" invariant from #896 — it is a
  // real handle, not an id. Never pass it for a non-direct row, where the name
  // is the orbit's, and never when the id came from the HINT rather than from
  // the row or the contacts: a pre-#908 row with no matching contact and a
  // differing deep-link `recipientId` would otherwise be labelled with the
  // row's handle while Unblock acted on the hint's id.
  const fallbackUsername = source !== 'hint' && conv?.type === 'direct' ? conv.name : null;
  const { label } = blockedUserLabel(
    peerId,
    state.contacts,
    state.blockedUserProfiles,
    fallbackUsername,
  );

  return { peerId, label };
}
