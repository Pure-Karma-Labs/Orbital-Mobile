/**
 * Tests for processMediaMetadata — the media pipeline in threadService.
 *
 * Covers: empty input early-return, existing-row path (mediaRowToItem),
 * new item path with/without encryptedMetadata, decryption retry on failure,
 * per-item resilience, threadId vs replyId parentRef routing.
 */

// ---------------------------------------------------------------------------
// Module mocks — must be declared before imports
// ---------------------------------------------------------------------------

const mockGetMedia = jest.fn();
const mockSaveMedia = jest.fn();

jest.mock('../../database/repositories/mediaRepository', () => ({
  getMedia: (...args: unknown[]) => mockGetMedia(...args),
  saveMedia: (...args: unknown[]) => mockSaveMedia(...args),
}));

const mockDecryptContent = jest.fn();
const mockGetOrFetchGroupKey = jest.fn();
const mockInvalidateGroupKey = jest.fn();

jest.mock('../crypto/contentCrypto', () => ({
  decryptContent: (...args: unknown[]) => mockDecryptContent(...args),
  encryptContent: jest.fn(),
  getOrFetchGroupKey: (...args: unknown[]) => mockGetOrFetchGroupKey(...args),
  invalidateGroupKey: (...args: unknown[]) => mockInvalidateGroupKey(...args),
}));

const mockSetMediaForThread = jest.fn();
const mockSetMediaForReply = jest.fn();

