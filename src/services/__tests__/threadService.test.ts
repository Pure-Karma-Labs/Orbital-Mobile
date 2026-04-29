/**
 * Tests for threadService — fetch, decrypt, and store orchestration for threads and replies.
 */

// ---------------------------------------------------------------------------
// Module mocks — must be declared before imports
// ---------------------------------------------------------------------------

jest.mock('../api/threads', () => ({
  getThread: jest.fn(),
  getThreadReplies: jest.fn(),
  createReply: jest.fn(),
}));

jest.mock('../crypto/contentCrypto', () => ({
  decryptContent: jest.fn(),
  encryptContent: jest.fn(),
  getOrFetchGroupKey: jest.fn(),
}));

jest.mock('../../utils/uuid', () => ({
  generateUUID: jest.fn(() => 'client-uuid-000'),
}));

// Mock the zustand store — provide getState with mock actions
const mockUpsertThread = jest.fn();
const mockSetReplies = jest.fn();
const mockAppendReplies = jest.fn();
const mockAddOptimisticReply = jest.fn();
const mockUpdateReplySyncStatus = jest.fn();

jest.mock('../../stores/useAppStore', () => ({
  useAppStore: {
    getState: jest.fn(() => ({
      upsertThread: mockUpsertThread,
      setReplies: mockSetReplies,
      appendReplies: mockAppendReplies,
      addOptimisticReply: mockAddOptimisticReply,
      updateReplySyncStatus: mockUpdateReplySyncStatus,
    })),
  },
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { loadThread, loadReplies, postReply } from '../threadService';
import { getThread, getThreadReplies, createReply } from '../api/threads';
import {
  decryptContent,
  encryptContent,
  getOrFetchGroupKey,
} from '../crypto/contentCrypto';
import type { ThreadResponse, ReplyResponse, ListRepliesResponse, CreateReplyResponse } from '../../types/api';

const mockGetThread = getThread as jest.MockedFunction<typeof getThread>;
const mockGetThreadReplies = getThreadReplies as jest.MockedFunction<typeof getThreadReplies>;
const mockCreateReply = createReply as jest.MockedFunction<typeof createReply>;
const mockDecryptContent = decryptContent as jest.MockedFunction<typeof decryptContent>;
const mockEncryptContent = encryptContent as jest.MockedFunction<typeof encryptContent>;
const mockGetOrFetchGroupKey = getOrFetchGroupKey as jest.MockedFunction<typeof getOrFetchGroupKey>;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const fakeGroupKey = new Uint8Array(32).fill(0xab);

function makeThreadResponse(overrides: Partial<ThreadResponse> = {}): ThreadResponse {
  return {
    threadId: 'thread-1',
    groupId: 'group-1',
    authorId: 'user-1',
    authorUsername: 'alice',
    authorDisplayName: 'Alice',
    encryptedTitle: 'enc-title-base64',
    titleIv: 'title-iv-base64',
    encryptedBody: 'enc-body-base64',
    bodyIv: 'body-iv-base64',
    replyCount: 2,
    createdAt: '2026-04-01T10:00:00Z',
    media: [],
    ...overrides,
  };
}

function makeReplyResponse(overrides: Partial<ReplyResponse> = {}): ReplyResponse {
  return {
    replyId: 'reply-1',
    threadId: 'thread-1',
    authorId: 'user-2',
    authorUsername: 'bob',
    authorDisplayName: 'Bob',
    encryptedBody: 'enc-reply-base64',
    bodyIv: 'reply-iv-base64',
    parentReplyId: null,
    level: 0,
    createdAt: '2026-04-01T11:00:00Z',
    media: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  jest.clearAllMocks();
  mockGetOrFetchGroupKey.mockResolvedValue(fakeGroupKey);
  mockDecryptContent.mockImplementation(async (ciphertext: string) => {
    if (ciphertext.includes('title')) return 'Decrypted Title';
    if (ciphertext.includes('reply')) return 'Decrypted Reply Body';
    return 'Decrypted Body';
  });
  mockEncryptContent.mockResolvedValue({
    ciphertext: 'encrypted-ciphertext',
    iv: 'encrypted-iv',
  });
});

// ---------------------------------------------------------------------------
// loadThread
// ---------------------------------------------------------------------------

describe('loadThread', () => {
  it('fetches thread, decrypts content, and upserts into store', async () => {
    const apiResponse = makeThreadResponse();
    mockGetThread.mockResolvedValue(apiResponse);

    const result = await loadThread('thread-1');

    expect(mockGetThread).toHaveBeenCalledWith('thread-1');
    expect(mockGetOrFetchGroupKey).toHaveBeenCalledWith('group-1');

    expect(mockDecryptContent).toHaveBeenCalledTimes(2);
    expect(mockDecryptContent).toHaveBeenCalledWith(
      'enc-title-base64',
      'title-iv-base64',
      fakeGroupKey,
      'group-1',
    );
    expect(mockDecryptContent).toHaveBeenCalledWith(
      'enc-body-base64',
      'body-iv-base64',
      fakeGroupKey,
      'group-1',
    );

    expect(mockUpsertThread).toHaveBeenCalledTimes(1);
    const upsertedThread = mockUpsertThread.mock.calls[0][0];
    expect(upsertedThread.id).toBe('thread-1');
    expect(upsertedThread.title).toBe('Decrypted Title');
    expect(upsertedThread.body).toBe('Decrypted Body');
    expect(upsertedThread.authorUsername).toBe('alice');
    expect(upsertedThread.conversationId).toBe('group-1');
    expect(upsertedThread.syncStatus).toBe('synced');

    expect(result.id).toBe('thread-1');
    expect(result.title).toBe('Decrypted Title');
  });

  it('handles null title and body gracefully', async () => {
    const apiResponse = makeThreadResponse({
      encryptedTitle: null,
      titleIv: null,
      encryptedBody: null,
      bodyIv: null,
    });
    mockGetThread.mockResolvedValue(apiResponse);

    const result = await loadThread('thread-1');

    expect(mockDecryptContent).not.toHaveBeenCalled();
    expect(result.title).toBeNull();
    expect(result.body).toBeNull();
  });

  it('converts ISO date strings to timestamps', async () => {
    const apiResponse = makeThreadResponse({
      createdAt: '2026-04-01T10:00:00Z',
    });
    mockGetThread.mockResolvedValue(apiResponse);

    const result = await loadThread('thread-1');

    expect(typeof result.createdAt).toBe('number');
    expect(result.createdAt).toBe(new Date('2026-04-01T10:00:00Z').getTime());
  });
});

// ---------------------------------------------------------------------------
// loadReplies
// ---------------------------------------------------------------------------

describe('loadReplies', () => {
  it('fetches replies, decrypts, and sets replies for first page', async () => {
    const response: ListRepliesResponse = {
      replies: [makeReplyResponse({ replyId: 'reply-1' }), makeReplyResponse({ replyId: 'reply-2' })],
      media: [],
      totalCount: 5,
      hasMore: true,
    };
    mockGetThreadReplies.mockResolvedValue(response);

    const result = await loadReplies('thread-1', 'group-1');

    expect(mockGetThreadReplies).toHaveBeenCalledWith('thread-1', undefined);
    expect(mockGetOrFetchGroupKey).toHaveBeenCalledWith('group-1');
    expect(mockDecryptContent).toHaveBeenCalledTimes(2);

    expect(mockSetReplies).toHaveBeenCalledTimes(1);
    expect(mockAppendReplies).not.toHaveBeenCalled();

    expect(result.replies).toHaveLength(2);
    expect(result.hasMore).toBe(true);
  });

  it('uses appendReplies for paginated (offset) requests', async () => {
    const response: ListRepliesResponse = {
      replies: [makeReplyResponse({ replyId: 'reply-3' })],
      media: [],
      totalCount: 3,
      hasMore: false,
    };
    mockGetThreadReplies.mockResolvedValue(response);

    const result = await loadReplies('thread-1', 'group-1', 20);

    expect(mockGetThreadReplies).toHaveBeenCalledWith('thread-1', 20);

    expect(mockAppendReplies).toHaveBeenCalledTimes(1);
    expect(mockSetReplies).not.toHaveBeenCalled();

    expect(result.hasMore).toBe(false);
  });

  it('maps reply fields correctly including authorUsername and level', async () => {
    const response: ListRepliesResponse = {
      replies: [
        makeReplyResponse({
          replyId: 'reply-1',
          authorUsername: 'charlie',
          level: 2,
          parentReplyId: 'reply-parent',
        }),
      ],
      media: [],
      totalCount: 1,
      hasMore: false,
    };
    mockGetThreadReplies.mockResolvedValue(response);

    const result = await loadReplies('thread-1', 'group-1');

    const reply = result.replies[0];
    expect(reply.authorUsername).toBe('charlie');
    expect(reply.depth).toBe(2);
    expect(reply.parentReplyId).toBe('reply-parent');
    expect(reply.syncStatus).toBe('synced');
  });
});

// ---------------------------------------------------------------------------
// postReply
// ---------------------------------------------------------------------------

describe('postReply', () => {
  it('encrypts body, adds optimistic reply, and calls API', async () => {
    const createResponse: CreateReplyResponse = {
      replyId: 'server-reply-id',
      threadId: 'thread-1',
      createdAt: '2026-04-01T12:00:00Z',
      media: [],
    };
    mockCreateReply.mockResolvedValue(createResponse);

    const result = await postReply(
      'thread-1',
      'group-1',
      'Hello world',
      null,
      0,
      'user-1',
      'alice',
    );

    expect(mockEncryptContent).toHaveBeenCalledWith('Hello world', fakeGroupKey, 'group-1');

    expect(mockAddOptimisticReply).toHaveBeenCalledTimes(1);
    const optimistic = mockAddOptimisticReply.mock.calls[0][0];
    expect(optimistic.id).toBe('client-uuid-000');
    expect(optimistic.body).toBe('Hello world');
    expect(optimistic.authorUsername).toBe('alice');
    expect(optimistic.syncStatus).toBe('pending');
    expect(optimistic.parentReplyId).toBeNull();
    expect(optimistic.depth).toBe(0);

    expect(mockCreateReply).toHaveBeenCalledWith('thread-1', {
      encryptedBody: 'encrypted-ciphertext',
      bodyIv: 'encrypted-iv',
      parentReplyId: null,
    });

    expect(mockUpdateReplySyncStatus).toHaveBeenCalledWith('client-uuid-000', 'synced');

    expect(result.syncStatus).toBe('synced');
    expect(result.id).toBe('server-reply-id');
  });

  it('sets sync status to failed when API call throws', async () => {
    mockCreateReply.mockRejectedValue(new Error('Network error'));

    await expect(
      postReply('thread-1', 'group-1', 'Hello', null, 0, 'user-1', 'alice'),
    ).rejects.toThrow('Failed to post reply');

    expect(mockAddOptimisticReply).toHaveBeenCalledTimes(1);

    expect(mockUpdateReplySyncStatus).toHaveBeenCalledWith('client-uuid-000', 'failed');
  });

  it('passes parentReplyId and depth for nested replies', async () => {
    const createResponse: CreateReplyResponse = {
      replyId: 'server-nested-reply',
      threadId: 'thread-1',
      createdAt: '2026-04-01T12:00:00Z',
      media: [],
    };
    mockCreateReply.mockResolvedValue(createResponse);

    await postReply(
      'thread-1',
      'group-1',
      'Nested reply',
      'parent-reply-1',
      2,
      'user-1',
      'alice',
    );

    const optimistic = mockAddOptimisticReply.mock.calls[0][0];
    expect(optimistic.parentReplyId).toBe('parent-reply-1');
    expect(optimistic.depth).toBe(2);

    expect(mockCreateReply).toHaveBeenCalledWith('thread-1', {
      encryptedBody: 'encrypted-ciphertext',
      bodyIv: 'encrypted-iv',
      parentReplyId: 'parent-reply-1',
    });
  });
});
