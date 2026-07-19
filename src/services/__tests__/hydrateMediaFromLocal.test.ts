/**
 * Tests for hydrateMediaFromLocal — seeds thread + per-reply indexes;
 * skips thumbnails; no-op when DB uninitialized; swallows repo throw.
 */

jest.mock('@dr.pogodin/react-native-fs', () => ({
  DocumentDirectoryPath: '/tmp/test-docs',
  exists: jest.fn(() => Promise.resolve(false)),
}));

const mockIsDatabaseInitialized = jest.fn(() => true);
jest.mock('../../database/connection', () => ({
  isDatabaseInitialized: () => mockIsDatabaseInitialized(),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockGetMediaForThread = jest.fn<any[], [string]>(() => []);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockGetMediaForThreadReplies = jest.fn<any[], [string]>(() => []);

jest.mock('../../database/repositories/mediaRepository', () => ({
  getMedia: jest.fn(),
  saveMedia: jest.fn(),
  getMediaForThread: (id: string) => mockGetMediaForThread(id),
  getMediaForThreadReplies: (id: string) => mockGetMediaForThreadReplies(id),
}));

jest.mock('../../database/repositories/threadRepository', () => ({
  getThreadsForConversation: jest.fn(() => []),
  saveThread: jest.fn(),
  saveThreadBatch: jest.fn(),
}));

jest.mock('../../database/repositories/replyRepository', () => ({
  getRepliesForThread: jest.fn(() => []),
  saveReply: jest.fn(),
  saveReplyBatch: jest.fn(),
}));

const mockMergeMediaBatch = jest.fn();
jest.mock('../../stores/useAppStore', () => ({
  useAppStore: {
    getState: jest.fn(() => ({
      media: {},
      setThreads: jest.fn(),
      setReplies: jest.fn(),
      mergeMediaBatch: mockMergeMediaBatch,
      mergeMediaForThread: jest.fn(),
      mergeMediaForReply: jest.fn(),
      upsertMedia: jest.fn(),
      upsertThread: jest.fn(),
      addOptimisticReply: jest.fn(),
      updateReplySyncStatus: jest.fn(),
      removeReply: jest.fn(),
      upsertReply: jest.fn(),
    })),
  },
}));

jest.mock('../api/threads', () => ({
  getThread: jest.fn(),
  getGroupThreads: jest.fn(),
  getThreadReplies: jest.fn(),
  createReply: jest.fn(),
  createThread: jest.fn(),
}));

jest.mock('../crypto/contentCrypto', () => ({
  decryptContent: jest.fn(),
  encryptContent: jest.fn(),
  getOrFetchGroupKey: jest.fn(),
}));

jest.mock('../crypto/utils', () => ({
  base64ToArrayBuffer: jest.fn(() => new ArrayBuffer(64)),
}));

import { hydrateMediaFromLocal } from '../threadService';
import type { MediaRow } from '../../database/repositories/mediaRepository';

function makeRow(overrides: Partial<MediaRow> = {}): MediaRow {
  return {
    id: 'media-1',
    thread_id: 'thread-1',
    reply_id: null,
    message_id: null,
    content_type: 'image/jpeg',
    file_name: 'photo.jpg',
    file_size: 1024,
    width: 640, height: 480,
    duration: null,
    attachment_key: new Uint8Array(64),
    attachment_digest: new Uint8Array(32),
    cdn_number: null, cdn_key: null,
    local_path: 'media/photo.jpg',
    thumbnail_path: null,
    blur_hash: null,
    expires_at: null,
    download_state: 'downloaded',
    upload_state: 'done',
    created_at: Date.now(),
    is_thumbnail: 0,
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockIsDatabaseInitialized.mockReturnValue(true);
  mockGetMediaForThread.mockReturnValue([]);
  mockGetMediaForThreadReplies.mockReturnValue([]);
  mockMergeMediaBatch.mockClear();
});

describe('hydrateMediaFromLocal', () => {
  it('seeds thread-level media into mergeMediaBatch', () => {
    mockGetMediaForThread.mockReturnValue([makeRow({ id: 'img-1' })]);

    hydrateMediaFromLocal('thread-1');

    expect(mockMergeMediaBatch).toHaveBeenCalledTimes(1);
    const batchArg: Map<string, { type: string; items: unknown[] }> = mockMergeMediaBatch.mock.calls[0][0];
    expect(batchArg.get('thread-1')?.type).toBe('thread');
    expect(batchArg.get('thread-1')?.items).toHaveLength(1);
  });

  it('seeds per-reply media grouped by reply_id', () => {
    mockGetMediaForThreadReplies.mockReturnValue([
      makeRow({ id: 'r1-img', reply_id: 'reply-1' }),
      makeRow({ id: 'r2-img', reply_id: 'reply-2' }),
    ]);

    hydrateMediaFromLocal('thread-1');

    const batchArg: Map<string, { type: string; items: unknown[] }> = mockMergeMediaBatch.mock.calls[0][0];
    expect(batchArg.get('reply-1')?.type).toBe('reply');
    expect(batchArg.get('reply-1')?.items).toHaveLength(1);
    expect(batchArg.get('reply-2')?.type).toBe('reply');
    expect(batchArg.get('reply-2')?.items).toHaveLength(1);
  });

  it('skips thumbnails', () => {
    mockGetMediaForThread.mockReturnValue([
      makeRow({ id: 'thumb', is_thumbnail: 1 }),
      makeRow({ id: 'normal', is_thumbnail: 0 }),
    ]);

    hydrateMediaFromLocal('thread-1');

    const batchArg: Map<string, { type: string; items: Array<{ id: string }> }> = mockMergeMediaBatch.mock.calls[0][0];
    const threadItems = batchArg.get('thread-1')?.items ?? [];
    expect(threadItems).toHaveLength(1);
    expect(threadItems[0].id).toBe('normal');
  });

  it('no-op when DB is not initialized', () => {
    mockIsDatabaseInitialized.mockReturnValue(false);
    hydrateMediaFromLocal('thread-1');
    expect(mockGetMediaForThread).not.toHaveBeenCalled();
    expect(mockMergeMediaBatch).not.toHaveBeenCalled();
  });

  it('swallows repo throw without propagating', () => {
    mockGetMediaForThread.mockImplementation(() => { throw new Error('DB busy'); });
    // Should not throw
    expect(() => hydrateMediaFromLocal('thread-1')).not.toThrow();
  });

  it('no-op (no mergeMediaBatch call) when no media found', () => {
    hydrateMediaFromLocal('thread-1');
    expect(mockMergeMediaBatch).not.toHaveBeenCalled();
  });
});
