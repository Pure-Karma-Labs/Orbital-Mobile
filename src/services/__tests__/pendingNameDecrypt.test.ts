/**
 * Tests for pending orbit name decryption (#325).
 *
 * Covers: join with pending key → null name + registry, wrapped_key_delivered
 * → name re-decrypted + store updated, genuine decrypt failure → no retry,
 * and stale session → no store write.
 */

jest.mock('../api/groups', () => ({
  listGroups: jest.fn(),
  listDms: jest.fn(),
  createDm: jest.fn(),
  joinGroup: jest.fn(),
  getGroupMembers: jest.fn(),
  getPendingWraps: jest.fn(),
  submitWrappedKey: jest.fn(),
  selfWrapGroupKey: jest.fn(),
}));

const mockGetOrFetchGroupKey = jest.fn();
const mockDecryptGroupName = jest.fn((name: string, _key: Uint8Array) => name);
const mockProcessReceivedGroupKey = jest.fn().mockResolvedValue(undefined);
jest.mock('../crypto/contentCrypto', () => ({
  PendingWrapError: class PendingWrapError extends Error {
    constructor() {
      super('Group key not yet available (pending wrap)');
      this.name = 'PendingWrapError';
    }
  },
  persistGroupKey: jest.fn(),
  processReceivedGroupKey: (...args: unknown[]) => mockProcessReceivedGroupKey(...args),
  getOrFetchGroupKey: (groupId: string) => mockGetOrFetchGroupKey(groupId),
  decryptGroupName: (name: string, key: Uint8Array) => mockDecryptGroupName(name, key),
  encryptGroupName: jest.fn(() => 'encrypted-name'),
  generateGroupKey: jest.fn(() => ({
    key: new Uint8Array(32),
    keyBase64: 'generated-key-base64',
  })),
  wrapGroupKey: jest.fn(() => 'ecies-wrapped-base64'),
  loadPersistedGroupKey: jest.fn(),
  setCachedGroupKey: jest.fn(),
  evictPendingCache: jest.fn(),
}));

jest.mock('../../utils/uuid', () => ({
  generateUUID: jest.fn(() => 'mock-uuid-1234'),
}));

jest.mock('../crypto/identityKeyAccess', () => ({
  getIdentityKeyPair: jest.fn(() => ({
    privateKey: new ArrayBuffer(32),
    publicKey: new ArrayBuffer(33),
  })),
  resolveRemoteIdentityKey: jest.fn().mockResolvedValue(new ArrayBuffer(33)),
}));

jest.mock('../crypto/utils', () => ({
  base64ToArrayBuffer: jest.fn(() => new ArrayBuffer(32)),
}));

const mockUpsertConversation = jest.fn();
const mockSetActiveConversation = jest.fn();
const mockSetConversations = jest.fn();
const mockMergeContacts = jest.fn();

jest.mock('../../stores/useAppStore', () => ({
  useAppStore: {
    getState: jest.fn(() => ({
      userId: 'test-self-user',
      activeConversationId: null,
      conversations: {},
      contacts: {},
      setConversations: mockSetConversations,
      setGroupConversations: mockSetConversations,
      setActiveConversation: mockSetActiveConversation,
      upsertConversation: mockUpsertConversation,
      mergeContacts: mockMergeContacts,
      removeContact: jest.fn(),
    })),
  },
}));

import {
  joinOrbit,
  retryPendingNameDecrypt,
  clearConversationServiceState,
  _getPendingNameRegistry,
  loadConversations,
} from '../conversationService';
import { joinGroup, listGroups } from '../api/groups';
import { useAppStore } from '../../stores/useAppStore';

const mockJoinGroup = joinGroup as jest.Mock;
const mockListGroups = listGroups as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  clearConversationServiceState();

  mockGetOrFetchGroupKey.mockResolvedValue(new Uint8Array(32));
  mockDecryptGroupName.mockImplementation((name: string) => name);

  (useAppStore.getState as jest.Mock).mockReturnValue({
    userId: 'test-self-user',
    activeConversationId: null,
    conversations: {},
    contacts: {},
    setConversations: mockSetConversations,
    setGroupConversations: mockSetConversations,
    setActiveConversation: mockSetActiveConversation,
    upsertConversation: mockUpsertConversation,
    mergeContacts: mockMergeContacts,
    removeContact: jest.fn(),
  });
});

