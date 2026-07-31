/**
 * Tests for mediaDownloadService — NotFoundError -> unavailable state,
 * DB write relative + store absolute, cache-check resolves legacy rows.
 */

jest.mock('@dr.pogodin/react-native-fs');

const mockDownloadMediaToFile = jest.fn();
jest.mock('../api/media', () => ({
  downloadMediaToFile: (...args: unknown[]) => mockDownloadMediaToFile(...args),
  // Simple stub — the real ceiling math is exercised by api/media's own tests.
  ciphertextByteCeiling: (_expectedBytes?: number | null) => 500 * 1024 * 1024,
}));

const mockVerifyPush = jest.fn();
const mockVerifyFinalize = jest.fn();
const mockDecryptPush = jest.fn().mockReturnValue('');
const mockDecryptFinalize = jest.fn().mockReturnValue('');
const mockDestroy = jest.fn();
const mockCreateAttachmentDecryptor = jest.fn();
mockCreateAttachmentDecryptor.mockReturnValue({
  verifyPush: mockVerifyPush,
  verifyFinalize: mockVerifyFinalize,
  decryptPush: mockDecryptPush,
  decryptFinalize: mockDecryptFinalize,
  destroy: mockDestroy,
});
jest.mock('../crypto/attachmentCrypto', () => ({
  createAttachmentDecryptor: (...args: unknown[]) => mockCreateAttachmentDecryptor(...args),
}));

// '../crypto/utils' is NOT mocked — the real base64 codec runs so the
// streaming read/verify/decrypt loops see consistent chunk lengths.

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

import { downloadAndDecryptMedia, isMediaCached } from '../mediaDownloadService';
import { NotFoundError } from '../api/errors';
import { ServerError } from '../api/errors';
import { arrayBufferToBase64 } from '../crypto/utils';
import type { MediaRow } from '../../database/repositories/mediaRepository';

const fakeKeys = new Uint8Array(64).fill(0xEE);
const fakeDigest = new Uint8Array(32).fill(0xDD);
const FAKE_MEDIA_ID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';

function makeRow(overrides: Partial<MediaRow> = {}): MediaRow {
  return {
    id: FAKE_MEDIA_ID,
    thread_id: 'thread-1',
    reply_id: null,
    message_id: null,
    content_type: 'image/jpeg',
    file_name: 'photo.jpg',
    file_size: 1000,
    width: 640, height: 480,
    duration: null,
    attachment_key: fakeKeys,
    attachment_digest: fakeDigest,
    cdn_number: null, cdn_key: null,
    local_path: null, thumbnail_path: null,
    blur_hash: null, expires_at: null,
    download_state: 'pending',
    upload_state: 'done',
    created_at: Date.now(),
    ...overrides,
  };
}

/** A stat() result shape matching RNFS's StatResult. */
function statResult(size: number): {
  size: number;
  mtime: Date;
  ctime: Date;
  isFile: () => boolean;
  isDirectory: () => boolean;
} {
  return { size, mtime: new Date(), ctime: new Date(), isFile: () => true, isDirectory: () => false };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetMedia.mockReturnValue(makeRow());
  mockDecryptPush.mockReturnValue('');
  mockDecryptFinalize.mockReturnValue('');

  const rnfs = require('@dr.pogodin/react-native-fs');
  rnfs.exists.mockResolvedValue(false);
  rnfs.mkdir.mockResolvedValue(undefined);
  rnfs.writeFile.mockResolvedValue(undefined);
  rnfs.moveFile.mockResolvedValue(undefined);
  rnfs.unlink.mockResolvedValue(undefined);

  // Ciphertext staging blob reads as non-empty; the decrypt-emit stub below
  // produces zero plaintext bytes, so the plaintext `.tmp` must stat as 0 to
  // stay consistent with `emittedBytes`.
  rnfs.stat.mockImplementation((path: string) =>
    Promise.resolve(statResult(path.endsWith('.tmp') ? 0 : 1024)),
  );

  // Each read returns a validly-padded base64 string decoding to exactly the
  // requested byte count — content is irrelevant since the decryptor above is
  // a stub, only the length bookkeeping in the read loops matters.
  rnfs.read.mockImplementation((_path: string, requested: number) =>
    Promise.resolve(arrayBufferToBase64(new ArrayBuffer(requested))),
  );
});

