/**
 * Tests for threadService — fetch, decrypt, and store orchestration for threads and replies.
 */

// ---------------------------------------------------------------------------
// Module mocks — must be declared before imports
// ---------------------------------------------------------------------------

jest.mock('../../database/repositories/threadRepository', () => ({
  saveThread: jest.fn(),
  saveThreadBatch: jest.fn(),
  getThreadsForConversation: jest.fn(() => []),
  getThread: jest.fn(() => null),
}));

jest.mock('../../database/repositories/replyRepository', () => ({
  saveReply: jest.fn(),
  saveReplyBatch: jest.fn(),
  getRepliesForThread: jest.fn(() => []),
}));

jest.mock('../../database/connection', () => ({
  isDatabaseInitialized: jest.fn(() => true),
}));

jest.mock('../api/threads', () => ({
  getThread: jest.fn(),
  getGroupThreads: jest.fn(),
  getThreadReplies: jest.fn(),
  createReply: jest.fn(),
  createThread: jest.fn(),
}));

jest.mock('../crypto/contentCrypto', () => ({
  PendingWrapError: class PendingWrapError extends Error {
    constructor() {
      super('Group key not yet available (pending wrap)');
      this.name = 'PendingWrapError';
    }
  },
  decryptContent: jest.fn(),
  encryptContent: jest.fn(),
  getOrFetchGroupKey: jest.fn(),
}));

jest.mock('../../utils/uuid', () => ({
  generateUUID: jest.fn(() => 'client-uuid-000'),
}));

// Mock the zustand store — provide getState with mock actions
const mockUpsertThread = jest.fn();
const mockMarkThreadViewed = jest.fn();
const mockSetReplies = jest.fn();
const mockAppendReplies = jest.fn();
const mockAddOptimisticReply = jest.fn();
const mockUpdateReplySyncStatus = jest.fn();
const mockRemoveReply = jest.fn();
const mockUpsertReply = jest.fn();
const mockAddOptimisticThread = jest.fn();
const mockRemoveThread = jest.fn();
const mockSetThreads = jest.fn();
const mockUpdateThreadSyncStatus = jest.fn();