// ---------------------------------------------------------------------------
// (a) Join with pending key → neutral name + registry entry
// ---------------------------------------------------------------------------

describe('joinOrbit with pending key', () => {
  it('returns null name and registers in pendingNameRegistry when key is pending', async () => {
    mockGetOrFetchGroupKey.mockRejectedValue(
      new (jest.requireMock('../crypto/contentCrypto').PendingWrapError)(),
    );
    mockJoinGroup.mockResolvedValue({
      groupId: 'orbit-pending',
      encryptedName: 'EncryptedOrbitName',
      memberCount: 3,
      joinedAt: '2026-06-01T00:00:00Z',
      wrappedGroupKey: null,
    });

    const result = await joinOrbit('INVITE123');

    // Name should be null (pending), not '(unable to decrypt)'
    expect(result.name).toBeNull();

    // The encrypted name should be registered for retry
    expect(_getPendingNameRegistry().get('orbit-pending')).toBe('EncryptedOrbitName');

    // Conversation should be upserted with null name
    expect(mockUpsertConversation).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'orbit-pending',
        name: null,
      }),
    );
  });

  it('does NOT register in pendingNameRegistry when name decrypts successfully', async () => {
    mockGetOrFetchGroupKey.mockResolvedValue(new Uint8Array(32));
    mockDecryptGroupName.mockReturnValue('Family Orbit');
    mockJoinGroup.mockResolvedValue({
      groupId: 'orbit-ok',
      encryptedName: 'EncryptedOrbitName',
      memberCount: 3,
      joinedAt: '2026-06-01T00:00:00Z',
      wrappedGroupKey: 'some-key',
    });

    const result = await joinOrbit('INVITE456');

    expect(result.name).toBe('Family Orbit');
    expect(_getPendingNameRegistry().has('orbit-ok')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// (b) wrapped_key_delivered → name re-decrypted and store updated
// ---------------------------------------------------------------------------

describe('retryPendingNameDecrypt', () => {
  it('re-decrypts name and updates the store when key becomes available', async () => {
    // Simulate: orbit was joined but key was pending
    mockGetOrFetchGroupKey.mockRejectedValueOnce(
      new (jest.requireMock('../crypto/contentCrypto').PendingWrapError)(),
    );
    mockJoinGroup.mockResolvedValue({
      groupId: 'orbit-retry',
      encryptedName: 'EncryptedName',
      memberCount: 2,
      joinedAt: '2026-06-01T00:00:00Z',
      wrappedGroupKey: null,
    });

    await joinOrbit('RETRY_CODE');
    expect(_getPendingNameRegistry().has('orbit-retry')).toBe(true);
    mockUpsertConversation.mockClear();

    // Now the key arrives — set up mocks for the retry
    const groupKey = new Uint8Array(32);
    mockGetOrFetchGroupKey.mockResolvedValue(groupKey);
    mockDecryptGroupName.mockReturnValue('Decrypted Orbit Name');

    // Store has the existing conversation
    const existingConversation = {
      id: 'orbit-retry',
      type: 'group',
      name: null,
      memberCount: 2,
      active: true,
      muteUntil: null,
      lastMessageAt: null,
      unreadCount: 3,
      createdAt: 1000,
      updatedAt: 1000,
    };
    (useAppStore.getState as jest.Mock).mockReturnValue({
      userId: 'test-self-user',
      conversations: { 'orbit-retry': existingConversation },
      upsertConversation: mockUpsertConversation,
    });

    await retryPendingNameDecrypt('orbit-retry');

    // Registry entry should be removed
    expect(_getPendingNameRegistry().has('orbit-retry')).toBe(false);

    // Store should be updated with decrypted name, preserving other fields
    expect(mockUpsertConversation).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'orbit-retry',
        name: 'Decrypted Orbit Name',
        unreadCount: 3,
        memberCount: 2,
      }),
    );
  });

  it('preserves registry entry when conversation is not yet in the store', async () => {
    mockGetOrFetchGroupKey.mockRejectedValueOnce(
      new (jest.requireMock('../crypto/contentCrypto').PendingWrapError)(),
    );
    mockJoinGroup.mockResolvedValue({
      groupId: 'orbit-early',
      encryptedName: 'EncryptedEarly',
      memberCount: 2,
      joinedAt: '2026-06-01T00:00:00Z',
      wrappedGroupKey: null,
    });

    await joinOrbit('EARLY_CODE');
    expect(_getPendingNameRegistry().has('orbit-early')).toBe(true);
    mockUpsertConversation.mockClear();

    const groupKey = new Uint8Array(32);
    mockGetOrFetchGroupKey.mockResolvedValue(groupKey);
    mockDecryptGroupName.mockReturnValue('Early Orbit');

    // Store does NOT have the conversation yet (join upsert still in flight)
    (useAppStore.getState as jest.Mock).mockReturnValue({
      userId: 'test-self-user',
      conversations: {},
      upsertConversation: mockUpsertConversation,
    });

    await retryPendingNameDecrypt('orbit-early');

    // No store write, and the registry entry must survive for a later attempt
    expect(mockUpsertConversation).not.toHaveBeenCalled();
    expect(_getPendingNameRegistry().has('orbit-early')).toBe(true);
  });

  it('does nothing when groupId is not in the pending registry', async () => {
    await retryPendingNameDecrypt('unknown-group');

    expect(mockGetOrFetchGroupKey).not.toHaveBeenCalled();
    expect(mockUpsertConversation).not.toHaveBeenCalled();
  });

  it('leaves registry entry intact when retry fails', async () => {
    // Seed the registry by simulating a pending join
    mockGetOrFetchGroupKey.mockRejectedValueOnce(
      new (jest.requireMock('../crypto/contentCrypto').PendingWrapError)(),
    );
    mockJoinGroup.mockResolvedValue({
      groupId: 'orbit-still-pending',
      encryptedName: 'SomeEncrypted',
      memberCount: 2,
      joinedAt: '2026-06-01T00:00:00Z',
      wrappedGroupKey: null,
    });
    await joinOrbit('FAIL_CODE');
    expect(_getPendingNameRegistry().has('orbit-still-pending')).toBe(true);

    // Clear mocks after the join setup
    mockUpsertConversation.mockClear();
    mockGetOrFetchGroupKey.mockClear();

    // Retry also fails
    mockGetOrFetchGroupKey.mockRejectedValue(new Error('still no key'));

    await retryPendingNameDecrypt('orbit-still-pending');

    // Entry should still be in the registry
    expect(_getPendingNameRegistry().has('orbit-still-pending')).toBe(true);
    expect(mockUpsertConversation).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// (c) Genuine decrypt failure → '(unable to decrypt)' and no retry registration
// ---------------------------------------------------------------------------

describe('genuine decrypt failure (not pending-key)', () => {
  it('returns (unable to decrypt) and does NOT register in pendingNameRegistry', async () => {
    // Key is available but decryption fails (e.g. corrupted ciphertext, key reset)
    mockGetOrFetchGroupKey.mockResolvedValue(new Uint8Array(32));
    mockDecryptGroupName.mockImplementation(() => {
      throw new Error('AES-GCM auth tag mismatch');
    });
    mockJoinGroup.mockResolvedValue({
      groupId: 'orbit-corrupt',
      encryptedName: 'CorruptedCiphertext',
      memberCount: 2,
      joinedAt: '2026-06-01T00:00:00Z',
      wrappedGroupKey: 'valid-key',
    });

    const result = await joinOrbit('CORRUPT_CODE');

    expect(result.name).toBe('(unable to decrypt)');
    expect(_getPendingNameRegistry().has('orbit-corrupt')).toBe(false);
  });

  it('returns (unable to decrypt) for non-pending getOrFetchGroupKey errors', async () => {
    // Network error, not a pending-wrap error
    mockGetOrFetchGroupKey.mockRejectedValue(new Error('Network error'));
    mockJoinGroup.mockResolvedValue({
      groupId: 'orbit-network',
      encryptedName: 'SomeEncrypted',
      memberCount: 2,
      joinedAt: '2026-06-01T00:00:00Z',
      wrappedGroupKey: null,
    });

    const result = await joinOrbit('NET_CODE');

    expect(result.name).toBe('(unable to decrypt)');
    expect(_getPendingNameRegistry().has('orbit-network')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// (d) Stale session → no store write during retryPendingNameDecrypt
// ---------------------------------------------------------------------------

describe('stale session guard in retryPendingNameDecrypt', () => {
  it('does not write to store when userId changes during retry', async () => {
    // Seed the registry
    mockGetOrFetchGroupKey.mockRejectedValueOnce(
      new (jest.requireMock('../crypto/contentCrypto').PendingWrapError)(),
    );
    mockJoinGroup.mockResolvedValue({
      groupId: 'orbit-logout',
      encryptedName: 'EncryptedName',
      memberCount: 2,
      joinedAt: '2026-06-01T00:00:00Z',
      wrappedGroupKey: null,
    });
    await joinOrbit('LOGOUT_CODE');
    expect(_getPendingNameRegistry().has('orbit-logout')).toBe(true);
    mockUpsertConversation.mockClear();

    // Key fetch succeeds, but userId changes (logout happened)
    mockGetOrFetchGroupKey.mockImplementation(async () => {
      // Simulate user logout happening during the async gap
      (useAppStore.getState as jest.Mock).mockReturnValue({
        userId: 'different-user',
        conversations: {
          'orbit-logout': { id: 'orbit-logout', name: null, type: 'group' },
        },
        upsertConversation: mockUpsertConversation,
      });
      return new Uint8Array(32);
    });
    mockDecryptGroupName.mockReturnValue('Decrypted Name');

    await retryPendingNameDecrypt('orbit-logout');

    // Store should NOT be written — session is stale
    expect(mockUpsertConversation).not.toHaveBeenCalled();
  });

  it('does not write to store when userId is null', async () => {
    // Seed the registry
    mockGetOrFetchGroupKey.mockRejectedValueOnce(
      new (jest.requireMock('../crypto/contentCrypto').PendingWrapError)(),
    );
    mockJoinGroup.mockResolvedValue({
      groupId: 'orbit-null',
      encryptedName: 'EncryptedName',
      memberCount: 2,
      joinedAt: '2026-06-01T00:00:00Z',
      wrappedGroupKey: null,
    });
    await joinOrbit('NULL_CODE');
    expect(_getPendingNameRegistry().has('orbit-null')).toBe(true);

    // Clear mocks from the join setup
    mockUpsertConversation.mockClear();
    mockGetOrFetchGroupKey.mockClear();

    // No user logged in when retry fires
    (useAppStore.getState as jest.Mock).mockReturnValue({
      userId: null,
      conversations: {},
      upsertConversation: mockUpsertConversation,
    });

    await retryPendingNameDecrypt('orbit-null');

    // Should bail because captureSession returns null
    expect(mockGetOrFetchGroupKey).not.toHaveBeenCalled();
    expect(mockUpsertConversation).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Session cleanup — pendingNameRegistry is cleared
// ---------------------------------------------------------------------------

describe('clearConversationServiceState clears pendingNameRegistry', () => {
  it('removes all pending name entries on session cleanup', async () => {
    // Seed the registry
    mockGetOrFetchGroupKey.mockRejectedValue(
      new (jest.requireMock('../crypto/contentCrypto').PendingWrapError)(),
    );
    mockJoinGroup.mockResolvedValue({
      groupId: 'orbit-cleanup',
      encryptedName: 'EncryptedName',
      memberCount: 2,
      joinedAt: '2026-06-01T00:00:00Z',
      wrappedGroupKey: null,
    });
    await joinOrbit('CLEANUP_CODE');
    expect(_getPendingNameRegistry().size).toBeGreaterThan(0);

    clearConversationServiceState();

    expect(_getPendingNameRegistry().size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// loadConversations also registers pending names
// ---------------------------------------------------------------------------

describe('loadConversations with pending key', () => {
  it('registers pending name when group key is pending during loadConversations', async () => {
    mockGetOrFetchGroupKey.mockRejectedValue(
      new (jest.requireMock('../crypto/contentCrypto').PendingWrapError)(),
    );
    mockListGroups.mockResolvedValue([
      {
        groupId: 'g-pending',
        encryptedName: 'PendingEncryptedName',
        wrappedGroupKey: null,
        wrappedBy: null,
        memberCount: 3,
        maxMembers: 10,
        isCreator: false,
        joinedAt: '2026-01-01T00:00:00.000Z',
      },
    ]);

    await loadConversations();

    // The pending name should be registered
    expect(_getPendingNameRegistry().get('g-pending')).toBe('PendingEncryptedName');

    // The conversation should be stored with null name (not '(unable to decrypt)')
    expect(mockSetConversations).toHaveBeenCalledWith([
      expect.objectContaining({
        id: 'g-pending',
        name: null,
      }),
    ]);
  });
});
