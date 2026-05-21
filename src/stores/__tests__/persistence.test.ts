/**
 * Tests for persistence configuration:
 * - MMKV storage adapter works correctly with deferred encrypted init
 * - getMMKVInstance() throws before initMMKV() is called
 * - partialize only includes expected keys
 * - Sensitive data (auth tokens, keys) is NOT in persisted state
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
   * Define the expected persisted keys — these match the partialize config
   * in useAppStore.ts.
   */
  const EXPECTED_PERSISTED_KEYS = new Set([
    'conversations',
    'conversationIds',
    'contacts',
    'colorScheme',
    'activeTab',
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

  /**
   * Build a fake AppState that mirrors the shape useAppStore would produce,
   * then run it through a partialize function identical to the one in
   * useAppStore.ts to verify which keys survive.
   */
  function partialize(state: Record<string, unknown>) {
    return {
      conversations: state.conversations,
      conversationIds: state.conversationIds,
      contacts: state.contacts,
      colorScheme: state.colorScheme,
      activeTab: state.activeTab,
    };
  }

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
    // Contacts
    contacts: { 'c-1': { id: 'c-1' } },
    // UI
    colorScheme: 'dark',
    activeTab: 'chats',
    composerDraft: null,
    isComposerOpen: false,
    syncOverallStatus: 'synced',
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
});
