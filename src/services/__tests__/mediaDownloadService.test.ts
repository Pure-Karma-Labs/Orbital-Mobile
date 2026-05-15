/**
 * Tests for mediaDownloadService — download, decrypt, cache, and cleanup.
 */

jest.mock('@dr.pogodin/react-native-fs');

const mockDownloadMedia = jest.fn();

jest.mock('../api/media', () => ({
  downloadMedia: (...args: unknown[]) => mockDownloadMedia(...args),
}));

const mockDecryptAttachment = jest.fn();

jest.mock('../crypto/attachmentCrypto', () => ({
  decryptAttachment: (...args: unknown[]) => mockDecryptAttachment(...args),
}));

jest.mock('../crypto/utils', () => ({
  base64ToArrayBuffer: jest.fn(() => {
    // Return a 64-byte ArrayBuffer (matches attachment key size)
    return new ArrayBuffer(64);
  }),
  arrayBufferToBase64: jest.fn(() => 'mock-plaintext-base64'),
  toArrayBuffer: jest.fn((u8: Uint8Array) =>
    u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength),
  ),
}));

const mockGetMedia = jest.fn();
const mockUpdateDownloadState = jest.fn();

jest.mock('../../database/repositories/mediaRepository', () => ({
  getMedia: (...args: unknown[]) => mockGetMedia(...args),
  updateDownloadState: (...args: unknown[]) => mockUpdateDownloadState(...args),
}));

const mockUpdateMediaDownloadState = jest.fn();

jest.mock('../../stores/useAppStore', () => ({
  useAppStore: {
    getState: jest.fn(() => ({
      updateMediaDownloadState: mockUpdateMediaDownloadState,
    })),
  },
}));

jest.mock('../../database/queryHelpers', () => ({
  queryMany: jest.fn(() => []),
}));

import {
  downloadAndDecryptMedia,
  retryDownload,
  isMediaCached,
  cleanupOrphanedMedia,
} from '../mediaDownloadService';
import type { MediaRow } from '../../database/repositories/mediaRepository';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const fakeKeysBase64 = 'fake-keys-base64-64bytes';
const fakeDigestBase64 = 'fake-digest-base64-32bytes';
const fakeCiphertextBuffer = new Uint8Array(100).fill(0xCC).buffer;
const fakePlaintext = new Uint8Array(80).fill(0xAA);

const FAKE_MEDIA_ID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';

