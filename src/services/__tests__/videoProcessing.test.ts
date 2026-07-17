/**
 * Tests for the video processing pipeline (prepareVideoForUpload).
 *
 * react-native-compressor and @dr.pogodin/react-native-fs are auto-mocked
 * from the root __mocks__ directory.
 */
import { createVideoThumbnail, getVideoMetaData } from 'react-native-compressor';
import { CachesDirectoryPath } from '@dr.pogodin/react-native-fs';
import { prepareVideoForUpload } from '../media/videoProcessing';

jest.mock('../media/mp4GpsSanitizer', () => ({
  sanitizeMp4Gps: jest.fn().mockResolvedValue(undefined),
  verifyNoGpsAtoms: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../media/imageSanitizer', () => ({
  sanitizeStillImage: jest.fn().mockResolvedValue(undefined),
}));

describe('prepareVideoForUpload', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('passes a file:// URL to createVideoThumbnail', async () => {
    // The Android implementation routes schemeless paths through the
    // remote-URL branch of MediaMetadataRetriever.setDataSource, which
    // fails with EINVAL (0xFFFFFFEA) for local files.
    await prepareVideoForUpload('/gallery/source.mp4', 'media-123');

    expect(createVideoThumbnail).toHaveBeenCalledWith(
      `file://${CachesDirectoryPath}/media-123-staging.bin`,
    );
  });

  it('returns the staging thumbnail path on success', async () => {
    const result = await prepareVideoForUpload('/gallery/source.mp4', 'media-123');

    expect(result.thumbnailPath).toBe(
      `${CachesDirectoryPath}/media-123-thumb-staging.bin`,
    );
    expect(result.videoPath).toBe(`${CachesDirectoryPath}/media-123-staging.bin`);
  });

  it('degrades to a null thumbnailPath when thumbnail extraction fails', async () => {
    (createVideoThumbnail as jest.Mock).mockRejectedValueOnce(
      new Error('setDataSource failed: status = 0xFFFFFFEA'),
    );

    const result = await prepareVideoForUpload('/gallery/source.mp4', 'media-123');

    expect(result.thumbnailPath).toBeNull();
    expect(result.videoPath).toBe(`${CachesDirectoryPath}/media-123-staging.bin`);
  });

  it('uses metadata from the compressed video', async () => {
    (getVideoMetaData as jest.Mock).mockResolvedValueOnce({
      width: 720,
      height: 1280,
      duration: 42,
    });

    const result = await prepareVideoForUpload('/gallery/source.mp4', 'media-123');

    expect(result.width).toBe(720);
    expect(result.height).toBe(1280);
    expect(result.duration).toBe(42);
  });
});
