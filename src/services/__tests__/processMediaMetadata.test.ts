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
const mockUpdateMediaParent = jest.fn();

jest.mock('../../database/repositories/mediaRepository', () => ({
  getMedia: (...args: unknown[]) => mockGetMedia(...args),
  saveMedia: (...args: unknown[]) => mockSaveMedia(...args),
  updateMediaParent: (...args: unknown[]) => mockUpdateMediaParent(...args),
}));

jest.mock('@dr.pogodin/react-native-fs', () => ({
  exists: jest.fn(() => Promise.resolve(true)),
  DocumentDirectoryPath: '/mock/documents',
}));

jest.mock('../../database/connection', () => ({
  isDatabaseInitialized: () => true,
}));

const mockDecryptContent = jest.fn();
const mockGetOrFetchGroupKey = jest.fn();
const mockInvalidateGroupKey = jest.fn();

jest.mock('../crypto/contentCrypto', () => ({
  PendingWrapError: class PendingWrapError extends Error {
    constructor() {
      super('Group key not yet available (pending wrap)');
      this.name = 'PendingWrapError';
    }
  },
  decryptContent: (...args: unknown[]) => mockDecryptContent(...args),
  encryptContent: jest.fn(),
  getOrFetchGroupKey: (...args: unknown[]) => mockGetOrFetchGroupKey(...args),
  invalidateGroupKey: (...args: unknown[]) => mockInvalidateGroupKey(...args),
}));

const mockBase64ToArrayBuffer = jest.fn<ArrayBuffer, [string]>(() => new ArrayBuffer(32));
jest.mock('../crypto/utils', () => ({
  base64ToArrayBuffer: (input: string) => mockBase64ToArrayBuffer(input),
}));

const mockMergeMediaForThread = jest.fn();
const mockMergeMediaForReply = jest.fn();

let mockStoreMedia: Record<string, unknown> = {};

