/**
 * Tests for the `useContactForConversation` selector after #908 re-expressed
 * it through the single DM-peer resolver.
 *
 * The store module is replaced with a real zustand store: importing
 * `src/stores/useAppStore` pulls in MMKV persistence, which does not load
 * under jest.
 */

import React from 'react';
import { Text } from 'react-native';
import { act, create } from 'react-test-renderer';
import type { Contact, Conversation } from '../../types/store';

interface TestState {
  conversations: Record<string, Conversation>;
  contacts: Record<string, Contact>;
}

jest.mock('../useAppStore', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- jest.mock factories are hoisted above imports
  const { create: createStore } = require('zustand');
  return {
    useAppStore: createStore(() => ({ conversations: {}, contacts: {} })),
  };
});

import { useAppStore, useContactForConversation } from '..';

const store = useAppStore as unknown as {
  setState: (partial: Partial<TestState>) => void;
};

const DM_ID = 'dm-1';
const PEER_ID = 'u-bob';

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

function renderSelector(conversationId: string | null): () => Contact | null {
  const seen: Array<Contact | null> = [];

  function Probe(): React.JSX.Element {
    const contact = useContactForConversation(conversationId);
    seen.push(contact);
    return <Text>{contact?.id ?? 'none'}</Text>;
  }

  act(() => {
    create(<Probe />);
  });
  return () => seen[seen.length - 1];
}

describe('useContactForConversation', () => {
  it('returns the DM peer contact via the contact reverse-scan', () => {
    store.setState({
      conversations: { [DM_ID]: makeConversation({ id: DM_ID }) },
      contacts: { [PEER_ID]: makeContact({ id: PEER_ID, conversationIds: [DM_ID] }) },
    });
    expect(renderSelector(DM_ID)()?.id).toBe(PEER_ID);
  });

  it('returns the peer right after startDm — peerUserId set, the contact not yet carrying the DM id', () => {
    // This shape is new (#908): before, the reverse-scan was the ONLY path, so
    // a brand-new DM resolved to null until the next list load. That is also
    // why ComposeThreadScreen's Unverified alert can now fire for a fresh DM.
    store.setState({
      conversations: { [DM_ID]: makeConversation({ id: DM_ID, peerUserId: PEER_ID }) },
      contacts: { [PEER_ID]: makeContact({ id: PEER_ID, username: 'bob', conversationIds: [] }) },
    });
    expect(renderSelector(DM_ID)()?.id).toBe(PEER_ID);
  });

  it('returns null for a group id that sits in some contact conversationIds', () => {
    store.setState({
      conversations: { 'orbit-1': makeConversation({ id: 'orbit-1', type: 'group' }) },
      contacts: { [PEER_ID]: makeContact({ id: PEER_ID, conversationIds: ['orbit-1'] }) },
    });
    expect(renderSelector('orbit-1')()).toBeNull();
  });

  it('returns null for a null id and when the peer has no contact row', () => {
    store.setState({
      conversations: { [DM_ID]: makeConversation({ id: DM_ID, peerUserId: PEER_ID }) },
      contacts: {},
    });
    expect(renderSelector(null)()).toBeNull();
    expect(renderSelector(DM_ID)()).toBeNull();
  });
});
