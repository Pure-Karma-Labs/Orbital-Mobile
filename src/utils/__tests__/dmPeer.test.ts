/**
 * Tests for the single DM-peer resolution path (#908).
 */

import { resolveDmPeerId, deriveBlockedDmPeer } from '../dmPeer';
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
    expect(resolveDmPeerId(DM_ID, conv, contacts, 'u-hint')).toBe(PEER_ID);
  });

  it('falls back to the contact whose conversationIds includes the id', () => {
    const conv = makeConversation({ id: DM_ID });
    const contacts = {
      [PEER_ID]: makeContact({ id: PEER_ID, conversationIds: ['other', DM_ID] }),
      'u-noise': makeContact({ id: 'u-noise', conversationIds: ['orbit-9'] }),
    };
    expect(resolveDmPeerId(DM_ID, conv, contacts, 'u-hint')).toBe(PEER_ID);
  });

  it('prefers the contact lookup over the hint', () => {
    const conv = makeConversation({ id: DM_ID });
    const contacts = {
      [PEER_ID]: makeContact({ id: PEER_ID, conversationIds: [DM_ID] }),
    };
    expect(resolveDmPeerId(DM_ID, conv, contacts, 'u-hint')).toBe(PEER_ID);
  });

  it('returns null for a group conversation even when a contact lists its id', () => {
    const conv = makeConversation({ id: 'orbit-1', type: 'group', peerUserId: PEER_ID });
    const contacts = {
      [PEER_ID]: makeContact({ id: PEER_ID, conversationIds: ['orbit-1'] }),
    };
    expect(resolveDmPeerId('orbit-1', conv, contacts, 'u-hint')).toBeNull();
  });

  it('accepts the contact scan for a MISSING row only when exactly one contact matches', () => {
    const single = {
      [PEER_ID]: makeContact({ id: PEER_ID, conversationIds: [DM_ID] }),
    };
    expect(resolveDmPeerId(DM_ID, undefined, single)).toBe(PEER_ID);

    // An orbit id lives on many contacts — never resolve it to a member.
    const many = {
      'u-a': makeContact({ id: 'u-a', conversationIds: ['orbit-1'] }),
      'u-b': makeContact({ id: 'u-b', conversationIds: ['orbit-1'] }),
    };
    expect(resolveDmPeerId('orbit-1', undefined, many)).toBeNull();
  });

  it('returns the hint for a missing row with no matching contact, and null without one', () => {
    expect(resolveDmPeerId(DM_ID, undefined, {}, 'u-hint')).toBe('u-hint');
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
    ).toEqual({ peerId: PEER_ID, label: '@bob_contact', labelResolved: true });
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
    ).toEqual({ peerId: PEER_ID, label: '@bob_profile', labelResolved: true });
  });

  it('labels from the DM row name last, still as a resolved handle', () => {
    expect(
      deriveBlockedDmPeer({ conversations: { [DM_ID]: conv }, blockedUserIds: [PEER_ID] }, DM_ID),
    ).toEqual({ peerId: PEER_ID, label: '@bob', labelResolved: true });
  });

  it('falls back to an id label with NO @ when nothing resolves', () => {
    const nameless = makeConversation({ id: DM_ID, peerUserId: 'abcdefghijkl' });
    expect(
      deriveBlockedDmPeer(
        { conversations: { [DM_ID]: nameless }, blockedUserIds: ['abcdefghijkl'] },
        DM_ID,
      ),
    ).toEqual({ peerId: 'abcdefghijkl', label: 'user-abcdefgh', labelResolved: false });
  });

  it('uses the route hint when the conversation row is missing', () => {
    expect(
      deriveBlockedDmPeer(
        { conversations: {}, contacts: {}, blockedUserIds: [PEER_ID] },
        DM_ID,
        PEER_ID,
      ),
    ).toEqual({ peerId: PEER_ID, label: 'user-u-bob', labelResolved: false });
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
        PEER_ID,
      ),
    ).toBeNull();
  });
});