jest.mock('../../stores/useAppStore', () => ({
  useAppStore: {
    getState: jest.fn(() => ({
      media: mockStoreMedia,
      mergeMediaForThread: mockMergeMediaForThread,
      mergeMediaForReply: mockMergeMediaForReply,
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

import { processMediaMetadata, clearProcessedMediaIds } from '../threadService';
import { exists } from '@dr.pogodin/react-native-fs';
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
    blur_hash: null,
    expires_at: null,
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
  mockStoreMedia = {}; // Default: no existing items in store
  mockGetMedia.mockReturnValue(null); // Default: no existing row in DB
  mockGetOrFetchGroupKey.mockResolvedValue(fakeGroupKey);
  mockBase64ToArrayBuffer.mockReturnValue(new ArrayBuffer(32)); // Default: 32-byte buffer
  clearProcessedMediaIds(); // Reset session dedup set between tests
});

// ---------------------------------------------------------------------------
// Empty / null input — early return
// ---------------------------------------------------------------------------

describe('processMediaMetadata — empty input', () => {
  it('returns early and does not call store actions for empty array', async () => {
    await processMediaMetadata([], fakeGroupKey, fakeGroupId, { threadId: 'thread-1' });

    expect(mockGetMedia).not.toHaveBeenCalled();
    expect(mockMergeMediaForThread).not.toHaveBeenCalled();
    expect(mockMergeMediaForReply).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// In-memory store check (store-first path)
// ---------------------------------------------------------------------------

describe('processMediaMetadata — existing item in store', () => {
  it('preserves existing store item and skips DB lookup entirely', async () => {
    const existing = {
      id: 'media-uuid-1',
      threadId: 'thread-1',
      replyId: null,
      contentType: 'image/jpeg',
      fileName: 'photo.jpg',
      fileSize: 1000,
      width: 640,
      height: 480,
      duration: null,
      blurHash: null,
      localPath: '/docs/media/media-uuid-1.jpg',
      thumbnailPath: null,
      downloadState: 'downloaded' as const,
      uploadState: 'done' as const,
      expiresAt: null,
      hasKeys: true,
    };
    mockStoreMedia = { 'media-uuid-1': existing };

    await processMediaMetadata(
      [makeMediaMetadata({ mediaId: 'media-uuid-1' })],
      fakeGroupKey,
      fakeGroupId,
      { replyId: 'reply-1' },
    );

    expect(mockGetMedia).not.toHaveBeenCalled();
    expect(mockSaveMedia).not.toHaveBeenCalled();
    expect(mockMergeMediaForReply).toHaveBeenCalledTimes(1);

    const items = mockMergeMediaForReply.mock.calls[0][1];
    expect(items).toHaveLength(1);
    expect(items[0]).toBe(existing); // Same object reference
    expect(items[0].hasKeys).toBe(true);
    expect(items[0].localPath).toBe('/docs/media/media-uuid-1.jpg');
  });
});

// ---------------------------------------------------------------------------
// Existing DB row path (mediaRowToItem)
// ---------------------------------------------------------------------------

describe('processMediaMetadata — existing row in DB', () => {
  it('uses mediaRowToItem and skips saveMedia when row already exists', async () => {
    const row = makeMediaRow({ id: 'media-uuid-1b', attachment_key: new Uint8Array(64).fill(0xAA) });
    mockGetMedia.mockReturnValue(row);

    await processMediaMetadata(
      [makeMediaMetadata({ mediaId: 'media-uuid-1b' })],
      fakeGroupKey,
      fakeGroupId,
      { threadId: 'thread-1' },
    );

    expect(mockSaveMedia).not.toHaveBeenCalled();
    expect(mockMergeMediaForThread).toHaveBeenCalledTimes(1);

    const items = mockMergeMediaForThread.mock.calls[0][1];
    expect(items).toHaveLength(1);
    // hasKeys derived from attachment_key presence
    expect(items[0].hasKeys).toBe(true);
    expect(items[0].id).toBe('media-uuid-1b');
  });

  it('maps all MediaRow fields to MediaItem correctly', async () => {
    const row = makeMediaRow({
      id: 'media-uuid-1c',
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
      [makeMediaMetadata({ mediaId: 'media-uuid-1c', contentType: 'video/mp4' })],
      fakeGroupKey,
      fakeGroupId,
      { threadId: 'thread-1' },
    );

    const items = mockMergeMediaForThread.mock.calls[0][1];
    const item = items[0];
    expect(item.contentType).toBe('video/mp4');
    expect(item.fileName).toBe('clip.mp4');
    expect(item.fileSize).toBe(5000);
    expect(item.width).toBe(1920);
    expect(item.height).toBe(1080);
    expect(item.duration).toBe(30);
    // Paths resolved through resolveMediaPath (legacy absolute → current MEDIA_DIR)
    expect(item.localPath).toBe('/mock/documents/media/clip.mp4');
    expect(item.thumbnailPath).toBe('/mock/documents/media/clip-thumb.jpg');
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

    expect(mockMergeMediaForThread).toHaveBeenCalledTimes(1);
    const items = mockMergeMediaForThread.mock.calls[0][1];
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

    const items = mockMergeMediaForThread.mock.calls[0][1];
    expect(items[0].expiresAt).toBe(new Date('2026-05-01T10:00:00Z').getTime());
  });

  it('handles null expiresAt without throwing', async () => {
    const meta = makeMediaMetadata({ mediaId: 'media-uuid-5', expiresAt: null });

    await processMediaMetadata([meta], fakeGroupKey, fakeGroupId, { threadId: 'thread-1' });

    const items = mockMergeMediaForThread.mock.calls[0][1];
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

    const items = mockMergeMediaForThread.mock.calls[0][1];
    const item = items[0];
    expect(item.contentType).toBe('image/webp');
    expect(item.fileName).toBe('decrypted.webp');
    expect(item.width).toBe(800);
    expect(item.height).toBe(600);

    const savedRow = mockSaveMedia.mock.calls[0][0];
    expect(savedRow.attachment_digest).toBeInstanceOf(Uint8Array);
  });
});

// ---------------------------------------------------------------------------
// New item — with encryptedMetadata (decryption failure fallback)
// ---------------------------------------------------------------------------

describe('processMediaMetadata — encryptedMetadata decryption failure', () => {
  it('falls back to API fields when decryption returns null (no retry)', async () => {
    // decryptContent returns 'null' so decryptMediaMetadataEnvelope returns null
    mockDecryptContent.mockReturnValue('null');

    const envelope = JSON.stringify({ ciphertext: 'enc-ct', iv: 'enc-iv' });
    const meta = makeMediaMetadata({
      mediaId: 'media-uuid-8',
      encryptedMetadata: envelope,
      contentType: 'image/bmp',
      fileName: 'fallback.bmp',
    });

    await processMediaMetadata([meta], fakeGroupKey, fakeGroupId, { threadId: 'thread-1' });

    // No key retry — only one decryptContent call
    expect(mockDecryptContent).toHaveBeenCalledTimes(1);
    expect(mockInvalidateGroupKey).not.toHaveBeenCalled();

    // Item produced with fallback API fields
    const items = mockMergeMediaForThread.mock.calls[0][1];
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
    const items = mockMergeMediaForThread.mock.calls[0][1];
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
    const items = mockMergeMediaForThread.mock.calls[0][1];
    expect(items).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// parentRef routing — threadId vs replyId
// ---------------------------------------------------------------------------

describe('processMediaMetadata — parentRef routing', () => {
  it('calls mergeMediaForThread when parentRef has threadId', async () => {
    const meta = makeMediaMetadata({ mediaId: 'media-uuid-11' });

    await processMediaMetadata([meta], fakeGroupKey, fakeGroupId, { threadId: 'thread-abc' });

    expect(mockMergeMediaForThread).toHaveBeenCalledWith('thread-abc', expect.any(Array));
    expect(mockMergeMediaForReply).not.toHaveBeenCalled();
  });

  it('calls mergeMediaForReply when parentRef has replyId', async () => {
    const meta = makeMediaMetadata({ mediaId: 'media-uuid-12' });

    await processMediaMetadata([meta], fakeGroupKey, fakeGroupId, { replyId: 'reply-xyz' });

    expect(mockMergeMediaForReply).toHaveBeenCalledWith('reply-xyz', expect.any(Array));
    expect(mockMergeMediaForThread).not.toHaveBeenCalled();

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
    const items = mockMergeMediaForThread.mock.calls[0][1];
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
    expect(mockMergeMediaForThread).not.toHaveBeenCalled();
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

    const items = mockMergeMediaForThread.mock.calls[0][1];
    expect(items[0].blurHash).toBe(hash);
  });
});

// ---------------------------------------------------------------------------
// New item — with attachmentKey in metadata envelope (v1+)
// ---------------------------------------------------------------------------

describe('processMediaMetadata — attachmentKey in envelope (new item)', () => {
  it('extracts valid 64-byte attachmentKey and sets hasKeys=true', async () => {
    const innerPayload = JSON.stringify({
      v: 1,
      contentType: 'image/jpeg',
      fileName: 'photo.jpg',
      width: 800,
      height: 600,
      digest: 'digest-base64',
      attachmentKey: 'valid-key-base64',
    });
    mockDecryptContent.mockReturnValue(innerPayload);
    // Return 64-byte buffer for attachmentKey, 32-byte for digest
    mockBase64ToArrayBuffer.mockImplementation((input: string) => {
      if (input === 'valid-key-base64') return new ArrayBuffer(64);
      return new ArrayBuffer(32);
    });

    const envelope = JSON.stringify({ ciphertext: 'enc-ct', iv: 'enc-iv' });
    const meta = makeMediaMetadata({
      mediaId: 'media-key-1',
      encryptedMetadata: envelope,
    });

    await processMediaMetadata([meta], fakeGroupKey, fakeGroupId, { threadId: 'thread-1' });

    // DB row should have attachment_key
    const savedRow = mockSaveMedia.mock.calls[0][0];
    expect(savedRow.attachment_key).toBeInstanceOf(Uint8Array);
    expect(savedRow.attachment_key.byteLength).toBe(64);

    // Store item should have hasKeys=true
    const items = mockMergeMediaForThread.mock.calls[0][1];
    expect(items[0].hasKeys).toBe(true);
  });

  it('rejects attachmentKey with wrong length (not 64 bytes)', async () => {
    const innerPayload = JSON.stringify({
      v: 1,
      contentType: 'image/jpeg',
      fileName: 'photo.jpg',
      attachmentKey: 'bad-key-base64',
    });
    mockDecryptContent.mockReturnValue(innerPayload);
    // Return 48-byte buffer — wrong length
    mockBase64ToArrayBuffer.mockImplementation((input: string) => {
      if (input === 'bad-key-base64') return new ArrayBuffer(48);
      return new ArrayBuffer(32);
    });

    const envelope = JSON.stringify({ ciphertext: 'enc-ct', iv: 'enc-iv' });
    const meta = makeMediaMetadata({
      mediaId: 'media-key-2',
      encryptedMetadata: envelope,
    });

    await processMediaMetadata([meta], fakeGroupKey, fakeGroupId, { threadId: 'thread-1' });

    const savedRow = mockSaveMedia.mock.calls[0][0];
    expect(savedRow.attachment_key).toBeNull();

    const items = mockMergeMediaForThread.mock.calls[0][1];
    expect(items[0].hasKeys).toBe(false);
  });

  it('handles missing attachmentKey in envelope (legacy v0 metadata)', async () => {
    const innerPayload = JSON.stringify({
      contentType: 'image/jpeg',
      fileName: 'photo.jpg',
      digest: 'digest-base64',
    });
    mockDecryptContent.mockReturnValue(innerPayload);

    const envelope = JSON.stringify({ ciphertext: 'enc-ct', iv: 'enc-iv' });
    const meta = makeMediaMetadata({
      mediaId: 'media-key-3',
      encryptedMetadata: envelope,
    });

    await processMediaMetadata([meta], fakeGroupKey, fakeGroupId, { threadId: 'thread-1' });

    const savedRow = mockSaveMedia.mock.calls[0][0];
    expect(savedRow.attachment_key).toBeNull();

    const items = mockMergeMediaForThread.mock.calls[0][1];
    expect(items[0].hasKeys).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Existing DB row — key recovery from envelope
// ---------------------------------------------------------------------------

describe('processMediaMetadata — existing row key recovery', () => {
  it('recovers key from envelope when existing row has no attachment_key', async () => {
    const existingRow = makeMediaRow({
      id: 'media-recover-1',
      attachment_key: null,
    });
    mockGetMedia.mockReturnValue(existingRow);

    const innerPayload = JSON.stringify({
      v: 1,
      contentType: 'image/jpeg',
      fileName: 'photo.jpg',
      attachmentKey: 'recovered-key-base64',
    });
    mockDecryptContent.mockReturnValue(innerPayload);
    mockBase64ToArrayBuffer.mockImplementation((input: string) => {
      if (input === 'recovered-key-base64') return new ArrayBuffer(64);
      return new ArrayBuffer(32);
    });

    const envelope = JSON.stringify({ ciphertext: 'enc-ct', iv: 'enc-iv' });
    const meta = makeMediaMetadata({
      mediaId: 'media-recover-1',
      encryptedMetadata: envelope,
    });

    await processMediaMetadata([meta], fakeGroupKey, fakeGroupId, { threadId: 'thread-1' });

    // saveMedia should be called to persist the recovered key
    expect(mockSaveMedia).toHaveBeenCalledTimes(1);
    const savedRow = mockSaveMedia.mock.calls[0][0];
    expect(savedRow.attachment_key).toBeInstanceOf(Uint8Array);
    expect(savedRow.attachment_key.byteLength).toBe(64);
    // Should preserve existing row fields
    expect(savedRow.id).toBe('media-recover-1');

    const items = mockMergeMediaForThread.mock.calls[0][1];
    expect(items[0].hasKeys).toBe(true);
  });

  it('does not attempt recovery when existing row already has key', async () => {
    const existingRow = makeMediaRow({
      id: 'media-has-key-1',
      attachment_key: new Uint8Array(64).fill(0xBB),
    });
    mockGetMedia.mockReturnValue(existingRow);

    const envelope = JSON.stringify({ ciphertext: 'enc-ct', iv: 'enc-iv' });
    const meta = makeMediaMetadata({
      mediaId: 'media-has-key-1',
      encryptedMetadata: envelope,
    });

    await processMediaMetadata([meta], fakeGroupKey, fakeGroupId, { threadId: 'thread-1' });

    // No saveMedia, no decryptContent — row used as-is
    expect(mockSaveMedia).not.toHaveBeenCalled();
    expect(mockDecryptContent).not.toHaveBeenCalled();

    const items = mockMergeMediaForThread.mock.calls[0][1];
    expect(items[0].hasKeys).toBe(true);
  });

  it('falls back to existing row when key recovery fails (decryption error)', async () => {
    const existingRow = makeMediaRow({
      id: 'media-recover-fail-1',
      attachment_key: null,
    });
    mockGetMedia.mockReturnValue(existingRow);
    mockDecryptContent.mockImplementation(() => { throw new Error('Decrypt failed'); });

    const envelope = JSON.stringify({ ciphertext: 'enc-ct', iv: 'enc-iv' });
    const meta = makeMediaMetadata({
      mediaId: 'media-recover-fail-1',
      encryptedMetadata: envelope,
    });

    await processMediaMetadata([meta], fakeGroupKey, fakeGroupId, { threadId: 'thread-1' });

    // Falls back to existing row — no saveMedia called
    expect(mockSaveMedia).not.toHaveBeenCalled();

    const items = mockMergeMediaForThread.mock.calls[0][1];
    expect(items[0].hasKeys).toBe(false);
    expect(items[0].id).toBe('media-recover-fail-1');
  });

  it('skips recovery when existing row has no encryptedMetadata', async () => {
    const existingRow = makeMediaRow({
      id: 'media-no-meta-1',
      attachment_key: null,
    });
    mockGetMedia.mockReturnValue(existingRow);

    const meta = makeMediaMetadata({
      mediaId: 'media-no-meta-1',
      encryptedMetadata: null,
    });

    await processMediaMetadata([meta], fakeGroupKey, fakeGroupId, { threadId: 'thread-1' });

    // No decryption attempted, no saveMedia called
    expect(mockDecryptContent).not.toHaveBeenCalled();
    expect(mockSaveMedia).not.toHaveBeenCalled();

    const items = mockMergeMediaForThread.mock.calls[0][1];
    expect(items[0].hasKeys).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// clearProcessedMediaIds
// ---------------------------------------------------------------------------

describe('clearProcessedMediaIds', () => {
  it('allows re-processing of previously processed media IDs', async () => {
    const meta = makeMediaMetadata({ mediaId: 'media-clear-1' });

    // First call processes the item
    await processMediaMetadata([meta], fakeGroupKey, fakeGroupId, { threadId: 'thread-1' });
    expect(mockSaveMedia).toHaveBeenCalledTimes(1);

    jest.clearAllMocks();
    mockGetMedia.mockReturnValue(null);
    mockStoreMedia = {};

    // Second call without clearing — item should be skipped (dedup)
    await processMediaMetadata([meta], fakeGroupKey, fakeGroupId, { threadId: 'thread-1' });
    expect(mockSaveMedia).not.toHaveBeenCalled();

    jest.clearAllMocks();
    mockGetMedia.mockReturnValue(null);
    mockStoreMedia = {};

    // Clear dedup set
    clearProcessedMediaIds();

    // Third call after clearing — item should be re-processed
    await processMediaMetadata([meta], fakeGroupKey, fakeGroupId, { threadId: 'thread-1' });
    expect(mockSaveMedia).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// exists() returns false — stale downloaded row recovery
// ---------------------------------------------------------------------------

describe('processMediaMetadata — stale local_path recovery', () => {
  it('resets download_state to pending and local_path to null when file does not exist', async () => {
    const row = makeMediaRow({
      id: 'media-stale-1',
      download_state: 'downloaded',
      local_path: '/cache/deleted-file.jpg',
      attachment_key: new Uint8Array(64).fill(0xCC),
    });
    mockGetMedia.mockReturnValue(row);

    // Override the FS mock to say the file does NOT exist
    (exists as jest.Mock).mockResolvedValueOnce(false);

    const meta = makeMediaMetadata({ mediaId: 'media-stale-1' });

    await processMediaMetadata([meta], fakeGroupKey, fakeGroupId, { threadId: 'thread-1' });

    // exists() should have been called with the resolved path (legacy absolute → current MEDIA_DIR)
    expect(exists).toHaveBeenCalledWith('/mock/documents/media/deleted-file.jpg');

    // The resulting MediaItem should have download_state reset to pending
    const items = mockMergeMediaForThread.mock.calls[0][1];
    expect(items).toHaveLength(1);
    expect(items[0].downloadState).toBe('pending');
    expect(items[0].localPath).toBeNull();
    // hasKeys should still be true since the row had an attachment_key
    expect(items[0].hasKeys).toBe(true);
  });

  it('preserves downloaded state when file exists on disk', async () => {
    const row = makeMediaRow({
      id: 'media-present-1',
      download_state: 'downloaded',
      local_path: '/cache/existing-file.jpg',
      attachment_key: new Uint8Array(64).fill(0xDD),
    });
    mockGetMedia.mockReturnValue(row);

    // File exists — default mock returns true, but be explicit
    (exists as jest.Mock).mockResolvedValueOnce(true);

    const meta = makeMediaMetadata({ mediaId: 'media-present-1' });

    await processMediaMetadata([meta], fakeGroupKey, fakeGroupId, { threadId: 'thread-1' });

    const items = mockMergeMediaForThread.mock.calls[0][1];
    expect(items[0].downloadState).toBe('downloaded');
    // localPath is now resolved through resolveMediaPath (legacy absolute → current MEDIA_DIR)
    expect(items[0].localPath).toBe('/mock/documents/media/existing-file.jpg');
  });
});

// ---------------------------------------------------------------------------
// reply_id backfill — two-pass thread-then-reply processing
// ---------------------------------------------------------------------------

describe('processMediaMetadata — reply_id backfill', () => {
  it('backfills reply_id via updateMediaParent in the dedup path', async () => {
    // First pass: thread context — creates item with replyId=null
    const meta = makeMediaMetadata({ mediaId: 'media-shared-1' });
    await processMediaMetadata([meta], fakeGroupKey, fakeGroupId, { threadId: 'thread-1' });

    // Item is now in processedMediaIds and store
    expect(mockMergeMediaForThread).toHaveBeenCalledTimes(1);

    // Simulate the store having the item after the first pass
    const firstPassItem = mockMergeMediaForThread.mock.calls[0][1][0];
    mockStoreMedia = { 'media-shared-1': firstPassItem };

    // Second pass: reply context — same media ID, more specific context
    // The dedup path fires (all items already processed)
    await processMediaMetadata([meta], fakeGroupKey, fakeGroupId, { replyId: 'reply-1' });

    // Should merge into reply index
    expect(mockMergeMediaForReply).toHaveBeenCalledTimes(1);
    expect(mockMergeMediaForReply).toHaveBeenCalledWith('reply-1', expect.any(Array));

    // Should backfill reply_id in DB via updateMediaParent
    expect(mockUpdateMediaParent).toHaveBeenCalledWith(
      'media-shared-1',
      'thread-1',  // threadId from the existing store item
      'reply-1',   // replyId from the new context
    );
  });

  it('backfills reply_id on store-first path for unprocessed items', async () => {
    // Pre-seed store with an item that has replyId=null
    const existingItem = {
      id: 'media-store-1',
      threadId: 'thread-1',
      replyId: null,
      contentType: 'image/jpeg',
      fileName: 'photo.jpg',
      fileSize: 1000,
      width: 640, height: 480,
      duration: null, blurHash: null,
      localPath: null, thumbnailPath: null,
      downloadState: 'pending' as const,
      uploadState: 'done' as const,
      expiresAt: null,
      hasKeys: true,
      thumbnailMediaId: null,
      isThumbnail: false,
    };
    mockStoreMedia = { 'media-store-1': existingItem };

    // Process with reply context — store-first path finds the item
    const meta = makeMediaMetadata({ mediaId: 'media-store-1' });
    await processMediaMetadata([meta], fakeGroupKey, fakeGroupId, { replyId: 'reply-2' });

    // Should backfill reply_id in DB
    expect(mockUpdateMediaParent).toHaveBeenCalledWith(
      'media-store-1',
      'thread-1',
      'reply-2',
    );
  });

  it('backfills reply_id on existing-DB-row path', async () => {
    // DB row has reply_id=null (created by thread-context first pass)
    const row = makeMediaRow({
      id: 'media-db-1',
      thread_id: 'thread-1',
      reply_id: null,
      attachment_key: new Uint8Array(64).fill(0xBB),
    });
    mockGetMedia.mockReturnValue(row);

    const meta = makeMediaMetadata({ mediaId: 'media-db-1' });
    await processMediaMetadata([meta], fakeGroupKey, fakeGroupId, { replyId: 'reply-3' });

    // Should backfill reply_id in DB
    expect(mockUpdateMediaParent).toHaveBeenCalledWith(
      'media-db-1',
      'thread-1',
      'reply-3',
    );

    // The merged item should reflect the backfilled reply_id
    const items = mockMergeMediaForReply.mock.calls[0][1];
    expect(items[0].replyId).toBe('reply-3');
  });

  it('does NOT backfill when context is thread-only', async () => {
    const row = makeMediaRow({
      id: 'media-thread-only',
      thread_id: 'thread-1',
      reply_id: null,
      attachment_key: new Uint8Array(64).fill(0xAA),
    });
    mockGetMedia.mockReturnValue(row);

    const meta = makeMediaMetadata({ mediaId: 'media-thread-only' });
    await processMediaMetadata([meta], fakeGroupKey, fakeGroupId, { threadId: 'thread-1' });

    // Should NOT call updateMediaParent — context is thread, not reply
    expect(mockUpdateMediaParent).not.toHaveBeenCalled();
  });

  it('two-pass thread-then-reply ends with correct placement in both indexes', async () => {
    const meta = makeMediaMetadata({ mediaId: 'media-two-pass' });

    // Pass 1: thread context
    await processMediaMetadata([meta], fakeGroupKey, fakeGroupId, { threadId: 'thread-1' });
    expect(mockMergeMediaForThread).toHaveBeenCalledWith('thread-1', expect.any(Array));

    // Simulate store having the item after pass 1
    const firstPassItem = mockMergeMediaForThread.mock.calls[0][1][0];
    mockStoreMedia = { 'media-two-pass': firstPassItem };

    // Pass 2: reply context
    await processMediaMetadata([meta], fakeGroupKey, fakeGroupId, { replyId: 'reply-4' });
    expect(mockMergeMediaForReply).toHaveBeenCalledWith('reply-4', expect.any(Array));

    // Both indexes populated
    expect(mockMergeMediaForThread).toHaveBeenCalledTimes(1);
    expect(mockMergeMediaForReply).toHaveBeenCalledTimes(1);

    // DB backfill happened
    expect(mockUpdateMediaParent).toHaveBeenCalledWith('media-two-pass', 'thread-1', 'reply-4');
  });
});
