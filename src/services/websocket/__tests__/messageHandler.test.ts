/**
 * Tests for WebSocket message handler — incoming event parsing, dispatching,
 * decryption, and store upserts.
 */

// ---------------------------------------------------------------------------
// Module mocks — must be declared before imports
// ---------------------------------------------------------------------------

jest.mock('../../api/client', () => ({
  snakeToCamel: jest.fn((v: unknown) => v),
}));

jest.mock('../../crypto/contentCrypto', () => ({
  PendingWrapError: class PendingWrapError extends Error {
    constructor() {
      super('Group key not yet available (pending wrap)');
      this.name = 'PendingWrapError';
    }
  },
  getOrFetchGroupKey: jest.fn(),
  invalidateGroupKey: jest.fn(),
  wrapGroupKey: jest.fn(() => 'wrapped-key-base64'),
  evictPendingCache: jest.fn(),
}));

jest.mock('../../crypto/identityKeyAccess', () => ({
  resolveRemoteIdentityKey: jest.fn().mockResolvedValue(new ArrayBuffer(33)),
}));

jest.mock('../../api/groups', () => ({
  submitWrappedKey: jest.fn().mockResolvedValue({ success: true }),
}));

jest.mock('../../threadService', () => ({
  decryptThreadFields: jest.fn(),
  decryptReplyBody: jest.fn(),
  processMediaMetadata: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../conversationService', () => ({
  ensureDmConversation: jest.fn().mockResolvedValue(null),
  hydrateContactsFromOrbits: jest.fn().mockResolvedValue(undefined),
  refreshContactAvatar: jest.fn().mockResolvedValue(undefined),
  retryPendingNameDecrypt: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../avatarService', () => ({
  invalidateAvatarCache: jest.fn().mockResolvedValue(undefined),
}));

const mockUpsertThread = jest.fn();
const mockUpsertReply = jest.fn();
const mockUpsertContact = jest.fn();
const mockSetConnectionStatus = jest.fn();
const mockSetLastConnectedAt = jest.fn();
const mockSetReconnectAttempt = jest.fn();
const mockAddTypingUser = jest.fn();
const mockBumpLastMessageAt = jest.fn();
const mockIncrementUnreadCount = jest.fn();

