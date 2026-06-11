/**
 * Tests for mediaUploadService — encryption, chunking, upload, and persistence.
 */

jest.mock('@dr.pogodin/react-native-fs');

jest.mock('../../database/connection', () => ({
  isDatabaseInitialized: () => true,
}));

const mockGenerateAttachmentKeys = jest.fn();
const mockEncryptAttachment = jest.fn();

jest.mock('../crypto/attachmentCrypto', () => ({
  generateAttachmentKeys: (...args: unknown[]) => mockGenerateAttachmentKeys(...args),
  encryptAttachment: (...args: unknown[]) => mockEncryptAttachment(...args),
}));

const mockEncryptContent = jest.fn();
const mockGetOrFetchGroupKey = jest.fn();

jest.mock('../crypto/contentCrypto', () => ({
  PendingWrapError: class PendingWrapError extends Error {
    constructor() {
      super('Group key not yet available (pending wrap)');
      this.name = 'PendingWrapError';
    }
  },
  encryptContent: (...args: unknown[]) => mockEncryptContent(...args),
  getOrFetchGroupKey: (...args: unknown[]) => mockGetOrFetchGroupKey(...args),
}));

jest.mock('../crypto/utils', () => ({
  arrayBufferToBase64: jest.fn(() => 'mock-base64'),
  toArrayBuffer: jest.fn((u8: Uint8Array) => u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength)),
}));

const mockUploadChunk = jest.fn();
const mockCompleteUpload = jest.fn();

jest.mock('../api/media', () => ({
  uploadChunk: (...args: unknown[]) => mockUploadChunk(...args),
  completeUpload: (...args: unknown[]) => mockCompleteUpload(...args),
}));

const mockSaveMedia = jest.fn();

jest.mock('../../database/repositories/mediaRepository', () => ({
  saveMedia: (...args: unknown[]) => mockSaveMedia(...args),
}));

const mockUpsertMedia = jest.fn();

jest.mock('../../stores/useAppStore', () => ({
  useAppStore: {
    getState: jest.fn(() => ({
      upsertMedia: mockUpsertMedia,
    })),
  },
}));

const mockGenerateUUID = jest.fn(() => 'test-media-id');

jest.mock('../../utils/uuid', () => ({
  generateUUID: () => mockGenerateUUID(),
}));

import { uploadMedia, uploadMediaBatch, cleanupOrphanedChunks } from '../mediaUploadService';
import type { PickedMedia } from '../../hooks/useMediaPicker';

const fakeGroupKey = new Uint8Array(32).fill(0xAB);
const fakeCiphertext = new Uint8Array(100).fill(0xCC);
const fakeDigest = new Uint8Array(32).fill(0xDD);
const fakeKeys = new Uint8Array(64).fill(0xEE);

beforeEach(() => {
  jest.clearAllMocks();
  mockGenerateAttachmentKeys.mockReturnValue({
    keys: fakeKeys,
    keysBase64: 'fake-keys-base64',
  });
  mockEncryptAttachment.mockReturnValue({
    ciphertext: fakeCiphertext,
    digest: fakeDigest,
  });
  mockGetOrFetchGroupKey.mockResolvedValue(fakeGroupKey);
  mockEncryptContent.mockReturnValue({
    ciphertext: 'encrypted-meta-ct',
    iv: 'encrypted-meta-iv',
  });
  mockUploadChunk.mockResolvedValue({
    uploadId: 'upload-1',
    received: 1,
    complete: false,
  });
  mockCompleteUpload.mockResolvedValue({
    mediaId: 'test-media-id',
    sizeBytes: 100,
    uploadedAt: '2026-01-01T00:00:00Z',
    expiresAt: '2026-01-08T00:00:00Z',
    chunksUploaded: 1,
  });
});

const baseOptions = {
  fileBase64: 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=',
  mimeType: 'image/jpeg',
  fileName: 'photo.jpg',
  fileSize: 50,
  groupId: 'group-1',
};