describe('NotFoundError -> unavailable', () => {
  it('sets unavailable state on NotFoundError from server', async () => {
    mockDownloadMediaToFile.mockRejectedValue(new NotFoundError('Gone'));

    await expect(downloadAndDecryptMedia(FAKE_MEDIA_ID)).rejects.toThrow();

    // DB state should be 'unavailable'
    expect(mockUpdateDownloadState).toHaveBeenCalledWith(FAKE_MEDIA_ID, 'unavailable');
    // Store state should be 'unavailable'
    expect(mockUpdateMediaDownloadState).toHaveBeenCalledWith(FAKE_MEDIA_ID, 'unavailable');
  });

  it('sets failed state on ServerError (not NotFoundError)', async () => {
    mockDownloadMediaToFile.mockRejectedValue(new ServerError(500, 'Internal'));

    await expect(downloadAndDecryptMedia(FAKE_MEDIA_ID)).rejects.toThrow();

    expect(mockUpdateDownloadState).toHaveBeenCalledWith(FAKE_MEDIA_ID, 'failed');
    expect(mockUpdateMediaDownloadState).toHaveBeenCalledWith(FAKE_MEDIA_ID, 'failed');
  });

  it('sets pending state on abort (not unavailable)', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      downloadAndDecryptMedia(FAKE_MEDIA_ID, controller.signal),
    ).rejects.toThrow();

    expect(mockUpdateDownloadState).toHaveBeenCalledWith(FAKE_MEDIA_ID, 'pending');
    expect(mockUpdateMediaDownloadState).toHaveBeenCalledWith(FAKE_MEDIA_ID, 'pending');
  });
});

describe('DB write relative + store absolute', () => {
  it('writes relative path to DB and absolute to store on success', async () => {
    mockDownloadMediaToFile.mockResolvedValue({ bytesWritten: 1024 });

    await downloadAndDecryptMedia(FAKE_MEDIA_ID);

    // DB should get relative path
    expect(mockUpdateDownloadState).toHaveBeenCalledWith(
      FAKE_MEDIA_ID,
      'downloaded',
      'media/a1b2c3d4-e5f6-7890-abcd-ef1234567890.jpg',
    );
    // Store should get absolute path
    expect(mockUpdateMediaDownloadState).toHaveBeenCalledWith(
      FAKE_MEDIA_ID,
      'downloaded',
      '/tmp/test-docs/media/a1b2c3d4-e5f6-7890-abcd-ef1234567890.jpg',
    );
  });
});

describe('cache-check resolves legacy rows', () => {
  it('resolves legacy absolute local_path on cache hit', async () => {
    const rnfs = require('@dr.pogodin/react-native-fs');
    // DB has legacy absolute path from old container
    mockGetMedia.mockReturnValue(makeRow({
      local_path: '/var/mobile/Containers/OLD-UUID/Documents/media/a1b2c3d4-e5f6-7890-abcd-ef1234567890.jpg',
    }));
    rnfs.exists.mockResolvedValue(true);

    const result = await downloadAndDecryptMedia(FAKE_MEDIA_ID);

    // Should resolve through mediaPaths to current MEDIA_DIR
    expect(result).toBe('/tmp/test-docs/media/a1b2c3d4-e5f6-7890-abcd-ef1234567890.jpg');
    // Should NOT download
    expect(mockDownloadMediaToFile).not.toHaveBeenCalled();
  });

  it('isMediaCached resolves legacy absolute paths', async () => {
    const rnfs = require('@dr.pogodin/react-native-fs');
    mockGetMedia.mockReturnValue(makeRow({
      local_path: '/old/container/media/file.jpg',
    }));
    rnfs.exists.mockResolvedValue(true);

    const result = await isMediaCached(FAKE_MEDIA_ID);
    expect(result).toBe(true);
    // exists() should be called with resolved path
    expect(rnfs.exists).toHaveBeenCalledWith('/tmp/test-docs/media/file.jpg');
  });
});