function makeMediaRow(overrides: Partial<MediaRow> = {}): MediaRow {
  return {
    id: FAKE_MEDIA_ID,
    thread_id: 'thread-1',
    reply_id: null,
    message_id: null,
    content_type: 'image/jpeg',
    file_name: 'photo.jpg',
    file_size: 1000,
    width: 640,
    height: 480,
    duration: null,
    attachment_key: fakeKeysBase64,
    attachment_digest: fakeDigestBase64,
    cdn_number: null,
    cdn_key: null,
    local_path: null,
    thumbnail_path: null,
    download_state: 'pending',
    upload_state: 'done',
    created_at: Date.now(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  jest.clearAllMocks();
  mockGetMedia.mockReturnValue(makeMediaRow());
  mockDownloadMedia.mockResolvedValue({
    data: fakeCiphertextBuffer,
    encryptionIv: null,
    expiresAt: null,
  });
  mockDecryptAttachment.mockReturnValue(fakePlaintext);

  // Reset RNFS mocks
  const rnfs = require('@dr.pogodin/react-native-fs');
  rnfs.exists.mockResolvedValue(false);
  rnfs.mkdir.mockResolvedValue(undefined);
  rnfs.writeFile.mockResolvedValue(undefined);
  rnfs.moveFile.mockResolvedValue(undefined);
  rnfs.unlink.mockResolvedValue(undefined);
});

// ---------------------------------------------------------------------------
// downloadAndDecryptMedia
// ---------------------------------------------------------------------------

describe('downloadAndDecryptMedia', () => {
  it('returns cached path when file exists on disk', async () => {
    const rnfs = require('@dr.pogodin/react-native-fs');
    mockGetMedia.mockReturnValue(
      makeMediaRow({ local_path: '/tmp/test-docs/media/a1b2c3d4-e5f6-7890-abcd-ef1234567890.jpg' }),
    );
    rnfs.exists.mockResolvedValue(true);

    const result = await downloadAndDecryptMedia(FAKE_MEDIA_ID);

    expect(result).toBe('/tmp/test-docs/media/a1b2c3d4-e5f6-7890-abcd-ef1234567890.jpg');
    expect(mockDownloadMedia).not.toHaveBeenCalled();
  });

  it('throws when no attachment keys available', async () => {
    mockGetMedia.mockReturnValue(makeMediaRow({ attachment_key: null }));

    await expect(downloadAndDecryptMedia(FAKE_MEDIA_ID)).rejects.toThrow(
      'No attachment keys available',
    );
    expect(mockDownloadMedia).not.toHaveBeenCalled();
  });

  it('downloads, decrypts, and writes to disk on success', async () => {
    const rnfs = require('@dr.pogodin/react-native-fs');

    const result = await downloadAndDecryptMedia(FAKE_MEDIA_ID);

    // Verify download was called
    expect(mockDownloadMedia).toHaveBeenCalledWith(FAKE_MEDIA_ID, undefined);

    // Verify decryption was called
    expect(mockDecryptAttachment).toHaveBeenCalledTimes(1);

    // Verify atomic write: writeFile to .tmp, then moveFile
    expect(rnfs.writeFile).toHaveBeenCalledWith(
      '/tmp/test-docs/media/a1b2c3d4-e5f6-7890-abcd-ef1234567890.jpg.tmp',
      'mock-plaintext-base64',
      'base64',
    );
    expect(rnfs.moveFile).toHaveBeenCalledWith(
      '/tmp/test-docs/media/a1b2c3d4-e5f6-7890-abcd-ef1234567890.jpg.tmp',
      '/tmp/test-docs/media/a1b2c3d4-e5f6-7890-abcd-ef1234567890.jpg',
    );

    // Verify state updates
    expect(mockUpdateDownloadState).toHaveBeenCalledWith(FAKE_MEDIA_ID, 'downloading');
    expect(mockUpdateDownloadState).toHaveBeenCalledWith(
      FAKE_MEDIA_ID,
      'downloaded',
      '/tmp/test-docs/media/a1b2c3d4-e5f6-7890-abcd-ef1234567890.jpg',
    );
    expect(mockUpdateMediaDownloadState).toHaveBeenCalledWith(FAKE_MEDIA_ID, 'downloading');
    expect(mockUpdateMediaDownloadState).toHaveBeenCalledWith(
      FAKE_MEDIA_ID,
      'downloaded',
      '/tmp/test-docs/media/a1b2c3d4-e5f6-7890-abcd-ef1234567890.jpg',
    );

    expect(result).toBe('/tmp/test-docs/media/a1b2c3d4-e5f6-7890-abcd-ef1234567890.jpg');
  });

  it('sets failed state and cleans up temp file on download error', async () => {
    const rnfs = require('@dr.pogodin/react-native-fs');
    mockDownloadMedia.mockRejectedValue(new Error('Network error'));

    await expect(downloadAndDecryptMedia(FAKE_MEDIA_ID)).rejects.toThrow(
      'Network error',
    );

    // State should be set to 'failed'
    expect(mockUpdateDownloadState).toHaveBeenCalledWith(FAKE_MEDIA_ID, 'failed');
    expect(mockUpdateMediaDownloadState).toHaveBeenCalledWith(FAKE_MEDIA_ID, 'failed');

    // Temp file should be cleaned up
    expect(rnfs.unlink).toHaveBeenCalledWith(
      '/tmp/test-docs/media/a1b2c3d4-e5f6-7890-abcd-ef1234567890.jpg.tmp',
    );
  });

  it('sets failed state on decryption error', async () => {
    mockDecryptAttachment.mockImplementation(() => {
      throw new Error('HMAC verification failed');
    });

    await expect(downloadAndDecryptMedia(FAKE_MEDIA_ID)).rejects.toThrow(
      'HMAC verification failed',
    );

    expect(mockUpdateDownloadState).toHaveBeenCalledWith(FAKE_MEDIA_ID, 'failed');
    expect(mockUpdateMediaDownloadState).toHaveBeenCalledWith(FAKE_MEDIA_ID, 'failed');
  });

  it('creates media directory if it does not exist', async () => {
    const rnfs = require('@dr.pogodin/react-native-fs');
    rnfs.exists.mockResolvedValue(false);

    await downloadAndDecryptMedia(FAKE_MEDIA_ID);

    expect(rnfs.mkdir).toHaveBeenCalledWith('/tmp/test-docs/media', {
      NSURLIsExcludedFromBackupKey: true,
    });
  });

  it('derives extension from content type when file name has no extension', async () => {
    mockGetMedia.mockReturnValue(
      makeMediaRow({ file_name: null, content_type: 'image/png' }),
    );

    const result = await downloadAndDecryptMedia(FAKE_MEDIA_ID);

    expect(result).toBe('/tmp/test-docs/media/a1b2c3d4-e5f6-7890-abcd-ef1234567890.png');
  });

  it('deduplicates concurrent downloads for the same media ID', async () => {
    // Start two downloads concurrently
    const p1 = downloadAndDecryptMedia(FAKE_MEDIA_ID);
    const p2 = downloadAndDecryptMedia(FAKE_MEDIA_ID);

    const [r1, r2] = await Promise.all([p1, p2]);

    // Both should return the same path
    expect(r1).toBe(r2);

    // But download should only be called once
    expect(mockDownloadMedia).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// retryDownload
// ---------------------------------------------------------------------------

describe('retryDownload', () => {
  it('resets state to pending before re-triggering download', async () => {
    const result = await retryDownload(FAKE_MEDIA_ID);

    // First call resets to 'pending'
    expect(mockUpdateDownloadState).toHaveBeenCalledWith(FAKE_MEDIA_ID, 'pending');
    expect(mockUpdateMediaDownloadState).toHaveBeenCalledWith(FAKE_MEDIA_ID, 'pending');

    // Then proceeds with download
    expect(mockDownloadMedia).toHaveBeenCalledTimes(1);
    expect(result).toBe('/tmp/test-docs/media/a1b2c3d4-e5f6-7890-abcd-ef1234567890.jpg');
  });
});

// ---------------------------------------------------------------------------
// isMediaCached
// ---------------------------------------------------------------------------

describe('isMediaCached', () => {
  it('returns true when file exists on disk', async () => {
    const rnfs = require('@dr.pogodin/react-native-fs');
    mockGetMedia.mockReturnValue(
      makeMediaRow({ local_path: '/tmp/test-docs/media/a1b2c3d4-e5f6-7890-abcd-ef1234567890.jpg' }),
    );
    rnfs.exists.mockResolvedValue(true);

    expect(await isMediaCached(FAKE_MEDIA_ID)).toBe(true);
  });

  it('returns false when no local path', async () => {
    mockGetMedia.mockReturnValue(makeMediaRow({ local_path: null }));

    expect(await isMediaCached(FAKE_MEDIA_ID)).toBe(false);
  });

  it('returns false when file does not exist', async () => {
    const rnfs = require('@dr.pogodin/react-native-fs');
    mockGetMedia.mockReturnValue(
      makeMediaRow({ local_path: '/tmp/test-docs/media/a1b2c3d4-e5f6-7890-abcd-ef1234567890.jpg' }),
    );
    rnfs.exists.mockResolvedValue(false);

    expect(await isMediaCached(FAKE_MEDIA_ID)).toBe(false);
  });

  it('returns false when DB throws', async () => {
    mockGetMedia.mockImplementation(() => {
      throw new Error('DB not initialized');
    });

    expect(await isMediaCached(FAKE_MEDIA_ID)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// cleanupOrphanedMedia
// ---------------------------------------------------------------------------

describe('cleanupOrphanedMedia', () => {
  it('deletes .tmp files older than 1 hour', async () => {
    const rnfs = require('@dr.pogodin/react-native-fs');
    rnfs.exists.mockResolvedValue(true);
    rnfs.readDir.mockResolvedValue([
      {
        name: 'media-1.jpg.tmp',
        path: '/tmp/test-docs/media/a1b2c3d4-e5f6-7890-abcd-ef1234567890.jpg.tmp',
        mtime: new Date(Date.now() - 7200_000),
        isDirectory: () => false,
      },
      {
        name: 'media-2.png.tmp',
        path: '/tmp/test-docs/media/media-2.png.tmp',
        mtime: new Date(),
        isDirectory: () => false,
      },
    ]);

    await cleanupOrphanedMedia();

    expect(rnfs.unlink).toHaveBeenCalledWith(
      '/tmp/test-docs/media/a1b2c3d4-e5f6-7890-abcd-ef1234567890.jpg.tmp',
    );
    expect(rnfs.unlink).not.toHaveBeenCalledWith(
      '/tmp/test-docs/media/media-2.png.tmp',
    );
  });

  it('deletes files with no matching DB row', async () => {
    const rnfs = require('@dr.pogodin/react-native-fs');
    rnfs.exists.mockResolvedValue(true);
    rnfs.readDir.mockResolvedValue([
      {
        name: 'orphan-id.jpg',
        path: '/tmp/test-docs/media/orphan-id.jpg',
        mtime: new Date(),
        isDirectory: () => false,
      },
    ]);
    mockGetMedia.mockReturnValue(null);

    await cleanupOrphanedMedia();

    expect(rnfs.unlink).toHaveBeenCalledWith(
      '/tmp/test-docs/media/orphan-id.jpg',
    );
  });

  it('does not throw on errors', async () => {
    const rnfs = require('@dr.pogodin/react-native-fs');
    rnfs.exists.mockRejectedValue(new Error('Permission denied'));

    // Should not throw
    await expect(cleanupOrphanedMedia()).resolves.toBeUndefined();
  });
});
