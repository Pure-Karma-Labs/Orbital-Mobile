/**
 * Tests for notificationSlice — initial state and all actions.
 */

import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import {
  createNotificationSlice,
  DEFAULT_NOTIFICATION_PREFS,
  MAX_PENDING_MUTE_OPS,
} from '../slices/notificationSlice';
import { PREF_KEY_BY_TYPE } from '../../services/notificationConstants';
import type { AppState, PendingMuteOp } from '../../types/store';

// ---------------------------------------------------------------------------
// Minimal store factory
// ---------------------------------------------------------------------------

function makeStore() {
  return create<AppState>()(devtools((...a) => ({
    ...createNotificationSlice(...a),

    // Auth stub
    isAuthenticated: false,
    userId: null,
    username: null,
    displayName: null,
    avatarPath: null,
    avatarDigest: null,
    needsTermsAcceptance: false,
    identityKeyConflict: false,
    keyRecoveryInProgress: false,
    email: null,
    conflictSource: null,
    keyRecoveryError: null,
    identityRestoreDeferred: false,
    setUser: jest.fn(),
    clearAuth: jest.fn(),
    setAuthenticated: jest.fn(),
    updateProfile: jest.fn(),
    setNeedsTermsAcceptance: jest.fn(),
    setIdentityKeyConflict: jest.fn(),
    setKeyRecoveryInProgress: jest.fn(),
    setEmail: jest.fn(),
    setConflictSource: jest.fn(),
    setKeyRecoveryError: jest.fn(),
    setIdentityRestoreDeferred: jest.fn(),

    // Conversations stub
    conversations: {},
    conversationIds: [],
    activeConversationId: null,
    viewingConversationId: null,
    setConversations: jest.fn(),
    setGroupConversations: jest.fn(),
    upsertConversation: jest.fn(),
    removeConversation: jest.fn(),
    setActiveConversation: jest.fn(),
    updateUnreadCount: jest.fn(),
    incrementUnreadCount: jest.fn(),
    markConversationRead: jest.fn(),
    setViewingConversation: jest.fn(),
    bumpLastMessageAt: jest.fn(),

    // Threads stub
    threads: {},
    threadIdsByConversation: {},
    replies: {},
    replyIdsByThread: {},
    activeThreadId: null,
    threadLastViewedAt: {},
    setThreads: jest.fn(),
    upsertThread: jest.fn(),
    removeThread: jest.fn(),
    setActiveThread: jest.fn(),
    setReplies: jest.fn(),
    appendReplies: jest.fn(),
    upsertReply: jest.fn(),
    removeReply: jest.fn(),
    addOptimisticThread: jest.fn(),
    addOptimisticReply: jest.fn(),
    updateThreadSyncStatus: jest.fn(),
    updateReplySyncStatus: jest.fn(),
    markThreadViewed: jest.fn(),

    // Contacts stub
    contacts: {},
    setContacts: jest.fn(),
    mergeContacts: jest.fn(),
    upsertContact: jest.fn(),
    removeContact: jest.fn(),
    setContactVerifiedStatus: jest.fn(),

    // UI stub
    colorScheme: 'system' as const,
    activeTab: 'threads' as const,
    composerDraft: null,
    isComposerOpen: false,
    syncOverallStatus: 'synced' as const,
    soundEnabled: true,
    setColorScheme: jest.fn(),
    setActiveTab: jest.fn(),
    setComposerDraft: jest.fn(),
    toggleComposer: jest.fn(),
    setSyncStatus: jest.fn(),
    setSoundEnabled: jest.fn(),

    // Connection stub
    connectionStatus: 'disconnected' as const,
    lastConnectedAt: null,
    reconnectAttempt: 0,
    typingUsers: {},
    setConnectionStatus: jest.fn(),
    setLastConnectedAt: jest.fn(),
    setReconnectAttempt: jest.fn(),
    addTypingUser: jest.fn(),
    removeTypingUser: jest.fn(),
    clearTypingUsers: jest.fn(),

    // Media stub
    media: {},
    mediaIdsByThread: {},
    mediaIdsByReply: {},
    mergeMediaForThread: jest.fn(),
    mergeMediaForReply: jest.fn(),
    mergeMediaBatch: jest.fn(),
    upsertMedia: jest.fn(),
    setMediaBatch: jest.fn(),
    updateMediaDownloadState: jest.fn(),
    updateMediaUploadState: jest.fn(),
    removeMedia: jest.fn(),

    // BlockedUsers stub
    blockedUserIds: [],
    blockedUserProfiles: {},
    blockUser: jest.fn(),
    unblockUser: jest.fn(),
    resetBlockedUsers: jest.fn(),
    hydrateBlockedUsers: jest.fn(),

    reportTarget: null,
    openReportSheet: jest.fn(),
    closeReportSheet: jest.fn(),
  })));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('notificationSlice — initial state', () => {
  it('has correct defaults', () => {
    const store = makeStore();
    const state = store.getState();
    expect(state.pushPermissionGranted).toBe(false);
    expect(state.pushToken).toBeNull();
    // #683: default is "not opted out" — a fresh install registers for push.
    expect(state.pushOptOut).toBe(false);
  });
});

describe('notificationSlice — setPushOptOut (#683)', () => {
  it('records an explicit opt-out', () => {
    const store = makeStore();
    store.getState().setPushOptOut(true);
    expect(store.getState().pushOptOut).toBe(true);
  });

  it('clears the opt-out when push is turned back on', () => {
    const store = makeStore();
    store.getState().setPushOptOut(true);
    store.getState().setPushOptOut(false);
    expect(store.getState().pushOptOut).toBe(false);
  });

  it('does not touch the OS-derived push state', () => {
    const store = makeStore();
    store.getState().setPushPermission(true);
    store.getState().setPushToken('fcm-token-abc');

    store.getState().setPushOptOut(true);

    // Intent and OS permission are separate axes: the toggle writes intent,
    // the register/deregister side-effects write the rest.
    expect(store.getState().pushPermissionGranted).toBe(true);
    expect(store.getState().pushToken).toBe('fcm-token-abc');
  });
});

describe('notificationSlice — setPushPermission', () => {
  it('updates pushPermissionGranted to true', () => {
    const store = makeStore();
    store.getState().setPushPermission(true);
    expect(store.getState().pushPermissionGranted).toBe(true);
  });

  it('updates pushPermissionGranted to false', () => {
    const store = makeStore();
    store.getState().setPushPermission(true);
    store.getState().setPushPermission(false);
    expect(store.getState().pushPermissionGranted).toBe(false);
  });
});

describe('notificationSlice — setPushToken', () => {
  it('stores a token', () => {
    const store = makeStore();
    store.getState().setPushToken('fcm-token-abc');
    expect(store.getState().pushToken).toBe('fcm-token-abc');
  });

  it('clears the token with null', () => {
    const store = makeStore();
    store.getState().setPushToken('fcm-token-abc');
    store.getState().setPushToken(null);
    expect(store.getState().pushToken).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// #449: notification preferences + per-target mutes
// ---------------------------------------------------------------------------

describe('notificationSlice — notification settings defaults (#449)', () => {
  it('defaults every per-type preference to true', () => {
    const store = makeStore();
    expect(store.getState().notificationPrefs).toEqual({
      newThread: true,
      newReply: true,
      newDm: true,
      memberJoined: true,
    });
  });

  it('starts with no muted targets', () => {
    const store = makeStore();
    expect(store.getState().mutedTargets).toEqual({});
  });

  /**
   * Registry cross-check (#679, retargeted in #692).
   *
   * The load-bearing job is the RUNTIME KEY SET of DEFAULT_NOTIFICATION_PREFS:
   * PREF_KEYS (notificationSettingsSync.ts) and the hydration floor in
   * mergePersistedAppState both derive their universe from Object.keys() of that
   * constant, so a key silently added or dropped there changes what the app
   * syncs and what it floors at rehydrate. Pinning it here makes that a test
   * failure and not a behaviour change.
   *
   * The PREF_KEY_BY_TYPE half is deliberately only a subset check. Its
   * `Record<SuppressibleType, keyof NotificationPrefs>` annotation
   * (notificationConstants.ts) ALREADY rejects both a wrong key set and a value
   * naming a pref that does not exist — the compiler covers what an equality
   * assertion here would. What it cannot cover is drift between that compile-time
   * union and the runtime object above, which is what the pin catches. The check
   * lives here rather than in notificationConstants.ts, whose header constraint
   * forbids importing the store: that module is loaded by index.js before MMKV is
   * open.
   */
  it('pins the runtime pref-key set, and every PREF_KEY_BY_TYPE value is one of them', () => {
    expect(Object.keys(DEFAULT_NOTIFICATION_PREFS).sort()).toEqual([
      'memberJoined',
      'newDm',
      'newReply',
      'newThread',
    ]);

    // Subset, not equality: values(PREF_KEY_BY_TYPE) ⊆ keys(DEFAULT_NOTIFICATION_PREFS)
    // is the structural invariant. Full equality holds today only by coincidence —
    // a future pref key with no suppressible push type would fail it spuriously.
    const prefKeys = new Set(Object.keys(DEFAULT_NOTIFICATION_PREFS));
    for (const key of Object.values(PREF_KEY_BY_TYPE)) expect(prefKeys.has(key)).toBe(true);
  });
});

describe('notificationSlice — setNotificationPrefs', () => {
  it('merges a partial patch, leaving other keys untouched', () => {
    const store = makeStore();
    store.getState().setNotificationPrefs({ newReply: false });

    expect(store.getState().notificationPrefs).toEqual({
      newThread: true,
      newReply: false,
      newDm: true,
      memberJoined: true,
    });
  });

  it('applies a full overwrite (sync path)', () => {
    const store = makeStore();
    store.getState().setNotificationPrefs({
      newThread: false,
      newReply: false,
      newDm: false,
      memberJoined: false,
    });

    expect(Object.values(store.getState().notificationPrefs)).toEqual([
      false,
      false,
      false,
      false,
    ]);
  });

  it('does not mutate the previous prefs object', () => {
    const store = makeStore();
    const before = store.getState().notificationPrefs;
    store.getState().setNotificationPrefs({ newDm: false });

    expect(before.newDm).toBe(true);
    expect(store.getState().notificationPrefs).not.toBe(before);
  });
});

describe('notificationSlice — muted targets', () => {
  it('adds a thread mute', () => {
    const store = makeStore();
    store.getState().addMutedTarget('thread-1', 'thread');

    expect(store.getState().mutedTargets).toEqual({ 'thread-1': 'thread' });
  });

  it('adds a group mute alongside an existing thread mute', () => {
    const store = makeStore();
    store.getState().addMutedTarget('thread-1', 'thread');
    store.getState().addMutedTarget('group-9', 'group');

    expect(store.getState().mutedTargets).toEqual({
      'thread-1': 'thread',
      'group-9': 'group',
    });
  });

  it('removes a mute', () => {
    const store = makeStore();
    store.getState().addMutedTarget('thread-1', 'thread');
    store.getState().addMutedTarget('group-9', 'group');
    store.getState().removeMutedTarget('thread-1');

    expect(store.getState().mutedTargets).toEqual({ 'group-9': 'group' });
  });

  it('removing an unknown target is a no-op', () => {
    const store = makeStore();
    store.getState().addMutedTarget('group-9', 'group');
    const before = store.getState().mutedTargets;

    store.getState().removeMutedTarget('nope');

    expect(store.getState().mutedTargets).toEqual({ 'group-9': 'group' });
    expect(store.getState().mutedTargets).toBe(before);
  });

  it('setMutedTargets replaces the whole map (server-authoritative overwrite)', () => {
    const store = makeStore();
    store.getState().addMutedTarget('stale', 'thread');
    store.getState().setMutedTargets({ 'group-9': 'group' });

    expect(store.getState().mutedTargets).toEqual({ 'group-9': 'group' });
  });

  it('setMutedTargets copies the input (later external mutation does not leak in)', () => {
    const store = makeStore();
    const input: Record<string, 'thread' | 'group'> = { 'thread-1': 'thread' };
    store.getState().setMutedTargets(input);
    input['thread-2'] = 'thread';

    expect(store.getState().mutedTargets).toEqual({ 'thread-1': 'thread' });
  });
});

// ---------------------------------------------------------------------------
// #678: write-ahead queue of unconfirmed mute intents
// ---------------------------------------------------------------------------

describe('notificationSlice — applyMuteIntent / pending mute queue (#678)', () => {
  const op = (overrides: Partial<PendingMuteOp> = {}): PendingMuteOp => ({
    targetType: 'thread',
    muted: true,
    ownerUserId: 'user-1',
    attempts: 0,
    ...overrides,
  });

  it('muted: true sets mutedTargets and writes the queue entry in one call', () => {
    const store = makeStore();
    store.getState().applyMuteIntent('thread-1', op());

    expect(store.getState().mutedTargets).toEqual({ 'thread-1': 'thread' });
    expect(store.getState().pendingMuteOps).toEqual({ 'thread-1': op() });
  });

  it('muted: false deletes mutedTargets and writes the queue entry', () => {
    const store = makeStore();
    store.getState().addMutedTarget('thread-1', 'thread');

    store.getState().applyMuteIntent('thread-1', op({ muted: false }));

    expect(store.getState().mutedTargets).toEqual({});
    expect(store.getState().pendingMuteOps).toEqual({ 'thread-1': op({ muted: false }) });
  });

  it('a second call for the same target replaces the intent (last-intent-wins, not appended)', () => {
    const store = makeStore();
    store.getState().applyMuteIntent('thread-1', op({ attempts: 0 }));
    store.getState().applyMuteIntent('thread-1', op({ muted: false, attempts: 3 }));

    expect(store.getState().pendingMuteOps).toEqual({
      'thread-1': op({ muted: false, attempts: 3 }),
    });
    expect(Object.keys(store.getState().pendingMuteOps)).toHaveLength(1);
  });

  it('clearPendingMuteOp removes one entry', () => {
    const store = makeStore();
    store.getState().applyMuteIntent('thread-1', op());
    store.getState().applyMuteIntent('group-9', op({ targetType: 'group' }));

    store.getState().clearPendingMuteOp('thread-1');

    expect(store.getState().pendingMuteOps).toEqual({ 'group-9': op({ targetType: 'group' }) });
  });

  it('clearPendingMuteOp on an absent key is an identity-preserving no-op', () => {
    const store = makeStore();
    store.getState().applyMuteIntent('group-9', op({ targetType: 'group' }));
    const before = store.getState().pendingMuteOps;

    store.getState().clearPendingMuteOp('nope');

    expect(store.getState().pendingMuteOps).toEqual({ 'group-9': op({ targetType: 'group' }) });
    expect(store.getState().pendingMuteOps).toBe(before);
  });

  it('clearPendingMuteOps removes several entries in one call', () => {
    const store = makeStore();
    store.getState().applyMuteIntent('thread-1', op());
    store.getState().applyMuteIntent('group-9', op({ targetType: 'group' }));
    store.getState().applyMuteIntent('thread-2', op());

    store.getState().clearPendingMuteOps(['thread-1', 'group-9']);

    expect(store.getState().pendingMuteOps).toEqual({ 'thread-2': op() });
  });

  it('clearPendingMuteOps is an identity-preserving no-op when nothing matches', () => {
    const store = makeStore();
    store.getState().applyMuteIntent('thread-1', op());
    const before = store.getState().pendingMuteOps;

    store.getState().clearPendingMuteOps(['nope', 'also-nope']);

    expect(store.getState().pendingMuteOps).toBe(before);
  });

  it('bumpPendingMuteAttempts increments the attempts counter', () => {
    const store = makeStore();
    store.getState().applyMuteIntent('thread-1', op({ attempts: 0 }));

    store.getState().bumpPendingMuteAttempts('thread-1');
    store.getState().bumpPendingMuteAttempts('thread-1');

    expect(store.getState().pendingMuteOps['thread-1']).toEqual(op({ attempts: 2 }));
  });

  it('bumpPendingMuteAttempts is an identity-preserving no-op when absent', () => {
    const store = makeStore();
    store.getState().applyMuteIntent('thread-1', op());
    const before = store.getState().pendingMuteOps;

    store.getState().bumpPendingMuteAttempts('nope');

    expect(store.getState().pendingMuteOps).toBe(before);
  });

  describe('MAX_PENDING_MUTE_OPS cap', () => {
    it('flips mutedTargets for a new target at cap but does not enqueue it', () => {
      const store = makeStore();
      for (let i = 0; i < MAX_PENDING_MUTE_OPS; i++) {
        store.getState().applyMuteIntent(`thread-${i}`, op());
      }
      expect(Object.keys(store.getState().pendingMuteOps)).toHaveLength(MAX_PENDING_MUTE_OPS);

      store.getState().applyMuteIntent('overflow', op());

      expect(store.getState().mutedTargets.overflow).toBe('thread');
      expect(store.getState().pendingMuteOps.overflow).toBeUndefined();
      expect(Object.keys(store.getState().pendingMuteOps)).toHaveLength(MAX_PENDING_MUTE_OPS);
    });

    it('still updates an already-queued target when the queue is at cap', () => {
      const store = makeStore();
      for (let i = 0; i < MAX_PENDING_MUTE_OPS; i++) {
        store.getState().applyMuteIntent(`thread-${i}`, op());
      }

      store.getState().applyMuteIntent('thread-0', op({ muted: false, attempts: 1 }));

      expect(store.getState().mutedTargets['thread-0']).toBeUndefined();
      expect(store.getState().pendingMuteOps['thread-0']).toEqual(op({ muted: false, attempts: 1 }));
      expect(Object.keys(store.getState().pendingMuteOps)).toHaveLength(MAX_PENDING_MUTE_OPS);
    });
  });
});

describe('notificationSlice — resetNotificationSettings', () => {
  it('restores all-true prefs and clears mutes and the pending queue', () => {
    const store = makeStore();
    store.getState().setNotificationPrefs({ newReply: false, newDm: false });
    store.getState().addMutedTarget('thread-1', 'thread');
    store.getState().applyMuteIntent('group-9', {
      targetType: 'group',
      muted: true,
      ownerUserId: 'user-1',
      attempts: 0,
    });

    store.getState().resetNotificationSettings();

    expect(store.getState().notificationPrefs).toEqual({
      newThread: true,
      newReply: true,
      newDm: true,
      memberJoined: true,
    });
    expect(store.getState().mutedTargets).toEqual({});
    expect(store.getState().pendingMuteOps).toEqual({});
  });

  it('clears the master-push opt-out (account-scoped intent, #683)', () => {
    const store = makeStore();
    store.getState().setPushOptOut(true);

    store.getState().resetNotificationSettings();

    // Opt-out survives a restart but not a logout — the next account must not
    // inherit the previous user's master-push intent.
    expect(store.getState().pushOptOut).toBe(false);
  });

  it('leaves push permission/token state alone (device-scoped, not account-scoped)', () => {
    const store = makeStore();
    store.getState().setPushPermission(true);
    store.getState().setPushToken('fcm-token-abc');

    store.getState().resetNotificationSettings();

    expect(store.getState().pushPermissionGranted).toBe(true);
    expect(store.getState().pushToken).toBe('fcm-token-abc');
  });
});
