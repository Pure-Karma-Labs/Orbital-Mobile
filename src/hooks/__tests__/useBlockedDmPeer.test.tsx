/**
 * Tests for useBlockedDmPeer / getBlockedDmPeer (#908).
 *
 * Runs against a REAL zustand store, not a hand-rolled selector stub, so the
 * `useShallow` subscription and the `useMemo` recompute are exercised. The
 * store module is replaced rather than imported for its own sake:
 * `src/stores/useAppStore` pulls in MMKV persistence, which does not load
 * under jest (react-native-nitro-modules).
 */

import React from 'react';
import { Text } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import type { Contact, Conversation } from '../../types/store';

interface TestState {
  conversations: Record<string, Conversation>;
  contacts: Record<string, Contact>;
  blockedUserIds: string[];
  blockedUserProfiles: Record<string, string>;
}

jest.mock('../../stores/useAppStore', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- jest.mock factories are hoisted above imports
  const { create: createStore } = require('zustand');
  return {
    useAppStore: createStore(() => ({
      conversations: {},
      contacts: {},
      blockedUserIds: [],
      blockedUserProfiles: {},
    })),
  };
});

import { useAppStore } from '../../stores/useAppStore';
import { useBlockedDmPeer, getBlockedDmPeer } from '../useBlockedDmPeer';

const store = useAppStore as unknown as {
  setState: (partial: Partial<TestState>) => void;
  getState: () => TestState;
};

const DM_ID = 'dm-1';
const PEER_ID = 'u-bob';

function makeDm(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: DM_ID,
    type: 'direct',
    name: 'bob',
    memberCount: 2,
    active: true,
    lastMessageAt: null,
    unreadCount: 0,
    lastReadAt: null,
    createdAt: 0,
    updatedAt: 0,
    peerUserId: PEER_ID,
    ...overrides,
  };
}

/** Renders the hook's current value and records every value it saw. */
function renderHook(conversationId: string | null, hint?: string | null) {
  const seen: Array<ReturnType<typeof useBlockedDmPeer>> = [];

  function Probe(): React.JSX.Element {
    const value = useBlockedDmPeer(conversationId, hint);
    seen.push(value);
    return <Text>{value ? value.label : 'none'}</Text>;
  }

  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(<Probe />);
  });
  return { seen, renderer, current: () => seen[seen.length - 1] };
}

beforeEach(() => {
  store.setState({
    conversations: { [DM_ID]: makeDm() },
    contacts: {},
    blockedUserIds: [],
    blockedUserProfiles: {},
  });
});

describe('useBlockedDmPeer', () => {
  it('is null while nothing is blocked, non-null after a block, null again after an unblock', () => {
    const hook = renderHook(DM_ID);
    expect(hook.current()).toBeNull();

    act(() => {
      store.setState({
        blockedUserIds: [PEER_ID],
        blockedUserProfiles: { [PEER_ID]: 'bob' },
      });
    });
    expect(hook.current()).toEqual({ peerId: PEER_ID, label: '@bob', labelResolved: true });

    act(() => {
      store.setState({ blockedUserIds: [], blockedUserProfiles: {} });
    });
    expect(hook.current()).toBeNull();
  });

  it('returns null for a null conversation id and for an orbit row', () => {
    expect(renderHook(null).current()).toBeNull();

    act(() => {
      store.setState({
        conversations: { 'orbit-1': makeDm({ id: 'orbit-1', type: 'group' }) },
        blockedUserIds: [PEER_ID],
      });
    });
    expect(renderHook('orbit-1').current()).toBeNull();
  });

  it('uses the hint when the conversation row is missing', () => {
    act(() => {
      store.setState({
        conversations: {},
        blockedUserIds: [PEER_ID],
        blockedUserProfiles: { [PEER_ID]: 'bob' },
      });
    });
    expect(renderHook(DM_ID, PEER_ID).current()).toEqual({
      peerId: PEER_ID,
      label: '@bob',
      labelResolved: true,
    });
  });

  it('churns a NEW object on an unrelated contacts write — which is why screens latch on a boolean (R3-4)', () => {
    act(() => {
      store.setState({ blockedUserIds: [PEER_ID], blockedUserProfiles: { [PEER_ID]: 'bob' } });
    });
    const hook = renderHook(DM_ID);
    const first = hook.current();

    act(() => {
      store.setState({
        contacts: {
          'u-unrelated': {
            id: 'u-unrelated',
            username: 'carol',
            displayName: null,
            avatarPath: null,
            conversationIds: [],
          },
        },
      });
    });
    const second = hook.current();

    expect(second).toEqual(first);
    expect(second).not.toBe(first);
  });
});

describe('getBlockedDmPeer', () => {
  it('answers from the store without rendering, and matches the hook', () => {
    expect(getBlockedDmPeer(DM_ID)).toBeNull();

    store.setState({ blockedUserIds: [PEER_ID], blockedUserProfiles: { [PEER_ID]: 'bob' } });

    expect(getBlockedDmPeer(DM_ID)).toEqual({
      peerId: PEER_ID,
      label: '@bob',
      labelResolved: true,
    });
    expect(getBlockedDmPeer('orbit-unknown')).toBeNull();
  });
});
