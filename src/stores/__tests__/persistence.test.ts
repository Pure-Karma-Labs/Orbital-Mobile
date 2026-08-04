/**
 * Tests for persistence configuration:
 * - MMKV storage adapter works correctly with deferred encrypted init
 * - getMMKVInstance() throws before initMMKV() is called
 * - partialize only includes expected keys
 * - Sensitive data (auth tokens, keys) is NOT in persisted state
 * - the persist merge floors notificationPrefs at hydration (#679)
 */

// Mock react-native-mmkv before any imports that use it
jest.mock('react-native-mmkv', () => {
  const mockInstance = {
    getString: jest.fn(),
    set: jest.fn(),
    remove: jest.fn(),
    getBoolean: jest.fn(),
    getNumber: jest.fn(),
    contains: jest.fn(),
    getAllKeys: jest.fn(),
    clearAll: jest.fn(),
  };
  return {
    createMMKV: jest.fn(() => mockInstance),
    __mockInstance: mockInstance,
  };
});

import {
  mmkvStateStorage,
  getMMKVInstance,
  resetMMKVForTesting,
} from '../middleware/persistence';
import { mergePersistedAppState, partializeAppState, useAppStore } from '../useAppStore';
import type { AppState } from '../../types/store';

// Helper to get the underlying mock instance created by the module
const getMockInstance = () => {
  const mod = require('react-native-mmkv') as {
    __mockInstance: {
      getString: jest.Mock;
      set: jest.Mock;
      remove: jest.Mock;
    };
  };
  return mod.__mockInstance;
};

// ---------------------------------------------------------------------------
// Deferred init
// ---------------------------------------------------------------------------

describe('deferred MMKV initialization', () => {
  it('getMMKVInstance throws before initMMKV is called', () => {
    // Use jest.isolateModules to get a fresh module with mmkvInstance === null
    jest.isolateModules(() => {
      const { getMMKVInstance: freshGet } = require('../middleware/persistence') as typeof import('../middleware/persistence');
      expect(() => freshGet()).toThrow('MMKV not initialized');
    });
  });

  it('getMMKVInstance returns instance after initMMKV is called', () => {
    jest.isolateModules(() => {
      const { initMMKV: freshInit, getMMKVInstance: freshGet } = require('../middleware/persistence') as typeof import('../middleware/persistence');
      freshInit('test-encryption-key');
      expect(freshGet()).toBeDefined();
    });
  });

  it('initMMKV throws if called a second time', () => {
    jest.isolateModules(() => {
      const { initMMKV: freshInit } = require('../middleware/persistence') as typeof import('../middleware/persistence');
      freshInit('first-key');
      expect(() => freshInit('second-key')).toThrow('MMKV already initialized');
    });
  });
});

// ---------------------------------------------------------------------------
// MMKV storage adapter (uses resetMMKVForTesting to enable without real Keychain)
// ---------------------------------------------------------------------------

describe('mmkvStateStorage', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetMMKVForTesting();
  });

  it('getItem returns string value from MMKV', () => {
    const mock = getMockInstance();
    mock.getString.mockReturnValue('{"foo":"bar"}');
    const result = mmkvStateStorage.getItem('test-key');
    expect(mock.getString).toHaveBeenCalledWith('test-key');
    expect(result).toBe('{"foo":"bar"}');
  });

  it('getItem returns null when MMKV returns undefined', () => {
    const mock = getMockInstance();
    mock.getString.mockReturnValue(undefined);
    const result = mmkvStateStorage.getItem('missing-key');
    expect(result).toBeNull();
  });

  it('setItem calls mmkv.set with key and value', () => {
    const mock = getMockInstance();
    mmkvStateStorage.setItem('my-key', '{"data":1}');
    expect(mock.set).toHaveBeenCalledWith('my-key', '{"data":1}');
  });

  it('removeItem calls mmkv.remove with key', () => {
    const mock = getMockInstance();
    mmkvStateStorage.removeItem('my-key');
    expect(mock.remove).toHaveBeenCalledWith('my-key');
  });
});

// ---------------------------------------------------------------------------
// getMMKVInstance — after resetMMKVForTesting
// ---------------------------------------------------------------------------

describe('getMMKVInstance', () => {
  it('returns a defined instance after resetMMKVForTesting', () => {
    resetMMKVForTesting();
    expect(getMMKVInstance()).toBeDefined();
  });

  it('returns the same instance on repeated calls', () => {
    resetMMKVForTesting();
    expect(getMMKVInstance()).toBe(getMMKVInstance());
  });
});

// ---------------------------------------------------------------------------
// partialize configuration
// ---------------------------------------------------------------------------