jest.mock('../../stores/useAppStore', () => ({
  useAppStore: {
    getState: jest.fn(() => ({
      threads: {},
      markThreadViewed: mockMarkThreadViewed,
      upsertThread: mockUpsertThread,
      setReplies: mockSetReplies,
      appendReplies: mockAppendReplies,
      addOptimisticReply: mockAddOptimisticReply,
      updateReplySyncStatus: mockUpdateReplySyncStatus,
      removeReply: mockRemoveReply,
      upsertReply: mockUpsertReply,
      addOptimisticThread: mockAddOptimisticThread,
      removeThread: mockRemoveThread,
      setThreads: mockSetThreads,
      updateThreadSyncStatus: mockUpdateThreadSyncStatus,
    })),
  },
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { loadThread, loadReplies, postReply, hydrateThreadsFromLocal, hydrateRepliesFromLocal, loadThreadsForGroup, createNewThread } from '../threadService';
import { saveThread as dbSaveThread, saveThreadBatch, getThreadsForConversation } from '../../database/repositories/threadRepository';
import { saveReply as dbSaveReply, saveReplyBatch, getRepliesForThread } from '../../database/repositories/replyRepository';
import { isDatabaseInitialized } from '../../database/connection';
import { getThread, getGroupThreads, getThreadReplies, createReply, createThread } from '../api/threads';
import {
  decryptContent,
  encryptContent,
  getOrFetchGroupKey,
} from '../crypto/contentCrypto';
import type { ThreadResponse, ReplyResponse, ListRepliesResponse, CreateReplyResponse, ListThreadsResponse, ThreadListItem } from '../../types/api';

const mockGetThread = getThread as jest.MockedFunction<typeof getThread>;
const mockGetGroupThreads = getGroupThreads as jest.MockedFunction<typeof getGroupThreads>;
const mockGetThreadReplies = getThreadReplies as jest.MockedFunction<typeof getThreadReplies>;
const mockCreateReply = createReply as jest.MockedFunction<typeof createReply>;
const mockCreateThread = createThread as jest.MockedFunction<typeof createThread>;
const mockDecryptContent = decryptContent as jest.MockedFunction<typeof decryptContent>;
const mockEncryptContent = encryptContent as jest.MockedFunction<typeof encryptContent>;
const mockGetOrFetchGroupKey = getOrFetchGroupKey as jest.MockedFunction<typeof getOrFetchGroupKey>;

const mockDbSaveThread = dbSaveThread as jest.MockedFunction<typeof dbSaveThread>;
const mockSaveThreadBatch = saveThreadBatch as jest.MockedFunction<typeof saveThreadBatch>;
const mockGetThreadsForConversation = getThreadsForConversation as jest.MockedFunction<typeof getThreadsForConversation>;
const mockDbSaveReply = dbSaveReply as jest.MockedFunction<typeof dbSaveReply>;
const mockSaveReplyBatch = saveReplyBatch as jest.MockedFunction<typeof saveReplyBatch>;
const mockGetRepliesForThread = getRepliesForThread as jest.MockedFunction<typeof getRepliesForThread>;
const mockIsDatabaseInitialized = isDatabaseInitialized as jest.MockedFunction<typeof isDatabaseInitialized>;

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

function makeThreadListItem(overrides: Partial<ThreadListItem> = {}): ThreadListItem {
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
    replyCount: 0,
    mediaCount: 0,
    createdAt: '2026-04-01T10:00:00Z',
    lastReplyAt: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  jest.clearAllMocks();
  mockIsDatabaseInitialized.mockReturnValue(true);
  const { useAppStore } = jest.requireMock('../../stores/useAppStore') as {
    useAppStore: { getState: jest.Mock };
  };
  useAppStore.getState.mockReturnValue({
    threads: {},
    markThreadViewed: mockMarkThreadViewed,
    upsertThread: mockUpsertThread,
    setReplies: mockSetReplies,
    appendReplies: mockAppendReplies,
    addOptimisticReply: mockAddOptimisticReply,
    updateReplySyncStatus: mockUpdateReplySyncStatus,
    removeReply: mockRemoveReply,
    upsertReply: mockUpsertReply,
    addOptimisticThread: mockAddOptimisticThread,
    removeThread: mockRemoveThread,
    setThreads: mockSetThreads,
    updateThreadSyncStatus: mockUpdateThreadSyncStatus,
  });
  mockGetOrFetchGroupKey.mockResolvedValue(fakeGroupKey);
  mockDecryptContent.mockImplementation((ciphertext: string) => {
    if (ciphertext.includes('title')) return 'Decrypted Title';
    if (ciphertext.includes('reply')) return 'Decrypted Reply Body';
    return 'Decrypted Body';
  });
  mockEncryptContent.mockReturnValue({
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
      { authorId: 'user-1', authorUsername: 'alice' },
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

    expect(mockRemoveReply).toHaveBeenCalledWith('client-uuid-000');
    expect(mockUpsertReply).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'server-reply-id', syncStatus: 'synced' }),
    );

    expect(result.syncStatus).toBe('synced');
    expect(result.id).toBe('server-reply-id');
  });

  it('sets sync status to failed when API call throws', async () => {
    mockCreateReply.mockRejectedValue(new Error('Network error'));

    await expect(
      postReply('thread-1', 'group-1', 'Hello', null, 0, { authorId: 'user-1', authorUsername: 'alice' }),
    ).rejects.toThrow('Failed to post reply');

    expect(mockAddOptimisticReply).toHaveBeenCalledTimes(1);

    expect(mockUpdateReplySyncStatus).toHaveBeenCalledWith('client-uuid-000', 'failed');
  });

  it('bumps the parent thread replyCount and lastReplyAt after a successful post (#329)', async () => {
    const { useAppStore } = jest.requireMock('../../stores/useAppStore') as {
      useAppStore: { getState: jest.Mock };
    };
    useAppStore.getState.mockReturnValue({
      threads: {
        'thread-1': {
          id: 'thread-1',
          conversationId: 'group-1',
          authorId: 'user-1',
          authorUsername: 'alice',
          title: 'T',
          body: null,
          contentType: 'text',
          pinned: false,
          replyCount: 4,
          lastReplyAt: 1000,
          createdAt: 900,
          updatedAt: 1000,
          syncStatus: 'synced',
        },
      },
      markThreadViewed: mockMarkThreadViewed,
      upsertThread: mockUpsertThread,
      setReplies: mockSetReplies,
      appendReplies: mockAppendReplies,
      addOptimisticReply: mockAddOptimisticReply,
      updateReplySyncStatus: mockUpdateReplySyncStatus,
      removeReply: mockRemoveReply,
      upsertReply: mockUpsertReply,
    });
    mockCreateReply.mockResolvedValue({
      replyId: 'server-reply-id',
      threadId: 'thread-1',
      createdAt: '2026-04-01T12:00:00Z',
      media: [],
    });

    await postReply('thread-1', 'group-1', 'Hi', null, 0, {
      authorId: 'user-1',
      authorUsername: 'alice',
    });

    expect(mockUpsertThread).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'thread-1',
        replyCount: 5,
        lastReplyAt: new Date('2026-04-01T12:00:00Z').getTime(),
      }),
    );
    expect(mockMarkThreadViewed).toHaveBeenCalledWith('thread-1');
  });

  it('does not crash when the parent thread is not in the store', async () => {
    mockCreateReply.mockResolvedValue({
      replyId: 'server-reply-id',
      threadId: 'thread-unknown',
      createdAt: '2026-04-01T12:00:00Z',
      media: [],
    });

    await expect(
      postReply('thread-unknown', 'group-1', 'Hi', null, 0, {
        authorId: 'user-1',
        authorUsername: 'alice',
      }),
    ).resolves.toBeDefined();

    expect(mockUpsertThread).not.toHaveBeenCalled();
    expect(mockMarkThreadViewed).toHaveBeenCalledWith('thread-unknown');
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
      { authorId: 'user-1', authorUsername: 'alice' },
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

// ---------------------------------------------------------------------------
// persistence write-through
// ---------------------------------------------------------------------------

describe('persistence write-through', () => {
  it('loadThread calls dbSaveThread after decrypt', async () => {
    const apiResponse = makeThreadResponse();
    mockGetThread.mockResolvedValue(apiResponse);

    await loadThread('thread-1');

    expect(mockDbSaveThread).toHaveBeenCalledTimes(1);
    const savedThread = mockDbSaveThread.mock.calls[0][0];
    expect(savedThread.id).toBe('thread-1');
    expect(savedThread.title).toBe('Decrypted Title');
    expect(savedThread.syncStatus).toBe('synced');
  });

  it('loadReplies calls saveReplyBatch with decrypted replies', async () => {
    const response: ListRepliesResponse = {
      replies: [makeReplyResponse({ replyId: 'reply-1' }), makeReplyResponse({ replyId: 'reply-2' })],
      media: [],
      totalCount: 2,
      hasMore: false,
    };
    mockGetThreadReplies.mockResolvedValue(response);

    await loadReplies('thread-1', 'group-1');

    expect(mockSaveReplyBatch).toHaveBeenCalledTimes(1);
    const [batchThreadId, batchReplies] = mockSaveReplyBatch.mock.calls[0];
    expect(batchThreadId).toBe('thread-1');
    expect(batchReplies).toHaveLength(2);
    expect(batchReplies[0].syncStatus).toBe('synced');
  });

  it('postReply calls dbSaveReply on server confirmation', async () => {
    const createResponse: CreateReplyResponse = {
      replyId: 'server-reply-id',
      threadId: 'thread-1',
      createdAt: '2026-04-01T12:00:00Z',
      media: [],
    };
    mockCreateReply.mockResolvedValue(createResponse);

    await postReply('thread-1', 'group-1', 'Hello', null, 0, { authorId: 'user-1', authorUsername: 'alice' });

    expect(mockDbSaveReply).toHaveBeenCalledTimes(1);
    const savedReply = mockDbSaveReply.mock.calls[0][0];
    expect(savedReply.id).toBe('server-reply-id');
    expect(savedReply.syncStatus).toBe('synced');
  });

  it('DB throws during loadThread, store upsert still called', async () => {
    mockDbSaveThread.mockImplementationOnce(() => { throw new Error('disk full'); });
    const apiResponse = makeThreadResponse();
    mockGetThread.mockResolvedValue(apiResponse);

    await expect(loadThread('thread-1')).resolves.toBeDefined();

    expect(mockUpsertThread).toHaveBeenCalledTimes(1);
  });

  it('DB throws during postReply, store upsert still called', async () => {
    mockDbSaveReply.mockImplementationOnce(() => { throw new Error('disk full'); });
    const createResponse: CreateReplyResponse = {
      replyId: 'server-reply-id',
      threadId: 'thread-1',
      createdAt: '2026-04-01T12:00:00Z',
      media: [],
    };
    mockCreateReply.mockResolvedValue(createResponse);

    const result = await postReply('thread-1', 'group-1', 'Hello', null, 0, { authorId: 'user-1', authorUsername: 'alice' });

    expect(result.id).toBe('server-reply-id');
    expect(mockUpsertReply).toHaveBeenCalledWith(expect.objectContaining({ id: 'server-reply-id' }));
  });

  it('isDatabaseInitialized false — DB functions not called, store still updated (loadThread)', async () => {
    mockIsDatabaseInitialized.mockReturnValueOnce(false);
    const apiResponse = makeThreadResponse();
    mockGetThread.mockResolvedValue(apiResponse);

    const result = await loadThread('thread-1');

    expect(mockDbSaveThread).not.toHaveBeenCalled();
    expect(mockUpsertThread).toHaveBeenCalledTimes(1);
    expect(result.id).toBe('thread-1');
  });

  it('isDatabaseInitialized false — DB functions not called, store still updated (loadReplies)', async () => {
    mockIsDatabaseInitialized.mockReturnValueOnce(false);
    const response: ListRepliesResponse = {
      replies: [makeReplyResponse()],
      media: [],
      totalCount: 1,
      hasMore: false,
    };
    mockGetThreadReplies.mockResolvedValue(response);

    await loadReplies('thread-1', 'group-1');

    expect(mockSaveReplyBatch).not.toHaveBeenCalled();
    expect(mockSetReplies).toHaveBeenCalledTimes(1);
  });

  it('loadThreadsForGroup calls saveThreadBatch with decrypted threads', async () => {
    const listResponse: ListThreadsResponse = {
      threads: [
        makeThreadListItem({ threadId: 'thread-1' }),
        makeThreadListItem({ threadId: 'thread-2' }),
      ],
      totalCount: 2,
      hasMore: false,
    };
    mockGetGroupThreads.mockResolvedValue(listResponse);

    await loadThreadsForGroup('group-1');

    expect(mockGetGroupThreads).toHaveBeenCalledWith('group-1');
    expect(mockSaveThreadBatch).toHaveBeenCalledTimes(1);
    const [batchGroupId, batchThreads] = mockSaveThreadBatch.mock.calls[0];
    expect(batchGroupId).toBe('group-1');
    expect(batchThreads).toHaveLength(2);
    expect(batchThreads[0].syncStatus).toBe('synced');
    expect(mockSetThreads).toHaveBeenCalledWith('group-1', expect.arrayContaining([
      expect.objectContaining({ id: 'thread-1' }),
      expect.objectContaining({ id: 'thread-2' }),
    ]));
  });

  it('createNewThread calls dbSaveThread with the server-confirmed thread', async () => {
    const createResponse = {
      threadId: 'server-thread-id',
      groupId: 'group-1',
      createdAt: '2026-04-01T10:00:00Z',
      media: [],
    };
    mockCreateThread.mockResolvedValue(createResponse);

    const result = await createNewThread(
      'group-1',
      'My Thread Title',
      'My thread body',
      { authorId: 'user-1', authorUsername: 'alice' },
    );

    expect(mockDbSaveThread).toHaveBeenCalledTimes(1);
    const savedThread = mockDbSaveThread.mock.calls[0][0];
    expect(savedThread.id).toBe('server-thread-id');
    expect(savedThread.syncStatus).toBe('synced');
    expect(savedThread.conversationId).toBe('group-1');
    expect(result.id).toBe('server-thread-id');
    expect(result.syncStatus).toBe('synced');
  });
});

// ---------------------------------------------------------------------------
// hydration
// ---------------------------------------------------------------------------

describe('hydration', () => {
  it('hydrateThreadsFromLocal calls getThreadsForConversation and populates store', () => {
    const fakeThreads = [
      {
        id: 'thread-1',
        conversationId: 'conv-1',
        authorId: 'user-1',
        authorUsername: 'alice',
        title: 'Cached thread',
        body: null,
        contentType: 'text' as const,
        pinned: false,
        replyCount: 0,
        lastReplyAt: null,
        createdAt: 1700000000000,
        updatedAt: 1700000000000,
        syncStatus: 'synced' as const,
      },
    ];
    mockGetThreadsForConversation.mockReturnValueOnce(fakeThreads);

    const mockSetThreads = jest.fn();
    const { useAppStore } = jest.requireMock('../../stores/useAppStore') as {
      useAppStore: { getState: jest.Mock };
    };
    useAppStore.getState.mockReturnValueOnce({
      threads: {},
      markThreadViewed: mockMarkThreadViewed,
      upsertThread: mockUpsertThread,
      setReplies: mockSetReplies,
      appendReplies: mockAppendReplies,
      addOptimisticReply: mockAddOptimisticReply,
      updateReplySyncStatus: mockUpdateReplySyncStatus,
      removeReply: mockRemoveReply,
      upsertReply: mockUpsertReply,
      setThreads: mockSetThreads,
    });

    hydrateThreadsFromLocal('conv-1');

    expect(mockGetThreadsForConversation).toHaveBeenCalledWith('conv-1');
    expect(mockSetThreads).toHaveBeenCalledWith('conv-1', fakeThreads);
  });

  it('hydrateThreadsFromLocal returns without store update when DB returns empty', () => {
    mockGetThreadsForConversation.mockReturnValueOnce([]);

    // Do NOT queue a getState once-value here: hydrateThreadsFromLocal guards
    // behind `threads.length > 0`, so getState() is never called on the empty
    // path.  A stale once-value left in the queue would be consumed by the
    // next test and cause localSetReplies to receive the wrong mock object.
    hydrateThreadsFromLocal('conv-1');

    expect(mockSetReplies).not.toHaveBeenCalled();
  });

  it('hydrateRepliesFromLocal calls getRepliesForThread and populates store', () => {
    const fakeReplies = [
      {
        id: 'reply-1',
        threadId: 'thread-1',
        authorId: 'user-1',
        authorUsername: 'alice',
        body: 'Cached reply',
        parentReplyId: null,
        depth: 0,
        createdAt: 1700000000000,
        updatedAt: 1700000000000,
        syncStatus: 'synced' as const,
      },
    ];
    mockGetRepliesForThread.mockReturnValueOnce(fakeReplies);

    const localSetReplies = jest.fn();
    const { useAppStore } = jest.requireMock('../../stores/useAppStore') as {
      useAppStore: { getState: jest.Mock };
    };
    useAppStore.getState.mockReturnValueOnce({
      setReplies: localSetReplies,
    });

    hydrateRepliesFromLocal('thread-1');

    expect(mockGetRepliesForThread).toHaveBeenCalledWith('thread-1');
    expect(localSetReplies).toHaveBeenCalledWith('thread-1', fakeReplies);
  });

  it('hydrateRepliesFromLocal returns without store update when DB returns empty', () => {
    mockGetRepliesForThread.mockReturnValueOnce([]);

    hydrateRepliesFromLocal('thread-1');

    expect(mockSetReplies).not.toHaveBeenCalled();
  });

  it('hydrateThreadsFromLocal swallows errors', () => {
    mockGetThreadsForConversation.mockImplementationOnce(() => { throw new Error('DB error'); });

    expect(() => hydrateThreadsFromLocal('conv-1')).not.toThrow();
  });

  it('hydrateRepliesFromLocal swallows errors', () => {
    mockGetRepliesForThread.mockImplementationOnce(() => { throw new Error('DB error'); });

    expect(() => hydrateRepliesFromLocal('thread-1')).not.toThrow();
  });

  it('hydrateThreadsFromLocal no-ops when database not initialized', () => {
    mockIsDatabaseInitialized.mockReturnValueOnce(false);

    hydrateThreadsFromLocal('conv-1');

    expect(mockGetThreadsForConversation).not.toHaveBeenCalled();
  });

  it('hydrateRepliesFromLocal no-ops when database not initialized', () => {
    mockIsDatabaseInitialized.mockReturnValueOnce(false);

    hydrateRepliesFromLocal('thread-1');

    expect(mockGetRepliesForThread).not.toHaveBeenCalled();
  });
});
