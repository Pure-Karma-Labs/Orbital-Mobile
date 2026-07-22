/**
 * Tests for mediaUploadService -- streaming encryption + chunked upload pipeline.
 */

jest.mock('@dr.pogodin/react-native-fs');

jest.mock('../media/imageSanitizer', () => ({
  sanitizeStillImage: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../media/videoProcessing', () => ({
  prepareVideoForUpload: jest.fn(),
}));

jest.mock('../../database/connection', () => ({
  isDatabaseInitialized: () => true,
}));

const mockGenerateAttachmentKeys = jest.fn();
const mockCreateAttachmentEncryptor = jest.fn();

jest.mock('../crypto/attachmentCrypto', () => ({
  generateAttachmentKeys: (...args: unknown[]) => mockGenerateAttachmentKeys(...args),
  createAttachmentEncryptor: (...args: unknown[]) => mockCreateAttachmentEncryptor(...args),
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
  arrayBufferToBase64: jest.fn((ab: ArrayBuffer) => {
    const bytes = new Uint8Array(ab);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }),
  toArrayBuffer: jest.fn((u8: Uint8Array) =>
    u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength),
  ),
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
import { QuotaExceededError, AuthError } from '../api/errors';
import type { PickedMedia } from '../../hooks/useMediaPicker';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const fakeGroupKey = new Uint8Array(32).fill(0xAB);
const fakeKeys = new Uint8Array(64).fill(0xEE);
const fakeDigest = new Uint8Array(32).fill(0xDD);

// A small plaintext (50 bytes) -- ciphertext = 16 (IV) + 64 (padded) + 32 (HMAC) = 112
const SMALL_PLAINTEXT_SIZE = 50;
const SMALL_CT_SIZE = 112; // 16 + (50 - 2 + 16) + 32

/** Produce a base64 string that decodes to exactly `length` bytes. */
function makeFakeBase64(length: number): string {
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i++) {
    bytes[i] = (i + 1) % 256; // avoid leading 0 for safety
  }
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/** Compute expected ciphertext length for a given plaintext size. */
function computeCtSize(plaintextSize: number): number {
  const paddedLen = plaintextSize - (plaintextSize % 16) + 16;
  return 16 + paddedLen + 32;
}

/** Stat result factory */
function makeStat(size: number) {
  return {
    size,
    mtime: new Date(),
    ctime: new Date(),
    isFile: () => true,
    isDirectory: () => false,
  };
}

// ---------------------------------------------------------------------------
// Mock encryptor factory
// ---------------------------------------------------------------------------

let mockEncPush: jest.Mock;
let mockEncFinalize: jest.Mock;
let mockEncDestroy: jest.Mock;

function setupMockEncryptor(ctSize = SMALL_CT_SIZE) {
  mockEncPush = jest.fn().mockReturnValue(new Uint8Array(0));
  mockEncFinalize = jest.fn().mockReturnValue({
    tail: new Uint8Array(ctSize),
    digest: fakeDigest,
  });
  mockEncDestroy = jest.fn();

  mockCreateAttachmentEncryptor.mockReturnValue({
    push: mockEncPush,
    finalize: mockEncFinalize,
    destroy: mockEncDestroy,
  });
}

/**
 * Configure RNFS stat + read mocks for a given plaintext size.
 * stat returns the plaintext size for source paths, ct size for cipher paths.
 * read returns correct-length base64 for any requested length.
 */
function setupRnfsMocks(plaintextSize: number) {
  const rnfs = require('@dr.pogodin/react-native-fs');
  const ctSize = computeCtSize(plaintextSize);

  rnfs.stat.mockImplementation((path: string) => {
    if (path.includes('-cipher.bin')) {
      return Promise.resolve(makeStat(ctSize));
    }
    return Promise.resolve(makeStat(plaintextSize));
  });

  rnfs.read.mockImplementation((_path: string, length: number) =>
    Promise.resolve(makeFakeBase64(length)),
  );
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  jest.clearAllMocks();

  setupMockEncryptor();

  mockGenerateAttachmentKeys.mockReturnValue({
    keys: fakeKeys,
    keysBase64: 'fake-keys-base64',
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

  // Default RNFS mocks for small files
  const rnfs = require('@dr.pogodin/react-native-fs');
  setupRnfsMocks(SMALL_PLAINTEXT_SIZE);
  rnfs.appendFile.mockResolvedValue(undefined);
  rnfs.copyFile.mockResolvedValue(undefined);
  rnfs.writeFile.mockResolvedValue(undefined);
  rnfs.unlink.mockResolvedValue(undefined);
  rnfs.exists.mockResolvedValue(false);
  rnfs.mkdir.mockResolvedValue(undefined);
});

const baseOptions = {
  fileUri: 'file:///tmp/photo.jpg',
  mimeType: 'image/jpeg',
  fileName: 'photo.jpg',
  groupId: 'group-1',
};

// ---------------------------------------------------------------------------
// uploadMedia
// ---------------------------------------------------------------------------

describe('uploadMedia', () => {
  it('rejects files over 50MB', async () => {
    setupRnfsMocks(51 * 1024 * 1024);

    await expect(uploadMedia(baseOptions)).rejects.toThrow('File too large');
  });

  it('rejects files at exactly 50MB + 1 byte', async () => {
    setupRnfsMocks(50 * 1024 * 1024 + 1);

    await expect(uploadMedia(baseOptions)).rejects.toThrow('File too large');
  });

  it('accepts files at exactly 50MB', async () => {
    const size = 50 * 1024 * 1024;
    setupRnfsMocks(size);
    setupMockEncryptor(computeCtSize(size));

    const result = await uploadMedia(baseOptions);
    expect(result.mediaId).toBe('test-media-id');
  });

  it('rejects zero-byte files', async () => {
    setupRnfsMocks(0);

    await expect(uploadMedia(baseOptions)).rejects.toThrow('empty file');
  });

  it('stream-encrypts via createAttachmentEncryptor', async () => {
    await uploadMedia(baseOptions);

    expect(mockCreateAttachmentEncryptor).toHaveBeenCalledWith(fakeKeys);
    expect(mockEncPush).toHaveBeenCalledTimes(1); // 50 bytes < 1MB = 1 push
    expect(mockEncFinalize).toHaveBeenCalledTimes(1);
    expect(mockEncDestroy).toHaveBeenCalledTimes(1);
  });

  it('reads plaintext in ENCRYPT_READ_SIZE_BYTES chunks', async () => {
    const fileSize = 2.5 * 1024 * 1024; // 2.5MB -> 3 reads
    setupRnfsMocks(fileSize);
    setupMockEncryptor(computeCtSize(fileSize));

    await uploadMedia(baseOptions);

    // Find encryption reads (to source path, not cipher path)
    const rnfs = require('@dr.pogodin/react-native-fs');
    const encryptReads = rnfs.read.mock.calls.filter(
      (call: unknown[]) => !(call[0] as string).includes('-cipher.bin'),
    );
    expect(encryptReads).toHaveLength(3);
    expect(encryptReads[0][1]).toBe(1024 * 1024); // 1MB
    expect(encryptReads[0][2]).toBe(0);
    expect(encryptReads[1][1]).toBe(1024 * 1024); // 1MB
    expect(encryptReads[1][2]).toBe(1024 * 1024);
    expect(encryptReads[2][1]).toBe(0.5 * 1024 * 1024); // 0.5MB
    expect(encryptReads[2][2]).toBe(2 * 1024 * 1024);
    expect(mockEncPush).toHaveBeenCalledTimes(3);
  });

  it('appends ciphertext blocks to ct file via appendFile', async () => {
    const rnfs = require('@dr.pogodin/react-native-fs');
    // Make push return some data
    const ctBlock = new Uint8Array(16).fill(0xAA);
    mockEncPush.mockReturnValue(ctBlock);

    await uploadMedia(baseOptions);

    // 1 appendFile for push output + 1 for finalize tail
    expect(rnfs.appendFile).toHaveBeenCalledTimes(2);
    expect(rnfs.appendFile.mock.calls[0][0]).toContain('-cipher.bin');
    expect(rnfs.appendFile.mock.calls[0][2]).toBe('base64');
  });

  it('verifies ciphertext size matches expected length', async () => {
    const rnfs = require('@dr.pogodin/react-native-fs');
    // Override stat to return wrong ct size
    rnfs.stat.mockImplementation((path: string) => {
      if (path.includes('-cipher.bin')) {
        return Promise.resolve(makeStat(999)); // wrong!
      }
      return Promise.resolve(makeStat(SMALL_PLAINTEXT_SIZE));
    });

    await expect(uploadMedia(baseOptions)).rejects.toThrow('Ciphertext size mismatch');
  });

  it('reads IV from first 16 bytes of ciphertext file', async () => {
    const rnfs = require('@dr.pogodin/react-native-fs');
    await uploadMedia(baseOptions);

    const ivReadCall = rnfs.read.mock.calls.find(
      (call: unknown[]) => call[1] === 16 && call[2] === 0 && (call[0] as string).includes('-cipher.bin'),
    );
    expect(ivReadCall).toBeDefined();
    expect(ivReadCall![3]).toBe('base64');
  });

  it('computes totalChunks from ciphertext size', async () => {
    const fileSize = 5 * 1024 * 1024; // 5MB plaintext -> ct > 5MB -> 2 chunks
    const ctSize = computeCtSize(fileSize);
    setupRnfsMocks(fileSize);
    setupMockEncryptor(ctSize);

    await uploadMedia(baseOptions);

    expect(Math.ceil(ctSize / (5 * 1024 * 1024))).toBe(2);
    expect(mockUploadChunk).toHaveBeenCalledTimes(2);
  });

  it('sends encryptedMetadata only with first chunk', async () => {
    const fileSize = 5 * 1024 * 1024;
    const ctSize = computeCtSize(fileSize);
    setupRnfsMocks(fileSize);
    setupMockEncryptor(ctSize);

    await uploadMedia(baseOptions);

    const firstCall = mockUploadChunk.mock.calls[0][0] as Record<string, unknown>;
    const secondCall = mockUploadChunk.mock.calls[1][0] as Record<string, unknown>;
    expect(firstCall.encryptedMetadata).toBeDefined();
    expect(firstCall.encryptionIv).toBeDefined();
    expect(secondCall.encryptedMetadata).toBeUndefined();
    expect(secondCall.encryptionIv).toBeUndefined();
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

  it('inner metadata envelope includes v:1 and attachmentKey', async () => {
    await uploadMedia(baseOptions);

    const [metadataJson] = mockEncryptContent.mock.calls[0];
    const parsed = JSON.parse(metadataJson as string);
    expect(parsed.v).toBe(1);
    expect(parsed.attachmentKey).toBeDefined();
    expect(parsed.contentType).toBe('image/jpeg');
    expect(parsed.fileName).toBe('photo.jpg');
    expect(parsed.digest).toBeDefined();
  });

  it('inner metadata includes width and height when provided', async () => {
    await uploadMedia({ ...baseOptions, width: 1920, height: 1080 });

    const [metadataJson] = mockEncryptContent.mock.calls[0];
    const parsed = JSON.parse(metadataJson as string);
    expect(parsed.v).toBe(1);
    expect(parsed.width).toBe(1920);
    expect(parsed.height).toBe(1080);
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

  it('returns the media ID in result', async () => {
    const result = await uploadMedia(baseOptions);
    expect(result.mediaId).toBe('test-media-id');
    expect(result.attachmentKey).toBeInstanceOf(Uint8Array);
    expect(result.digest).toBeInstanceOf(Uint8Array);
  });

  it('retries on transient upload failure', async () => {
    mockUploadChunk
      .mockRejectedValueOnce(new Error('Network error'))
      .mockResolvedValueOnce({ uploadId: 'u1', received: 1, complete: false });

    await uploadMedia(baseOptions);

    expect(mockUploadChunk).toHaveBeenCalledTimes(2);
  });

  it('throws after max retries exhausted and saves failure row', async () => {
    mockUploadChunk.mockRejectedValue(new Error('Network error'));

    await expect(uploadMedia(baseOptions)).rejects.toThrow('Failed to upload media');
    expect(mockUploadChunk).toHaveBeenCalledTimes(3);
    expect(mockSaveMedia).toHaveBeenCalledTimes(1);
    const failedRow = mockSaveMedia.mock.calls[0][0];
    expect(failedRow.upload_state).toBe('failed');
  });

  it('does not retry on 401 error', async () => {
    mockUploadChunk.mockRejectedValue(new Error('401 Unauthorized'));

    await expect(uploadMedia(baseOptions)).rejects.toThrow('401');
    expect(mockUploadChunk).toHaveBeenCalledTimes(1);
  });

  it('does not retry on quota error', async () => {
    const quotaBody = JSON.stringify({
      error: 'QUOTA_EXCEEDED',
      details: {
        quota: {
          storage_bytes: 500 * 1024 * 1024,
          max_bytes: 500 * 1024 * 1024,
          file_count: 42,
          max_files: 1000,
          storage_percent: 100,
          files_percent: 4.2,
          evictable_bytes: 0,
        },
      },
    });
    mockUploadChunk.mockRejectedValue(new QuotaExceededError(quotaBody));

    await expect(uploadMedia(baseOptions)).rejects.toBeInstanceOf(QuotaExceededError);
    expect(mockUploadChunk).toHaveBeenCalledTimes(1);
    // No failed-row saveMedia call on typed error short-circuit
    expect(mockSaveMedia).not.toHaveBeenCalled();
  });

  it('does not retry on typed AuthError', async () => {
    mockUploadChunk.mockRejectedValue(new AuthError(401, 'token expired'));

    await expect(uploadMedia(baseOptions)).rejects.toBeInstanceOf(AuthError);
    expect(mockUploadChunk).toHaveBeenCalledTimes(1);
  });

  it('cleans up encryptor and cipher file when source file changes mid-read', async () => {
    const rnfs = require('@dr.pogodin/react-native-fs');
    // Short read: return fewer bytes than requested for the source file
    rnfs.read.mockImplementation((path: string, length: number) =>
      Promise.resolve(
        path.includes('-cipher.bin')
          ? makeFakeBase64(length)
          : makeFakeBase64(length - 1),
      ),
    );

    await expect(uploadMedia(baseOptions)).rejects.toThrow('File changed');

    expect(mockEncDestroy).toHaveBeenCalledTimes(1);
    expect(rnfs.unlink).toHaveBeenCalledWith(
      expect.stringContaining('-cipher.bin'),
    );
    expect(mockUploadChunk).not.toHaveBeenCalled();
  });

  it('respects abort signal before phase 1 encryption', async () => {
    const rnfs = require('@dr.pogodin/react-native-fs');
    const controller = new AbortController();
    controller.abort();

    await expect(
      uploadMedia({ ...baseOptions, signal: controller.signal }),
    ).rejects.toThrow('cancelled');

    expect(mockEncDestroy).toHaveBeenCalled();
    expect(rnfs.unlink).toHaveBeenCalled();
  });

  it('respects abort signal during phase 2 chunk upload', async () => {
    const rnfs = require('@dr.pogodin/react-native-fs');
    const fileSize = 5 * 1024 * 1024;
    const ctSize = computeCtSize(fileSize);
    setupRnfsMocks(fileSize);
    setupMockEncryptor(ctSize);

    const controller = new AbortController();

    // Abort after first chunk upload succeeds
    mockUploadChunk.mockImplementation(() => {
      controller.abort();
      return Promise.resolve({ uploadId: 'u1', received: 1, complete: false });
    });

    await expect(
      uploadMedia({ ...baseOptions, signal: controller.signal }),
    ).rejects.toThrow('cancelled');

    // ctPath should be cleaned up in finally
    const unlinkCalls = rnfs.unlink.mock.calls.map((c: unknown[]) => c[0] as string);
    const cipherCleanup = unlinkCalls.some((p: string) => p.includes('-cipher.bin'));
    expect(cipherCleanup).toBe(true);
  });

  it('cleans up cipher temp file in finally block', async () => {
    const rnfs = require('@dr.pogodin/react-native-fs');

    await uploadMedia(baseOptions);

    const unlinkCalls = rnfs.unlink.mock.calls.map((c: unknown[]) => c[0] as string);
    const cipherUnlink = unlinkCalls.find((p: string) => p.includes('-cipher.bin'));
    expect(cipherUnlink).toBeDefined();
  });

  it('copies sanitized plaintext to canonical path via copyFile', async () => {
    const rnfs = require('@dr.pogodin/react-native-fs');

    await uploadMedia(baseOptions);

    const copyFileCalls = rnfs.copyFile.mock.calls;
    const canonicalCopy = copyFileCalls.find(
      (c: unknown[]) => (c[1] as string).includes('/media/test-media-id.jpg'),
    );
    expect(canonicalCopy).toBeDefined();
    // Source is now the sanitized staging path (image goes through sanitizeStillImage)
    expect(canonicalCopy![0]).toContain('-staging.bin');
  });

  it('handles content:// URIs by staging to cache', async () => {
    const rnfs = require('@dr.pogodin/react-native-fs');

    await uploadMedia({
      ...baseOptions,
      fileUri: 'content://media/external/images/123',
    });

    // First copyFile is the staging copy (content:// -> staging)
    const firstCopy = rnfs.copyFile.mock.calls[0];
    expect(firstCopy[0]).toBe('content://media/external/images/123');
    expect(firstCopy[1]).toContain('-staging.bin');

    // Regression guard: the content:// staging file must be cleaned up in finally.
    // For content:// URIs resolveUri returns sourcePath === stagingPath, and the
    // sanitized image is written back into the staging path in place, so cleanup
    // must be unconditional (see mediaUploadService finally block).
    const stagingPath = firstCopy[1];
    expect(rnfs.unlink.mock.calls.some((c: string[]) => c[0] === stagingPath)).toBe(true);
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
});

// ---------------------------------------------------------------------------
// uploadMedia — video branch (pass-through mime/fileName)
// ---------------------------------------------------------------------------

describe('uploadMedia — video branch', () => {
  const { prepareVideoForUpload } = require('../media/videoProcessing') as {
    prepareVideoForUpload: jest.Mock;
  };

  beforeEach(() => {
    prepareVideoForUpload.mockResolvedValue({
      videoPath: '/tmp/test-cache/test-media-id-staging.bin',
      mimeType: 'video/quicktime',
      fileName: 'test-media-id.mov',
      width: 720,
      height: 1280,
      duration: 12.3,
      fileSize: SMALL_PLAINTEXT_SIZE,
      thumbnailPath: null,
    });
  });

  const videoOptions = {
    fileUri: 'file:///tmp/clip.mov',
    mimeType: 'video/quicktime',
    fileName: 'IMG_0001.MOV',
    groupId: 'group-1',
  };

  it('passes sourceMimeType as 2nd arg to prepareVideoForUpload', async () => {
    await uploadMedia(videoOptions);

    expect(prepareVideoForUpload).toHaveBeenCalledWith(
      '/tmp/clip.mov',
      'video/quicktime',
      'test-media-id',
      expect.objectContaining({ signal: undefined }),
    );
  });

  it('encrypts metadata envelope with pass-through contentType and fileName', async () => {
    await uploadMedia(videoOptions);

    const [metadataJson] = mockEncryptContent.mock.calls[0];
    const parsed = JSON.parse(metadataJson as string);
    expect(parsed.contentType).toBe('video/quicktime');
    expect(parsed.fileName).toBe('test-media-id.mov');
    expect(parsed.duration).toBe(12.3);
  });

  it('saves media row with pass-through content_type', async () => {
    await uploadMedia(videoOptions);

    expect(mockSaveMedia).toHaveBeenCalledTimes(1);
    const row = mockSaveMedia.mock.calls[0][0];
    expect(row.content_type).toBe('video/quicktime');
  });

  it('copies plaintext to canonical path with pass-through extension', async () => {
    const rnfs = require('@dr.pogodin/react-native-fs');

    await uploadMedia(videoOptions);

    const copyFileCalls = rnfs.copyFile.mock.calls;
    const canonicalCopy = copyFileCalls.find(
      (c: unknown[]) => (c[1] as string).includes('/media/test-media-id.mov'),
    );
    expect(canonicalCopy).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// uploadMediaBatch
// ---------------------------------------------------------------------------

describe('uploadMediaBatch', () => {
  const fakeItems: PickedMedia[] = [
    {
      uri: 'file:///photo1.jpg',
      type: 'image/jpeg',
      fileName: 'photo1.jpg',
      fileSize: 50,
      width: 100,
      height: 100,
    },
    {
      uri: 'file:///photo2.png',
      type: 'image/png',
      fileName: 'photo2.png',
      fileSize: 80,
      width: 200,
      height: 200,
    },
  ];

  it('calls uploadMedia for each item and maps uri, returns collected IDs', async () => {
    mockGenerateUUID
      .mockReturnValueOnce('batch-id-1')
      .mockReturnValueOnce('batch-id-2');

    const ids = await uploadMediaBatch(fakeItems, 'group-1');

    expect(ids).toEqual(['batch-id-1', 'batch-id-2']);
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
    const rnfs = require('@dr.pogodin/react-native-fs');
    rnfs.readDir.mockResolvedValueOnce([
      { name: 'abc-chunk-0.bin', path: '/tmp/test-cache/abc-chunk-0.bin', mtime: new Date(Date.now() - 7200_000) },
      { name: 'recent-chunk-0.bin', path: '/tmp/test-cache/recent-chunk-0.bin', mtime: new Date() },
      { name: 'unrelated.txt', path: '/tmp/test-cache/unrelated.txt', mtime: new Date(Date.now() - 7200_000) },
    ]);

    await cleanupOrphanedChunks();

    expect(rnfs.unlink).toHaveBeenCalledWith('/tmp/test-cache/abc-chunk-0.bin');
    expect(rnfs.unlink).not.toHaveBeenCalledWith('/tmp/test-cache/recent-chunk-0.bin');
    expect(rnfs.unlink).not.toHaveBeenCalledWith('/tmp/test-cache/unrelated.txt');
  });

  it('removes stale cipher temp files older than 1 hour', async () => {
    const rnfs = require('@dr.pogodin/react-native-fs');
    rnfs.readDir.mockResolvedValueOnce([
      { name: 'abc-cipher.bin', path: '/tmp/test-cache/abc-cipher.bin', mtime: new Date(Date.now() - 7200_000) },
      { name: 'recent-cipher.bin', path: '/tmp/test-cache/recent-cipher.bin', mtime: new Date() },
    ]);

    await cleanupOrphanedChunks();

    expect(rnfs.unlink).toHaveBeenCalledWith('/tmp/test-cache/abc-cipher.bin');
    expect(rnfs.unlink).not.toHaveBeenCalledWith('/tmp/test-cache/recent-cipher.bin');
  });

  it('removes stale staging temp files older than 1 hour', async () => {
    const rnfs = require('@dr.pogodin/react-native-fs');
    rnfs.readDir.mockResolvedValueOnce([
      { name: 'abc-staging.bin', path: '/tmp/test-cache/abc-staging.bin', mtime: new Date(Date.now() - 7200_000) },
      { name: 'recent-staging.bin', path: '/tmp/test-cache/recent-staging.bin', mtime: new Date() },
    ]);

    await cleanupOrphanedChunks();

    expect(rnfs.unlink).toHaveBeenCalledWith('/tmp/test-cache/abc-staging.bin');
    expect(rnfs.unlink).not.toHaveBeenCalledWith('/tmp/test-cache/recent-staging.bin');
  });
});