describe('persistence partialize', () => {
  /**
   * The REAL selector from useAppStore.ts — asserting against a local copy
   * let the copy drift (it silently missed soundEnabled, blockedUserIds, and
   * threadLastViewedAt for several releases).
   */
  const partialize = (state: Record<string, unknown>) =>
    partializeAppState(state as unknown as AppState) as unknown as Record<string, unknown>;

  /** Keys the app is expected to persist. */
  const EXPECTED_PERSISTED_KEYS = new Set([
    'conversations',
    'conversationIds',
    'contacts',
    'colorScheme',
    'activeTab',
    'soundEnabled',
    'blockedUserIds',
    'blockedUserProfiles',
    'threadLastViewedAt',
    // #449 — notification settings survive restart so the UI is correct before
    // the login-time server sync lands.
    'notificationPrefs',
    'mutedTargets',
    // #678 — the mute-intent write-ahead queue survives restart so an offline
    // toggle is still drained on the next sync.
    'pendingMuteOps',
  ]);

  /**
   * Keys that must never appear in persisted state for security reasons.
   * JWT tokens and encryption keys belong in Keychain/Keystore only.
   */
  const FORBIDDEN_PERSISTED_KEYS = [
    'isAuthenticated',
    'userId',
    'username',
    'displayName',
    // Auth token fields — must never be in persisted store
    'token',
    'accessToken',
    'refreshToken',
    'jwtToken',
    'authToken',
    // Crypto key material — must never be in persisted store
    'identityKey',
    'privateKey',
    'signalingKey',
    'encryptionKey',
    'registrationId',
    // Push device state — OS-derived, re-read at launch. The FCM token is a
    // routable device identifier and must not sit at rest in the store.
    'pushToken',
    'pushPermissionGranted',
    // Transient UI state
    'activeConversationId',
    'activeThreadId',
    'isComposerOpen',
    'syncOverallStatus',
    // Large/transient data
    'threads',
    'threadIdsByConversation',
    'replies',
    'replyIdsByThread',
  ];

  const fullState: Record<string, unknown> = {
    // Auth
    isAuthenticated: true,
    userId: 'user-123',
    username: 'alice',
    displayName: 'Alice',
    avatarPath: null,
    // Conversations
    conversations: { 'conv-1': { id: 'conv-1' } },
    conversationIds: ['conv-1'],
    activeConversationId: 'conv-1',
    // Threads
    threads: {},
    threadIdsByConversation: {},
    replies: {},
    replyIdsByThread: {},
    activeThreadId: null,
    threadLastViewedAt: { 'thread-1': 123 },
    // Contacts
    contacts: { 'c-1': { id: 'c-1' } },
    // UI
    colorScheme: 'dark',
    activeTab: 'chats',
    composerDraft: null,
    isComposerOpen: false,
    syncOverallStatus: 'synced',
    soundEnabled: true,
    // Blocked users
    blockedUserIds: ['blocked-1'],
    blockedUserProfiles: { 'blocked-1': 'mallory' },
    // Notifications (#449)
    pushPermissionGranted: true,
    pushToken: 'fcm-token-secret',
    notificationPrefs: { newThread: true, newReply: false, newDm: true, memberJoined: true },
    mutedTargets: { 'thread-1': 'thread' },
    // Notifications (#678)
    pendingMuteOps: {
      'thread-1': { targetType: 'thread', muted: true, ownerUserId: 'user-1', attempts: 0 },
    },
  };

  it('includes exactly the expected keys', () => {
    const persisted = partialize(fullState);
    const persistedKeys = new Set(Object.keys(persisted));
    expect(persistedKeys).toEqual(EXPECTED_PERSISTED_KEYS);
  });

  it('does not contain any forbidden key', () => {
    const persisted = partialize(fullState);
    for (const key of FORBIDDEN_PERSISTED_KEYS) {
      expect(key in persisted).toBe(false);
    }
  });

  it('persists conversations data correctly', () => {
    const persisted = partialize(fullState);
    expect(persisted.conversations).toEqual({ 'conv-1': { id: 'conv-1' } });
    expect(persisted.conversationIds).toEqual(['conv-1']);
  });

  it('persists contacts data correctly', () => {
    const persisted = partialize(fullState);
    expect(persisted.contacts).toEqual({ 'c-1': { id: 'c-1' } });
  });

  it('persists UI preferences correctly', () => {
    const persisted = partialize(fullState);
    expect(persisted.colorScheme).toBe('dark');
    expect(persisted.activeTab).toBe('chats');
  });

  it('persists notification settings but never the push token (#449)', () => {
    const persisted = partialize(fullState);
    expect(persisted.notificationPrefs).toEqual({
      newThread: true,
      newReply: false,
      newDm: true,
      memberJoined: true,
    });
    expect(persisted.mutedTargets).toEqual({ 'thread-1': 'thread' });
    expect('pushToken' in persisted).toBe(false);
  });

  it('persists the pending mute-op queue (#678)', () => {
    const persisted = partialize(fullState);
    expect(persisted.pendingMuteOps).toEqual({
      'thread-1': { targetType: 'thread', muted: true, ownerUserId: 'user-1', attempts: 0 },
    });
  });
});

