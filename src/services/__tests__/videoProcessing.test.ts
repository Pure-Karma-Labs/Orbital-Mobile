/**
 * Tests for the video processing pipeline (prepareVideoForUpload).
 *
 * orbital-media-transcoder is mapped to __mocks__/orbital-media-transcoder.ts
 * via jest.config.js moduleNameMapper; @dr.pogodin/react-native-fs is
 * auto-mocked from the root __mocks__ directory.
 */
import {
  transcodeVideo,
  cancelTranscode,
  getVideoMetadata,
  extractThumbnail,
  subscribeTranscodeProgress,
  MediaTranscoderError,
} from 'orbital-media-transcoder';
import {
  stat,
  moveFile,
  copyFile,
  unlink,
  CachesDirectoryPath,
} from '@dr.pogodin/react-native-fs';
import { prepareVideoForUpload, VIDEO_MIME_EXT } from '../media/videoProcessing';
import { MAX_UPLOAD_SIZE_BYTES } from '../media/mediaLimits';
import { sanitizeMp4Gps, verifyNoGpsAtoms } from '../media/mp4GpsSanitizer';
import { sanitizeStillImage } from '../media/imageSanitizer';

jest.mock('../media/mp4GpsSanitizer', () => ({
  sanitizeMp4Gps: jest.fn().mockResolvedValue(undefined),
  verifyNoGpsAtoms: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../media/imageSanitizer', () => ({
  sanitizeStillImage: jest.fn().mockResolvedValue(undefined),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const STAGING_PATH = `${CachesDirectoryPath}/media-123-staging.bin`;
/** Note the .mp4 extension: AVAssetWriter derives the container from it. */
const TRANSCODE_PATH = `${CachesDirectoryPath}/media-123-transcode-staging.mp4`;
const THUMB_RAW_PATH = `${CachesDirectoryPath}/media-123-thumbraw-staging.bin`;

/** Configure per-path stat sizes. Paths not in the map return `fallback`. */
function mockStatSizes(sizes: Record<string, number>, fallback = 1024) {
  (stat as jest.Mock).mockImplementation((p: string) =>
    Promise.resolve({
      size: sizes[p] ?? fallback,
      mtime: new Date(),
      ctime: new Date(),
      isFile: () => true,
      isDirectory: () => false,
    }),
  );
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

describe('prepareVideoForUpload', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (transcodeVideo as jest.Mock).mockResolvedValue(undefined);
    (extractThumbnail as jest.Mock).mockResolvedValue(undefined);
    (getVideoMetadata as jest.Mock).mockResolvedValue({
      width: 1280,
      height: 720,
      duration: 10.5,
    });
    (subscribeTranscodeProgress as jest.Mock).mockImplementation(() => ({
      remove: jest.fn(),
    }));
    // Default: transcode smaller than source (normal path)
    mockStatSizes({
      [TRANSCODE_PATH]: 1_000_000,
      '/gallery/source.mp4': 4_000_000,
      '/gallery/source.mov': 4_000_000,
    });
  });

  // -------------------------------------------------------------------------
  // Native wrapper contract
  // -------------------------------------------------------------------------

  it('passes plain (schemeless) paths to every native call', async () => {
    await prepareVideoForUpload('/gallery/source.mp4', 'video/mp4', 'media-123');

    expect(transcodeVideo).toHaveBeenCalledWith(
      'media-123',
      '/gallery/source.mp4',
      TRANSCODE_PATH,
      { maxDimension: 1280, bitrate: 2_000_000 },
    );
    expect(getVideoMetadata).toHaveBeenCalledWith(STAGING_PATH);
    expect(extractThumbnail).toHaveBeenCalledWith(
      STAGING_PATH,
      1000,
      THUMB_RAW_PATH,
      640,
      0.8,
    );
    for (const call of [
      ...(transcodeVideo as jest.Mock).mock.calls,
      ...(getVideoMetadata as jest.Mock).mock.calls,
      ...(extractThumbnail as jest.Mock).mock.calls,
    ]) {
      for (const arg of call) {
        if (typeof arg === 'string') {
          expect(arg.startsWith('file://')).toBe(false);
        }
      }
    }
  });

  it('returns the staging thumbnail path on success', async () => {
    const result = await prepareVideoForUpload('/gallery/source.mp4', 'video/mp4', 'media-123');

    expect(result.thumbnailPath).toBe(
      `${CachesDirectoryPath}/media-123-thumb-staging.bin`,
    );
    expect(result.videoPath).toBe(STAGING_PATH);
  });

  it('degrades to a null thumbnailPath when thumbnail extraction fails', async () => {
    (extractThumbnail as jest.Mock).mockRejectedValueOnce(
      new MediaTranscoderError('ETHUMBNAIL', 'no decodable frame'),
    );

    const result = await prepareVideoForUpload('/gallery/source.mp4', 'video/mp4', 'media-123');

    expect(result.thumbnailPath).toBeNull();
    expect(result.videoPath).toBe(STAGING_PATH);
  });

  it('uses metadata from the transcoded video', async () => {
    (getVideoMetadata as jest.Mock).mockResolvedValueOnce({
      width: 720,
      height: 1280,
      duration: 42,
    });

    const result = await prepareVideoForUpload('/gallery/source.mp4', 'video/mp4', 'media-123');

    expect(result.width).toBe(720);
    expect(result.height).toBe(1280);
    expect(result.duration).toBe(42);
  });

  // -------------------------------------------------------------------------
  // Transcode integrity guard — pass-through tests
  // -------------------------------------------------------------------------

  it('passes through source when transcode is inflated (>= source)', async () => {
    // Source: 4MB, Transcode: 25MB (inflation)
    mockStatSizes({
      [TRANSCODE_PATH]: 25_000_000,
      '/gallery/source.mov': 4_000_000,
    });

    const result = await prepareVideoForUpload(
      '/gallery/source.mov',
      'video/quicktime',
      'media-123',
    );

    // copyFile used (not moveFile) for pass-through
    expect(copyFile).toHaveBeenCalledWith('/gallery/source.mov', STAGING_PATH);
    // Transcode deleted
    expect(unlink).toHaveBeenCalledWith(TRANSCODE_PATH);
    // moveFile NOT called for the guard step (may be called for thumbnail)
    const moveFileCalls = (moveFile as jest.Mock).mock.calls.filter(
      (c: unknown[]) => c[0] === TRANSCODE_PATH,
    );
    expect(moveFileCalls).toHaveLength(0);

    // Result carries source MIME and extension
    expect(result.mimeType).toBe('video/quicktime');
    expect(result.fileName).toBe('media-123.mov');

    // GPS sanitization still runs on staging path
    expect(sanitizeMp4Gps).toHaveBeenCalledWith(STAGING_PATH);
    expect(verifyNoGpsAtoms).toHaveBeenCalledWith(STAGING_PATH);
  });

  it('passes through source when sizes are equal (locks >= semantics)', async () => {
    mockStatSizes({
      [TRANSCODE_PATH]: 4_000_000,
      '/gallery/source.mp4': 4_000_000,
    });

    const result = await prepareVideoForUpload(
      '/gallery/source.mp4',
      'video/mp4',
      'media-123',
    );

    expect(copyFile).toHaveBeenCalledWith('/gallery/source.mp4', STAGING_PATH);
    expect(unlink).toHaveBeenCalledWith(TRANSCODE_PATH);
    // mimeType is pass-through (source MIME)
    expect(result.mimeType).toBe('video/mp4');
    expect(result.fileName).toBe('media-123.mp4');
  });

  it('uses moveFile on normal path (transcode < source)', async () => {
    const result = await prepareVideoForUpload(
      '/gallery/source.mp4',
      'video/mp4',
      'media-123',
    );

    expect(moveFile).toHaveBeenCalledWith(TRANSCODE_PATH, STAGING_PATH);
    // copyFile NOT called for the guard step (may be called for thumbnail)
    const copyFileCalls = (copyFile as jest.Mock).mock.calls.filter(
      (c: unknown[]) => c[0] === '/gallery/source.mp4',
    );
    expect(copyFileCalls).toHaveLength(0);

    expect(result.mimeType).toBe('video/mp4');
    expect(result.fileName).toBe('media-123.mp4');
  });

  it('falls back to transcode on source-stat failure', async () => {
    // Make stat reject for source path only
    (stat as jest.Mock).mockImplementation((p: string) => {
      if (p === '/gallery/source.mp4') {
        return Promise.reject(new Error('ENOENT'));
      }
      return Promise.resolve({
        size: 25_000_000,
        mtime: new Date(),
        ctime: new Date(),
        isFile: () => true,
        isDirectory: () => false,
      });
    });

    const result = await prepareVideoForUpload(
      '/gallery/source.mp4',
      'video/mp4',
      'media-123',
    );

    expect(moveFile).toHaveBeenCalledWith(TRANSCODE_PATH, STAGING_PATH);
    const copyFileCalls = (copyFile as jest.Mock).mock.calls.filter(
      (c: unknown[]) => c[0] === '/gallery/source.mp4',
    );
    expect(copyFileCalls).toHaveLength(0);

    // Result uses transcode MIME, not source
    expect(result.mimeType).toBe('video/mp4');
  });

  it('skips self-copy when sourcePath equals stagingPath (content:// alias)', async () => {
    // Simulate Android content:// pre-staging: sourcePath IS the staging path
    mockStatSizes({
      [TRANSCODE_PATH]: 25_000_000,
      [STAGING_PATH]: 4_000_000,
    });

    const result = await prepareVideoForUpload(
      STAGING_PATH,
      'video/quicktime',
      'media-123',
    );

    // copyFile should NOT be called (self-copy guard)
    expect(copyFile).not.toHaveBeenCalled();
    // Transcode is still unlinked
    expect(unlink).toHaveBeenCalledWith(TRANSCODE_PATH);
    // Result is still pass-through
    expect(result.mimeType).toBe('video/quicktime');
    expect(result.fileName).toBe('media-123.mov');
  });

  // -------------------------------------------------------------------------
  // Pass-through on transcode failure (owner decision: only cancellation is fatal)
  // -------------------------------------------------------------------------

  it('passes through the sanitized source when the transcode rejects', async () => {
    (transcodeVideo as jest.Mock).mockRejectedValueOnce(
      new MediaTranscoderError('ETRANSCODE', 'ERROR_CODE_ENCODING_FAILED'),
    );
    mockStatSizes({
      '/gallery/source.mov': 4_000_000,
      [STAGING_PATH]: 4_000_000,
    });

    const result = await prepareVideoForUpload(
      '/gallery/source.mov',
      'video/quicktime',
      'media-123',
    );

    // Source copied through, transcode output never stat'ed
    expect(copyFile).toHaveBeenCalledWith('/gallery/source.mov', STAGING_PATH);
    expect(moveFile).not.toHaveBeenCalledWith(TRANSCODE_PATH, STAGING_PATH);
    // Sanitizers still run — the upload size cap and GPS strip are not bypassed
    expect(sanitizeMp4Gps).toHaveBeenCalledWith(STAGING_PATH);
    expect(verifyNoGpsAtoms).toHaveBeenCalledWith(STAGING_PATH);
    expect(sanitizeStillImage).toHaveBeenCalled();
    // Source MIME/extension preserved
    expect(result.mimeType).toBe('video/quicktime');
    expect(result.fileName).toBe('media-123.mov');
  });

  it('routes an unknown rejection shape to pass-through rather than crashing', async () => {
    (transcodeVideo as jest.Mock).mockRejectedValueOnce({ weird: true });
    mockStatSizes({
      '/gallery/source.mp4': 4_000_000,
      [STAGING_PATH]: 4_000_000,
    });

    const result = await prepareVideoForUpload(
      '/gallery/source.mp4',
      'video/mp4',
      'media-123',
    );

    expect(copyFile).toHaveBeenCalledWith('/gallery/source.mp4', STAGING_PATH);
    expect(result.mimeType).toBe('video/mp4');
  });

  it('rejects and cleans up when the transcode is cancelled (ECANCELLED is fatal)', async () => {
    (transcodeVideo as jest.Mock).mockRejectedValueOnce(
      new MediaTranscoderError('ECANCELLED', 'transcode cancelled'),
    );

    await expect(
      prepareVideoForUpload('/gallery/source.mp4', 'video/mp4', 'media-123'),
    ).rejects.toMatchObject({ code: 'ECANCELLED' });

    expect(copyFile).not.toHaveBeenCalled();
    expect(unlink).toHaveBeenCalledWith(STAGING_PATH);
    expect(unlink).toHaveBeenCalledWith(TRANSCODE_PATH);
    expect(unlink).toHaveBeenCalledWith(
      `${CachesDirectoryPath}/media-123-thumb-staging.bin`,
    );
  });

  // -------------------------------------------------------------------------
  // Cancellation + progress plumbing
  // -------------------------------------------------------------------------

  it('cancels the native job when the abort signal fires', async () => {
    const controller = new AbortController();
    (transcodeVideo as jest.Mock).mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          controller.abort();
          reject(new MediaTranscoderError('ECANCELLED', 'transcode cancelled'));
        }),
    );

    await expect(
      prepareVideoForUpload('/gallery/source.mp4', 'video/mp4', 'media-123', {
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: 'ECANCELLED' });

    expect(cancelTranscode).toHaveBeenCalledWith('media-123');
  });

  it('subscribes to progress for its own jobId and removes the subscription', async () => {
    const remove = jest.fn();
    (subscribeTranscodeProgress as jest.Mock).mockReturnValueOnce({ remove });
    const onProgress = jest.fn();

    await prepareVideoForUpload('/gallery/source.mp4', 'video/mp4', 'media-123', {
      onProgress,
    });

    expect(subscribeTranscodeProgress).toHaveBeenCalledWith(
      'media-123',
      expect.any(Function),
    );
    // The forwarded callback reaches the caller's onProgress
    const forward = (subscribeTranscodeProgress as jest.Mock).mock.calls[0][1];
    forward(0.42);
    expect(onProgress).toHaveBeenCalledWith(0.42);
    expect(remove).toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Size cap + allowlist sync
  // -------------------------------------------------------------------------

  it('reports the pass-through variant of the size-cap error', async () => {
    // Source over the upload cap, transcode larger still (inflated -> guard trips)
    mockStatSizes({
      [TRANSCODE_PATH]: MAX_UPLOAD_SIZE_BYTES * 2,
      '/gallery/big.mov': MAX_UPLOAD_SIZE_BYTES + 1,
      [STAGING_PATH]: MAX_UPLOAD_SIZE_BYTES + 1,
    });

    await expect(
      prepareVideoForUpload('/gallery/big.mov', 'video/quicktime', 'media-123'),
    ).rejects.toThrow(/could not be re-encoded/);
  });

  it('reports the normal variant of the size-cap error', async () => {
    // Transcode succeeded and is smaller than source, but still over the cap
    mockStatSizes({
      [TRANSCODE_PATH]: MAX_UPLOAD_SIZE_BYTES + 1,
      '/gallery/big.mp4': MAX_UPLOAD_SIZE_BYTES * 2,
      [STAGING_PATH]: MAX_UPLOAD_SIZE_BYTES + 1,
    });

    await expect(
      prepareVideoForUpload('/gallery/big.mp4', 'video/mp4', 'media-123'),
    ).rejects.toThrow(/still too large after re-encoding/);
  });

  it('VIDEO_MIME_EXT covers every ALLOWED_VIDEO_MIMES entry', () => {
    // Lazy import to avoid pulling in React hooks at module level
    const { ALLOWED_VIDEO_MIMES } = require('../../hooks/useMediaPicker');

    for (const mime of ALLOWED_VIDEO_MIMES) {
      expect(VIDEO_MIME_EXT).toHaveProperty(mime);
    }
  });
});
