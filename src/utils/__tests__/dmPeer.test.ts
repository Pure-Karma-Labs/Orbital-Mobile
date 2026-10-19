/**
 * Tests for the single DM-peer resolution path (#908).
 */

import { resolveDmPeer, resolveDmPeerId, deriveBlockedDmPeer } from '../dmPeer';
import type { Contact, Conversation } from '../../types/store';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeContact(overrides: Partial<Contact> & { id: string }): Contact {
  return {
    username: null,
    displayName: null,
    avatarPath: null,
    conversationIds: [],
    ...overrides,
  };
}

function makeConversation(overrides: Partial<Conversation> & { id: string }): Conversation {
  return {
    type: 'direct',
    name: null,
    memberCount: 2,
    active: true,
    lastMessageAt: null,
    unreadCount: 0,
    lastReadAt: null,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

const DM_ID = 'dm-1';
const PEER_ID = 'u-bob';

// ---------------------------------------------------------------------------
// resolveDmPeer — source field
// ---------------------------------------------------------------------------

describe('resolveDmPeer — source field', () => {
  it('returns source "row" when peer comes from conv.peerUserId', () => {
    const conv = makeConversation({ id: DM_ID, peerUserId: PEER_ID });
    expect(resolveDmPeer(DM_ID, conv, {})).toEqual({ peerId: PEER_ID, source: 'row' });
  });

  it('returns source "contact" when peer comes from the contacts reverse-scan', () => {
    const conv = makeConversation({ id: DM_ID });
    const contacts = { [PEER_ID]: makeContact({ id: PEER_ID, conversationIds: [DM_ID] }) };
    expect(resolveDmPeer(DM_ID, conv, contacts)).toEqual({ peerId: PEER_ID, source: 'contact' });
  });

  it('returns source "hint" when peer falls through to the hint', () => {
    // Row is absent; hint provides identity; no matching contacts.
    expect(resolveDmPeer(DM_ID, undefined, {}, { hint: 'u-hint' })).toEqual({
      peerId: 'u-hint',
      source: 'hint',
    });
  });
});

// ---------------------------------------------------------------------------
// resolveDmPeerId
// ---------------------------------------------------------------------------

describe('resolveDmPeerId', () => {
  it('returns null without a conversation id', () => {
    expect(resolveDmPeerId(null, undefined, {})).toBeNull();
  });

  it('prefers peerUserId over the contact lookup and over the hint', () => {
    const conv = makeConversation({ id: DM_ID, peerUserId: PEER_ID });
    const contacts = {
      'u-other': makeContact({ id: 'u-other', conversationIds: [DM_ID] }),
    };
    expect(resolveDmPeerId(DM_ID, conv, contacts, { hint: 'u-hint' })).toBe(PEER_ID);
  });

  it('falls back to the contact whose conversationIds includes the id', () => {
    const conv = makeConversation({ id: DM_ID });
    const contacts = {
      [PEER_ID]: makeContact({ id: PEER_ID, conversationIds: ['other', DM_ID] }),
      'u-noise': makeContact({ id: 'u-noise', conversationIds: ['orbit-9'] }),
    };
    expect(resolveDmPeerId(DM_ID, conv, contacts, { hint: 'u-hint' })).toBe(PEER_ID);
  });

  it('prefers the contact lookup over the hint', () => {
    const conv = makeConversation({ id: DM_ID });
    const contacts = {
      [PEER_ID]: makeContact({ id: PEER_ID, conversationIds: [DM_ID] }),
    };
    expect(resolveDmPeerId(DM_ID, conv, contacts, { hint: 'u-hint' })).toBe(PEER_ID);
  });

  it('returns null for a group conversation even when a contact lists its id', () => {
    const conv = makeConversation({ id: 'orbit-1', type: 'group', peerUserId: PEER_ID });
    const contacts = {
      [PEER_ID]: makeContact({ id: PEER_ID, conversationIds: ['orbit-1'] }),
    };
    expect(resolveDmPeerId('orbit-1', conv, contacts, { hint: 'u-hint' })).toBeNull();
  });

  // --- dmIntent gate ---

  it('returns null for a MISSING row when no dmIntent or hint is passed (orbit ambiguity guard)', () => {
    // Exactly one contact matches — but without dmIntent/hint, a missing row
    // could be a two-member orbit, so the scan must NOT run.
    const contacts = {
      [PEER_ID]: makeContact({ id: PEER_ID, conversationIds: [DM_ID] }),
    };
    expect(resolveDmPeerId(DM_ID, undefined, contacts)).toBeNull();
  });

  it('resolves the FIRST contact match with dmIntent: true even when the row is MISSING', () => {
    const contacts = {
      [PEER_ID]: makeContact({ id: PEER_ID, conversationIds: [DM_ID] }),
    };
    expect(resolveDmPeerId(DM_ID, undefined, contacts, { dmIntent: true })).toBe(PEER_ID);
  });

  it('resolves the FIRST contact match when hint is present (hint IS a dmIntent assertion)', () => {
    // hint alone triggers dmIntent; contact scan wins over the hint itself.
    const contacts = {
      [PEER_ID]: makeContact({ id: PEER_ID, conversationIds: [DM_ID] }),
    };
    expect(resolveDmPeerId(DM_ID, undefined, contacts, { hint: 'u-other' })).toBe(PEER_ID);
  });

  it('row PRESENT + no peerUserId + two contacts listing the id → first match wins (no ambiguity refusal)', () => {
    const conv = makeConversation({ id: DM_ID }); // no peerUserId, type: 'direct'
    const contacts = {
      'u-a': makeContact({ id: 'u-a', conversationIds: [DM_ID] }),
      'u-b': makeContact({ id: 'u-b', conversationIds: [DM_ID] }),
    };
    // Row present means we already know it is a DM — first match wins.
    const result = resolveDmPeerId(DM_ID, conv, contacts);
    expect(['u-a', 'u-b']).toContain(result);
  });

  it('returns the hint for a missing row with no matching contact, and null without one', () => {
    expect(resolveDmPeerId(DM_ID, undefined, {}, { hint: 'u-hint' })).toBe('u-hint');
    expect(resolveDmPeerId(DM_ID, undefined, {})).toBeNull();
    expect(resolveDmPeerId(DM_ID, undefined, undefined)).toBeNull();
  });

  it('tolerates a contact row with no conversationIds array', () => {
    const contacts = {
      'u-bad': { id: 'u-bad' } as unknown as Contact,
    };
    expect(resolveDmPeerId(DM_ID, undefined, contacts)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// deriveBlockedDmPeer
// ---------------------------------------------------------------------------

describe('deriveBlockedDmPeer', () => {
  const conv = makeConversation({ id: DM_ID, name: 'bob', peerUserId: PEER_ID });

  it('short-circuits on an empty block list', () => {
    expect(
      deriveBlockedDmPeer(
        { conversations: { [DM_ID]: conv }, contacts: {}, blockedUserIds: [] },
        DM_ID,
      ),
    ).toBeNull();
  });

  it('tolerates missing slices (a partial store mock degrades to "not blocked")', () => {
    expect(deriveBlockedDmPeer({}, DM_ID)).toBeNull();
    expect(deriveBlockedDmPeer({ blockedUserIds: [PEER_ID] }, DM_ID)).toBeNull();
    expect(deriveBlockedDmPeer({ blockedUserIds: [PEER_ID] }, null)).toBeNull();
  });

  it('returns null when the resolved peer is not blocked', () => {
    expect(
      deriveBlockedDmPeer(
        { conversations: { [DM_ID]: conv }, blockedUserIds: ['u-someone-else'] },
        DM_ID,
      ),
    ).toBeNull();
  });

  it('labels from contacts first', () => {
    expect(
      deriveBlockedDmPeer(
        {
          conversations: { [DM_ID]: conv },
          contacts: { [PEER_ID]: makeContact({ id: PEER_ID, username: 'bob_contact' }) },
          blockedUserProfiles: { [PEER_ID]: 'bob_profile' },
          blockedUserIds: [PEER_ID],
        },
        DM_ID,
      ),
    ).toEqual({ peerId: PEER_ID, label: '@bob_contact' });
  });

  it('labels from blockedUserProfiles next', () => {
    expect(
      deriveBlockedDmPeer(
        {
          conversations: { [DM_ID]: conv },
          contacts: {},
          blockedUserProfiles: { [PEER_ID]: 'bob_profile' },
          blockedUserIds: [PEER_ID],
        },
        DM_ID,
      ),
    ).toEqual({ peerId: PEER_ID, label: '@bob_profile' });
  });

  it('labels from the DM row name last, still as a resolved handle', () => {
    expect(
      deriveBlockedDmPeer({ conversations: { [DM_ID]: conv }, blockedUserIds: [PEER_ID] }, DM_ID),
    ).toEqual({ peerId: PEER_ID, label: '@bob' });
  });

  it('falls back to an id label with NO @ when nothing resolves', () => {
    const nameless = makeConversation({ id: DM_ID, peerUserId: 'abcdefghijkl' });
    expect(
      deriveBlockedDmPeer(
        { conversations: { [DM_ID]: nameless }, blockedUserIds: ['abcdefghijkl'] },
        DM_ID,
      ),
    ).toEqual({ peerId: 'abcdefghijkl', label: 'user-abcdefgh' });
  });

  it('uses the route hint when the conversation row is missing', () => {
    expect(
      deriveBlockedDmPeer({ conversations: {}, contacts: {}, blockedUserIds: [PEER_ID] }, DM_ID, {
        hint: PEER_ID,
      }),
    ).toEqual({ peerId: PEER_ID, label: 'user-u-bob' });
  });

  it('never resolves an orbit row, even when its member is blocked', () => {
    const orbit = makeConversation({ id: 'orbit-1', type: 'group', name: 'Family' });
    expect(
      deriveBlockedDmPeer(
        {
          conversations: { 'orbit-1': orbit },
          contacts: { [PEER_ID]: makeContact({ id: PEER_ID, conversationIds: ['orbit-1'] }) },
          blockedUserIds: [PEER_ID],
        },
        'orbit-1',
        { hint: PEER_ID },
      ),
    ).toBeNull();
  });

  // --- Two-member orbit with missing row (dmIntent gate) ---

  it('returns null for a two-member orbit id whose row is absent and no dmIntent/hint (guard against orbit refusal)', () => {
    // hydrateContactsFromOrbits writes the orbit id onto every co-member's
    // conversationIds, so one match does NOT prove this is a DM.
    const contacts = {
      [PEER_ID]: makeContact({ id: PEER_ID, conversationIds: ['orbit-2'] }),
    };
    expect(
      deriveBlockedDmPeer({ conversations: {}, contacts, blockedUserIds: [PEER_ID] }, 'orbit-2'),
    ).toBeNull();
  });

  it('resolves the blocked peer when dmIntent: true is asserted even with a missing row', () => {
    const contacts = {
      [PEER_ID]: makeContact({ id: PEER_ID, conversationIds: [DM_ID] }),
    };
    expect(
      deriveBlockedDmPeer({ conversations: {}, contacts, blockedUserIds: [PEER_ID] }, DM_ID, {
        dmIntent: true,
      }),
    ).toEqual({ peerId: PEER_ID, label: 'user-u-bob' });
  });

  // --- Hint-label rule (source !== 'hint' guard) ---

  it('hint-sourced peer does NOT borrow the row name as label (guard against label/id mismatch)', () => {
    // A type:'direct' row with name:'rowhandle' and no peerUserId and no matching
    // contact, but a hint pointing to a different blocked user id.
    const hintId = 'u-other-xyz';
    const rowWithName = makeConversation({ id: DM_ID, type: 'direct', name: 'rowhandle' });
    const result = deriveBlockedDmPeer(
      {
        conversations: { [DM_ID]: rowWithName },
        contacts: {},
        blockedUserIds: [hintId],
        blockedUserProfiles: {},
      },
      DM_ID,
      { hint: hintId },
    );
    // Peer resolved from hint must NOT get the row's name (@rowhandle).
    expect(result).not.toBeNull();
    expect(result?.label).not.toBe('@rowhandle');
    // Label must be the unresolved id form.
    expect(result?.label).toBe(`user-${hintId.slice(0, 8)}`);
  });

  it('row peerUserId peer DOES borrow the row name as label (source === "row" path)', () => {
    // The same row name is available and the peer comes from peerUserId (source:'row').
    const rowPeerId = 'u-rowpeer0';
    const rowWithName = makeConversation({
      id: DM_ID,
      type: 'direct',
      name: 'rowhandle',
      peerUserId: rowPeerId,
    });
    const result = deriveBlockedDmPeer(
      {
        conversations: { [DM_ID]: rowWithName },
        contacts: {},
        blockedUserIds: [rowPeerId],
        blockedUserProfiles: {},
      },
      DM_ID,
    );
    expect(result?.label).toBe('@rowhandle');
  });
});
