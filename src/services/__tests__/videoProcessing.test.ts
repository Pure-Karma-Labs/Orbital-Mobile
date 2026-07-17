/**
 * Tests for the video processing pipeline (prepareVideoForUpload).
 *
 * react-native-compressor and @dr.pogodin/react-native-fs are auto-mocked
 * from the root __mocks__ directory.
 */
import { createVideoThumbnail, getVideoMetaData } from 'react-native-compressor';
import {
  stat,
  moveFile,
  copyFile,
  unlink,
  CachesDirectoryPath,
} from '@dr.pogodin/react-native-fs';
import { prepareVideoForUpload, VIDEO_MIME_EXT } from '../media/videoProcessing';
import { sanitizeMp4Gps, verifyNoGpsAtoms } from '../media/mp4GpsSanitizer';

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

/**
 * Configure per-path stat sizes. Paths not in the map return `fallback`.
 *
 * NOTE: '/tmp/compressed.mp4' couples to the react-native-compressor mock's
 * Video.compress resolved value in __mocks__/react-native-compressor.ts.
 */
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
    // Default: transcode smaller than source (normal path)
    mockStatSizes({
      '/tmp/compressed.mp4': 1_000_000,
      '/gallery/source.mp4': 4_000_000,
      '/gallery/source.mov': 4_000_000,
    });
  });

  // -------------------------------------------------------------------------
  // Existing tests (updated signature: sourceMimeType as 2nd arg)
  // -------------------------------------------------------------------------

  it('passes a file:// URL to createVideoThumbnail', async () => {
    // The Android implementation routes schemeless paths through the
    // remote-URL branch of MediaMetadataRetriever.setDataSource, which
    // fails with EINVAL (0xFFFFFFEA) for local files.
    await prepareVideoForUpload('/gallery/source.mp4', 'video/mp4', 'media-123');

    expect(createVideoThumbnail).toHaveBeenCalledWith(
      `file://${CachesDirectoryPath}/media-123-staging.bin`,
    );
  });

  it('returns the staging thumbnail path on success', async () => {
    const result = await prepareVideoForUpload('/gallery/source.mp4', 'video/mp4', 'media-123');

    expect(result.thumbnailPath).toBe(
      `${CachesDirectoryPath}/media-123-thumb-staging.bin`,
    );
    expect(result.videoPath).toBe(`${CachesDirectoryPath}/media-123-staging.bin`);
  });

  it('degrades to a null thumbnailPath when thumbnail extraction fails', async () => {
    (createVideoThumbnail as jest.Mock).mockRejectedValueOnce(
      new Error('setDataSource failed: status = 0xFFFFFFEA'),
    );

    const result = await prepareVideoForUpload('/gallery/source.mp4', 'video/mp4', 'media-123');

    expect(result.thumbnailPath).toBeNull();
    expect(result.videoPath).toBe(`${CachesDirectoryPath}/media-123-staging.bin`);
  });

  it('uses metadata from the compressed video', async () => {
    (getVideoMetaData as jest.Mock).mockResolvedValueOnce({
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
    // Source: 4MB, Transcode: 25MB (corrupt inflation)
    mockStatSizes({
      '/tmp/compressed.mp4': 25_000_000,
      '/gallery/source.mov': 4_000_000,
    });

    const stagingPath = `${CachesDirectoryPath}/media-123-staging.bin`;

    const result = await prepareVideoForUpload(
      '/gallery/source.mov',
      'video/quicktime',
      'media-123',
    );

    // copyFile used (not moveFile) for pass-through
    expect(copyFile).toHaveBeenCalledWith('/gallery/source.mov', stagingPath);
    // Transcode deleted
    expect(unlink).toHaveBeenCalledWith('/tmp/compressed.mp4');
    // moveFile NOT called for the guard step (may be called for thumbnail)
    const moveFileCalls = (moveFile as jest.Mock).mock.calls.filter(
      (c: unknown[]) => c[0] === '/tmp/compressed.mp4',
    );
    expect(moveFileCalls).toHaveLength(0);

    // Result carries source MIME and extension
    expect(result.mimeType).toBe('video/quicktime');
    expect(result.fileName).toBe('media-123.mov');

    // GPS sanitization still runs on staging path
    expect(sanitizeMp4Gps).toHaveBeenCalledWith(stagingPath);
    expect(verifyNoGpsAtoms).toHaveBeenCalledWith(stagingPath);
  });

  it('passes through source when sizes are equal (locks >= semantics)', async () => {
    // Equal sizes: 4MB each
    mockStatSizes({
      '/tmp/compressed.mp4': 4_000_000,
      '/gallery/source.mp4': 4_000_000,
    });

    const result = await prepareVideoForUpload(
      '/gallery/source.mp4',
      'video/mp4',
      'media-123',
    );

    expect(copyFile).toHaveBeenCalledWith(
      '/gallery/source.mp4',
      `${CachesDirectoryPath}/media-123-staging.bin`,
    );
    expect(unlink).toHaveBeenCalledWith('/tmp/compressed.mp4');
    // mimeType is pass-through (source MIME)
    expect(result.mimeType).toBe('video/mp4');
    expect(result.fileName).toBe('media-123.mp4');
  });

  it('uses moveFile on normal path (transcode < source)', async () => {
    // Default sizes: transcode 1MB < source 4MB
    const stagingPath = `${CachesDirectoryPath}/media-123-staging.bin`;

    const result = await prepareVideoForUpload(
      '/gallery/source.mp4',
      'video/mp4',
      'media-123',
    );

    expect(moveFile).toHaveBeenCalledWith('/tmp/compressed.mp4', stagingPath);
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

    // moveFile called (normal path), NOT copyFile for the source
    expect(moveFile).toHaveBeenCalledWith(
      '/tmp/compressed.mp4',
      `${CachesDirectoryPath}/media-123-staging.bin`,
    );
    const copyFileCalls = (copyFile as jest.Mock).mock.calls.filter(
      (c: unknown[]) => c[0] === '/gallery/source.mp4',
    );
    expect(copyFileCalls).toHaveLength(0);

    // Result uses transcode MIME, not source
    expect(result.mimeType).toBe('video/mp4');
  });

  it('skips self-copy when sourcePath equals stagingPath (content:// alias)', async () => {
    // Simulate Android content:// pre-staging: sourcePath IS the staging path
    const stagingPath = `${CachesDirectoryPath}/media-123-staging.bin`;

    mockStatSizes({
      '/tmp/compressed.mp4': 25_000_000,
      [stagingPath]: 4_000_000,
    });

    const result = await prepareVideoForUpload(
      stagingPath,
      'video/quicktime',
      'media-123',
    );

    // copyFile should NOT be called (self-copy guard)
    expect(copyFile).not.toHaveBeenCalled();
    // Transcode is still unlinked
    expect(unlink).toHaveBeenCalledWith('/tmp/compressed.mp4');
    // Result is still pass-through
    expect(result.mimeType).toBe('video/quicktime');
    expect(result.fileName).toBe('media-123.mov');
  });

  // -------------------------------------------------------------------------
  // Allowlist sync
  // -------------------------------------------------------------------------

  it('reports invalid compressor output when an oversize source passes through', async () => {
    // Source 60MB (over the 50MB cap), transcode 70MB (inflated -> guard trips)
    mockStatSizes({
      '/tmp/compressed.mp4': 70_000_000,
      '/gallery/big.mov': 60_000_000,
      [`${CachesDirectoryPath}/media-123-staging.bin`]: 60_000_000,
    });

    await expect(
      prepareVideoForUpload('/gallery/big.mov', 'video/quicktime', 'media-123'),
    ).rejects.toThrow(/compressor output was invalid/);
  });

  it('VIDEO_MIME_EXT covers every ALLOWED_VIDEO_MIMES entry', () => {
    // Lazy import to avoid pulling in React hooks at module level
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { ALLOWED_VIDEO_MIMES } = require('../../hooks/useMediaPicker');

    for (const mime of ALLOWED_VIDEO_MIMES) {
      expect(VIDEO_MIME_EXT).toHaveProperty(mime);
    }
  });
});