// ---------------------------------------------------------------------------
// persist merge — hydration (#679)
//
// Placed LAST on purpose: these cases rehydrate the real shared store, and the
// restore routes through persist's wrapped setState (which writes to the shared
// MMKV mock). Keeping them after the partialize describes stops that bleeding
// into assertions above.
// ---------------------------------------------------------------------------

describe('persist merge — hydration floors notificationPrefs', () => {
  /**
   * The MMKV instance setup above is scoped to the mmkvStateStorage describe,
   * so without resetMMKVForTesting here mmkvStateStorage.getItem returns null
   * regardless of what getString is mocked to return.
   *
   * Never assert on MMKV writes as evidence of the floor: hydrate() applies its
   * result through the unwrapped set and does not write back.
   */
  let snapshot: AppState;

  beforeEach(() => {
    resetMMKVForTesting();
    jest.clearAllMocks();
    snapshot = useAppStore.getState();
  });

  afterEach(() => {
    useAppStore.setState(snapshot, true);
    jest.clearAllMocks();
  });

  /** A blob from a build that predated three of today's four pref keys. */
  const PERSISTED_BLOB = JSON.stringify({
    state: { notificationPrefs: { newDm: false }, colorScheme: 'dark' },
    version: 0,
  });

  it('floors pref keys absent from the persisted blob instead of hydrating undefined', async () => {
    getMockInstance().getString.mockReturnValue(PERSISTED_BLOB);

    await useAppStore.persist.rehydrate();

    // Without merge, zustand's default top-level spread REPLACES the whole
    // object: the three absent keys hydrate as `undefined` for the session, so
    // the settings screen renders toggles with no value while pushes fire.
    expect(useAppStore.getState().notificationPrefs).toEqual({
      newThread: true,
      newReply: true,
      newDm: false,
      memberJoined: true,
    });
  });

  it('keeps default top-level semantics and every action (replace-mode guard)', async () => {
    getMockInstance().getString.mockReturnValue(PERSISTED_BLOB);

    await useAppStore.persist.rehydrate();

    expect(useAppStore.getState().colorScheme).toBe('dark');
    // The merge result is applied with set(state, true) — replace mode. A merge
    // that stops spreading `current` strips every action and bricks launch.
    expect(typeof useAppStore.getState().setNotificationPrefs).toBe('function');
  });

  it('is non-destructive when storage is empty', async () => {
    useAppStore.getState().setNotificationPrefs({ newReply: false });
    getMockInstance().getString.mockReturnValue(undefined);

    await useAppStore.persist.rehydrate();

    // getItem returns null whenever the MMKV singleton was reset (the known
    // Metro Fast Refresh mode), and zustand still calls merge(undefined, current).
    // Flooring from DEFAULT_NOTIFICATION_PREFS would silently reset server truth
    // to all-on here; flooring from `current` cannot.
    expect(useAppStore.getState().notificationPrefs.newReply).toBe(false);
  });

  it('rejects a non-object blob, including an array', () => {
    const current = useAppStore.getState();

    const fromString = mergePersistedAppState('garbage', current);
    expect(fromString.notificationPrefs).toEqual(current.notificationPrefs);
    expect(typeof fromString.setNotificationPrefs).toBe('function');

    // Spreading an array would splatter index keys ('0', '1') into state.
    const fromArray = mergePersistedAppState(['a', 'b'], current);
    expect(fromArray.notificationPrefs).toEqual(current.notificationPrefs);
    expect('0' in fromArray).toBe(false);
  });

  it('rejects a non-object notificationPrefs', () => {
    const current = useAppStore.getState();

    const merged = mergePersistedAppState({ notificationPrefs: 'garbage' }, current);

    expect(merged.notificationPrefs).toEqual(current.notificationPrefs);
    expect(typeof merged.setNotificationPrefs).toBe('function');
  });

  it('floors a non-boolean pref value and clamps a key the app no longer has', () => {
    const current = useAppStore.getState();

    const merged = mergePersistedAppState(
      { notificationPrefs: { newDm: 'false', bogus: true } },
      current,
    );

    expect(merged.notificationPrefs.newDm).toBe(current.notificationPrefs.newDm);
    expect('bogus' in merged.notificationPrefs).toBe(false);
  });

  it('never resurrects a key partialize excludes (the allowlist governs reads too)', () => {
    const current = useAppStore.getState();

    const merged = mergePersistedAppState(
      { pushToken: 'evil-token', isAuthenticated: true },
      current,
    );

    expect(merged.pushToken).toBe(current.pushToken);
    expect(merged.isAuthenticated).toBe(current.isAuthenticated);
  });
});
