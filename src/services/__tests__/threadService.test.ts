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
  deleteReply: jest.fn(),
}));

jest.mock('../../database/connection', () => ({
  isDatabaseInitialized: jest.fn(() => true),
}));

// Only the surface threadService imports. The real module would need a live
// DB handle (connection is mocked above), so nothing here may hit SQLite.
jest.mock('../../database/repositories/mediaRepository', () => ({
  getMedia: jest.fn(() => null),
  saveMedia: jest.fn(),
  getThreadLevelMedia: jest.fn(() => []),
  getMediaForReply: jest.fn(() => []),
  getMediaForThreadReplies: jest.fn(() => []),
  updateMediaParent: jest.fn(),
}));

jest.mock('../media/mediaTeardown', () => ({
  teardownLocalMedia: jest.fn(() => Promise.resolve()),
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
const mockReplaceReply = jest.fn();
const mockReconcileReplies = jest.fn(() => [] as string[]);
const mockAddOptimisticThread = jest.fn();
const mockRemoveThread = jest.fn();
const mockSetThreads = jest.fn();
const mockUpdateThreadSyncStatus = jest.fn();
const mockBumpLastMessageAt = jest.fn();

jest.mock('../../stores/useAppStore', () => ({
  useAppStore: {
    getState: jest.fn(() => ({
      threads: {},
      replies: {},
      replyIdsByThread: {},
      markThreadViewed: mockMarkThreadViewed,
      upsertThread: mockUpsertThread,
      setReplies: mockSetReplies,
      appendReplies: mockAppendReplies,
      addOptimisticReply: mockAddOptimisticReply,
      updateReplySyncStatus: mockUpdateReplySyncStatus,
      removeReply: mockRemoveReply,
      upsertReply: mockUpsertReply,
      replaceReply: mockReplaceReply,
      reconcileReplies: mockReconcileReplies,
      addOptimisticThread: mockAddOptimisticThread,
      removeThread: mockRemoveThread,
      setThreads: mockSetThreads,
      updateThreadSyncStatus: mockUpdateThreadSyncStatus,
      bumpLastMessageAt: mockBumpLastMessageAt,
      // #906 review: the request-ordering token the recency reconcile reads.
      blockedUsersGeneration: 0,
      // #908: the slices deriveBlockedDmPeer reads on every send. It tolerates
      // missing ones by returning null, so they are supplied explicitly here
      // (and per-test below) rather than relied on to be absent.
      conversations: {},
      contacts: {},
      blockedUserIds: [],
      blockedUserProfiles: {},
    })),
  },
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { loadThread, loadReplies, postReply, hydrateThreadsFromLocal, hydrateRepliesFromLocal, loadThreadsForGroup, createNewThread, reconcileThreadReplies, applyReplyToParentThread, getKnownThreadAuthorId } from '../threadService';
import { saveThread as dbSaveThread, saveThreadBatch, getThreadsForConversation, getThread as dbGetThread } from '../../database/repositories/threadRepository';
import { saveReply as dbSaveReply, saveReplyBatch, getRepliesForThread, deleteReply as dbDeleteReply } from '../../database/repositories/replyRepository';
import { isDatabaseInitialized } from '../../database/connection';
import { getMedia, getMediaForReply } from '../../database/repositories/mediaRepository';
import { teardownLocalMedia } from '../media/mediaTeardown';
import { ServerError } from '../api/errors';
import { PendingWrapError } from '../crypto/contentCrypto';
import { getThread, getGroupThreads, getThreadReplies, createReply, createThread } from '../api/threads';
import {
  decryptContent,
  encryptContent,
  getOrFetchGroupKey,
} from '../crypto/contentCrypto';
import type { ThreadResponse, ReplyResponse, ListRepliesResponse, CreateReplyResponse, CreateThreadResponse, ListThreadsResponse, ThreadListItem } from '../../types/api';
import type { Thread, Conversation, Contact } from '../../types/store';

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
const mockDbGetThread = dbGetThread as jest.MockedFunction<typeof dbGetThread>;
const mockDbSaveReply = dbSaveReply as jest.MockedFunction<typeof dbSaveReply>;
const mockSaveReplyBatch = saveReplyBatch as jest.MockedFunction<typeof saveReplyBatch>;
const mockGetRepliesForThread = getRepliesForThread as jest.MockedFunction<typeof getRepliesForThread>;
const mockDbDeleteReply = dbDeleteReply as jest.MockedFunction<typeof dbDeleteReply>;
const mockGetMediaForReply = getMediaForReply as jest.MockedFunction<typeof getMediaForReply>;
const mockGetMedia = getMedia as jest.MockedFunction<typeof getMedia>;
const mockTeardownLocalMedia = teardownLocalMedia as jest.MockedFunction<typeof teardownLocalMedia>;
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
  mockReconcileReplies.mockReset();
  mockReconcileReplies.mockReturnValue([]);
  useAppStore.getState.mockReturnValue({
    threads: {},
    replies: {},
    replyIdsByThread: {},
    markThreadViewed: mockMarkThreadViewed,
    upsertThread: mockUpsertThread,
    setReplies: mockSetReplies,
    appendReplies: mockAppendReplies,
    addOptimisticReply: mockAddOptimisticReply,
    updateReplySyncStatus: mockUpdateReplySyncStatus,
    removeReply: mockRemoveReply,
    upsertReply: mockUpsertReply,
    replaceReply: mockReplaceReply,
    reconcileReplies: mockReconcileReplies,
    addOptimisticThread: mockAddOptimisticThread,
    removeThread: mockRemoveThread,
    setThreads: mockSetThreads,
    updateThreadSyncStatus: mockUpdateThreadSyncStatus,
    bumpLastMessageAt: mockBumpLastMessageAt,
    // #908: see the factory mock above — the blocked-DM-peer derivation slices.
    conversations: {},
    contacts: {},
    blockedUserIds: [],
    blockedUserProfiles: {},
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
  it('fetches replies, decrypts, and ALWAYS appends — even for the first page (#821)', async () => {
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

    // Page 1 no longer calls setReplies — appendReplies is the only path (#821)
    expect(mockAppendReplies).toHaveBeenCalledTimes(1);
    expect(mockSetReplies).not.toHaveBeenCalled();

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

  it('returns rawCount and raw serverIds, including a reply that fails to decrypt', async () => {
    mockDecryptContent.mockImplementation((ciphertext: string) => {
      if (ciphertext === 'enc-reply-bad') {
        throw new Error('decrypt failed');
      }
      if (ciphertext.includes('reply')) return 'Decrypted Reply Body';
      return 'Decrypted Body';
    });
    const response: ListRepliesResponse = {
      replies: [
        makeReplyResponse({ replyId: 'reply-good' }),
        makeReplyResponse({ replyId: 'reply-bad', encryptedBody: 'enc-reply-bad' }),
      ],
      media: [],
      totalCount: 2,
      hasMore: false,
    };
    mockGetThreadReplies.mockResolvedValue(response);

    const result = await loadReplies('thread-1', 'group-1');

    // rawCount counts ALL server rows, decrypted or not
    expect(result.rawCount).toBe(2);
    // serverIds is raw, in response order, including the decrypt failure
    expect(result.serverIds).toEqual(['reply-good', 'reply-bad']);
    // The failed row never makes it into the decrypted replies
    expect(result.replies.map((r) => r.id)).toEqual(['reply-good']);
    expect(result.replies.find((r) => r.id === 'reply-bad')).toBeUndefined();
  });

  it('newIdCount is 0 when the page only re-returns ids already in the store', async () => {
    const { useAppStore } = jest.requireMock('../../stores/useAppStore') as {
      useAppStore: { getState: jest.Mock };
    };
    useAppStore.getState.mockReturnValue({
      threads: {},
      replies: {},
      replyIdsByThread: { 'thread-1': ['reply-1', 'reply-2'] },
      markThreadViewed: mockMarkThreadViewed,
      upsertThread: mockUpsertThread,
      setReplies: mockSetReplies,
      appendReplies: mockAppendReplies,
      addOptimisticReply: mockAddOptimisticReply,
      updateReplySyncStatus: mockUpdateReplySyncStatus,
      removeReply: mockRemoveReply,
      upsertReply: mockUpsertReply,
      replaceReply: mockReplaceReply,
      reconcileReplies: mockReconcileReplies,
      bumpLastMessageAt: mockBumpLastMessageAt,
    });
    const response: ListRepliesResponse = {
      replies: [makeReplyResponse({ replyId: 'reply-1' }), makeReplyResponse({ replyId: 'reply-2' })],
      media: [],
      totalCount: 2,
      hasMore: false,
    };
    mockGetThreadReplies.mockResolvedValue(response);

    const result = await loadReplies('thread-1', 'group-1');

    expect(result.newIdCount).toBe(0);
  });

  it('newIdCount counts only decrypted rows not already known to the store', async () => {
    const { useAppStore } = jest.requireMock('../../stores/useAppStore') as {
      useAppStore: { getState: jest.Mock };
    };
    useAppStore.getState.mockReturnValue({
      threads: {},
      replies: {},
      replyIdsByThread: { 'thread-1': ['reply-1'] },
      markThreadViewed: mockMarkThreadViewed,
      upsertThread: mockUpsertThread,
      setReplies: mockSetReplies,
      appendReplies: mockAppendReplies,
      addOptimisticReply: mockAddOptimisticReply,
      updateReplySyncStatus: mockUpdateReplySyncStatus,
      removeReply: mockRemoveReply,
      upsertReply: mockUpsertReply,
      replaceReply: mockReplaceReply,
      reconcileReplies: mockReconcileReplies,
      bumpLastMessageAt: mockBumpLastMessageAt,
    });
    const response: ListRepliesResponse = {
      replies: [makeReplyResponse({ replyId: 'reply-1' }), makeReplyResponse({ replyId: 'reply-2' })],
      media: [],
      totalCount: 2,
      hasMore: false,
    };
    mockGetThreadReplies.mockResolvedValue(response);

    const result = await loadReplies('thread-1', 'group-1');

    expect(result.newIdCount).toBe(1);
  });

  it('throws on a malformed 200 instead of reading it as an empty thread', async () => {
    // An empty `replies` array from a broken response would end the pass with
    // an empty keep-set and hand every loaded reply to the reconcile.
    mockGetThreadReplies.mockResolvedValue({
      media: [],
      totalCount: 0,
      hasMore: false,
    } as unknown as ListRepliesResponse);

    await expect(loadReplies('thread-1', 'group-1')).rejects.toThrow(/malformed/i);
    expect(mockAppendReplies).not.toHaveBeenCalled();
  });

  it('throws when hasMore is not a boolean', async () => {
    mockGetThreadReplies.mockResolvedValue({
      replies: [],
      media: [],
      totalCount: 0,
    } as unknown as ListRepliesResponse);

    await expect(loadReplies('thread-1', 'group-1')).rejects.toThrow(/malformed/i);
    expect(mockAppendReplies).not.toHaveBeenCalled();
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
// reconcileThreadReplies
// ---------------------------------------------------------------------------

describe('reconcileThreadReplies', () => {
  it('removes dropped ids from the store and calls deleteReply for each', () => {
    mockReconcileReplies.mockReturnValue(['dropped-1', 'dropped-2']);

    const dropped = reconcileThreadReplies('thread-1', ['keep-1'], ['keep-1', 'dropped-1', 'dropped-2']);

    expect(mockReconcileReplies).toHaveBeenCalledWith(
      'thread-1',
      ['keep-1'],
      ['keep-1', 'dropped-1', 'dropped-2'],
    );
    expect(dropped).toEqual(['dropped-1', 'dropped-2']);
    expect(mockDbDeleteReply).toHaveBeenCalledTimes(2);
    expect(mockDbDeleteReply).toHaveBeenCalledWith('dropped-1');
    expect(mockDbDeleteReply).toHaveBeenCalledWith('dropped-2');
  });

  it('never deletes a decrypt-failed id that is in the keep set (store never drops it)', () => {
    // A decrypt-failed id is still a raw serverId, so it is passed in keepIds
    // and the store's reconcileReplies never drops it — deleteReply is never
    // called for it.
    mockReconcileReplies.mockReturnValue([]);

    const dropped = reconcileThreadReplies(
      'thread-1',
      ['decrypt-failed-id', 'keep-2'],
      ['decrypt-failed-id', 'keep-2'],
    );

    expect(dropped).toEqual([]);
    expect(mockDbDeleteReply).not.toHaveBeenCalled();
  });

  it('never deletes a pending row (store keeps it, so it is never in the dropped list)', () => {
    // reconcileReplies (the store action) already excludes pending rows from
    // what it drops; the service simply deletes whatever the store reports.
    mockReconcileReplies.mockReturnValue([]);

    const dropped = reconcileThreadReplies('thread-1', [], ['pending-1']);

    expect(dropped).toEqual([]);
    expect(mockDbDeleteReply).not.toHaveBeenCalled();
  });

  it('does not touch the DB when nothing drops', () => {
    mockReconcileReplies.mockReturnValue([]);

    reconcileThreadReplies('thread-1', ['a', 'b'], ['a', 'b']);

    expect(mockDbDeleteReply).not.toHaveBeenCalled();
  });

  it('tears down the local media of every pruned reply, thumbnail child included', async () => {
    mockReconcileReplies.mockReturnValue(['dropped-1']);
    mockGetMediaForReply.mockReturnValue([
      {
        id: 'media-1',
        local_path: 'file:///whatever/media/media-1.jpg',
        thumbnail_media_id: 'thumb-1',
      },
    ] as unknown as ReturnType<typeof getMediaForReply>);
    mockGetMedia.mockReturnValue({
      id: 'thumb-1',
      local_path: 'file:///whatever/media/thumb-1.jpg',
    } as unknown as ReturnType<typeof getMedia>);

    reconcileThreadReplies('thread-1', [], ['dropped-1']);
    // Teardown is detached (async, best-effort) — flush the microtask queue.
    await new Promise((resolve) => setImmediate(resolve));

    expect(mockGetMediaForReply).toHaveBeenCalledWith('dropped-1');
    expect(mockTeardownLocalMedia).toHaveBeenCalledWith('media-1', expect.stringContaining('media-1.jpg'));
    expect(mockTeardownLocalMedia).toHaveBeenCalledWith('thumb-1', expect.stringContaining('thumb-1.jpg'));
  });

  it('does not tear down media when nothing was pruned', async () => {
    mockReconcileReplies.mockReturnValue([]);

    reconcileThreadReplies('thread-1', ['a'], ['a']);
    await new Promise((resolve) => setImmediate(resolve));

    expect(mockGetMediaForReply).not.toHaveBeenCalled();
    expect(mockTeardownLocalMedia).not.toHaveBeenCalled();
  });

  it('skips DB deletes when the database is not initialized', () => {
    mockIsDatabaseInitialized.mockReturnValue(false);
    mockReconcileReplies.mockReturnValue(['dropped-1']);

    const dropped = reconcileThreadReplies('thread-1', [], ['dropped-1']);

    expect(dropped).toEqual(['dropped-1']);
    expect(mockDbDeleteReply).not.toHaveBeenCalled();
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

    // #821: ONE atomic swap via replaceReply, not removeReply + upsertReply
    expect(mockReplaceReply).toHaveBeenCalledTimes(1);
    expect(mockReplaceReply).toHaveBeenCalledWith(
      'client-uuid-000',
      expect.objectContaining({ id: 'server-reply-id', syncStatus: 'synced' }),
    );
    expect(mockRemoveReply).not.toHaveBeenCalled();
    expect(mockUpsertReply).not.toHaveBeenCalled();

    expect(result.syncStatus).toBe('synced');
    expect(result.id).toBe('server-reply-id');
  });

  it('removes the optimistic row and rethrows the ORIGINAL error on failure (#749/#747)', async () => {
    // The rethrow must be the same object: uploadTelemetry reads `instanceof
    // ApiError` off it for the status / api_code tags, which a rewrapped
    // `new Error('Failed to post reply')` erased.
    const err = new ServerError(500);
    mockCreateReply.mockRejectedValue(err);

    await expect(
      postReply('thread-1', 'group-1', 'Hello', null, 0, { authorId: 'user-1', authorUsername: 'alice' }),
    ).rejects.toBe(err);

    expect(mockAddOptimisticReply).toHaveBeenCalledTimes(1);

    // #749: failure path removes the optimistic row rather than marking it 'failed'
    expect(mockRemoveReply).toHaveBeenCalledTimes(1);
    expect(mockRemoveReply).toHaveBeenCalledWith('client-uuid-000');
    // upsertReply only fires on the success path — never reached when createReply rejects
    expect(mockUpsertReply).not.toHaveBeenCalled();
    // updateReplySyncStatus has no production caller after #749
    expect(mockUpdateReplySyncStatus).not.toHaveBeenCalled();
  });

  it('removes the optimistic row and rethrows a PendingWrapError from the key fetch (#749/#747)', async () => {
    const err = new PendingWrapError();
    mockGetOrFetchGroupKey.mockRejectedValue(err);

    await expect(
      postReply('thread-1', 'group-1', 'Hello', null, 0, { authorId: 'user-1', authorUsername: 'alice' }),
    ).rejects.toBe(err);

    // addOptimisticReply fires before the try block, so the row exists and must be removed
    expect(mockAddOptimisticReply).toHaveBeenCalledTimes(1);
    expect(mockRemoveReply).toHaveBeenCalledTimes(1);
    expect(mockRemoveReply).toHaveBeenCalledWith('client-uuid-000');
    expect(mockUpdateReplySyncStatus).not.toHaveBeenCalled();
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
      replies: {},
      replyIdsByThread: {},
      markThreadViewed: mockMarkThreadViewed,
      upsertThread: mockUpsertThread,
      setReplies: mockSetReplies,
      appendReplies: mockAppendReplies,
      addOptimisticReply: mockAddOptimisticReply,
      updateReplySyncStatus: mockUpdateReplySyncStatus,
      removeReply: mockRemoveReply,
      upsertReply: mockUpsertReply,
      replaceReply: mockReplaceReply,
      reconcileReplies: mockReconcileReplies,
      bumpLastMessageAt: mockBumpLastMessageAt,
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

  it('clamps the optimistic createdAt past the newest sibling when Date.now() is older (#821)', async () => {
    const { useAppStore } = jest.requireMock('../../stores/useAppStore') as {
      useAppStore: { getState: jest.Mock };
    };
    useAppStore.getState.mockReturnValue({
      threads: {},
      replies: {
        'sib-1': {
          id: 'sib-1',
          threadId: 'thread-1',
          parentReplyId: null,
          createdAt: 5_000,
        },
        // A different parent — must NOT count as a sibling
        'other-parent-1': {
          id: 'other-parent-1',
          threadId: 'thread-1',
          parentReplyId: 'some-other-parent',
          createdAt: 9_000,
        },
      },
      replyIdsByThread: { 'thread-1': ['sib-1', 'other-parent-1'] },
      markThreadViewed: mockMarkThreadViewed,
      upsertThread: mockUpsertThread,
      setReplies: mockSetReplies,
      appendReplies: mockAppendReplies,
      addOptimisticReply: mockAddOptimisticReply,
      updateReplySyncStatus: mockUpdateReplySyncStatus,
      removeReply: mockRemoveReply,
      upsertReply: mockUpsertReply,
      replaceReply: mockReplaceReply,
      reconcileReplies: mockReconcileReplies,
      bumpLastMessageAt: mockBumpLastMessageAt,
    });

    const dateNowSpy = jest.spyOn(Date, 'now').mockReturnValue(1_000);
    try {
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

      const optimistic = mockAddOptimisticReply.mock.calls[0][0];
      // newestSiblingCreatedAt (same threadId + parentReplyId=null) is 5000,
      // NOT 9000 (that row has a different parent) — clamp is 5000 + 1, not
      // Date.now()'s 1000.
      expect(optimistic.createdAt).toBe(5_001);
      expect(optimistic.updatedAt).toBe(5_001);
    } finally {
      dateNowSpy.mockRestore();
    }
  });

  it('uses Date.now() when it is newer than the newest sibling', async () => {
    const { useAppStore } = jest.requireMock('../../stores/useAppStore') as {
      useAppStore: { getState: jest.Mock };
    };
    useAppStore.getState.mockReturnValue({
      threads: {},
      replies: {
        'sib-1': {
          id: 'sib-1',
          threadId: 'thread-1',
          parentReplyId: null,
          createdAt: 1_000,
        },
      },
      replyIdsByThread: { 'thread-1': ['sib-1'] },
      markThreadViewed: mockMarkThreadViewed,
      upsertThread: mockUpsertThread,
      setReplies: mockSetReplies,
      appendReplies: mockAppendReplies,
      addOptimisticReply: mockAddOptimisticReply,
      updateReplySyncStatus: mockUpdateReplySyncStatus,
      removeReply: mockRemoveReply,
      upsertReply: mockUpsertReply,
      replaceReply: mockReplaceReply,
      reconcileReplies: mockReconcileReplies,
      bumpLastMessageAt: mockBumpLastMessageAt,
    });

    const dateNowSpy = jest.spyOn(Date, 'now').mockReturnValue(50_000);
    try {
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

      const optimistic = mockAddOptimisticReply.mock.calls[0][0];
      expect(optimistic.createdAt).toBe(50_000);
    } finally {
      dateNowSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// createNewThread failure
// ---------------------------------------------------------------------------

describe('createNewThread', () => {
  it('removes the optimistic row and rethrows the ORIGINAL error on failure (#749/#747)', async () => {
    const err = new ServerError(500);
    mockCreateThread.mockRejectedValue(err);

    await expect(
      createNewThread('group-1', 'My Thread Title', 'My thread body', {
        authorId: 'user-1',
        authorUsername: 'alice',
      }),
    ).rejects.toBe(err);

    expect(mockAddOptimisticThread).toHaveBeenCalledTimes(1);
    // #749: failure path removes the optimistic row rather than marking it 'failed'
    expect(mockRemoveThread).toHaveBeenCalledTimes(1);
    expect(mockRemoveThread).toHaveBeenCalledWith('client-uuid-000');
    // upsertThread only fires on the success path — never reached when createThread rejects
    expect(mockUpsertThread).not.toHaveBeenCalled();
    // updateThreadSyncStatus has no production caller after #749
    expect(mockUpdateThreadSyncStatus).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// contentType derivation (camera-icon fix)
// ---------------------------------------------------------------------------

describe('contentType derivation', () => {
  it('mapThreadListItem: mediaCount > 0 yields contentType "media"', async () => {
    const listResponse: ListThreadsResponse = {
      threads: [makeThreadListItem({ threadId: 'thread-media', mediaCount: 2 })],
      totalCount: 1,
      hasMore: false,
    };
    mockGetGroupThreads.mockResolvedValue(listResponse);

    const threads = await loadThreadsForGroup('group-1');

    expect(threads[0].contentType).toBe('media');
  });

  it('mapThreadListItem: mediaCount 0 yields contentType "text"', async () => {
    const listResponse: ListThreadsResponse = {
      threads: [makeThreadListItem({ threadId: 'thread-text', mediaCount: 0 })],
      totalCount: 1,
      hasMore: false,
    };
    mockGetGroupThreads.mockResolvedValue(listResponse);

    const threads = await loadThreadsForGroup('group-1');

    expect(threads[0].contentType).toBe('text');
  });

  it('mapThreadResponse/loadThread: non-empty media array yields contentType "media"', async () => {
    const apiResponse = makeThreadResponse({
      threadId: 'thread-with-media',
      media: [
        {
          mediaId: 'media-1',
          encryptedMetadata: null,
          sizeBytes: 1024,
          uploadedAt: '2026-04-01T10:00:00Z',
          expiresAt: null,
          contentType: 'image/jpeg',
          fileName: 'photo.jpg',
          blurHash: undefined,
          width: 100,
          height: 100,
          duration: undefined,
        },
      ],
    });
    mockGetThread.mockResolvedValue(apiResponse);

    const result = await loadThread('thread-with-media');

    expect(result.contentType).toBe('media');
  });

  it('mapThreadResponse/loadThread: empty media array yields contentType "text"', async () => {
    const apiResponse = makeThreadResponse({
      threadId: 'thread-no-media',
      media: [],
    });
    mockGetThread.mockResolvedValue(apiResponse);

    const result = await loadThread('thread-no-media');

    expect(result.contentType).toBe('text');
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
    expect(mockReplaceReply).toHaveBeenCalledWith(
      'client-uuid-000',
      expect.objectContaining({ id: 'server-reply-id' }),
    );
  });

  it('isDatabaseInitialized false — DB functions not called, store still updated (loadThread)', async () => {
    // mockReturnValue, not ...Once: loadThread now asks twice — once for the
    // #883 recency fallback read, once for the write-through.
    mockIsDatabaseInitialized.mockReturnValue(false);
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
    expect(mockAppendReplies).toHaveBeenCalledTimes(1);
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

    expect(mockGetGroupThreads).toHaveBeenCalledWith('group-1', { sort: 'activity_desc' });
    expect(mockSaveThreadBatch).toHaveBeenCalledTimes(1);
    const [batchGroupId, batchThreads] = mockSaveThreadBatch.mock.calls[0];
    expect(batchGroupId).toBe('group-1');
    expect(batchThreads).toHaveLength(2);
    expect(batchThreads[0].syncStatus).toBe('synced');
    expect(mockSetThreads).toHaveBeenCalledWith(
      'group-1',
      expect.arrayContaining([
        expect.objectContaining({ id: 'thread-1' }),
        expect.objectContaining({ id: 'thread-2' }),
      ]),
      // The service reconciles recency itself (#897), so the slice must not
      // re-apply its never-lower merge on top of the decision.
      { authoritativeRecency: true },
    );
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

  it('createNewThread persists contentType "media" when the server response carries media', async () => {
    const createResponse = {
      threadId: 'server-thread-media',
      groupId: 'group-1',
      createdAt: '2026-04-01T10:00:00Z',
      media: [{ mediaId: 'media-1' }],
    } as unknown as CreateThreadResponse;
    mockCreateThread.mockResolvedValue(createResponse);

    const result = await createNewThread(
      'group-1',
      'Media Thread',
      'body',
      { authorId: 'user-1', authorUsername: 'alice' },
      { mediaIds: ['media-1'] },
    );

    expect(result.contentType).toBe('media');
    const savedThread = mockDbSaveThread.mock.calls[0][0];
    expect(savedThread.contentType).toBe('media');
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

// ---------------------------------------------------------------------------
// #883 — activity recency never goes backwards
// ---------------------------------------------------------------------------

function makeStoredThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: 'thread-1',
    conversationId: 'group-1',
    authorId: 'user-1',
    authorUsername: 'alice',
    title: 'T',
    body: null,
    contentType: 'text',
    pinned: false,
    replyCount: 1,
    lastReplyAt: null,
    createdAt: 900,
    updatedAt: 900,
    syncStatus: 'synced',
    ...overrides,
  };
}

function setStoreThreads(threads: Record<string, Thread>): void {
  const { useAppStore } = jest.requireMock('../../stores/useAppStore') as {
    useAppStore: { getState: jest.Mock };
  };
  const current = useAppStore.getState();
  useAppStore.getState.mockReturnValue({ ...current, threads });
}

/** Simulate a block/unblock landing: the generation token moves (#906 review). */
function setStoreBlockedGeneration(generation: number): void {
  const { useAppStore } = jest.requireMock('../../stores/useAppStore') as {
    useAppStore: { getState: jest.Mock };
  };
  const current = useAppStore.getState();
  useAppStore.getState.mockReturnValue({ ...current, blockedUsersGeneration: generation });
}

describe('#883 loadThread recency merge', () => {
  it('keeps the store lastReplyAt when the server OMITS the field', async () => {
    setStoreThreads({ 'thread-1': makeStoredThread({ lastReplyAt: 5000 }) });
    // `makeThreadResponse` omits lastReplyAt entirely — a 1.7.6-era backend.
    // Absent is NOT the same as null (#897): there is no server answer to be
    // authoritative about, so the never-lower merge still rules.
    mockGetThread.mockResolvedValue(makeThreadResponse());

    const result = await loadThread('thread-1');

    expect(result.lastReplyAt).toBe(5000);
    expect(mockDbSaveThread.mock.calls[0][0].lastReplyAt).toBe(5000);
    expect(mockUpsertThread.mock.calls[0][0].lastReplyAt).toBe(5000);
    // The decision was made here, so the slice is told not to merge again.
    expect(mockUpsertThread.mock.calls[0][1]).toEqual({ authoritativeRecency: true });
  });

  it('takes an explicit null lastReplyAt, lowering the stored value (#897)', async () => {
    // `last_reply_at: null` means "no reply counts for THIS viewer" since
    // Backend #306 — blocking the author of the only reply produces exactly
    // this response, and it has to clear the activity slot everywhere.
    setStoreThreads({ 'thread-1': makeStoredThread({ lastReplyAt: 5000 }) });
    mockGetThread.mockResolvedValue(makeThreadResponse({ lastReplyAt: null }));

    const result = await loadThread('thread-1');

    expect(result.lastReplyAt).toBeNull();
    expect(mockDbSaveThread.mock.calls[0][0].lastReplyAt).toBeNull();
    expect(mockUpsertThread.mock.calls[0][0].lastReplyAt).toBeNull();
    expect(mockUpsertThread.mock.calls[0][1]).toEqual({ authoritativeRecency: true });
  });

  it('takes the server lastReplyAt when it is newer than the store value', async () => {
    setStoreThreads({ 'thread-1': makeStoredThread({ lastReplyAt: 1000 }) });
    mockGetThread.mockResolvedValue(
      makeThreadResponse({ lastReplyAt: '2026-04-01T12:00:00Z' }),
    );

    const result = await loadThread('thread-1');

    expect(result.lastReplyAt).toBe(new Date('2026-04-01T12:00:00Z').getTime());
  });

  it('falls back to the SQLite row when the store is empty (cold push open)', async () => {
    mockDbGetThread.mockReturnValueOnce(makeStoredThread({ lastReplyAt: 7000 }));
    // Field omitted: the legacy never-lower path, now against the disk row.
    mockGetThread.mockResolvedValue(makeThreadResponse());

    const result = await loadThread('thread-1');

    expect(mockDbGetThread).toHaveBeenCalledWith('thread-1');
    expect(result.lastReplyAt).toBe(7000);
    // The DB write must carry the merged value — dbSaveThread runs before the
    // store upsert, so it has no slice-level guard behind it.
    expect(mockDbSaveThread.mock.calls[0][0].lastReplyAt).toBe(7000);
  });

  it('lets an explicit null lower a value that exists only on disk (#897)', async () => {
    // A DB-only row can never carry a mid-request bump (the WS path upserts
    // the store before it persists), so the server value wins outright.
    mockDbGetThread.mockReturnValueOnce(makeStoredThread({ lastReplyAt: 7000 }));
    mockGetThread.mockResolvedValue(makeThreadResponse({ lastReplyAt: null }));

    const result = await loadThread('thread-1');

    expect(result.lastReplyAt).toBeNull();
    expect(mockDbSaveThread.mock.calls[0][0].lastReplyAt).toBeNull();
    expect(mockUpsertThread.mock.calls[0][0].lastReplyAt).toBeNull();
  });

  it('does not read SQLite when the database is not initialized', async () => {
    mockIsDatabaseInitialized.mockReturnValue(false);
    mockGetThread.mockResolvedValue(makeThreadResponse({ lastReplyAt: null }));

    const result = await loadThread('thread-1');

    expect(mockDbGetThread).not.toHaveBeenCalled();
    expect(result.lastReplyAt).toBeNull();
  });

  it('still resolves when the SQLite read throws', async () => {
    mockDbGetThread.mockImplementationOnce(() => {
      throw new Error('DB error');
    });
    mockGetThread.mockResolvedValue(
      makeThreadResponse({ lastReplyAt: '2026-04-01T12:00:00Z' }),
    );

    const result = await loadThread('thread-1');

    expect(result.lastReplyAt).toBe(new Date('2026-04-01T12:00:00Z').getTime());
    expect(mockUpsertThread).toHaveBeenCalledTimes(1);
  });

  it('maps an unparseable server lastReplyAt to null, never NaN', async () => {
    mockGetThread.mockResolvedValue(makeThreadResponse({ lastReplyAt: 'not-a-date' }));

    const result = await loadThread('thread-1');

    expect(result.lastReplyAt).toBeNull();
  });
});

describe('#883 loadThreadsForGroup', () => {
  it('requests the activity_desc sort', async () => {
    mockGetGroupThreads.mockResolvedValue({
      threads: [makeThreadListItem()],
      totalCount: 1,
      hasMore: false,
    });

    await loadThreadsForGroup('group-1');

    expect(mockGetGroupThreads).toHaveBeenCalledWith('group-1', {
      sort: 'activity_desc',
    });
  });

  it('maps an unparseable list lastReplyAt to null, never NaN', async () => {
    mockGetGroupThreads.mockResolvedValue({
      threads: [makeThreadListItem({ lastReplyAt: 'garbage' })],
      totalCount: 1,
      hasMore: false,
    });

    const threads = await loadThreadsForGroup('group-1');

    expect(threads[0].lastReplyAt).toBeNull();
  });

  it('keeps a reply applied DURING the request, lastReplyAt and replyCount together', async () => {
    // thread-1 is at 1000/4 when the request goes out; a WS reply bumps the
    // store row to 9000/5 while it is in flight, and the response (computed
    // before that reply) carries null/0. Only the pre-request snapshot can
    // tell this apart from a per-viewer lowering (#897) — and the pair has to
    // move together, or the slot and the count disagree. saveThreadBatch is
    // INSERT OR REPLACE, so the live pair must reach SQLite too.
    setStoreThreads({
      'thread-1': makeStoredThread({ lastReplyAt: 1000, replyCount: 4 }),
    });
    mockGetGroupThreads.mockImplementationOnce(async () => {
      setStoreThreads({
        'thread-1': makeStoredThread({ lastReplyAt: 9000, replyCount: 5 }),
      });
      return {
        threads: [makeThreadListItem({ lastReplyAt: null, replyCount: 0 })],
        totalCount: 1,
        hasMore: false,
      };
    });

    const threads = await loadThreadsForGroup('group-1');

    expect(threads[0].lastReplyAt).toBe(9000);
    expect(threads[0].replyCount).toBe(5);
    const [, batchThreads] = mockSaveThreadBatch.mock.calls[0];
    expect(batchThreads[0].lastReplyAt).toBe(9000);
    expect(batchThreads[0].replyCount).toBe(5);
    expect(mockSetThreads).toHaveBeenCalledWith(
      'group-1',
      [expect.objectContaining({ lastReplyAt: 9000, replyCount: 5 })],
      { authoritativeRecency: true },
    );
  });

  it('falls back to the SQLite row for the batch merge when the field is omitted', async () => {
    mockDbGetThread.mockReturnValueOnce(makeStoredThread({ lastReplyAt: 7000 }));
    mockGetGroupThreads.mockResolvedValue({
      // Explicitly omitted: the fixture default is `null`, which is now an
      // authoritative "no counted reply" rather than "not sent" (#897).
      threads: [makeThreadListItem({ lastReplyAt: undefined })],
      totalCount: 1,
      hasMore: false,
    });

    await loadThreadsForGroup('group-1');

    const [, batchThreads] = mockSaveThreadBatch.mock.calls[0];
    expect(batchThreads[0].lastReplyAt).toBe(7000);
  });

  it('lets an explicit null lower a batch value that exists only on disk (#897)', async () => {
    mockDbGetThread.mockReturnValueOnce(makeStoredThread({ lastReplyAt: 7000 }));
    mockGetGroupThreads.mockResolvedValue({
      threads: [makeThreadListItem({ lastReplyAt: null })],
      totalCount: 1,
      hasMore: false,
    });

    await loadThreadsForGroup('group-1');

    const [, batchThreads] = mockSaveThreadBatch.mock.calls[0];
    expect(batchThreads[0].lastReplyAt).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// #897 — a per-viewer server value may LOWER the stored recency
// ---------------------------------------------------------------------------

describe('#897 loadThreadsForGroup authoritative recency', () => {
  it('stores the server null over a higher local value when nothing moved mid-request', async () => {
    // THE ISSUE: blocking the member whose reply lifted thread-1 drops that
    // reply from this viewer's last_reply_at/reply_count (Backend #306). The
    // old unconditional max-merge pinned the thread at 9000 forever while the
    // count fell to 0, so the activity slot and the badge disagreed.
    setStoreThreads({
      'thread-1': makeStoredThread({ lastReplyAt: 9000, replyCount: 5 }),
    });
    mockGetGroupThreads.mockResolvedValue({
      threads: [makeThreadListItem({ lastReplyAt: null, replyCount: 0 })],
      totalCount: 1,
      hasMore: false,
    });

    const threads = await loadThreadsForGroup('group-1');

    expect(threads[0].lastReplyAt).toBeNull();
    expect(threads[0].replyCount).toBe(0);
    const [, batchThreads] = mockSaveThreadBatch.mock.calls[0];
    expect(batchThreads[0].lastReplyAt).toBeNull();
    expect(batchThreads[0].replyCount).toBe(0);
    expect(mockSetThreads).toHaveBeenCalledWith(
      'group-1',
      [expect.objectContaining({ lastReplyAt: null, replyCount: 0 })],
      { authoritativeRecency: true },
    );
  });

  it('stores an OLDER server timestamp over a higher local value', async () => {
    // Same lowering, one surviving reply: the slot moves back to that reply.
    const older = Date.parse('2026-04-01T11:00:00Z');
    setStoreThreads({
      'thread-1': makeStoredThread({
        lastReplyAt: Date.parse('2026-04-05T10:00:00Z'),
        replyCount: 5,
      }),
    });
    mockGetGroupThreads.mockResolvedValue({
      threads: [
        makeThreadListItem({ lastReplyAt: '2026-04-01T11:00:00Z', replyCount: 3 }),
      ],
      totalCount: 1,
      hasMore: false,
    });

    const threads = await loadThreadsForGroup('group-1');

    expect(threads[0].lastReplyAt).toBe(older);
    expect(threads[0].replyCount).toBe(3);
    const [, batchThreads] = mockSaveThreadBatch.mock.calls[0];
    expect(batchThreads[0].lastReplyAt).toBe(older);
    expect(batchThreads[0].replyCount).toBe(3);
    expect(mockSetThreads).toHaveBeenCalledWith(
      'group-1',
      [expect.objectContaining({ lastReplyAt: older, replyCount: 3 })],
      { authoritativeRecency: true },
    );
  });

  it('degrades to the never-lower merge for a mapped row the raw payload does not key', async () => {
    // `serverSentById` is keyed off the RAW payload by id, never positionally,
    // and the lookup is `=== true` — a mapped row with no entry has no server
    // answer and must take the legacy path. The mapper is identity on the id
    // today, so the only way to produce such a row is to make the raw item
    // report a different id for the map build than for the mapping.
    setStoreThreads({ 'thread-1': makeStoredThread({ lastReplyAt: 9000 }) });
    const item = makeThreadListItem({ lastReplyAt: null });
    let idReads = 0;
    Object.defineProperty(item, 'threadId', {
      get: () => (idReads++ === 0 ? 'thread-ghost' : 'thread-1'),
    });
    mockGetGroupThreads.mockResolvedValue({
      threads: [item],
      totalCount: 1,
      hasMore: false,
    });

    const threads = await loadThreadsForGroup('group-1');

    expect(threads[0].id).toBe('thread-1');
    expect(threads[0].lastReplyAt).toBe(9000);
    const [, batchThreads] = mockSaveThreadBatch.mock.calls[0];
    expect(batchThreads[0].lastReplyAt).toBe(9000);
  });
});

// ---------------------------------------------------------------------------
// #906 review — a block landing MID-REQUEST makes the response unusable
// ---------------------------------------------------------------------------

describe('#906 blocked-set generation guard', () => {
  it('keeps the live row when the blocked set changed during loadThreadsForGroup', async () => {
    // The response left the server BEFORE the block, so its per-viewer values
    // are pre-block and must not be written authoritatively. Nothing moved in
    // the store, so only the generation token can tell.
    setStoreThreads({
      'thread-1': makeStoredThread({ lastReplyAt: 9000, replyCount: 5 }),
    });
    mockGetGroupThreads.mockImplementationOnce(async () => {
      setStoreBlockedGeneration(1);
      return {
        threads: [makeThreadListItem({ lastReplyAt: null, replyCount: 0 })],
        totalCount: 1,
        hasMore: false,
      };
    });

    const threads = await loadThreadsForGroup('group-1');

    expect(threads[0].lastReplyAt).toBe(9000);
    expect(threads[0].replyCount).toBe(5);
    const [, batchThreads] = mockSaveThreadBatch.mock.calls[0];
    expect(batchThreads[0].lastReplyAt).toBe(9000);
    expect(batchThreads[0].replyCount).toBe(5);
    expect(mockSetThreads).toHaveBeenCalledWith(
      'group-1',
      [expect.objectContaining({ lastReplyAt: 9000, replyCount: 5 })],
      { authoritativeRecency: true },
    );
  });

  it('falls back to the never-lower merge when the generation changed and there is no live row', async () => {
    // Nothing live to keep, so the disk row is protected by the legacy path
    // and the refresh that bumped the generation supplies the real values.
    mockDbGetThread.mockReturnValueOnce(makeStoredThread({ lastReplyAt: 7000 }));
    mockGetGroupThreads.mockImplementationOnce(async () => {
      setStoreBlockedGeneration(1);
      return {
        threads: [makeThreadListItem({ lastReplyAt: null, replyCount: 0 })],
        totalCount: 1,
        hasMore: false,
      };
    });

    await loadThreadsForGroup('group-1');

    const [, batchThreads] = mockSaveThreadBatch.mock.calls[0];
    expect(batchThreads[0].lastReplyAt).toBe(7000);
  });

  it('keeps the live row when the blocked set changed during loadThread', async () => {
    setStoreThreads({
      'thread-1': makeStoredThread({ lastReplyAt: 9000, replyCount: 5 }),
    });
    mockGetThread.mockImplementationOnce(async () => {
      setStoreBlockedGeneration(1);
      return makeThreadResponse({ lastReplyAt: null, replyCount: 0 });
    });

    const result = await loadThread('thread-1');

    expect(result.lastReplyAt).toBe(9000);
    expect(result.replyCount).toBe(5);
    expect(mockDbSaveThread.mock.calls[0][0].lastReplyAt).toBe(9000);
    expect(mockDbSaveThread.mock.calls[0][0].replyCount).toBe(5);
    expect(mockUpsertThread.mock.calls[0][0].lastReplyAt).toBe(9000);
    expect(mockUpsertThread.mock.calls[0][0].replyCount).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// #906 review — the mid-request bump keeps the HIGHER replyCount
// ---------------------------------------------------------------------------

describe('#906 mid-request bump replyCount', () => {
  it('keeps a bump that starts from a null snapshot recency', async () => {
    // The QA shape: the thread had no counted reply at all when the request
    // went out, and the first reply landed while it was in flight. An invalid
    // (null) snapshot value still reads as "moved forward".
    setStoreThreads({
      'thread-1': makeStoredThread({ lastReplyAt: null, replyCount: 0 }),
    });
    mockGetGroupThreads.mockImplementationOnce(async () => {
      setStoreThreads({
        'thread-1': makeStoredThread({ lastReplyAt: 9000, replyCount: 1 }),
      });
      return {
        threads: [makeThreadListItem({ lastReplyAt: null, replyCount: 0 })],
        totalCount: 1,
        hasMore: false,
      };
    });

    const threads = await loadThreadsForGroup('group-1');

    expect(threads[0].lastReplyAt).toBe(9000);
    expect(threads[0].replyCount).toBe(1);
    const [, batchThreads] = mockSaveThreadBatch.mock.calls[0];
    expect(batchThreads[0].lastReplyAt).toBe(9000);
    expect(batchThreads[0].replyCount).toBe(1);
  });

  it('takes the SERVER count when it is higher than the single local bump', async () => {
    // The local bump is +1; the server may already count more replies than
    // this device ever saw, so the pair takes the higher of the two.
    setStoreThreads({
      'thread-1': makeStoredThread({ lastReplyAt: 1000, replyCount: 4 }),
    });
    mockGetGroupThreads.mockImplementationOnce(async () => {
      setStoreThreads({
        'thread-1': makeStoredThread({ lastReplyAt: 9000, replyCount: 5 }),
      });
      return {
        threads: [makeThreadListItem({ lastReplyAt: null, replyCount: 9 })],
        totalCount: 1,
        hasMore: false,
      };
    });

    const threads = await loadThreadsForGroup('group-1');

    expect(threads[0].lastReplyAt).toBe(9000);
    expect(threads[0].replyCount).toBe(9);
  });
});

// ---------------------------------------------------------------------------
// #897 — getKnownThreadAuthorId (the WS new_reply block guard's lookup)
// ---------------------------------------------------------------------------

describe('#897 getKnownThreadAuthorId', () => {
  it('reads the author from the store without touching SQLite', () => {
    setStoreThreads({ 'thread-1': makeStoredThread({ authorId: 'user-store' }) });

    expect(getKnownThreadAuthorId('thread-1')).toBe('user-store');
    expect(mockDbGetThread).not.toHaveBeenCalled();
  });

  it('falls back to the SQLite row when the store has no such thread', () => {
    mockDbGetThread.mockReturnValueOnce(
      makeStoredThread({ id: 'thread-2', authorId: 'user-disk' }),
    );

    expect(getKnownThreadAuthorId('thread-2')).toBe('user-disk');
    expect(mockDbGetThread).toHaveBeenCalledWith('thread-2');
  });

  it('returns null when neither the store nor SQLite knows the thread', () => {
    // `null` is "unknown here", and the WS guard fails OPEN on it.
    expect(getKnownThreadAuthorId('thread-missing')).toBeNull();
    expect(mockDbGetThread).toHaveBeenCalledWith('thread-missing');
  });

  it('returns null without reading SQLite when the database is not initialized', () => {
    mockIsDatabaseInitialized.mockReturnValue(false);

    expect(getKnownThreadAuthorId('thread-1')).toBeNull();
    expect(mockDbGetThread).not.toHaveBeenCalled();
  });
});

describe('#883 applyReplyToParentThread', () => {
  it('upserts the parent with replyCount+1 and the max lastReplyAt, persists it, and bumps the conversation', () => {
    setStoreThreads({
      'thread-1': makeStoredThread({ replyCount: 4, lastReplyAt: 1000 }),
    });

    applyReplyToParentThread('group-1', 'thread-1', 2000);

    expect(mockUpsertThread).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'thread-1', replyCount: 5, lastReplyAt: 2000 }),
    );
    expect(mockDbSaveThread).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'thread-1', lastReplyAt: 2000 }),
    );
    expect(mockBumpLastMessageAt).toHaveBeenCalledWith('group-1', 2000);
  });

  it('never lowers lastReplyAt with an older reply timestamp', () => {
    setStoreThreads({ 'thread-1': makeStoredThread({ lastReplyAt: 9000 }) });

    applyReplyToParentThread('group-1', 'thread-1', 2000);

    expect(mockUpsertThread).toHaveBeenCalledWith(
      expect.objectContaining({ lastReplyAt: 9000 }),
    );
  });

  it('resolves the parent from SQLite when it is not in the store', () => {
    mockDbGetThread.mockReturnValueOnce(
      makeStoredThread({ id: 'thread-2', replyCount: 2, lastReplyAt: 100 }),
    );

    applyReplyToParentThread('group-1', 'thread-2', 3000);

    expect(mockUpsertThread).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'thread-2', replyCount: 3, lastReplyAt: 3000 }),
    );
    expect(mockBumpLastMessageAt).toHaveBeenCalledWith('group-1', 3000);
  });

  it('still bumps the conversation when the parent is nowhere to be found', () => {
    applyReplyToParentThread('group-1', 'thread-missing', 3000);

    expect(mockUpsertThread).not.toHaveBeenCalled();
    expect(mockDbSaveThread).not.toHaveBeenCalled();
    expect(mockBumpLastMessageAt).toHaveBeenCalledWith('group-1', 3000);
  });

  it('is a complete no-op for an unparseable reply timestamp', () => {
    setStoreThreads({ 'thread-1': makeStoredThread({ lastReplyAt: 1000 }) });

    applyReplyToParentThread('group-1', 'thread-1', NaN);
    applyReplyToParentThread('group-1', 'thread-1', Infinity);

    expect(mockUpsertThread).not.toHaveBeenCalled();
    expect(mockDbSaveThread).not.toHaveBeenCalled();
    expect(mockBumpLastMessageAt).not.toHaveBeenCalled();
  });
});

describe('#883 createNewThread conversation bump', () => {
  it('bumps lastMessageAt with the SERVER createdAt on success', async () => {
    const createdAt = '2026-04-02T09:30:00Z';
    mockCreateThread.mockResolvedValue({
      threadId: 'server-thread-id',
      groupId: 'group-1',
      createdAt,
      media: [],
    } as CreateThreadResponse);

    await createNewThread('group-1', 'Title', 'Body', {
      authorId: 'user-1',
      authorUsername: 'alice',
    });

    expect(mockBumpLastMessageAt).toHaveBeenCalledWith(
      'group-1',
      new Date(createdAt).getTime(),
    );
  });

  it('does not bump when the post fails', async () => {
    mockCreateThread.mockRejectedValue(new ServerError(500));

    await expect(
      createNewThread('group-1', 'Title', 'Body', {
        authorId: 'user-1',
        authorUsername: 'alice',
      }),
    ).rejects.toBeDefined();

    expect(mockBumpLastMessageAt).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// #908 blocked-DM-peer send refusal
// ---------------------------------------------------------------------------

describe('#908 blocked DM peer refuses the send', () => {
  function seedStore(state: {
    conversations?: Record<string, Conversation>;
    contacts?: Record<string, Contact>;
    blockedUserIds?: string[];
  }): void {
    const { useAppStore } = jest.requireMock('../../stores/useAppStore') as {
      useAppStore: { getState: jest.Mock };
    };
    useAppStore.getState.mockReturnValue({
      threads: {},
      replies: {},
      replyIdsByThread: {},
      markThreadViewed: mockMarkThreadViewed,
      upsertThread: mockUpsertThread,
      setReplies: mockSetReplies,
      appendReplies: mockAppendReplies,
      addOptimisticReply: mockAddOptimisticReply,
      updateReplySyncStatus: mockUpdateReplySyncStatus,
      removeReply: mockRemoveReply,
      upsertReply: mockUpsertReply,
      replaceReply: mockReplaceReply,
      reconcileReplies: mockReconcileReplies,
      addOptimisticThread: mockAddOptimisticThread,
      removeThread: mockRemoveThread,
      setThreads: mockSetThreads,
      updateThreadSyncStatus: mockUpdateThreadSyncStatus,
      bumpLastMessageAt: mockBumpLastMessageAt,
      blockedUsersGeneration: 0,
      conversations: state.conversations ?? {},
      contacts: state.contacts ?? {},
      blockedUserIds: state.blockedUserIds ?? [],
      blockedUserProfiles: {},
    });
  }

  function makeDmRow(overrides: Partial<Conversation> = {}): Conversation {
    return {
      id: 'dm-1',
      type: 'direct',
      name: 'bob',
      memberCount: 2,
      active: true,
      lastMessageAt: 1000,
      unreadCount: 0,
      lastReadAt: null,
      createdAt: 900,
      updatedAt: 1000,
      peerUserId: 'user-2',
      ...overrides,
    };
  }

  function makeContact(overrides: Partial<Contact> = {}): Contact {
    return {
      id: 'user-2',
      username: 'bob',
      displayName: null,
      avatarPath: null,
      conversationIds: ['dm-1'],
      ...overrides,
    };
  }

  /** Nothing may have been encrypted, enqueued or sent. */
  function expectNoSendSideEffects(): void {
    expect(mockGetOrFetchGroupKey).not.toHaveBeenCalled();
    expect(mockEncryptContent).not.toHaveBeenCalled();
    expect(mockBumpLastMessageAt).not.toHaveBeenCalled();
  }

  it('createNewThread rejects with BlockedRecipientError (peer from peerUserId)', async () => {
    seedStore({ conversations: { 'dm-1': makeDmRow() }, blockedUserIds: ['user-2'] });

    // `name`, not `instanceof`: the suites that factory-mock this service can
    // leave the error class undefined.
    await expect(
      createNewThread('dm-1', 'Title', 'Body', {
        authorId: 'user-1',
        authorUsername: 'alice',
      }),
    ).rejects.toMatchObject({
      name: 'BlockedRecipientError',
      recipientId: 'user-2',
      message: 'You blocked this person.',
    });

    // The refusal is the FIRST statement: no network call and — because it is
    // ahead of addOptimisticThread — no row to roll back either.
    expect(mockCreateThread).not.toHaveBeenCalled();
    expect(mockAddOptimisticThread).not.toHaveBeenCalled();
    expect(mockRemoveThread).not.toHaveBeenCalled();
    expectNoSendSideEffects();
  });

  it('postReply rejects with BlockedRecipientError (peer from peerUserId)', async () => {
    seedStore({ conversations: { 'dm-1': makeDmRow() }, blockedUserIds: ['user-2'] });

    await expect(
      postReply('thread-1', 'dm-1', 'Hello', null, 0, {
        authorId: 'user-1',
        authorUsername: 'alice',
      }),
    ).rejects.toMatchObject({
      name: 'BlockedRecipientError',
      recipientId: 'user-2',
    });

    expect(mockCreateReply).not.toHaveBeenCalled();
    expect(mockAddOptimisticReply).not.toHaveBeenCalled();
    expect(mockRemoveReply).not.toHaveBeenCalled();
    expectNoSendSideEffects();
  });

  it('resolves the peer from the contact fallback when the row predates #908', async () => {
    // A DM row persisted before peerUserId existed: the contact reverse-scan
    // is the only way to the peer, and the send must still be refused.
    const { peerUserId: _legacy, ...legacyRow } = makeDmRow();
    seedStore({
      conversations: { 'dm-1': legacyRow },
      contacts: { 'user-2': makeContact() },
      blockedUserIds: ['user-2'],
    });

    await expect(
      postReply('thread-1', 'dm-1', 'Hello', null, 0, {
        authorId: 'user-1',
        authorUsername: 'alice',
      }),
    ).rejects.toMatchObject({
      name: 'BlockedRecipientError',
      recipientId: 'user-2',
    });

    expect(mockCreateReply).not.toHaveBeenCalled();
    expect(mockAddOptimisticReply).not.toHaveBeenCalled();
  });

  it('createNewThread into an ORBIT proceeds even when a member is blocked', async () => {
    // An orbit id is never reverse-looked-up to a member: posting to a forum
    // the blocked person happens to be in is not a send to them.
    seedStore({
      conversations: {
        'group-1': makeDmRow({ id: 'group-1', type: 'group', name: 'Family', peerUserId: undefined }),
      },
      contacts: { 'user-2': makeContact({ conversationIds: ['group-1'] }) },
      blockedUserIds: ['user-2'],
    });
    mockCreateThread.mockResolvedValue({
      threadId: 'server-thread-id',
      groupId: 'group-1',
      createdAt: '2026-04-02T09:30:00Z',
      media: [],
    } as CreateThreadResponse);

    await expect(
      createNewThread('group-1', 'Title', 'Body', {
        authorId: 'user-1',
        authorUsername: 'alice',
      }),
    ).resolves.toMatchObject({ id: 'server-thread-id' });

    expect(mockAddOptimisticThread).toHaveBeenCalledTimes(1);
    expect(mockCreateThread).toHaveBeenCalledTimes(1);
  });

  it('postReply into a DM whose peer is NOT blocked proceeds', async () => {
    seedStore({
      conversations: { 'dm-1': makeDmRow() },
      contacts: { 'user-2': makeContact() },
      blockedUserIds: ['someone-else'],
    });
    mockCreateReply.mockResolvedValue({
      replyId: 'server-reply-id',
      threadId: 'thread-1',
      createdAt: '2026-04-01T12:00:00Z',
      media: [],
    } as CreateReplyResponse);

    await expect(
      postReply('thread-1', 'dm-1', 'Hello', null, 0, {
        authorId: 'user-1',
        authorUsername: 'alice',
      }),
    ).resolves.toMatchObject({ id: 'server-reply-id' });

    expect(mockAddOptimisticReply).toHaveBeenCalledTimes(1);
    expect(mockCreateReply).toHaveBeenCalledTimes(1);
  });

  it('createNewThread into a DM whose peer is NOT blocked proceeds', async () => {
    seedStore({ conversations: { 'dm-1': makeDmRow() }, blockedUserIds: [] });
    mockCreateThread.mockResolvedValue({
      threadId: 'server-thread-id',
      groupId: 'dm-1',
      createdAt: '2026-04-02T09:30:00Z',
      media: [],
    } as CreateThreadResponse);

    await expect(
      createNewThread('dm-1', 'Title', 'Body', {
        authorId: 'user-1',
        authorUsername: 'alice',
      }),
    ).resolves.toMatchObject({ id: 'server-thread-id' });

    expect(mockCreateThread).toHaveBeenCalledTimes(1);
  });
});
