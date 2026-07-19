/**
 * Tests for mediaDownloadService — NotFoundError -> unavailable state,
 * DB write relative + store absolute, cache-check resolves legacy rows.
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
  base64ToArrayBuffer: jest.fn(() => new ArrayBuffer(64)),
  arrayBufferToBase64: jest.fn(() => 'mock-base64'),
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

import { downloadAndDecryptMedia, isMediaCached } from '../mediaDownloadService';
import { NotFoundError } from '../api/errors';
import { ServerError } from '../api/errors';
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

beforeEach(() => {
  jest.clearAllMocks();
  mockGetMedia.mockReturnValue(makeRow());
  const rnfs = require('@dr.pogodin/react-native-fs');
  rnfs.exists.mockResolvedValue(false);
  rnfs.mkdir.mockResolvedValue(undefined);
  rnfs.writeFile.mockResolvedValue(undefined);
  rnfs.moveFile.mockResolvedValue(undefined);
  rnfs.unlink.mockResolvedValue(undefined);
});

describe('NotFoundError -> unavailable', () => {
  it('sets unavailable state on NotFoundError from server', async () => {
    mockDownloadMedia.mockRejectedValue(new NotFoundError('Gone'));

    await expect(downloadAndDecryptMedia(FAKE_MEDIA_ID)).rejects.toThrow();

    // DB state should be 'unavailable'
    expect(mockUpdateDownloadState).toHaveBeenCalledWith(FAKE_MEDIA_ID, 'unavailable');
    // Store state should be 'unavailable'
    expect(mockUpdateMediaDownloadState).toHaveBeenCalledWith(FAKE_MEDIA_ID, 'unavailable');
  });

  it('sets failed state on ServerError (not NotFoundError)', async () => {
    mockDownloadMedia.mockRejectedValue(new ServerError(500, 'Internal'));

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
    mockDecryptAttachment.mockReturnValue(new Uint8Array(80).fill(0xAA));
    mockDownloadMedia.mockResolvedValue({ data: new ArrayBuffer(100) });

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
    expect(mockDownloadMedia).not.toHaveBeenCalled();
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
