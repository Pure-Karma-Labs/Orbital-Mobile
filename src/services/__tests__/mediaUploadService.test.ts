/**
 * Tests for mediaUploadService -- streaming encryption + chunked upload pipeline.
 */

jest.mock('@dr.pogodin/react-native-fs');

jest.mock('../media/imageSanitizer', () => ({
  sanitizeStillImage: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../media/videoProcessing', () => ({
  prepareVideoForUpload: jest.fn(),
  // Real implementation, not a stub: videoProcessing re-exports the transcoder's
  // isCancellation (security invariant #7 forbids mediaUploadService importing
  // the transcoder itself), and the global transcoder mock provides a working
  // ECANCELLED check. A jest.fn() here would silently break
  // isUploadCancellation for every abort-path test.
  isCancellation: require('orbital-media-transcoder').isCancellation,
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
  // Promoted out of mediaUploadService into crypto/utils (#578) so the
  // download read loop can share one decode implementation.
  base64ToUint8Array: jest.fn((b64: string) => {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }),
}));

const mockUploadChunk = jest.fn();
const mockCompleteUpload = jest.fn();

jest.mock('../api/media', () => ({
  uploadChunk: (...args: unknown[]) => mockUploadChunk(...args),
  completeUpload: (...args: unknown[]) => mockCompleteUpload(...args),
}));

const mockSaveMedia = jest.fn();
const mockDeleteMedia = jest.fn();

jest.mock('../../database/repositories/mediaRepository', () => ({
  saveMedia: (...args: unknown[]) => mockSaveMedia(...args),
  deleteMedia: (...args: unknown[]) => mockDeleteMedia(...args),
}));

const mockUpsertMedia = jest.fn();
const mockRemoveMedia = jest.fn();
/** Mutable backing store for the mocked Zustand `media` map — reset per test. */
let mockMediaMap: Record<string, { localPath: string | null }> = {};

jest.mock('../../stores/useAppStore', () => ({
  useAppStore: {
    getState: jest.fn(() => ({
      upsertMedia: mockUpsertMedia,
      removeMedia: mockRemoveMedia,
      media: mockMediaMap,
    })),
  },
}));

const mockGenerateUUID = jest.fn(() => 'test-media-id');

jest.mock('../../utils/uuid', () => ({
  generateUUID: () => mockGenerateUUID(),
}));

import {
  uploadMedia,
  uploadMediaBatch,
  cleanupOrphanedChunks,
  isUploadCancellation,
  type UploadProgressEvent,
  type BatchUploadProgressEvent,
  type BatchUploadError,
} from '../mediaUploadService';
import { QuotaExceededError, AuthError } from '../api/errors';
import { UPLOAD_CANCELLED_MESSAGE } from '../media/uploadCancellation';
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

