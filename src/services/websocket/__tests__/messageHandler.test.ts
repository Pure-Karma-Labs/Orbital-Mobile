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
}));

const mockUpsertThread = jest.fn();
const mockUpsertReply = jest.fn();
const mockUpsertContact = jest.fn();
const mockSetConnectionStatus = jest.fn();
const mockSetLastConnectedAt = jest.fn();
const mockSetReconnectAttempt = jest.fn();
const mockAddTypingUser = jest.fn();

jest.mock('../../../stores/useAppStore', () => ({
  useAppStore: {
    getState: jest.fn(() => ({
      upsertThread: mockUpsertThread,
      upsertReply: mockUpsertReply,
      upsertContact: mockUpsertContact,
      setConnectionStatus: mockSetConnectionStatus,
      setLastConnectedAt: mockSetLastConnectedAt,
      setReconnectAttempt: mockSetReconnectAttempt,
      addTypingUser: mockAddTypingUser,
      contacts: {},
    })),
  },
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { handleServerMessage } from '../messageHandler';
import { snakeToCamel } from '../../api/client';
import {
  getOrFetchGroupKey,
  invalidateGroupKey,
} from '../../crypto/contentCrypto';
import { decryptThreadFields, decryptReplyBody } from '../../threadService';

const mockSnakeToCamel = snakeToCamel as jest.MockedFunction<typeof snakeToCamel>;
const mockGetOrFetchGroupKey = getOrFetchGroupKey as jest.MockedFunction<typeof getOrFetchGroupKey>;
const mockInvalidateGroupKey = invalidateGroupKey as jest.MockedFunction<typeof invalidateGroupKey>;
const mockDecryptThreadFields = decryptThreadFields as jest.MockedFunction<typeof decryptThreadFields>;
const mockDecryptReplyBody = decryptReplyBody as jest.MockedFunction<typeof decryptReplyBody>;

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
      displayName: 'New Name',
      avatarPath: null,
      conversationIds: [],
    });
  });
});

// ---------------------------------------------------------------------------
// typing broadcast
// ---------------------------------------------------------------------------

describe('typing broadcast', () => {
  it('adds typing user to store', async () => {
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

    expect(mockAddTypingUser).toHaveBeenCalledWith(
      'group-1',
      expect.objectContaining({ userId: 'user-6' }),
    );
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
