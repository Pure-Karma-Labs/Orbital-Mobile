/**
 * Video processing pipeline -- compress, sanitize GPS, extract metadata,
 * and create thumbnail for video uploads.
 *
 * Flow:
 * 1. Video.compress (720p H.264 mp4, ~2Mbps)
 * 2. Move output to {mediaId}-staging.bin (GC-covered temp suffix)
 * 3. sanitizeMp4Gps (strip GPS atoms)
 * 4. verifyNoGpsAtoms (independent fail-closed check)
 * 5. getVideoMetaData (authoritative w/h/duration)
 * 6. createVideoThumbnail (~1s frame)
 * 7. Move thumbnail to {mediaId}-thumb-staging.bin (GC-covered)
 * 8. sanitizeStillImage (strip EXIF/GPS from thumbnail)
 * 9. clearCache (clean up compressor temp files)
 *
 * Abort supported via cancelCompression.
 */

import {
  Video,
  Image,
  getVideoMetaData,
  createVideoThumbnail,
  clearCache,
} from 'react-native-compressor';
import {
  moveFile,
  stat,
  unlink,
  CachesDirectoryPath,
} from '@dr.pogodin/react-native-fs';
import { sanitizeMp4Gps, verifyNoGpsAtoms } from './mp4GpsSanitizer';
import { sanitizeStillImage } from './imageSanitizer';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface VideoProcessingResult {
  /** Path to the compressed + sanitized video staging file */
  videoPath: string;
  /** MIME type (always video/mp4 after compression) */
  mimeType: string;
  /** File name (always .mp4) */
  fileName: string;
  /** Video width in pixels */
  width: number;
  /** Video height in pixels */
  height: number;
  /** Duration in seconds (float) */
  duration: number;
  /** File size in bytes (post-compression) */
  fileSize: number;
  /** Path to the sanitized thumbnail staging file, or null if thumbnail creation failed */
  thumbnailPath: string | null;
}

export interface VideoProcessingOptions {
  /** AbortSignal for cancellation */
  signal?: AbortSignal;
  /** Progress callback for compression phase (0-1) */
  onProgress?: (progress: number) => void;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_UPLOAD_SIZE_BYTES = 50 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Main function
// ---------------------------------------------------------------------------

/**
 * Prepare a video for upload: compress, strip GPS, extract metadata, create thumbnail.
 *
 * @param sourcePath Absolute path to the source video file
 * @param mediaId UUID for this upload (used for temp file naming)
 * @param options Abort signal and progress callback
 * @returns Processing result with paths and metadata
 * @throws Error if compression fails, GPS can't be stripped, or file too large
 */
export async function prepareVideoForUpload(
  sourcePath: string,
  mediaId: string,
  options?: VideoProcessingOptions,
): Promise<VideoProcessingResult> {
  const stagingPath = `${CachesDirectoryPath}/${mediaId}-staging.bin`;
  const thumbStagingPath = `${CachesDirectoryPath}/${mediaId}-thumb-staging.bin`;

  let compressedPath: string | null = null;
  let rawThumbPath: string | null = null;

  try {
    // 1. Check abort before starting compression
    if (options?.signal?.aborted) {
      throw new Error('Upload cancelled');
    }

    // 2. Compress video to 720p H.264
    compressedPath = await Video.compress(sourcePath, {
      compressionMethod: 'manual',
      maxSize: 1280,
      bitrate: 2_000_000,
      minimumFileSizeForCompress: 0,
    }, (progress) => {
      options?.onProgress?.(progress);
    });

    // Check abort after compression
    if (options?.signal?.aborted) {
      throw new Error('Upload cancelled');
    }

    // 3. Move compressed output to staging path (GC-covered suffix)
    await moveFile(compressedPath, stagingPath);
    compressedPath = null; // Moved, no longer at original location

    // 4. Sanitize GPS atoms
    await sanitizeMp4Gps(stagingPath);

    // 5. Verify no GPS atoms remain (independent pass, fail-closed)
    await verifyNoGpsAtoms(stagingPath);

    // 6. Check post-compression file size
    const st = await stat(stagingPath);
    if (st.size > MAX_UPLOAD_SIZE_BYTES) {
      throw new Error(
        `Video is still too large after compression (${Math.round(st.size / 1024 / 1024)}MB). Maximum is 50MB.`,
      );
    }

    // 7. Get authoritative metadata from compressed video
    const metadata = await getVideoMetaData(stagingPath);
    const width = metadata.width ?? 0;
    const height = metadata.height ?? 0;
    const duration = metadata.duration ?? 0;

    // 8. Create thumbnail (~1s frame)
    let thumbnailPath: string | null = null;
    try {
      // file:// scheme required: the Android impl treats schemeless paths as
      // remote URLs (URLUtil.isFileUrl branch) and fails with EINVAL.
      const thumbResult = await createVideoThumbnail(`file://${stagingPath}`);
      rawThumbPath = await Image.compress(
        thumbResult.path,
        {
          compressionMethod: 'auto',
          maxWidth: 640,
          maxHeight: 640,
          quality: 0.8,
          output: 'jpg',
        },
      );

      // 9. Sanitize thumbnail (strip EXIF/GPS)
      await sanitizeStillImage(rawThumbPath, 'image/jpeg', thumbStagingPath);
      thumbnailPath = thumbStagingPath;
    } catch (e) {
      // Thumbnail creation is best-effort -- degrade to duration-only
      if (__DEV__) {
        console.warn('[prepareVideoForUpload] thumbnail creation failed:', e instanceof Error ? e.message : e);
      }
    } finally {
      if (rawThumbPath) {
        await unlink(rawThumbPath).catch(() => {});
        rawThumbPath = null;
      }
    }

    // 10. Clear compressor cache
    await clearCache().catch(() => {});

    return {
      videoPath: stagingPath,
      mimeType: 'video/mp4',
      fileName: `${mediaId}.mp4`,
      width,
      height,
      duration,
      fileSize: st.size,
      thumbnailPath,
    };
  } catch (e) {
    // Clean up on failure
    await unlink(stagingPath).catch(() => {});
    await unlink(thumbStagingPath).catch(() => {});

    // Try to cancel compression if it's still running
    try {
      await Video.cancelCompression('');
    } catch {
      // Best effort
    }

    await clearCache().catch(() => {});

    throw e;
  } finally {
    // Clean up raw paths that might remain
    if (compressedPath) {
      await unlink(compressedPath).catch(() => {});
    }
    if (rawThumbPath) {
      await unlink(rawThumbPath).catch(() => {});
    }
  }
}