jest.mock('../../../stores/useAppStore', () => ({
  useAppStore: {
    getState: jest.fn(() => ({
      userId: 'test-user-id',
      viewingConversationId: null,
      upsertThread: mockUpsertThread,
      upsertReply: mockUpsertReply,
      upsertContact: mockUpsertContact,
      setConnectionStatus: mockSetConnectionStatus,
      setLastConnectedAt: mockSetLastConnectedAt,
      setReconnectAttempt: mockSetReconnectAttempt,
      blockedUserIds: [],
      addTypingUser: mockAddTypingUser,
      bumpLastMessageAt: mockBumpLastMessageAt,
      incrementUnreadCount: mockIncrementUnreadCount,
      contacts: {},
    })),
  },
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { handleServerMessage, clearMessageHandlerState } from '../messageHandler';
import { snakeToCamel } from '../../api/client';
import {
  getOrFetchGroupKey,
  invalidateGroupKey,
  wrapGroupKey,
  evictPendingCache,
} from '../../crypto/contentCrypto';
import { resolveRemoteIdentityKey } from '../../crypto/identityKeyAccess';
import { submitWrappedKey } from '../../api/groups';
import { decryptThreadFields, decryptReplyBody } from '../../threadService';
import { useAppStore } from '../../../stores/useAppStore';

const mockSnakeToCamel = snakeToCamel as jest.MockedFunction<typeof snakeToCamel>;
const mockGetOrFetchGroupKey = getOrFetchGroupKey as jest.MockedFunction<typeof getOrFetchGroupKey>;
const mockInvalidateGroupKey = invalidateGroupKey as jest.MockedFunction<typeof invalidateGroupKey>;
const mockDecryptThreadFields = decryptThreadFields as jest.MockedFunction<typeof decryptThreadFields>;
const mockDecryptReplyBody = decryptReplyBody as jest.MockedFunction<typeof decryptReplyBody>;
const mockWrapGroupKey = wrapGroupKey as jest.MockedFunction<typeof wrapGroupKey>;
const mockEvictPendingCache = evictPendingCache as jest.MockedFunction<typeof evictPendingCache>;
const mockSubmitWrappedKey = submitWrappedKey as jest.MockedFunction<typeof submitWrappedKey>;
const mockResolveRemoteIdentityKey = resolveRemoteIdentityKey as jest.MockedFunction<typeof resolveRemoteIdentityKey>;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const fakeGroupKey = new Uint8Array(32).fill(0xab);

function makeNewThreadMessage(): string {
  return JSON.stringify({
    type: 'new_message',
    conversationId: 'group-1',
    timestamp: 1700000000000,
    data: {
      type: 'new_thread',
      threadId: 'thread-ws-1',
      groupId: 'group-1',
      authorId: 'user-1',
      authorName: 'alice',
      encryptedTitle: 'enc-title',
      encryptedBody: 'enc-body',
      titleIv: 'title-iv',
      bodyIv: 'body-iv',
      createdAt: '2026-04-01T10:00:00Z',
      media: [],
    },
  });
}

function makeNewReplyMessage(): string {
  return JSON.stringify({
    type: 'new_message',
    conversationId: 'group-1',
    timestamp: 1700000001000,
    data: {
      type: 'new_reply',
      replyId: 'reply-ws-1',
      threadId: 'thread-1',
      groupId: 'group-1',
      authorId: 'user-2',
      authorName: 'bob',
      encryptedBody: 'enc-reply-body',
      bodyIv: 'reply-body-iv',
      parentReplyId: null,
      createdAt: '2026-04-01T11:00:00Z',
      media: [],
    },
  });
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  jest.clearAllMocks();
  clearMessageHandlerState();
  // Default: snakeToCamel is identity (test sends pre-transformed camelCase)
  mockSnakeToCamel.mockImplementation((v: unknown) => v);
  mockGetOrFetchGroupKey.mockResolvedValue(fakeGroupKey);
  mockDecryptThreadFields.mockResolvedValue({ title: 'Decrypted Title', body: 'Decrypted Body' });
  mockDecryptReplyBody.mockResolvedValue('Decrypted Reply');
});

// ---------------------------------------------------------------------------
// connection_ack
// ---------------------------------------------------------------------------

describe('connection_ack', () => {
  it('sets connection status to connected and records timestamp', async () => {
    const raw = JSON.stringify({ type: 'connection_ack', timestamp: 1700000000000 });
    await handleServerMessage(raw);

    expect(mockSetConnectionStatus).toHaveBeenCalledWith('connected');
    expect(mockSetLastConnectedAt).toHaveBeenCalledWith(expect.any(Number));
    expect(mockSetReconnectAttempt).toHaveBeenCalledWith(0);
  });
});

// ---------------------------------------------------------------------------
// new_thread broadcast
// ---------------------------------------------------------------------------

describe('new_thread broadcast', () => {
  it('decrypts and upserts a thread', async () => {
    await handleServerMessage(makeNewThreadMessage());

    expect(mockGetOrFetchGroupKey).toHaveBeenCalledWith('group-1');
    expect(mockDecryptThreadFields).toHaveBeenCalledWith(
      'enc-title',
      'title-iv',
      'enc-body',
      'body-iv',
      fakeGroupKey,
      'group-1',
    );

    expect(mockUpsertThread).toHaveBeenCalledTimes(1);
    const thread = mockUpsertThread.mock.calls[0][0];
    expect(thread.id).toBe('thread-ws-1');
    expect(thread.conversationId).toBe('group-1');
    expect(thread.authorUsername).toBe('alice');
    expect(thread.title).toBe('Decrypted Title');
    expect(thread.body).toBe('Decrypted Body');
    expect(thread.syncStatus).toBe('synced');
    expect(thread.replyCount).toBe(0);
  });

  it('deduplicates by threadId', async () => {
    const msg = JSON.stringify({
      type: 'new_message',
      conversationId: 'group-1',
      timestamp: 1700000000000,
      data: {
        type: 'new_thread',
        threadId: 'thread-dedup-test',
        groupId: 'group-1',
        authorId: 'user-1',
        authorName: 'alice',
        encryptedTitle: 'enc-title',
        encryptedBody: 'enc-body',
        titleIv: 'title-iv',
        bodyIv: 'body-iv',
        createdAt: '2026-04-01T10:00:00Z',
        media: [],
      },
    });
    await handleServerMessage(msg);
    await handleServerMessage(msg);

    expect(mockUpsertThread).toHaveBeenCalledTimes(1);
  });

  it('retries with fresh key on decrypt failure (WS-03)', async () => {
    mockDecryptThreadFields
      .mockRejectedValueOnce(new Error('AES-GCM auth failed'))
      .mockResolvedValueOnce({ title: 'Retried Title', body: 'Retried Body' });

    // Use a unique threadId so dedup doesn't block it
    const msg = JSON.stringify({
      type: 'new_message',
      conversationId: 'group-1',
      timestamp: 1700000000000,
      data: {
        type: 'new_thread',
        threadId: 'thread-ws-retry',
        groupId: 'group-1',
        authorId: 'user-1',
        authorName: 'alice',
        encryptedTitle: 'enc-title',
        encryptedBody: 'enc-body',
        titleIv: 'title-iv',
        bodyIv: 'body-iv',
        createdAt: '2026-04-01T10:00:00Z',
        media: [],
      },
    });

    await handleServerMessage(msg);

    expect(mockInvalidateGroupKey).toHaveBeenCalledWith('group-1');
    expect(mockGetOrFetchGroupKey).toHaveBeenCalledTimes(2);
    expect(mockUpsertThread).toHaveBeenCalledTimes(1);
    expect(mockUpsertThread.mock.calls[0][0].title).toBe('Retried Title');
  });

  it('bumps lastMessageAt after upserting thread', async () => {
    const msg = JSON.stringify({
      type: 'new_message',
      conversationId: 'group-1',
      timestamp: 1700000000000,
      data: {
        type: 'new_thread',
        threadId: 'thread-bump-test',
        groupId: 'group-1',
        authorId: 'user-1',
        authorName: 'alice',
        encryptedTitle: 'enc-title',
        encryptedBody: 'enc-body',
        titleIv: 'title-iv',
        bodyIv: 'body-iv',
        createdAt: '2026-04-01T10:00:00Z',
        media: [],
      },
    });

    await handleServerMessage(msg);

    const { ensureDmConversation } = require('../../conversationService');
    expect(ensureDmConversation).toHaveBeenCalledWith('group-1');
    expect(mockBumpLastMessageAt).toHaveBeenCalledWith(
      'group-1',
      new Date('2026-04-01T10:00:00Z').getTime(),
    );
  });

  it('clears dedup entry and logs on failure so message can be retried', async () => {
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation();
    mockGetOrFetchGroupKey.mockRejectedValue(new Error('key unavailable'));

    const msg = JSON.stringify({
      type: 'new_message',
      conversationId: 'group-1',
      timestamp: 1700000000000,
      data: {
        type: 'new_thread',
        threadId: 'thread-fail-dedup',
        groupId: 'group-1',
        authorId: 'user-1',
        authorName: 'alice',
        encryptedTitle: 'enc-title',
        encryptedBody: 'enc-body',
        titleIv: 'title-iv',
        bodyIv: 'body-iv',
        createdAt: '2026-04-01T10:00:00Z',
        media: [],
      },
    });

    await handleServerMessage(msg);

    expect(consoleSpy).toHaveBeenCalledWith('[WS:new_thread_failed]');
    expect(mockUpsertThread).not.toHaveBeenCalled();

    // Dedup entry was cleared — retrying processes the message
    mockGetOrFetchGroupKey.mockResolvedValue(fakeGroupKey);
    await handleServerMessage(msg);
    expect(mockUpsertThread).toHaveBeenCalledTimes(1);

    consoleSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// new_reply broadcast
// ---------------------------------------------------------------------------

describe('new_reply broadcast', () => {
  it('decrypts and upserts a reply', async () => {
    await handleServerMessage(makeNewReplyMessage());

    expect(mockGetOrFetchGroupKey).toHaveBeenCalledWith('group-1');
    expect(mockDecryptReplyBody).toHaveBeenCalledWith(
      'enc-reply-body',
      'reply-body-iv',
      fakeGroupKey,
      'group-1',
    );

    expect(mockUpsertReply).toHaveBeenCalledTimes(1);
    const reply = mockUpsertReply.mock.calls[0][0];
    expect(reply.id).toBe('reply-ws-1');
    expect(reply.threadId).toBe('thread-1');
    expect(reply.authorUsername).toBe('bob');
    expect(reply.body).toBe('Decrypted Reply');
    expect(reply.depth).toBe(0);
    expect(reply.syncStatus).toBe('synced');
  });

  it('sets depth to 1 for nested replies (parentReplyId present)', async () => {
    const msg = JSON.stringify({
      type: 'new_message',
      conversationId: 'group-1',
      timestamp: 1700000002000,
      data: {
        type: 'new_reply',
        replyId: 'reply-ws-nested',
        threadId: 'thread-1',
        groupId: 'group-1',
        authorId: 'user-3',
        authorName: 'charlie',
        encryptedBody: 'enc-nested',
        bodyIv: 'nested-iv',
        parentReplyId: 'reply-ws-1',
        createdAt: '2026-04-01T11:30:00Z',
        media: [],
      },
    });

    await handleServerMessage(msg);

    const reply = mockUpsertReply.mock.calls[0][0];
    expect(reply.depth).toBe(1);
    expect(reply.parentReplyId).toBe('reply-ws-1');
  });

  it('calls ensureDmConversation before decryption', async () => {
    const msg = JSON.stringify({
      type: 'new_message',
      conversationId: 'group-1',
      timestamp: 1700000001000,
      data: {
        type: 'new_reply',
        replyId: 'reply-ensure-dm-test',
        threadId: 'thread-1',
        groupId: 'group-1',
        authorId: 'user-2',
        authorName: 'bob',
        encryptedBody: 'enc-reply-body',
        bodyIv: 'reply-body-iv',
        parentReplyId: null,
        createdAt: '2026-04-01T11:00:00Z',
        media: [],
      },
    });

    await handleServerMessage(msg);

    const { ensureDmConversation } = require('../../conversationService');
    expect(ensureDmConversation).toHaveBeenCalledWith('group-1');
  });

  it('bumps lastMessageAt after upserting reply', async () => {
    const msg = JSON.stringify({
      type: 'new_message',
      conversationId: 'group-1',
      timestamp: 1700000001000,
      data: {
        type: 'new_reply',
        replyId: 'reply-bump-test',
        threadId: 'thread-1',
        groupId: 'group-1',
        authorId: 'user-2',
        authorName: 'bob',
        encryptedBody: 'enc-reply-body',
        bodyIv: 'reply-body-iv',
        parentReplyId: null,
        createdAt: '2026-04-01T11:00:00Z',
        media: [],
      },
    });

    await handleServerMessage(msg);

    expect(mockBumpLastMessageAt).toHaveBeenCalledWith(
      'group-1',
      new Date('2026-04-01T11:00:00Z').getTime(),
    );
  });

  it('clears dedup entry on reply failure so message can be retried', async () => {
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation();
    mockGetOrFetchGroupKey.mockRejectedValue(new Error('key unavailable'));

    const msg = JSON.stringify({
      type: 'new_message',
      conversationId: 'group-1',
      timestamp: 1700000001000,
      data: {
        type: 'new_reply',
        replyId: 'reply-fail-dedup',
        threadId: 'thread-1',
        groupId: 'group-1',
        authorId: 'user-2',
        authorName: 'bob',
        encryptedBody: 'enc-reply-body',
        bodyIv: 'reply-body-iv',
        parentReplyId: null,
        createdAt: '2026-04-01T11:00:00Z',
        media: [],
      },
    });

    await handleServerMessage(msg);

    expect(consoleSpy).toHaveBeenCalledWith('[WS:new_reply_failed]');
    expect(mockUpsertReply).not.toHaveBeenCalled();

    mockGetOrFetchGroupKey.mockResolvedValue(fakeGroupKey);
    await handleServerMessage(msg);
    expect(mockUpsertReply).toHaveBeenCalledTimes(1);

    consoleSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// display_name_changed broadcast
// ---------------------------------------------------------------------------

describe('display_name_changed broadcast', () => {
  it('upserts contact with new displayName', async () => {
    const msg = JSON.stringify({
      type: 'new_message',
      conversationId: 'group-1',
      timestamp: 1700000003000,
      data: {
        type: 'display_name_changed',
        userId: 'user-5',
        displayName: 'New Name',
        timestamp: 1700000003000,
      },
    });

    await handleServerMessage(msg);

    expect(mockUpsertContact).toHaveBeenCalledWith({
      id: 'user-5',
      username: null,
      displayName: 'New Name',
      avatarPath: null,
      conversationIds: [],
    });
  });
});

// ---------------------------------------------------------------------------
// typing broadcast (removed from KNOWN_BROADCAST_TYPES — backend never broadcasts it)
// ---------------------------------------------------------------------------

describe('typing broadcast', () => {
  it('typing inside broadcast envelope is rejected by allow-list', async () => {
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation();
    const msg = JSON.stringify({
      type: 'new_message',
      conversationId: 'group-1',
      timestamp: 1700000004000,
      data: {
        type: 'typing',
        userId: 'user-6',
        conversationId: 'group-1',
      },
    });

    await handleServerMessage(msg);

    // Should be blocked by the allow-list guard
    expect(consoleSpy).toHaveBeenCalledWith('[WS:unknown_broadcast]');
    expect(mockAddTypingUser).not.toHaveBeenCalled();

    consoleSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// media_uploaded broadcast
// ---------------------------------------------------------------------------

describe('media_uploaded broadcast', () => {
  it('dispatches without error and does not upsert thread or reply', async () => {
    const msg = JSON.stringify({
      type: 'new_message',
      conversationId: 'group-1',
      timestamp: 1700000006000,
      data: {
        type: 'media_uploaded',
        mediaId: 'media-ws-1',
        groupId: 'group-1',
        authorId: 'user-1',
        encryptedMetadata: 'enc-meta-base64',
        sizeBytes: 1024,
        uploadedAt: '2026-04-01T12:00:00Z',
        expiresAt: '2026-05-01T12:00:00Z',
      },
    });

    await expect(handleServerMessage(msg)).resolves.toBeUndefined();

    // Should NOT trigger thread/reply upserts
    expect(mockUpsertThread).not.toHaveBeenCalled();
    expect(mockUpsertReply).not.toHaveBeenCalled();
  });

  it('is not blocked by the broadcast allow-list', async () => {
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation();
    const msg = JSON.stringify({
      type: 'new_message',
      conversationId: 'group-1',
      timestamp: 1700000007000,
      data: {
        type: 'media_uploaded',
        mediaId: 'media-ws-2',
        groupId: 'group-1',
        authorId: 'user-2',
        encryptedMetadata: 'enc-meta-base64',
        sizeBytes: 2048,
        uploadedAt: '2026-04-01T13:00:00Z',
        expiresAt: '2026-05-01T13:00:00Z',
      },
    });

    await handleServerMessage(msg);

    // Should NOT log [WS:unknown_broadcast] — it's a known type
    expect(consoleSpy).not.toHaveBeenCalledWith('[WS:unknown_broadcast]');

    consoleSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Dead broadcast entries removed (#193)
// ---------------------------------------------------------------------------

describe('dead broadcast entries removed', () => {
  it('wrap_key_request inside broadcast envelope is rejected by allow-list', async () => {
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation();
    const msg = JSON.stringify({
      type: 'new_message',
      conversationId: 'group-1',
      timestamp: 1700000008000,
      data: {
        type: 'wrap_key_request',
        groupId: 'group-1',
        targetUserId: 'target-user',
        targetIdentityPublicKey: 'key-base64',
      },
    });

    await handleServerMessage(msg);

    // Should be blocked by the allow-list guard
    expect(consoleSpy).toHaveBeenCalledWith('[WS:unknown_broadcast]');
    expect(mockSubmitWrappedKey).not.toHaveBeenCalled();

    consoleSpy.mockRestore();
  });

  it('wrapped_key_delivered inside broadcast envelope is rejected by allow-list', async () => {
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation();
    const msg = JSON.stringify({
      type: 'new_message',
      conversationId: 'group-1',
      timestamp: 1700000009000,
      data: {
        type: 'wrapped_key_delivered',
        groupId: 'group-1',
        senderUserId: 'sender-1',
      },
    });

    await handleServerMessage(msg);

    // Should be blocked by the allow-list guard
    expect(consoleSpy).toHaveBeenCalledWith('[WS:unknown_broadcast]');
    expect(mockEvictPendingCache).not.toHaveBeenCalled();

    consoleSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('edge cases', () => {
  it('silently ignores invalid JSON', async () => {
    await expect(handleServerMessage('not json')).resolves.toBeUndefined();
  });

  it('silently ignores messages without type field', async () => {
    await expect(handleServerMessage('{}')).resolves.toBeUndefined();
  });

  it('silently ignores pong messages', async () => {
    const raw = JSON.stringify({ type: 'pong', timestamp: 1700000000000 });
    await expect(handleServerMessage(raw)).resolves.toBeUndefined();
    // No store calls
    expect(mockSetConnectionStatus).not.toHaveBeenCalled();
  });

  it('ignores unknown broadcast data.type (WS-05)', async () => {
    const msg = JSON.stringify({
      type: 'new_message',
      conversationId: 'group-1',
      timestamp: 1700000005000,
      data: {
        type: 'future_event',
        someField: 'value',
      },
    });

    await expect(handleServerMessage(msg)).resolves.toBeUndefined();
    expect(mockUpsertThread).not.toHaveBeenCalled();
    expect(mockUpsertReply).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// wrap_key_request handler
// ---------------------------------------------------------------------------

describe('wrap_key_request', () => {
  // wrap_key_request arrives as a top-level message (via sendToUser),
  // NOT inside a broadcast envelope.
  function makeWrapKeyRequest(groupId = 'group-1', targetUserId = 'target-user') {
    return JSON.stringify({
      type: 'wrap_key_request',
      groupId,
      targetUserId,
      targetIdentityPublicKey: 'ignored-base64',
    });
  }

  beforeEach(() => {
    mockGetOrFetchGroupKey.mockResolvedValue(fakeGroupKey);
  });

  it('wraps and submits the group key for the target user', async () => {
    await handleServerMessage(makeWrapKeyRequest());

    expect(mockGetOrFetchGroupKey).toHaveBeenCalledWith('group-1');
    expect(mockResolveRemoteIdentityKey).toHaveBeenCalledWith('target-user', 'test-user-id');
    expect(mockWrapGroupKey).toHaveBeenCalledWith(fakeGroupKey, expect.any(ArrayBuffer), 'group-1');
    expect(mockSubmitWrappedKey).toHaveBeenCalledWith('group-1', 'target-user', 'wrapped-key-base64');
  });

  it('deduplicates within 30s TTL', async () => {
    await handleServerMessage(makeWrapKeyRequest('group-dedup', 'target-dedup'));
    await handleServerMessage(makeWrapKeyRequest('group-dedup', 'target-dedup'));

    expect(mockSubmitWrappedKey).toHaveBeenCalledTimes(1);
  });

  it('returns early when userId is null', async () => {
    (useAppStore.getState as jest.Mock).mockReturnValueOnce({
      userId: null,
      viewingConversationId: null,
      upsertThread: mockUpsertThread,
      upsertReply: mockUpsertReply,
      upsertContact: mockUpsertContact,
      setConnectionStatus: mockSetConnectionStatus,
      setLastConnectedAt: mockSetLastConnectedAt,
      setReconnectAttempt: mockSetReconnectAttempt,
      blockedUserIds: [],
      addTypingUser: mockAddTypingUser,
      bumpLastMessageAt: mockBumpLastMessageAt,
      incrementUnreadCount: mockIncrementUnreadCount,
      contacts: {},
    });

    await handleServerMessage(makeWrapKeyRequest('group-auth', 'user-auth'));

    expect(mockSubmitWrappedKey).not.toHaveBeenCalled();
  });

  it('clears dedup entry on error so retry succeeds', async () => {
    mockGetOrFetchGroupKey
      .mockRejectedValueOnce(new Error('key not available'))
      .mockResolvedValueOnce(fakeGroupKey);

    await handleServerMessage(makeWrapKeyRequest('group-retry', 'user-retry'));
    await handleServerMessage(makeWrapKeyRequest('group-retry', 'user-retry'));

    expect(mockGetOrFetchGroupKey).toHaveBeenCalledTimes(2);
    expect(mockSubmitWrappedKey).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// wrapped_key_delivered handler
// ---------------------------------------------------------------------------

describe('wrapped_key_delivered', () => {
  // wrapped_key_delivered arrives as a top-level message (via sendToUser),
  // NOT inside a broadcast envelope.
  function makeDeliveredEvent(groupId = 'group-1') {
    return JSON.stringify({
      type: 'wrapped_key_delivered',
      groupId,
      senderUserId: 'sender-1',
    });
  }

  beforeEach(() => {
    mockGetOrFetchGroupKey.mockResolvedValue(fakeGroupKey);
  });

  it('evicts pending cache and fetches group key', async () => {
    await handleServerMessage(makeDeliveredEvent());

    expect(mockEvictPendingCache).toHaveBeenCalledWith('group-1');
    expect(mockGetOrFetchGroupKey).toHaveBeenCalledWith('group-1');
  });

  it('retries pending orbit name decrypt after key acquisition', async () => {
    const { retryPendingNameDecrypt } = jest.requireMock('../../conversationService');

    await handleServerMessage(makeDeliveredEvent('group-name-retry'));

    expect(retryPendingNameDecrypt).toHaveBeenCalledWith('group-name-retry');
  });

  it('does not retry name decrypt when key fetch fails', async () => {
    const { retryPendingNameDecrypt } = jest.requireMock('../../conversationService');
    (retryPendingNameDecrypt as jest.Mock).mockClear();
    mockGetOrFetchGroupKey.mockRejectedValueOnce(new Error('fetch failed'));

    await handleServerMessage(makeDeliveredEvent('group-name-retry-fail'));

    expect(retryPendingNameDecrypt).not.toHaveBeenCalled();
  });

  it('deduplicates within 30s TTL', async () => {
    await handleServerMessage(makeDeliveredEvent('group-dedup-d'));
    await handleServerMessage(makeDeliveredEvent('group-dedup-d'));

    expect(mockGetOrFetchGroupKey).toHaveBeenCalledTimes(1);
  });

  it('swallows errors without throwing', async () => {
    mockGetOrFetchGroupKey.mockRejectedValueOnce(new Error('fetch failed'));

    await expect(handleServerMessage(makeDeliveredEvent('group-err'))).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Production error logging (#190)
// ---------------------------------------------------------------------------

describe('production error logging', () => {
  let consoleSpy: jest.SpyInstance;

  beforeEach(() => {
    consoleSpy = jest.spyOn(console, 'error').mockImplementation();
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it('logs [WS:parse_failure] on invalid JSON', async () => {
    await handleServerMessage('not json at all');

    expect(consoleSpy).toHaveBeenCalledWith('[WS:parse_failure]');
  });

  it('logs [WS:missing_type] when type field is absent', async () => {
    await handleServerMessage('{"data": "no-type"}');

    expect(consoleSpy).toHaveBeenCalledWith('[WS:missing_type]');
  });

  it('logs [WS:unknown_type] for unrecognized top-level type', async () => {
    const msg = JSON.stringify({ type: 'alien_message' });
    await handleServerMessage(msg);

    expect(consoleSpy).toHaveBeenCalledWith('[WS:unknown_type]');
  });

  it('logs [WS:unknown_broadcast] for unrecognized broadcast data.type', async () => {
    const msg = JSON.stringify({
      type: 'new_message',
      conversationId: 'group-1',
      timestamp: Date.now(),
      data: {
        type: 'some_future_event',
      },
    });
    await handleServerMessage(msg);

    expect(consoleSpy).toHaveBeenCalledWith('[WS:unknown_broadcast]');
  });

  it('logs [WS:decrypt_retry] on decrypt failure before retry', async () => {
    mockDecryptThreadFields
      .mockRejectedValueOnce(new Error('AES-GCM auth failed'))
      .mockResolvedValueOnce({ title: 'Retried', body: 'Body' });

    const msg = JSON.stringify({
      type: 'new_message',
      conversationId: 'group-1',
      timestamp: Date.now(),
      data: {
        type: 'new_thread',
        threadId: 'thread-decrypt-retry-log',
        groupId: 'group-1',
        authorId: 'user-1',
        authorName: 'alice',
        encryptedTitle: 'enc',
        encryptedBody: 'enc',
        titleIv: 'iv',
        bodyIv: 'iv',
        createdAt: '2026-04-01T10:00:00Z',
        media: [],
      },
    });

    await handleServerMessage(msg);

    expect(consoleSpy).toHaveBeenCalledWith('[WS:decrypt_retry]');
  });

  it('production error logs contain ONLY the category string, no dynamic data', async () => {
    // Unknown type — verify console.error is called with exactly 1 arg
    const msg = JSON.stringify({ type: 'alien_message' });
    await handleServerMessage(msg);

    const unknownTypeCall = consoleSpy.mock.calls.find(
      (args: unknown[]) => args[0] === '[WS:unknown_type]',
    );
    expect(unknownTypeCall).toBeDefined();
    expect(unknownTypeCall).toHaveLength(1); // Only the category string, no extra args
  });
});

// ---------------------------------------------------------------------------
// Unread count increment (#228)
// ---------------------------------------------------------------------------

describe('unread count increment', () => {
  afterEach(() => {
    (useAppStore.getState as jest.Mock).mockReturnValue({
      userId: 'test-user-id',
      viewingConversationId: null,
      upsertThread: mockUpsertThread,
      upsertReply: mockUpsertReply,
      upsertContact: mockUpsertContact,
      setConnectionStatus: mockSetConnectionStatus,
      setLastConnectedAt: mockSetLastConnectedAt,
      setReconnectAttempt: mockSetReconnectAttempt,
      blockedUserIds: [],
      addTypingUser: mockAddTypingUser,
      bumpLastMessageAt: mockBumpLastMessageAt,
      incrementUnreadCount: mockIncrementUnreadCount,
      contacts: {},
    });
  });

  it('increments unread when viewingConversationId differs from groupId (new_thread)', async () => {
    const msg = JSON.stringify({
      type: 'new_message',
      conversationId: 'group-1',
      timestamp: Date.now(),
      data: {
        type: 'new_thread',
        threadId: 'thread-unread-1',
        groupId: 'group-1',
        authorId: 'user-1',
        authorName: 'alice',
        encryptedTitle: 'enc-title',
        encryptedBody: 'enc-body',
        titleIv: 'title-iv',
        bodyIv: 'body-iv',
        createdAt: '2026-04-01T10:00:00Z',
        media: [],
      },
    });

    await handleServerMessage(msg);

    expect(mockIncrementUnreadCount).toHaveBeenCalledWith('group-1');
  });

  it('does NOT increment unread when viewingConversationId === groupId (new_thread)', async () => {
    (useAppStore.getState as jest.Mock).mockReturnValue({
      userId: 'test-user-id',
      viewingConversationId: 'group-1',
      upsertThread: mockUpsertThread,
      upsertReply: mockUpsertReply,
      upsertContact: mockUpsertContact,
      setConnectionStatus: mockSetConnectionStatus,
      setLastConnectedAt: mockSetLastConnectedAt,
      setReconnectAttempt: mockSetReconnectAttempt,
      blockedUserIds: [],
      addTypingUser: mockAddTypingUser,
      bumpLastMessageAt: mockBumpLastMessageAt,
      incrementUnreadCount: mockIncrementUnreadCount,
      contacts: {},
    });

    const msg = JSON.stringify({
      type: 'new_message',
      conversationId: 'group-1',
      timestamp: Date.now(),
      data: {
        type: 'new_thread',
        threadId: 'thread-unread-2',
        groupId: 'group-1',
        authorId: 'user-1',
        authorName: 'alice',
        encryptedTitle: 'enc-title',
        encryptedBody: 'enc-body',
        titleIv: 'title-iv',
        bodyIv: 'body-iv',
        createdAt: '2026-04-01T10:00:00Z',
        media: [],
      },
    });

    await handleServerMessage(msg);

    expect(mockIncrementUnreadCount).not.toHaveBeenCalled();
  });

  it('increments unread when viewingConversationId differs from groupId (new_reply)', async () => {
    const msg = JSON.stringify({
      type: 'new_message',
      conversationId: 'group-1',
      timestamp: Date.now(),
      data: {
        type: 'new_reply',
        replyId: 'reply-unread-1',
        threadId: 'thread-1',
        groupId: 'group-1',
        authorId: 'user-2',
        authorName: 'bob',
        encryptedBody: 'enc-reply-body',
        bodyIv: 'reply-body-iv',
        parentReplyId: null,
        createdAt: '2026-04-01T11:00:00Z',
        media: [],
      },
    });

    await handleServerMessage(msg);

    expect(mockIncrementUnreadCount).toHaveBeenCalledWith('group-1');
  });

  it('does NOT increment unread when viewingConversationId === groupId (new_reply)', async () => {
    (useAppStore.getState as jest.Mock).mockReturnValue({
      userId: 'test-user-id',
      viewingConversationId: 'group-1',
      upsertThread: mockUpsertThread,
      upsertReply: mockUpsertReply,
      upsertContact: mockUpsertContact,
      setConnectionStatus: mockSetConnectionStatus,
      setLastConnectedAt: mockSetLastConnectedAt,
      setReconnectAttempt: mockSetReconnectAttempt,
      blockedUserIds: [],
      addTypingUser: mockAddTypingUser,
      bumpLastMessageAt: mockBumpLastMessageAt,
      incrementUnreadCount: mockIncrementUnreadCount,
      contacts: {},
    });

    const msg = JSON.stringify({
      type: 'new_message',
      conversationId: 'group-1',
      timestamp: Date.now(),
      data: {
        type: 'new_reply',
        replyId: 'reply-unread-2',
        threadId: 'thread-1',
        groupId: 'group-1',
        authorId: 'user-2',
        authorName: 'bob',
        encryptedBody: 'enc-reply-body',
        bodyIv: 'reply-body-iv',
        parentReplyId: null,
        createdAt: '2026-04-01T11:00:00Z',
        media: [],
      },
    });

    await handleServerMessage(msg);

    expect(mockIncrementUnreadCount).not.toHaveBeenCalled();
  });
});


// ---------------------------------------------------------------------------
// avatar_changed broadcast
// ---------------------------------------------------------------------------

describe('avatar_changed broadcast', () => {
  it('updates avatarDigest and clears localAvatarUri for known contact', async () => {
    (useAppStore.getState as jest.Mock).mockReturnValue({
      userId: 'test-user-id',
      viewingConversationId: null,
      upsertThread: mockUpsertThread,
      upsertReply: mockUpsertReply,
      upsertContact: mockUpsertContact,
      setConnectionStatus: mockSetConnectionStatus,
      setLastConnectedAt: mockSetLastConnectedAt,
      setReconnectAttempt: mockSetReconnectAttempt,
      addTypingUser: mockAddTypingUser,
      bumpLastMessageAt: mockBumpLastMessageAt,
      incrementUnreadCount: mockIncrementUnreadCount,
      contacts: {
        'user-avatar': {
          id: 'user-avatar',
          username: 'bob',
          displayName: 'Bob',
          avatarPath: '/old/path.jpg',
          conversationIds: ['group-1'],
          avatarDigest: 'old-digest',
          localAvatarUri: 'file:///old/local.jpg',
        },
      },
    });

    const msg = JSON.stringify({
      type: 'new_message',
      conversationId: 'group-1',
      timestamp: 1700000010000,
      data: {
        type: 'avatar_changed',
        userId: 'user-avatar',
        avatarDigest: 'new-digest-abc',
        timestamp: 1700000010000,
      },
    });

    await handleServerMessage(msg);

    expect(mockUpsertContact).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'user-avatar',
        avatarDigest: 'new-digest-abc',
        localAvatarUri: null,
      }),
    );
  });

  it('calls invalidateAvatarCache with correct userId', async () => {
    const msg = JSON.stringify({
      type: 'new_message',
      conversationId: 'group-1',
      timestamp: 1700000011000,
      data: {
        type: 'avatar_changed',
        userId: 'user-cache-test',
        avatarDigest: 'digest-123',
        timestamp: 1700000011000,
      },
    });

    await handleServerMessage(msg);

    const { invalidateAvatarCache } = require('../../avatarService');
    expect(invalidateAvatarCache).toHaveBeenCalledWith('user-cache-test');
  });

  it('calls refreshContactAvatar for known contact', async () => {
    (useAppStore.getState as jest.Mock).mockReturnValue({
      userId: 'test-user-id',
      viewingConversationId: null,
      upsertThread: mockUpsertThread,
      upsertReply: mockUpsertReply,
      upsertContact: mockUpsertContact,
      setConnectionStatus: mockSetConnectionStatus,
      setLastConnectedAt: mockSetLastConnectedAt,
      setReconnectAttempt: mockSetReconnectAttempt,
      addTypingUser: mockAddTypingUser,
      bumpLastMessageAt: mockBumpLastMessageAt,
      incrementUnreadCount: mockIncrementUnreadCount,
      contacts: {
        'user-refresh': {
          id: 'user-refresh',
          username: 'carol',
          displayName: 'Carol',
          avatarPath: null,
          conversationIds: ['group-1'],
        },
      },
    });

    const msg = JSON.stringify({
      type: 'new_message',
      conversationId: 'group-1',
      timestamp: 1700000012000,
      data: {
        type: 'avatar_changed',
        userId: 'user-refresh',
        avatarDigest: 'new-digest',
        timestamp: 1700000012000,
      },
    });

    await handleServerMessage(msg);

    const { refreshContactAvatar } = require('../../conversationService');
    expect(refreshContactAvatar).toHaveBeenCalledWith('user-refresh');
  });

  it('does not call upsertContact or refreshContactAvatar for unknown contact', async () => {
    const msg = JSON.stringify({
      type: 'new_message',
      conversationId: 'group-1',
      timestamp: 1700000013000,
      data: {
        type: 'avatar_changed',
        userId: 'unknown-user',
        avatarDigest: 'some-digest',
        timestamp: 1700000013000,
      },
    });

    await handleServerMessage(msg);

    expect(mockUpsertContact).not.toHaveBeenCalled();
    const { refreshContactAvatar } = require('../../conversationService');
    expect(refreshContactAvatar).not.toHaveBeenCalled();
    // Cache is still invalidated even for unknown contacts
    const { invalidateAvatarCache } = require('../../avatarService');
    expect(invalidateAvatarCache).toHaveBeenCalledWith('unknown-user');
  });

  it('handles null avatarDigest (avatar removed)', async () => {
    (useAppStore.getState as jest.Mock).mockReturnValue({
      userId: 'test-user-id',
      viewingConversationId: null,
      upsertThread: mockUpsertThread,
      upsertReply: mockUpsertReply,
      upsertContact: mockUpsertContact,
      setConnectionStatus: mockSetConnectionStatus,
      setLastConnectedAt: mockSetLastConnectedAt,
      setReconnectAttempt: mockSetReconnectAttempt,
      addTypingUser: mockAddTypingUser,
      bumpLastMessageAt: mockBumpLastMessageAt,
      incrementUnreadCount: mockIncrementUnreadCount,
      contacts: {
        'user-remove-avatar': {
          id: 'user-remove-avatar',
          username: 'dave',
          displayName: 'Dave',
          avatarPath: '/old.jpg',
          conversationIds: ['group-1'],
          avatarDigest: 'old-digest',
          localAvatarUri: 'file:///old.jpg',
        },
      },
    });

    const msg = JSON.stringify({
      type: 'new_message',
      conversationId: 'group-1',
      timestamp: 1700000014000,
      data: {
        type: 'avatar_changed',
        userId: 'user-remove-avatar',
        avatarDigest: null,
        timestamp: 1700000014000,
      },
    });

    await handleServerMessage(msg);

    expect(mockUpsertContact).toHaveBeenCalledWith(
      expect.objectContaining({
        avatarDigest: null,
        localAvatarUri: null,
      }),
    );
  });

  it('is not blocked by the broadcast allow-list', async () => {
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation();

    const msg = JSON.stringify({
      type: 'new_message',
      conversationId: 'group-1',
      timestamp: 1700000015000,
      data: {
        type: 'avatar_changed',
        userId: 'user-allowlist',
        avatarDigest: 'digest-x',
        timestamp: 1700000015000,
      },
    });

    await handleServerMessage(msg);

    expect(consoleSpy).not.toHaveBeenCalledWith('[WS:unknown_broadcast]');
    consoleSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// clearMessageHandlerState (#204)
// ---------------------------------------------------------------------------

describe('clearMessageHandlerState', () => {
  it('clears dedup state so previously seen messages are processed again', async () => {
    const msg = JSON.stringify({
      type: 'new_message',
      conversationId: 'group-1',
      timestamp: Date.now(),
      data: {
        type: 'new_thread',
        threadId: 'thread-clear-test',
        groupId: 'group-1',
        authorId: 'user-1',
        authorName: 'alice',
        encryptedTitle: 'enc-title',
        encryptedBody: 'enc-body',
        titleIv: 'title-iv',
        bodyIv: 'body-iv',
        createdAt: '2026-04-01T10:00:00Z',
        media: [],
      },
    });

    await handleServerMessage(msg);
    expect(mockUpsertThread).toHaveBeenCalledTimes(1);

    clearMessageHandlerState();

    await handleServerMessage(msg);
    expect(mockUpsertThread).toHaveBeenCalledTimes(2);
  });
});

// ============================================================
// blocked user guard
// ============================================================

describe('blocked user guard', () => {
  it('drops new_thread from blocked user', async () => {
    (useAppStore.getState as jest.Mock).mockReturnValue({
      userId: 'test-user-id',
      viewingConversationId: null,
      upsertThread: mockUpsertThread,
      upsertReply: mockUpsertReply,
      upsertContact: mockUpsertContact,
      setConnectionStatus: mockSetConnectionStatus,
      setLastConnectedAt: mockSetLastConnectedAt,
      setReconnectAttempt: mockSetReconnectAttempt,
      blockedUserIds: ['blocked-user-1'],
      addTypingUser: mockAddTypingUser,
      bumpLastMessageAt: mockBumpLastMessageAt,
      incrementUnreadCount: mockIncrementUnreadCount,
      contacts: {},
    });

    const msg = JSON.stringify({
      type: 'new_message',
      conversationId: 'group-1',
      timestamp: Date.now(),
      data: {
        type: 'new_thread',
        threadId: 'thread-blocked-1',
        groupId: 'group-1',
        authorId: 'blocked-user-1',
        authorName: 'baduser',
        encryptedTitle: 'enc-title',
        encryptedBody: 'enc-body',
        titleIv: 'iv',
        bodyIv: 'iv',
        createdAt: '2026-06-06T00:00:00Z',
        media: [],
      },
    });

    await handleServerMessage(msg);
    expect(mockUpsertThread).not.toHaveBeenCalled();
    expect(mockIncrementUnreadCount).not.toHaveBeenCalled();
  });

  it('drops new_reply from blocked user', async () => {
    (useAppStore.getState as jest.Mock).mockReturnValue({
      userId: 'test-user-id',
      viewingConversationId: null,
      upsertThread: mockUpsertThread,
      upsertReply: mockUpsertReply,
      upsertContact: mockUpsertContact,
      setConnectionStatus: mockSetConnectionStatus,
      setLastConnectedAt: mockSetLastConnectedAt,
      setReconnectAttempt: mockSetReconnectAttempt,
      blockedUserIds: ['blocked-user-2'],
      addTypingUser: mockAddTypingUser,
      bumpLastMessageAt: mockBumpLastMessageAt,
      incrementUnreadCount: mockIncrementUnreadCount,
      contacts: {},
    });

    const msg = JSON.stringify({
      type: 'new_message',
      conversationId: 'group-1',
      timestamp: Date.now(),
      data: {
        type: 'new_reply',
        replyId: 'reply-blocked-1',
        threadId: 'thread-1',
        groupId: 'group-1',
        authorId: 'blocked-user-2',
        authorName: 'baduser2',
        encryptedBody: 'enc-body',
        bodyIv: 'iv',
        parentReplyId: null,
        createdAt: '2026-06-06T00:00:00Z',
        media: [],
      },
    });

    await handleServerMessage(msg);
    expect(mockUpsertReply).not.toHaveBeenCalled();
    expect(mockIncrementUnreadCount).not.toHaveBeenCalled();
  });
});