describe('uploadMedia', () => {
  it('rejects files over 25MB', async () => {
    await expect(
      uploadMedia({ ...baseOptions, fileSize: 26 * 1024 * 1024 }),
    ).rejects.toThrow('File too large');
  });

  it('encrypts plaintext with attachment keys', async () => {
    await uploadMedia(baseOptions);

    expect(mockGenerateAttachmentKeys).toHaveBeenCalledTimes(1);
    expect(mockEncryptAttachment).toHaveBeenCalledTimes(1);
    const [plaintext, keys] = mockEncryptAttachment.mock.calls[0];
    expect(plaintext).toBeInstanceOf(Uint8Array);
    expect(keys).toBe(fakeKeys);
  });

  it('encrypts metadata with group key (not plaintext)', async () => {
    await uploadMedia(baseOptions);

    expect(mockGetOrFetchGroupKey).toHaveBeenCalledWith('group-1');
    expect(mockEncryptContent).toHaveBeenCalledTimes(1);
    const [metadataJson, groupKey, groupId] = mockEncryptContent.mock.calls[0];
    expect(groupKey).toBe(fakeGroupKey);
    expect(groupId).toBe('group-1');

    const parsed = JSON.parse(metadataJson as string);
    expect(parsed.contentType).toBe('image/jpeg');
    expect(parsed.fileName).toBe('photo.jpg');
  });

  it('uploads correct number of chunks for small file', async () => {
    await uploadMedia(baseOptions);

    expect(mockUploadChunk).toHaveBeenCalledTimes(1);
    expect(mockCompleteUpload).toHaveBeenCalledWith('test-media-id', 'group-1');
  });

  it('uploads multiple chunks for large ciphertext', async () => {
    const largeCiphertext = new Uint8Array(6 * 1024 * 1024).fill(0xAA);
    mockEncryptAttachment.mockReturnValue({
      ciphertext: largeCiphertext,
      digest: fakeDigest,
    });

    await uploadMedia(baseOptions);

    expect(mockUploadChunk).toHaveBeenCalledTimes(2);
  });

  it('sends encryptedMetadata only with first chunk', async () => {
    const largeCiphertext = new Uint8Array(6 * 1024 * 1024).fill(0xAA);
    mockEncryptAttachment.mockReturnValue({
      ciphertext: largeCiphertext,
      digest: fakeDigest,
    });

    await uploadMedia(baseOptions);

    const firstCall = mockUploadChunk.mock.calls[0][0] as Record<string, unknown>;
    const secondCall = mockUploadChunk.mock.calls[1][0] as Record<string, unknown>;
    expect(firstCall.encryptedMetadata).toBeDefined();
    expect(firstCall.encryptionIv).toBeDefined();
    expect(secondCall.encryptedMetadata).toBeUndefined();
    expect(secondCall.encryptionIv).toBeUndefined();
  });

  it('saves to database and store on success', async () => {
    await uploadMedia(baseOptions);

    expect(mockSaveMedia).toHaveBeenCalledTimes(1);
    expect(mockUpsertMedia).toHaveBeenCalledTimes(1);

    const storeItem = mockUpsertMedia.mock.calls[0][0];
    expect(storeItem.id).toBe('test-media-id');
    expect(storeItem.uploadState).toBe('done');
    expect(storeItem.hasKeys).toBe(true);
  });

  it('returns the media ID', async () => {
    const id = await uploadMedia(baseOptions);
    expect(id).toBe('test-media-id');
  });

  it('retries on transient upload failure', async () => {
    mockUploadChunk
      .mockRejectedValueOnce(new Error('Network error'))
      .mockResolvedValueOnce({ uploadId: 'u1', received: 1, complete: false });

    await uploadMedia(baseOptions);

    expect(mockUploadChunk).toHaveBeenCalledTimes(2);
  });

  it('throws after max retries exhausted', async () => {
    mockUploadChunk.mockRejectedValue(new Error('Network error'));

    await expect(uploadMedia(baseOptions)).rejects.toThrow();
    expect(mockUploadChunk).toHaveBeenCalledTimes(3);
  });

  it('respects abort signal', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      uploadMedia({ ...baseOptions, signal: controller.signal }),
    ).rejects.toThrow('cancelled');
  });

  it('encrypted metadata contains ciphertext and iv, not plaintext fields', async () => {
    await uploadMedia(baseOptions);

    const firstCall = mockUploadChunk.mock.calls[0][0] as Record<string, unknown>;
    const metadataStr = firstCall.encryptedMetadata as string;
    const metadataParsed = JSON.parse(metadataStr);
    expect(metadataParsed).toHaveProperty('ciphertext');
    expect(metadataParsed).toHaveProperty('iv');
    expect(metadataParsed).not.toHaveProperty('fileName');
    expect(metadataParsed).not.toHaveProperty('contentType');
  });

  it('inner metadata envelope includes v:1 and attachmentKey', async () => {
    await uploadMedia(baseOptions);

    // encryptContent receives the plaintext metadata JSON before encryption
    const [metadataJson] = mockEncryptContent.mock.calls[0];
    const parsed = JSON.parse(metadataJson as string);
    expect(parsed.v).toBe(1);
    expect(parsed.attachmentKey).toBe('mock-base64'); // arrayBufferToBase64 mock returns 'mock-base64'
    expect(parsed.contentType).toBe('image/jpeg');
    expect(parsed.fileName).toBe('photo.jpg');
    expect(parsed.digest).toBe('mock-base64');
  });

  it('inner metadata includes width and height when provided', async () => {
    await uploadMedia({ ...baseOptions, width: 1920, height: 1080 });

    const [metadataJson] = mockEncryptContent.mock.calls[0];
    const parsed = JSON.parse(metadataJson as string);
    expect(parsed.v).toBe(1);
    expect(parsed.width).toBe(1920);
    expect(parsed.height).toBe(1080);
    expect(parsed.attachmentKey).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// uploadMediaBatch
// ---------------------------------------------------------------------------

describe('uploadMediaBatch', () => {
  const fakeItems: PickedMedia[] = [
    {
      uri: 'file:///photo1.jpg',
      base64: 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=',
      type: 'image/jpeg',
      fileName: 'photo1.jpg',
      fileSize: 50,
      width: 100,
      height: 100,
    },
    {
      uri: 'file:///photo2.png',
      base64: 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=',
      type: 'image/png',
      fileName: 'photo2.png',
      fileSize: 80,
      width: 200,
      height: 200,
    },
  ];

  it('calls uploadMedia for each item and returns collected IDs', async () => {
    mockGenerateUUID
      .mockReturnValueOnce('batch-id-1')
      .mockReturnValueOnce('batch-id-2');

    const ids = await uploadMediaBatch(fakeItems, 'group-1');

    expect(ids).toEqual(['batch-id-1', 'batch-id-2']);
    // uploadMedia calls uploadChunk once per item (small files = 1 chunk each)
    expect(mockUploadChunk).toHaveBeenCalledTimes(2);
    expect(mockCompleteUpload).toHaveBeenCalledTimes(2);
  });

  it('returns empty array for empty input', async () => {
    const ids = await uploadMediaBatch([], 'group-1');
    expect(ids).toEqual([]);
    expect(mockUploadChunk).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// cleanupOrphanedChunks
// ---------------------------------------------------------------------------

describe('cleanupOrphanedChunks', () => {
  it('removes stale chunk files older than 1 hour', async () => {
    const { readDir, unlink: mockUnlink } = require('@dr.pogodin/react-native-fs');
    readDir.mockResolvedValueOnce([
      { name: 'abc-chunk-0.bin', path: '/tmp/test-cache/abc-chunk-0.bin', mtime: new Date(Date.now() - 7200_000) },
      { name: 'recent-chunk-0.bin', path: '/tmp/test-cache/recent-chunk-0.bin', mtime: new Date() },
      { name: 'unrelated.txt', path: '/tmp/test-cache/unrelated.txt', mtime: new Date(Date.now() - 7200_000) },
    ]);

    await cleanupOrphanedChunks();

    expect(mockUnlink).toHaveBeenCalledWith('/tmp/test-cache/abc-chunk-0.bin');
    expect(mockUnlink).not.toHaveBeenCalledWith('/tmp/test-cache/recent-chunk-0.bin');
    expect(mockUnlink).not.toHaveBeenCalledWith('/tmp/test-cache/unrelated.txt');
  });
});