jest.mock('../../stores/useAppStore', () => ({
  useAppStore: {
    getState: jest.fn(() => ({
      setMediaForThread: mockSetMediaForThread,
      setMediaForReply: mockSetMediaForReply,
      upsertThread: jest.fn(),
      setReplies: jest.fn(),
      appendReplies: jest.fn(),
      addOptimisticReply: jest.fn(),
      updateReplySyncStatus: jest.fn(),
      removeReply: jest.fn(),
      upsertReply: jest.fn(),
    })),
  },
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { processMediaMetadata } from '../threadService';
import type { MediaMetadata } from '../../types/api';
import type { MediaRow } from '../../database/repositories/mediaRepository';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const fakeGroupKey = new Uint8Array(32).fill(0xab);
const fakeGroupId = 'group-1';

function makeMediaMetadata(overrides: Partial<MediaMetadata> = {}): MediaMetadata {
  return {
    mediaId: 'media-uuid-1',
    encryptedMetadata: null,
    sizeBytes: 2048,
    uploadedAt: '2026-04-01T10:00:00Z',
    expiresAt: '2026-05-01T10:00:00Z',
    contentType: 'image/jpeg',
    fileName: 'photo.jpg',
    blurHash: 'LKO2?U%2Tw=w]~RBVZRi};RPxuwH',
    width: 640,
    height: 480,
    duration: undefined,
    ...overrides,
  };
}

function makeMediaRow(overrides: Partial<MediaRow> = {}): MediaRow {
  return {
    id: 'media-uuid-1',
    thread_id: 'thread-1',
    reply_id: null,
    message_id: null,
    content_type: 'image/jpeg',
    file_name: 'photo.jpg',
    file_size: 2048,
    width: 640,
    height: 480,
    duration: null,
    attachment_key: null,
    attachment_digest: null,
    cdn_number: null,
    cdn_key: null,
    local_path: null,
    thumbnail_path: null,
    download_state: 'pending',
    upload_state: 'done',
    created_at: 1743494400000,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  jest.clearAllMocks();
  mockGetMedia.mockReturnValue(null); // Default: no existing row
  mockGetOrFetchGroupKey.mockResolvedValue(fakeGroupKey);
});

// ---------------------------------------------------------------------------
// Empty / null input — early return
// ---------------------------------------------------------------------------

describe('processMediaMetadata — empty input', () => {
  it('returns early and does not call store actions for empty array', async () => {
    await processMediaMetadata([], fakeGroupKey, fakeGroupId, { threadId: 'thread-1' });

    expect(mockGetMedia).not.toHaveBeenCalled();
    expect(mockSetMediaForThread).not.toHaveBeenCalled();
    expect(mockSetMediaForReply).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Existing DB row path (mediaRowToItem)
// ---------------------------------------------------------------------------

describe('processMediaMetadata — existing row in DB', () => {
  it('uses mediaRowToItem and skips saveMedia when row already exists', async () => {
    const row = makeMediaRow({ id: 'media-uuid-1', attachment_key: 'some-key' });
    mockGetMedia.mockReturnValue(row);

    await processMediaMetadata(
      [makeMediaMetadata({ mediaId: 'media-uuid-1' })],
      fakeGroupKey,
      fakeGroupId,
      { threadId: 'thread-1' },
    );

    expect(mockSaveMedia).not.toHaveBeenCalled();
    expect(mockSetMediaForThread).toHaveBeenCalledTimes(1);

    const items = mockSetMediaForThread.mock.calls[0][1];
    expect(items).toHaveLength(1);
    // hasKeys derived from attachment_key presence
    expect(items[0].hasKeys).toBe(true);
    expect(items[0].id).toBe('media-uuid-1');
  });

  it('maps all MediaRow fields to MediaItem correctly', async () => {
    const row = makeMediaRow({
      id: 'media-uuid-1',
      content_type: 'video/mp4',
      file_name: 'clip.mp4',
      file_size: 5000,
      width: 1920,
      height: 1080,
      duration: 30,
      local_path: '/cache/clip.mp4',
      thumbnail_path: '/cache/clip-thumb.jpg',
      download_state: 'downloaded',
      upload_state: 'done',
      attachment_key: null,
    });
    mockGetMedia.mockReturnValue(row);

    await processMediaMetadata(
      [makeMediaMetadata({ mediaId: 'media-uuid-1', contentType: 'video/mp4' })],
      fakeGroupKey,
      fakeGroupId,
      { threadId: 'thread-1' },
    );

    const items = mockSetMediaForThread.mock.calls[0][1];
    const item = items[0];
    expect(item.contentType).toBe('video/mp4');
    expect(item.fileName).toBe('clip.mp4');
    expect(item.fileSize).toBe(5000);
    expect(item.width).toBe(1920);
    expect(item.height).toBe(1080);
    expect(item.duration).toBe(30);
    expect(item.localPath).toBe('/cache/clip.mp4');
    expect(item.thumbnailPath).toBe('/cache/clip-thumb.jpg');
    expect(item.downloadState).toBe('downloaded');
    expect(item.hasKeys).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// New item — without encryptedMetadata
// ---------------------------------------------------------------------------

describe('processMediaMetadata — new item without encryptedMetadata', () => {
  it('saves to DB and store with plain API fields', async () => {
    const meta = makeMediaMetadata({
      mediaId: 'media-uuid-2',
      encryptedMetadata: null,
      contentType: 'image/png',
      fileName: 'image.png',
    });

    await processMediaMetadata([meta], fakeGroupKey, fakeGroupId, { threadId: 'thread-1' });

    expect(mockSaveMedia).toHaveBeenCalledTimes(1);
    const savedRow = mockSaveMedia.mock.calls[0][0];
    expect(savedRow.content_type).toBe('image/png');
    expect(savedRow.file_name).toBe('image.png');
    expect(savedRow.attachment_key).toBeNull();
    expect(savedRow.download_state).toBe('pending');
    expect(savedRow.upload_state).toBe('done');

    expect(mockSetMediaForThread).toHaveBeenCalledTimes(1);
    const items = mockSetMediaForThread.mock.calls[0][1];
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe('media-uuid-2');
    expect(items[0].hasKeys).toBe(false);
    expect(items[0].downloadState).toBe('pending');
    expect(items[0].uploadState).toBe('done');
  });

  it('uses fallback contentType when API field is absent', async () => {
    const meta = makeMediaMetadata({
      mediaId: 'media-uuid-3',
      encryptedMetadata: null,
      contentType: undefined,
      fileName: undefined,
    });

    await processMediaMetadata([meta], fakeGroupKey, fakeGroupId, { threadId: 'thread-1' });

    const savedRow = mockSaveMedia.mock.calls[0][0];
    expect(savedRow.content_type).toBe('application/octet-stream');
    expect(savedRow.file_name).toBeNull();
  });

  it('converts uploadedAt and expiresAt ISO strings to timestamps', async () => {
    const meta = makeMediaMetadata({
      mediaId: 'media-uuid-4',
      uploadedAt: '2026-04-01T10:00:00Z',
      expiresAt: '2026-05-01T10:00:00Z',
    });

    await processMediaMetadata([meta], fakeGroupKey, fakeGroupId, { threadId: 'thread-1' });

    const items = mockSetMediaForThread.mock.calls[0][1];
    expect(items[0].expiresAt).toBe(new Date('2026-05-01T10:00:00Z').getTime());
  });

  it('handles null expiresAt without throwing', async () => {
    const meta = makeMediaMetadata({ mediaId: 'media-uuid-5', expiresAt: null });

    await processMediaMetadata([meta], fakeGroupKey, fakeGroupId, { threadId: 'thread-1' });

    const items = mockSetMediaForThread.mock.calls[0][1];
    expect(items[0].expiresAt).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// New item — with encryptedMetadata (happy path)
// ---------------------------------------------------------------------------

describe('processMediaMetadata — new item with encryptedMetadata (happy path)', () => {
  it('decrypts metadata and extracts contentType, fileName, dimensions', async () => {
    const innerPayload = JSON.stringify({
      contentType: 'image/webp',
      fileName: 'decrypted.webp',
      width: 800,
      height: 600,
      digest: 'abc123digest',
    });
    mockDecryptContent.mockReturnValue(innerPayload);

    const envelope = JSON.stringify({ ciphertext: 'enc-ct', iv: 'enc-iv' });
    const meta = makeMediaMetadata({
      mediaId: 'media-uuid-6',
      encryptedMetadata: envelope,
      contentType: 'application/octet-stream',
      fileName: 'fallback.bin',
    });

    await processMediaMetadata([meta], fakeGroupKey, fakeGroupId, { threadId: 'thread-1' });

    expect(mockDecryptContent).toHaveBeenCalledWith('enc-ct', 'enc-iv', fakeGroupKey, fakeGroupId);

    const items = mockSetMediaForThread.mock.calls[0][1];
    const item = items[0];
    expect(item.contentType).toBe('image/webp');
    expect(item.fileName).toBe('decrypted.webp');
    expect(item.width).toBe(800);
    expect(item.height).toBe(600);

    const savedRow = mockSaveMedia.mock.calls[0][0];
    expect(savedRow.attachment_digest).toBe('abc123digest');
  });
});

// ---------------------------------------------------------------------------
// New item — with encryptedMetadata (retry path)
// ---------------------------------------------------------------------------

describe('processMediaMetadata — encryptedMetadata decryption retry', () => {
  it('retries with fresh key when first decryptMediaMetadataEnvelope returns null', async () => {
    // decryptMediaMetadataEnvelope returns null when JSON.parse(plainJson) is null.
    // That happens when decryptContent returns the JSON string 'null'.
    // On the retry, decryptContent returns a valid payload.
    const innerPayload = JSON.stringify({ contentType: 'image/gif', fileName: 'retry.gif' });
    mockDecryptContent
      .mockReturnValueOnce('null')        // first attempt: JSON.parse('null') === null
      .mockReturnValueOnce(innerPayload); // retry: valid payload

    const envelope = JSON.stringify({ ciphertext: 'enc-ct', iv: 'enc-iv' });
    const meta = makeMediaMetadata({
      mediaId: 'media-uuid-7',
      encryptedMetadata: envelope,
    });
    const freshKey = new Uint8Array(32).fill(0xcc);
    mockGetOrFetchGroupKey.mockResolvedValue(freshKey);

    await processMediaMetadata([meta], fakeGroupKey, fakeGroupId, { threadId: 'thread-1' });

    // invalidateGroupKey should be called with the groupId
    expect(mockInvalidateGroupKey).toHaveBeenCalledWith(fakeGroupId);
    // getOrFetchGroupKey called to get the fresh key
    expect(mockGetOrFetchGroupKey).toHaveBeenCalledWith(fakeGroupId);
    // Second decryptContent call uses the fresh key
    expect(mockDecryptContent).toHaveBeenCalledTimes(2);
    expect(mockDecryptContent).toHaveBeenNthCalledWith(2, 'enc-ct', 'enc-iv', freshKey, fakeGroupId);

    const items = mockSetMediaForThread.mock.calls[0][1];
    expect(items[0].contentType).toBe('image/gif');
  });

  it('falls back to API fields when both decrypt attempts return null', async () => {
    // Both attempts return 'null' so decryptMediaMetadataEnvelope returns null twice
    mockDecryptContent.mockReturnValue('null');
    const freshKey = new Uint8Array(32).fill(0xcc);
    mockGetOrFetchGroupKey.mockResolvedValue(freshKey);

    const envelope = JSON.stringify({ ciphertext: 'enc-ct', iv: 'enc-iv' });
    const meta = makeMediaMetadata({
      mediaId: 'media-uuid-8',
      encryptedMetadata: envelope,
      contentType: 'image/bmp',
      fileName: 'fallback.bmp',
    });

    await processMediaMetadata([meta], fakeGroupKey, fakeGroupId, { threadId: 'thread-1' });

    // Should still produce an item using the API-level fields as fallback
    const items = mockSetMediaForThread.mock.calls[0][1];
    expect(items).toHaveLength(1);
    expect(items[0].contentType).toBe('image/bmp');
    expect(items[0].fileName).toBe('fallback.bmp');
  });

  it('handles invalid JSON in the encryptedMetadata envelope (outer parse fails)', async () => {
    const meta = makeMediaMetadata({
      mediaId: 'media-uuid-9',
      encryptedMetadata: 'this-is-not-json',
      contentType: 'image/jpeg',
    });

    await processMediaMetadata([meta], fakeGroupKey, fakeGroupId, { threadId: 'thread-1' });

    // decryptContent should never be called since envelope parsing fails first
    expect(mockDecryptContent).not.toHaveBeenCalled();
    // Item still produced with fallback API fields
    const items = mockSetMediaForThread.mock.calls[0][1];
    expect(items).toHaveLength(1);
  });

  it('handles envelope missing ciphertext or iv fields', async () => {
    const badEnvelope = JSON.stringify({ ciphertext: 'ct' }); // missing iv
    const meta = makeMediaMetadata({
      mediaId: 'media-uuid-10',
      encryptedMetadata: badEnvelope,
      contentType: 'image/jpeg',
    });

    await processMediaMetadata([meta], fakeGroupKey, fakeGroupId, { threadId: 'thread-1' });

    expect(mockDecryptContent).not.toHaveBeenCalled();
    const items = mockSetMediaForThread.mock.calls[0][1];
    expect(items).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// parentRef routing — threadId vs replyId
// ---------------------------------------------------------------------------

describe('processMediaMetadata — parentRef routing', () => {
  it('calls setMediaForThread when parentRef has threadId', async () => {
    const meta = makeMediaMetadata({ mediaId: 'media-uuid-11' });

    await processMediaMetadata([meta], fakeGroupKey, fakeGroupId, { threadId: 'thread-abc' });

    expect(mockSetMediaForThread).toHaveBeenCalledWith('thread-abc', expect.any(Array));
    expect(mockSetMediaForReply).not.toHaveBeenCalled();
  });

  it('calls setMediaForReply when parentRef has replyId', async () => {
    const meta = makeMediaMetadata({ mediaId: 'media-uuid-12' });

    await processMediaMetadata([meta], fakeGroupKey, fakeGroupId, { replyId: 'reply-xyz' });

    expect(mockSetMediaForReply).toHaveBeenCalledWith('reply-xyz', expect.any(Array));
    expect(mockSetMediaForThread).not.toHaveBeenCalled();

    const savedRow = mockSaveMedia.mock.calls[0][0];
    expect(savedRow.thread_id).toBeNull();
    expect(savedRow.reply_id).toBe('reply-xyz');
  });
});

// ---------------------------------------------------------------------------
// Per-item resilience — one corrupt item must not drop siblings
// ---------------------------------------------------------------------------

describe('processMediaMetadata — per-item resilience', () => {
  it('processes remaining items when one item causes getMedia to throw', async () => {
    mockGetMedia
      .mockImplementationOnce(() => { throw new Error('DB error'); })
      .mockReturnValue(null); // second item is a new item

    const meta1 = makeMediaMetadata({ mediaId: 'media-bad-1' });
    const meta2 = makeMediaMetadata({ mediaId: 'media-good-2' });

    await processMediaMetadata([meta1, meta2], fakeGroupKey, fakeGroupId, { threadId: 'thread-1' });

    // The second item should still be processed
    const items = mockSetMediaForThread.mock.calls[0][1];
    expect(items.some((i: { id: string }) => i.id === 'media-good-2')).toBe(true);
  });

  it('returns without calling store when all items fail per-item', async () => {
    // Trigger the outer per-item catch via a decryptContent throw — that path
    // is not wrapped in an inner try/catch, so the error propagates to the
    // outer per-item catch, which skips the item and continues.
    const envelope = JSON.stringify({ ciphertext: 'enc-ct', iv: 'enc-iv' });
    mockDecryptContent.mockImplementation(() => { throw new Error('Decrypt fatal error'); });

    const meta = makeMediaMetadata({ mediaId: 'media-fail', encryptedMetadata: envelope });

    await processMediaMetadata([meta], fakeGroupKey, fakeGroupId, { threadId: 'thread-1' });

    // Outer catch swallowed the error — no items produced, store not called
    expect(mockSetMediaForThread).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// blurHash preserved from API metadata
// ---------------------------------------------------------------------------

describe('processMediaMetadata — blurHash', () => {
  it('preserves blurHash from API metadata in the store item', async () => {
    const hash = 'LKO2?U%2Tw=w]~RBVZRi};RPxuwH';
    const meta = makeMediaMetadata({ mediaId: 'media-uuid-13', blurHash: hash });

    await processMediaMetadata([meta], fakeGroupKey, fakeGroupId, { threadId: 'thread-1' });

    const items = mockSetMediaForThread.mock.calls[0][1];
    expect(items[0].blurHash).toBe(hash);
  });
});