/** Mirrors mediaUploadService's private CHUNK_SIZE_BYTES (5MB) for progress-math assertions. */
const CHUNK_SIZE_BYTES = 5 * 1024 * 1024;

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
  // clearAllMocks does NOT drain mockReturnValueOnce queues (only mockReset
  // does) — without this, ids queued by a test that consumes fewer than it
  // arms leak into later tests and misattribute media ids (panel finding,
  // PR #719 review).
  mockGenerateUUID.mockReset();
  mockGenerateUUID.mockImplementation(() => 'test-media-id');
  mockMediaMap = {};

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

  // Pins the class-beats-size decision (#707 / Backend #243): an image is tagged
  // 'image' EXPLICITLY, which deliberately withdraws the incidental video-hold that
  // >= 3 MiB photos get today from the server's NULL size-floor fallback. Changing
  // this to omit the field for images is a retention-policy change, not a refactor.
  it('tags an image upload with content_class "image" (class beats the server size floor)', async () => {
    await uploadMedia(baseOptions);

    const firstCall = mockUploadChunk.mock.calls[0][0] as Record<string, unknown>;
    expect(firstCall.contentClass).toBe('image');
  });

  it('sends contentClass only with the first chunk', async () => {
    const fileSize = 5 * 1024 * 1024;
    const ctSize = computeCtSize(fileSize);
    setupRnfsMocks(fileSize);
    setupMockEncryptor(ctSize);

    await uploadMedia(baseOptions);

    expect(mockUploadChunk).toHaveBeenCalledTimes(2);
    const firstCall = mockUploadChunk.mock.calls[0][0] as Record<string, unknown>;
    const secondCall = mockUploadChunk.mock.calls[1][0] as Record<string, unknown>;
    expect(firstCall.contentClass).toBe('image');
    expect(secondCall.contentClass).toBeUndefined();
  });

  // Unknown types must stay untagged so the server keeps its NULL size-floor
  // fallback rather than being handed a mislabelled class.
  it('omits contentClass for a type that is neither image/* nor video/*', async () => {
    await uploadMedia({ ...baseOptions, mimeType: 'audio/mp4', fileName: 'memo.m4a' });

    const firstCall = mockUploadChunk.mock.calls[0][0] as Record<string, unknown>;
    expect(firstCall.contentClass).toBeUndefined();
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

  it('saves media row with archive_confirmed=1 on success (own upload auto-confirmed)', async () => {
    await uploadMedia(baseOptions);

    expect(mockSaveMedia).toHaveBeenCalledTimes(1);
    const row = mockSaveMedia.mock.calls[0][0];
    expect(row.archive_confirmed).toBe(1);
  });

  it('saves failed row with archive_confirmed=0 (or absent) on failure', async () => {
    mockUploadChunk.mockRejectedValue(new Error('Network error'));

    await expect(uploadMedia(baseOptions)).rejects.toThrow('Failed to upload media');
    expect(mockSaveMedia).toHaveBeenCalledTimes(1);
    const failedRow = mockSaveMedia.mock.calls[0][0];
    // Failed rows default to 0
    expect(failedRow.archive_confirmed ?? 0).toBe(0);
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

  it('emits a full progress sequence: encrypting totalBytes, then per-chunk fraction/bytesSent culminating at 1', async () => {
    const fileSize = 12 * 1024 * 1024; // -> 3 chunks
    const ctSize = computeCtSize(fileSize);
    setupRnfsMocks(fileSize);
    setupMockEncryptor(ctSize);

    const events: UploadProgressEvent[] = [];
    await uploadMedia({ ...baseOptions, onProgress: (e) => events.push(e) });

    const totalChunks = Math.ceil(ctSize / CHUNK_SIZE_BYTES);
    expect(totalChunks).toBeGreaterThanOrEqual(2);

    const encryptingWithTotal = events.find(
      (e) => e.phase === 'encrypting' && e.totalBytes === ctSize,
    );
    expect(encryptingWithTotal).toBeDefined();

    // Per-chunk uploading events only -- excludes the pre-loop bytesSent:0 marker
    // that announces the upload phase before the first chunk goes out.
    const chunkEvents = events.filter((e) => e.phase === 'uploading' && (e.bytesSent ?? 0) > 0);
    expect(chunkEvents).toHaveLength(totalChunks);
    chunkEvents.forEach((e, i) => {
      expect(e.fraction).toBe((i + 1) / totalChunks);
      expect(e.bytesSent).toBe(Math.min((i + 1) * CHUNK_SIZE_BYTES, ctSize));
    });

    const last = chunkEvents[chunkEvents.length - 1];
    expect(last.fraction).toBe(1);
    expect(last.bytesSent).toBe(ctSize);
  });

  it('emits exactly one per-chunk uploading event for a single-chunk image (the 0→1 jump)', async () => {
    const events: UploadProgressEvent[] = [];
    await uploadMedia({ ...baseOptions, onProgress: (e) => events.push(e) });

    const chunkEvents = events.filter((e) => e.phase === 'uploading' && (e.bytesSent ?? 0) > 0);
    expect(chunkEvents).toHaveLength(1);
    expect(chunkEvents[0].fraction).toBe(1);
    expect(chunkEvents[0].bytesSent).toBe(SMALL_CT_SIZE);
  });
});

// ---------------------------------------------------------------------------
// isUploadCancellation
// ---------------------------------------------------------------------------

describe('isUploadCancellation', () => {
  it('is true for the upload-cancelled sentinel message', () => {
    expect(isUploadCancellation(new Error(UPLOAD_CANCELLED_MESSAGE))).toBe(true);
  });

  it('is true for a transcoder ECANCELLED-shaped rejection', () => {
    expect(isUploadCancellation({ code: 'ECANCELLED' })).toBe(true);
  });

  it('is false for an unrelated Error', () => {
    expect(isUploadCancellation(new Error('boom'))).toBe(false);
  });

  it('is false for undefined', () => {
    expect(isUploadCancellation(undefined)).toBe(false);
  });

  it('is false for null', () => {
    expect(isUploadCancellation(null)).toBe(false);
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

  // NESTED on purpose: un-nulling thumbnailPath in the parent beforeEach would make
  // the thumbnail encrypt first and reorder mockEncryptContent.mock.calls, breaking
  // the sibling assertions above.
  describe('video branch — with thumbnail', () => {
    beforeEach(() => {
      prepareVideoForUpload.mockResolvedValue({
        videoPath: '/tmp/test-cache/parent-media-id-staging.bin',
        mimeType: 'video/quicktime',
        fileName: 'parent-media-id.mov',
        width: 720,
        height: 1280,
        duration: 12.3,
        fileSize: SMALL_PLAINTEXT_SIZE,
        thumbnailPath: '/tmp/test-cache/thumb.jpg',
      });

      // The parent draws its id first, the thumbnail recursion second. Without
      // distinct ids the two uploads collide on the same cipher/chunk temp paths.
      mockGenerateUUID
        .mockReturnValueOnce('parent-media-id')
        .mockReturnValueOnce('thumb-media-id');
    });

    it('sends content_class "video" on both the video and its inherited thumbnail', async () => {
      await uploadMedia(videoOptions);

      // Load-bearing: thumbnail upload failure degrades silently inside a
      // try/catch, so without this count a broken thumbnail path passes vacuously.
      expect(mockUploadChunk).toHaveBeenCalledTimes(2);

      const calls = mockUploadChunk.mock.calls.map(
        (c: unknown[]) => c[0] as Record<string, unknown>,
      );
      const parentCall = calls.find((c) => c.mediaId === 'parent-media-id');
      const thumbCall = calls.find((c) => c.mediaId === 'thumb-media-id');

      expect(parentCall).toBeDefined();
      expect(thumbCall).toBeDefined();
      // The thumbnail is an image/jpeg but inherits 'video' so a retained video
      // keeps its poster frame instead of the thumbnail being evicted under it.
      expect(parentCall!.contentClass).toBe('video');
      expect(thumbCall!.contentClass).toBe('video');
    });
  });

  describe('video branch — progress + cancellation', () => {
    it('maps transcode progress into compressing*0.3, then starts the upload phase at 0.3 and ends at 1', async () => {
      // prepareVideoForUpload is mocked -- drive its onProgress callback directly
      // so we control the transcode progress values fed into the 0.3x mapping.
      prepareVideoForUpload.mockImplementation(
        (
          _src: string,
          _mime: string,
          _id: string,
          opts: { onProgress?: (p: number) => void },
        ) => {
          opts.onProgress?.(0.5);
          opts.onProgress?.(1);
          return Promise.resolve({
            videoPath: '/tmp/test-cache/test-media-id-staging.bin',
            mimeType: 'video/quicktime',
            fileName: 'test-media-id.mov',
            width: 720,
            height: 1280,
            duration: 12.3,
            fileSize: SMALL_PLAINTEXT_SIZE,
            thumbnailPath: null,
          });
        },
      );

      const events: UploadProgressEvent[] = [];
      await uploadMedia({ ...videoOptions, onProgress: (e) => events.push(e) });

      // Excludes the initial fraction:0 "compressing started" marker emitted
      // before prepareVideoForUpload is even called -- an assertion over the
      // raw phase array would silently accept that marker being dropped.
      const compressingFromTranscode = events
        .filter((e) => e.phase === 'compressing' && e.fraction > 0)
        .map((e) => e.fraction);
      expect(compressingFromTranscode).toEqual([0.15, 0.3]);

      const uploadingEvents = events.filter((e) => e.phase === 'uploading');
      expect(uploadingEvents.length).toBeGreaterThan(0);
      expect(uploadingEvents[0].fraction).toBe(0.3);
      expect(uploadingEvents[uploadingEvents.length - 1].fraction).toBe(1);
    });

    // NESTED (mirrors the sibling 'with thumbnail' block above): reuses the
    // two-UUID mock pattern so the parent and its thumbnail recursion don't
    // collide on the same generated media id.
    describe('with thumbnail', () => {
      beforeEach(() => {
        prepareVideoForUpload.mockResolvedValue({
          videoPath: '/tmp/test-cache/parent-media-id-staging.bin',
          mimeType: 'video/quicktime',
          fileName: 'parent-media-id.mov',
          width: 720,
          height: 1280,
          duration: 12.3,
          fileSize: SMALL_PLAINTEXT_SIZE,
          thumbnailPath: '/tmp/test-cache/thumb.jpg',
        });

        mockGenerateUUID
          .mockReturnValueOnce('parent-media-id')
          .mockReturnValueOnce('thumb-media-id');
      });

      it("thumbnail child never emits into the parent's progress channel; bytesSent stays monotonic", async () => {
        const events: UploadProgressEvent[] = [];
        await uploadMedia({ ...videoOptions, onProgress: (e) => events.push(e) });

        let lastBytesSent = -Infinity;
        for (const e of events) {
          if (e.bytesSent != null) {
            expect(e.bytesSent).toBeGreaterThanOrEqual(lastBytesSent);
            lastBytesSent = e.bytesSent;
          }
        }

        // The thumbnail recursion is a single small chunk too -- if it leaked its
        // own uploadMedia progress into the parent's onProgress this would double.
        const chunkEvents = events.filter(
          (e) => e.phase === 'uploading' && (e.bytesSent ?? 0) > 0,
        );
        expect(chunkEvents).toHaveLength(1);
        expect(chunkEvents[0].bytesSent).toBe(computeCtSize(SMALL_PLAINTEXT_SIZE));
      });

      it('rethrows a cancellation from the thumbnail child instead of degrading to duration-only', async () => {
        const controller = new AbortController();
        mockUploadChunk.mockImplementation((args: Record<string, unknown>) => {
          // The thumbnail child uploads first (its recursive uploadMedia call
          // completes before the parent's own chunk loop begins).
          if (args.mediaId === 'thumb-media-id') {
            controller.abort();
            return Promise.reject(new Error(UPLOAD_CANCELLED_MESSAGE));
          }
          return Promise.resolve({ uploadId: 'u1', received: 1, complete: false });
        });

        const err = await uploadMedia({ ...videoOptions, signal: controller.signal }).catch(
          (e) => e,
        );

        expect(isUploadCancellation(err)).toBe(true);
        // Only the thumbnail's OWN metadata envelope was ever built (it builds
        // its metadata before its chunk-upload loop runs). The parent's own
        // metadata build -- which is where thumbnailMediaId would be attached --
        // never runs on a cancel rethrow, proving it did not silently degrade to
        // a duration-only upload.
        expect(mockEncryptContent).toHaveBeenCalledTimes(1);
        const [metadataJson] = mockEncryptContent.mock.calls[0];
        const parsed = JSON.parse(metadataJson as string);
        expect(parsed).not.toHaveProperty('thumbnailMediaId');
        expect(parsed.contentType).toBe('image/jpeg');
        // Only the thumbnail's own chunk went out; the parent's chunk loop never started.
        expect(mockUploadChunk).toHaveBeenCalledTimes(1);
      });
    });
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

  it('stamps every progress event with itemIndex/itemCount', async () => {
    mockGenerateUUID
      .mockReturnValueOnce('batch-id-1')
      .mockReturnValueOnce('batch-id-2');

    const events: BatchUploadProgressEvent[] = [];
    await uploadMediaBatch(fakeItems, 'group-1', { onProgress: (e) => events.push(e) });

    expect(events.length).toBeGreaterThan(0);
    const item0Count = events.filter((e) => e.itemIndex === 0).length;
    const item1Count = events.filter((e) => e.itemIndex === 1).length;
    expect(item0Count).toBeGreaterThan(0);
    expect(item1Count).toBeGreaterThan(0);
    for (const e of events) {
      expect(e.itemCount).toBe(2);
    }
  });

  it("threads the batch signal into every item's uploadChunk call", async () => {
    mockGenerateUUID
      .mockReturnValueOnce('batch-id-1')
      .mockReturnValueOnce('batch-id-2');

    const controller = new AbortController();
    await uploadMediaBatch(fakeItems, 'group-1', { signal: controller.signal });

    expect(mockUploadChunk).toHaveBeenCalledTimes(2);
    for (const call of mockUploadChunk.mock.calls) {
      expect(call[1]).toBe(controller.signal);
    }
  });

  it('does not start item 2 when the signal aborts in the gap between items', async () => {
    mockGenerateUUID
      .mockReturnValueOnce('batch-id-1')
      .mockReturnValueOnce('batch-id-2');

    const controller = new AbortController();
    // Item 1 is a single small chunk -- abort lands after it completes, in the
    // gap the batch loop checks before starting item 2.
    mockUploadChunk.mockImplementationOnce(() => {
      controller.abort();
      return Promise.resolve({ uploadId: 'u1', received: 1, complete: false });
    });

    await expect(
      uploadMediaBatch(fakeItems, 'group-1', { signal: controller.signal }),
    ).rejects.toThrow('cancelled');

    // Only item 1's chunk went out -- item 2's uploadMedia (and its uploadChunk
    // call) never started.
    expect(mockUploadChunk).toHaveBeenCalledTimes(1);
  });

  it("rejects when the signal aborts mid item 1's own chunk loop", async () => {
    const fileSize = 5 * 1024 * 1024; // -> 2 chunks per item
    const ctSize = computeCtSize(fileSize);
    setupRnfsMocks(fileSize);
    setupMockEncryptor(ctSize);
    mockGenerateUUID
      .mockReturnValueOnce('batch-id-1')
      .mockReturnValueOnce('batch-id-2');

    const controller = new AbortController();
    // Abort during item 1's FIRST chunk -- the abort check before its SECOND
    // chunk must fail item 1 itself, not just skip item 2.
    mockUploadChunk.mockImplementationOnce(() => {
      controller.abort();
      return Promise.resolve({ uploadId: 'u1', received: 1, complete: false });
    });

    await expect(
      uploadMediaBatch(fakeItems, 'group-1', { signal: controller.signal }),
    ).rejects.toThrow('cancelled');

    // Only item 1's first chunk went out -- its second chunk, and all of item 2,
    // never did.
    expect(mockUploadChunk).toHaveBeenCalledTimes(1);
  });

  it('rolls back item 1 locally (delete + unlink) and reports it in uploadedMediaIds when the batch cancels before item 2', async () => {
    mockGenerateUUID
      .mockReturnValueOnce('batch-id-1')
      .mockReturnValueOnce('batch-id-2');

    const localPath = '/tmp/media/batch-id-1.jpg';
    mockMediaMap['batch-id-1'] = { localPath };

    const controller = new AbortController();
    // Abort DURING item 1's completeUpload: the pre-completeUpload abort check
    // has already passed, so item 1 finishes and lands in `ids` — the batch's
    // item-2 gap check then converts the abort into a cancellation, and the
    // completed item 1 must be rolled back.
    mockCompleteUpload.mockImplementationOnce(() => {
      controller.abort();
      return Promise.resolve({ mediaId: 'batch-id-1', complete: true });
    });

    const rnfs = require('@dr.pogodin/react-native-fs');
    const err = (await uploadMediaBatch(fakeItems, 'group-1', {
      signal: controller.signal,
    }).catch((e) => e)) as BatchUploadError;

    expect(mockDeleteMedia).toHaveBeenCalledWith('batch-id-1');
    expect(mockRemoveMedia).toHaveBeenCalledWith('batch-id-1');
    expect(rnfs.unlink).toHaveBeenCalledWith(localPath);
    expect(err.uploadedMediaIds).toContain('batch-id-1');
  });

  it('cancels instead of completing when the abort lands after the final chunk POST (pre-completeUpload check)', async () => {
    mockGenerateUUID.mockReturnValueOnce('tail-id-1');

    const controller = new AbortController();
    // Abort fires while the LAST (only) chunk POST is in flight — the old code
    // would sail through completeUpload + canonical copy and resolve the batch,
    // publishing the post the user cancelled (panel finding, PR #719 review).
    mockUploadChunk.mockImplementationOnce(() => {
      controller.abort();
      return Promise.resolve({ uploadId: 'u1', received: 1, complete: false });
    });

    await expect(
      uploadMediaBatch([fakeItems[0]], 'group-1', { signal: controller.signal }),
    ).rejects.toThrow('cancelled');

    // The item was stopped BEFORE the unsignalled tail — no server complete,
    // no local commit to roll back.
    expect(mockCompleteUpload).not.toHaveBeenCalled();
    expect(mockSaveMedia).not.toHaveBeenCalled();
  });

  it('rejects and rolls back when the abort lands after the LAST item fully completes (post-loop check)', async () => {
    mockGenerateUUID.mockReturnValueOnce('tail-id-2');

    const localPath = '/tmp/media/tail-id-2.jpg';
    mockMediaMap['tail-id-2'] = { localPath };

    const controller = new AbortController();
    // Abort fires during the LAST item's completeUpload: the item itself
    // finishes (its pre-check already passed), so only the batch's trailing
    // post-loop check can convert this into a cancellation — without it the
    // batch resolves and the composer publishes.
    mockCompleteUpload.mockImplementationOnce(() => {
      controller.abort();
      return Promise.resolve({ mediaId: 'tail-id-2', complete: true });
    });

    const rnfs = require('@dr.pogodin/react-native-fs');
    const err = (await uploadMediaBatch([fakeItems[0]], 'group-1', {
      signal: controller.signal,
    }).catch((e) => e)) as BatchUploadError;

    expect(err.message).toContain('cancelled');
    expect(mockDeleteMedia).toHaveBeenCalledWith('tail-id-2');
    expect(mockRemoveMedia).toHaveBeenCalledWith('tail-id-2');
    expect(rnfs.unlink).toHaveBeenCalledWith(localPath);
    expect(err.uploadedMediaIds).toContain('tail-id-2');
  });
});

// ---------------------------------------------------------------------------
// cleanupOrphanedChunks
// ---------------------------------------------------------------------------

describe('cleanupOrphanedChunks', () => {
  interface CacheEntry {
    name: string;
    path: string;
    mtime: Date;
  }

  /** Entries the fake Caches listing currently reports. */
  let cacheEntries: CacheEntry[] = [];
  /** Fresh mtimes returned by a re-stat, overriding the listing per path. */
  let restatMtimes: Map<string, Date>;

  /**
   * Install one directory listing AND the matching per-file stat results.
   *
   * The reaper re-stats every candidate immediately before unlinking, so the
   * fixture has to model both: `readDir` is the (possibly stale) snapshot,
   * `stat` is the truth at delete time. They agree unless a test overrides a
   * path in `restatMtimes` to simulate a concurrent recreate.
   */
  function listCache(entries: CacheEntry[]): void {
    const rnfs = require('@dr.pogodin/react-native-fs');
    cacheEntries = entries;
    rnfs.readDir.mockResolvedValueOnce(entries);
    rnfs.stat.mockImplementation((p: string) => {
      const entry = cacheEntries.find((e) => e.path === p);
      if (!entry) return Promise.reject(new Error(`ENOENT: ${p}`));
      const mtime = restatMtimes.get(p) ?? entry.mtime;
      return Promise.resolve({
        size: 1024,
        mtime,
        ctime: mtime,
        isFile: () => true,
        isDirectory: () => false,
      });
    });
  }

  beforeEach(() => {
    cacheEntries = [];
    restatMtimes = new Map();
  });

  it('removes stale chunk files older than 1 hour', async () => {
    const rnfs = require('@dr.pogodin/react-native-fs');
    listCache([
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
    listCache([
      { name: 'abc-cipher.bin', path: '/tmp/test-cache/abc-cipher.bin', mtime: new Date(Date.now() - 7200_000) },
      { name: 'recent-cipher.bin', path: '/tmp/test-cache/recent-cipher.bin', mtime: new Date() },
    ]);

    await cleanupOrphanedChunks();

    expect(rnfs.unlink).toHaveBeenCalledWith('/tmp/test-cache/abc-cipher.bin');
    expect(rnfs.unlink).not.toHaveBeenCalledWith('/tmp/test-cache/recent-cipher.bin');
  });

  // The download path stages ciphertext as `{id}-dl-cipher.bin` (#578). The
  // `endsWith('-cipher.bin')` predicate already covers it — this pins that so a
  // future narrowing of the predicate can't silently orphan download staging.
  it('removes stale DOWNLOAD cipher staging files older than 1 hour', async () => {
    const rnfs = require('@dr.pogodin/react-native-fs');
    listCache([
      { name: 'abc-dl-cipher.bin', path: '/tmp/test-cache/abc-dl-cipher.bin', mtime: new Date(Date.now() - 7200_000) },
      { name: 'recent-dl-cipher.bin', path: '/tmp/test-cache/recent-dl-cipher.bin', mtime: new Date() },
    ]);

    await cleanupOrphanedChunks();

    expect(rnfs.unlink).toHaveBeenCalledWith('/tmp/test-cache/abc-dl-cipher.bin');
    expect(rnfs.unlink).not.toHaveBeenCalledWith('/tmp/test-cache/recent-dl-cipher.bin');
  });

  it('removes stale staging temp files older than 1 hour', async () => {
    const rnfs = require('@dr.pogodin/react-native-fs');
    listCache([
      { name: 'abc-staging.bin', path: '/tmp/test-cache/abc-staging.bin', mtime: new Date(Date.now() - 7200_000) },
      { name: 'recent-staging.bin', path: '/tmp/test-cache/recent-staging.bin', mtime: new Date() },
    ]);

    await cleanupOrphanedChunks();

    expect(rnfs.unlink).toHaveBeenCalledWith('/tmp/test-cache/abc-staging.bin');
    expect(rnfs.unlink).not.toHaveBeenCalledWith('/tmp/test-cache/recent-staging.bin');
  });

  // The readDir snapshot can be stale by the time the loop reaches an entry: a
  // download that just started may have recreated that exact deterministic path.
  // Deleting it would silently truncate a live transfer.
  it('skips a candidate that a concurrent transfer recreated since the listing', async () => {
    const rnfs = require('@dr.pogodin/react-native-fs');
    const LIVE = '/tmp/test-cache/live-dl-cipher.bin';
    const DEAD = '/tmp/test-cache/dead-dl-cipher.bin';
    listCache([
      { name: 'live-dl-cipher.bin', path: LIVE, mtime: new Date(Date.now() - 7200_000) },
      { name: 'dead-dl-cipher.bin', path: DEAD, mtime: new Date(Date.now() - 7200_000) },
    ]);
    // LIVE was recreated after the listing — its fresh mtime is now.
    restatMtimes.set(LIVE, new Date());

    await cleanupOrphanedChunks();

    expect(rnfs.unlink).not.toHaveBeenCalledWith(LIVE);
    expect(rnfs.unlink).toHaveBeenCalledWith(DEAD);
  });

  // If we cannot confirm staleness we do not delete.
  it('skips a candidate whose re-stat fails', async () => {
    const rnfs = require('@dr.pogodin/react-native-fs');
    listCache([
      { name: 'abc-cipher.bin', path: '/tmp/test-cache/abc-cipher.bin', mtime: new Date(Date.now() - 7200_000) },
    ]);
    rnfs.stat.mockRejectedValue(new Error('ENOENT'));

    await cleanupOrphanedChunks();

    expect(rnfs.unlink).not.toHaveBeenCalledWith('/tmp/test-cache/abc-cipher.bin');
  });

  it('removes stale .mp4 transcode staging files older than 1 hour', async () => {
    // The video transcode staging file cannot use the .bin suffix -- AVAssetWriter
    // derives the container type from the extension.
    const rnfs = require('@dr.pogodin/react-native-fs');
    listCache([
      { name: 'abc-transcode-staging.mp4', path: '/tmp/test-cache/abc-transcode-staging.mp4', mtime: new Date(Date.now() - 7200_000) },
      { name: 'recent-transcode-staging.mp4', path: '/tmp/test-cache/recent-transcode-staging.mp4', mtime: new Date() },
    ]);

    await cleanupOrphanedChunks();

    expect(rnfs.unlink).toHaveBeenCalledWith('/tmp/test-cache/abc-transcode-staging.mp4');
    expect(rnfs.unlink).not.toHaveBeenCalledWith('/tmp/test-cache/recent-transcode-staging.mp4');
  });

  it('sweeps the legacy compressor thumbnails directory when present', async () => {
    const rnfs = require('@dr.pogodin/react-native-fs');
    rnfs.exists.mockResolvedValueOnce(true);
    rnfs.readDir.mockResolvedValueOnce([]);

    await cleanupOrphanedChunks();

    expect(rnfs.unlink).toHaveBeenCalledWith('/tmp/test-cache/thumbnails');
  });

  it('does not touch the legacy thumbnails directory when it is absent', async () => {
    const rnfs = require('@dr.pogodin/react-native-fs');
    rnfs.exists.mockResolvedValueOnce(false);
    rnfs.readDir.mockResolvedValueOnce([]);

    await cleanupOrphanedChunks();

    expect(rnfs.unlink).not.toHaveBeenCalledWith('/tmp/test-cache/thumbnails');
  });
});
