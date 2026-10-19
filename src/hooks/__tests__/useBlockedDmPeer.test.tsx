/**
 * Tests for useBlockedDmPeer / getBlockedDmPeer / useBlockedPeerTransition (#908).
 *
 * Runs against a REAL zustand store, not a hand-rolled selector stub, so the
 * `useShallow` subscription and the derivation are exercised. The store module
 * is replaced rather than imported for its own sake: `src/stores/useAppStore`
 * pulls in MMKV persistence, which does not load under jest
 * (react-native-nitro-modules).
 */

import React from 'react';
import { AccessibilityInfo, Text, View } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import type { Contact, Conversation } from '../../types/store';
import type { DmPeerOptions, BlockedDmPeer } from '../../utils/dmPeer';

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

// Mutable flag so individual tests can flip focus state.
let mockIsFocused = true;
jest.mock('@react-navigation/native', () => ({
  useIsFocused: () => mockIsFocused,
}));

import { useAppStore } from '../../stores/useAppStore';
import { useBlockedDmPeer, getBlockedDmPeer, useBlockedPeerTransition } from '../useBlockedDmPeer';

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
function renderHook(conversationId: string | null, options?: DmPeerOptions) {
  const seen: Array<ReturnType<typeof useBlockedDmPeer>> = [];

  function Probe(): React.JSX.Element {
    const value = useBlockedDmPeer(conversationId, options);
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
  mockIsFocused = true;
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
    expect(hook.current()).toEqual({ peerId: PEER_ID, label: '@bob' });

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
    expect(renderHook(DM_ID, { hint: PEER_ID }).current()).toEqual({
      peerId: PEER_ID,
      label: '@bob',
    });
  });

  it('returns a STABLE reference across an unrelated store write (useShallow churn fix)', () => {
    // Set up a blocked peer so the hook returns a non-null object.
    act(() => {
      store.setState({ blockedUserIds: [PEER_ID], blockedUserProfiles: { [PEER_ID]: 'bob' } });
    });
    const hook = renderHook(DM_ID);
    const first = hook.current();
    expect(first).not.toBeNull();
    const rendersBefore = hook.seen.length;

    // An unrelated contacts write (avatar, displayName, unrelated user) must
    // not change the returned object identity — deriveBlockedDmPeer returns the
    // same { peerId, label }, and useShallow compares shallowly, suppressing
    // the re-render entirely.
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

    // Same value AND same reference (useShallow prevented a churn).
    expect(second).toEqual(first);
    expect(second).toBe(first);
    // The Probe component must NOT have re-rendered.
    expect(hook.seen.length).toBe(rendersBefore);
  });

  it('returns a NEW reference when the label actually changes', () => {
    act(() => {
      store.setState({ blockedUserIds: [PEER_ID], blockedUserProfiles: { [PEER_ID]: 'bob' } });
    });
    const hook = renderHook(DM_ID);
    const first = hook.current();

    act(() => {
      store.setState({ blockedUserProfiles: { [PEER_ID]: 'bob_renamed' } });
    });
    const second = hook.current();

    expect(second?.label).toBe('@bob_renamed');
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
    });
    expect(getBlockedDmPeer('orbit-unknown')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// useBlockedPeerTransition
// ---------------------------------------------------------------------------

describe('useBlockedPeerTransition', () => {
  let announceSpy: jest.SpyInstance;

  beforeEach(() => {
    announceSpy = jest
      .spyOn(AccessibilityInfo, 'announceForAccessibility')
      .mockImplementation(() => {});
  });

  afterEach(() => {
    announceSpy.mockRestore();
  });

  /** Minimal component that exercises the hook. */
  function TransitionProbe({
    blockedPeer,
    onBlock,
  }: {
    blockedPeer: BlockedDmPeer | null;
    onBlock?: () => void;
  }): React.JSX.Element {
    useBlockedPeerTransition(blockedPeer, onBlock);
    return <View />;
  }

  it('(a) onBlock runs exactly once across several re-renders while blocked', () => {
    const onBlock = jest.fn();
    const peer: BlockedDmPeer = { peerId: 'u-1', label: '@alice' };
    let renderer!: ReactTestRenderer;

    act(() => {
      renderer = create(<TransitionProbe blockedPeer={peer} onBlock={onBlock} />);
    });
    expect(onBlock).toHaveBeenCalledTimes(1);

    // Re-render with the same blocked peer — the latch must suppress extra calls.
    act(() => {
      renderer.update(<TransitionProbe blockedPeer={peer} onBlock={onBlock} />);
    });
    act(() => {
      renderer.update(<TransitionProbe blockedPeer={peer} onBlock={onBlock} />);
    });
    expect(onBlock).toHaveBeenCalledTimes(1);
  });

  it('(b) announceForAccessibility is called exactly once when focused', () => {
    mockIsFocused = true;
    const peer: BlockedDmPeer = { peerId: 'u-1', label: '@alice' };

    act(() => {
      create(<TransitionProbe blockedPeer={peer} />);
    });

    expect(announceSpy).toHaveBeenCalledTimes(1);
    expect(announceSpy).toHaveBeenCalledWith('You blocked @alice. Sending is turned off.');
  });

  it('(c) when useIsFocused() is false, onBlock STILL runs but announce does NOT', () => {
    // This must FAIL if the focus gate on announceForAccessibility is removed.
    mockIsFocused = false;
    const onBlock = jest.fn();
    const peer: BlockedDmPeer = { peerId: 'u-1', label: '@alice' };

    act(() => {
      create(<TransitionProbe blockedPeer={peer} onBlock={onBlock} />);
    });

    expect(onBlock).toHaveBeenCalledTimes(1);
    expect(announceSpy).not.toHaveBeenCalled();
  });

  it('(d) latch resets on true→false so a re-block fires onBlock again', () => {
    const onBlock = jest.fn();
    const peer: BlockedDmPeer = { peerId: 'u-1', label: '@alice' };
    let renderer!: ReactTestRenderer;

    // First block — latch fires.
    act(() => {
      renderer = create(<TransitionProbe blockedPeer={peer} onBlock={onBlock} />);
    });
    expect(onBlock).toHaveBeenCalledTimes(1);

    // Unblock — latch resets.
    act(() => {
      renderer.update(<TransitionProbe blockedPeer={null} onBlock={onBlock} />);
    });

    // Re-block — latch fires again.
    act(() => {
      renderer.update(<TransitionProbe blockedPeer={peer} onBlock={onBlock} />);
    });
    expect(onBlock).toHaveBeenCalledTimes(2);
  });
});
