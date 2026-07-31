/**
 * Video processing pipeline -- transcode, sanitize GPS, extract metadata,
 * and create thumbnail for video uploads.
 *
 * Flow:
 * 1. transcodeVideo -> {mediaId}-transcode-staging.mp4 (720p H.264 @ 2Mbps).
 *    The .mp4 extension is load-bearing: AVAssetWriter derives the container
 *    type from it.
 * 2. Transcode guard: on transcode failure, or if the transcode is >= the
 *    source size, discard the transcode and upload the GPS-sanitized source
 *    instead (pass-through). Cancellation is the one fatal failure.
 * 3. Move/copy output to {mediaId}-staging.bin (GC-covered temp suffix)
 * 4. sanitizeMp4Gps (strip GPS atoms)
 * 5. verifyNoGpsAtoms (independent fail-closed check)
 * 6. getVideoMetadata (authoritative w/h/duration, rotation-corrected)
 * 7. extractThumbnail (~1s frame)
 * 8. sanitizeStillImage (strip EXIF/GPS from thumbnail)
 *
 * Abort is plumbed through cancelTranscode(mediaId); native cancellation
 * rejects with ECANCELLED and deletes the partial output.
 */

import {
  transcodeVideo,
  cancelTranscode,
  getVideoMetadata,
  extractThumbnail,
  subscribeTranscodeProgress,
  isCancellation,
} from 'orbital-media-transcoder';
import {
  moveFile,
  copyFile,
  stat,
  unlink,
  CachesDirectoryPath,
} from '@dr.pogodin/react-native-fs';
import { sanitizeMp4Gps, verifyNoGpsAtoms } from './mp4GpsSanitizer';
import { sanitizeStillImage } from './imageSanitizer';
import { MAX_UPLOAD_SIZE_BYTES } from './mediaLimits';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface VideoProcessingResult {
  /** Path to the transcoded + sanitized video staging file */
  videoPath: string;
  /** MIME type (video/mp4 after transcode, or source MIME on pass-through) */
  mimeType: string;
  /** File name ({mediaId}.mp4 after transcode, or {mediaId}.{ext} on pass-through) */
  fileName: string;
  /** Video width in pixels */
  width: number;
  /** Video height in pixels */
  height: number;
  /** Duration in seconds (float) */
  duration: number;
  /** File size in bytes (post-transcode) */
  fileSize: number;
  /** Path to the sanitized thumbnail staging file, or null if thumbnail creation failed */
  thumbnailPath: string | null;
}

export interface VideoProcessingOptions {
  /** AbortSignal for cancellation */
  signal?: AbortSignal;
  /** Progress callback for the transcode phase (0-1) */
  onProgress?: (progress: number) => void;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Long-side cap: 1280 yields 720p for 16:9 sources. */
const MAX_VIDEO_DIMENSION = 1280;
const TARGET_VIDEO_BITRATE = 2_000_000;

/**
 * Video MIME → file extension mapping for pass-through uploads.
 * Must stay in sync with ALLOWED_VIDEO_MIMES in src/hooks/useMediaPicker.ts.
 */
export const VIDEO_MIME_EXT: Record<string, string> = {
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/x-m4v': 'm4v',
};

// ---------------------------------------------------------------------------
// Main function
// ---------------------------------------------------------------------------

/**
 * Prepare a video for upload: transcode, strip GPS, extract metadata, create thumbnail.
 *
 * If the transcode fails on a device-specific encoder path, or its output is
 * >= the source size, the transcode is discarded and the GPS-sanitized source
 * is uploaded instead. Cancellation is never swallowed.
 *
 * @param sourcePath Absolute path to the source video file
 * @param sourceMimeType MIME type of the source (e.g. 'video/quicktime'); used for
 *   pass-through result so the envelope carries the real content type.
 * @param mediaId UUID for this upload (used for temp file naming and as the
 *   native transcode job id)
 * @param options Abort signal and progress callback
 * @returns Processing result with paths and metadata
 * @throws Error if the upload was cancelled, GPS can't be stripped, or the file is too large
 */
export async function prepareVideoForUpload(
  sourcePath: string,
  sourceMimeType: string,
  mediaId: string,
  options?: VideoProcessingOptions,
): Promise<VideoProcessingResult> {
  const stagingPath = `${CachesDirectoryPath}/${mediaId}-staging.bin`;
  const thumbStagingPath = `${CachesDirectoryPath}/${mediaId}-thumb-staging.bin`;
  // AVFoundation requires the extension to match the container type, so this
  // one staging file cannot use the usual .bin suffix.
  const transcodePath = `${CachesDirectoryPath}/${mediaId}-transcode-staging.mp4`;

  let transcodeWritten = false;
  let rawThumbPath: string | null = null;

  const progressSubscription = subscribeTranscodeProgress(mediaId, (progress) => {
    options?.onProgress?.(progress);
  });
  const onAbort = () => {
    cancelTranscode(mediaId);
  };
  options?.signal?.addEventListener('abort', onAbort);

  try {
    // 1. Check abort before starting the transcode
    if (options?.signal?.aborted) {
      throw new Error('Upload cancelled');
    }

    // 2. Transcode to 720p H.264. A device-specific encoder failure is not
    //    fatal -- it falls through to the pass-through branch below, which
    //    still enforces the GPS sanitizers and the 50MB cap. Only cancellation
    //    aborts the upload.
    let transcodeFailed = false;
    try {
      await transcodeVideo(mediaId, sourcePath, transcodePath, {
        maxDimension: MAX_VIDEO_DIMENSION,
        bitrate: TARGET_VIDEO_BITRATE,
      });
      transcodeWritten = true;
    } catch (e) {
      if (isCancellation(e) || options?.signal?.aborted) {
        throw e;
      }
      transcodeFailed = true;
      if (__DEV__) {
        console.warn(
          '[prepareVideoForUpload] transcode failed, uploading sanitized source:',
          e instanceof Error ? e.message : e,
        );
      }
    }

    // Check abort after the transcode
    if (options?.signal?.aborted) {
      throw new Error('Upload cancelled');
    }

    // 3. Transcode integrity guard: if the transcode failed, or came out
    //    >= the source, discard it and pass the source through.
    let passThrough = transcodeFailed;
    {
      let sourceSize: number | null = null;
      try {
        sourceSize = (await stat(sourcePath)).size;
      } catch (e) {
        if (__DEV__) {
          console.warn(
            '[prepareVideoForUpload] source stat failed, keeping transcode:',
            e instanceof Error ? e.message : e,
          );
        }
      }

      if (!transcodeFailed) {
        const transcodeSize = (await stat(transcodePath)).size;
        passThrough = sourceSize !== null && transcodeSize >= sourceSize;

        if (passThrough && __DEV__) {
          console.warn(
            `[prepareVideoForUpload] transcode integrity guard tripped (source=${sourceSize}B, transcode=${transcodeSize}B); uploading sanitized source`,
          );
        }
      }

      if (passThrough) {
        if (transcodeWritten) {
          await unlink(transcodePath).catch(() => {});
          transcodeWritten = false;
        }
        // Android content:// sources are pre-staged by resolveUri
        // (mediaUploadService.ts) at the identical ${mediaId}-staging.bin path;
        // a self-copy is undefined behavior on some platforms.
        if (sourcePath !== stagingPath) {
          await copyFile(sourcePath, stagingPath);
        }
      } else {
        await moveFile(transcodePath, stagingPath);
        transcodeWritten = false;
      }
    }

    // Abort check after guard
    if (options?.signal?.aborted) {
      throw new Error('Upload cancelled');
    }

    // 4. Sanitize GPS atoms
    await sanitizeMp4Gps(stagingPath);

    // 5. Verify no GPS atoms remain (independent pass, fail-closed)
    await verifyNoGpsAtoms(stagingPath);

    // 6. Check post-transcode file size
    const st = await stat(stagingPath);
    if (st.size > MAX_UPLOAD_SIZE_BYTES) {
      const mb = Math.round(st.size / 1024 / 1024);
      // On pass-through, "after re-encoding" would be misleading -- the
      // transcode either failed or produced output we discarded as invalid.
      throw new Error(
        passThrough
          ? `Video could not be re-encoded and the original is too large to upload directly (${mb}MB). Maximum is ${MAX_UPLOAD_SIZE_BYTES / 1024 / 1024}MB.`
          : `Video is still too large after re-encoding (${mb}MB). Maximum is ${MAX_UPLOAD_SIZE_BYTES / 1024 / 1024}MB.`,
      );
    }

    // 7. Get authoritative metadata from the staged video. Paths are plain
    //    (schemeless) on both platforms -- the wrapper normalizes.
    const metadata = await getVideoMetadata(stagingPath);
    const width = metadata.width ?? 0;
    const height = metadata.height ?? 0;
    const duration = metadata.duration ?? 0;

    // 8. Create thumbnail (~1s frame)
    let thumbnailPath: string | null = null;
    try {
      rawThumbPath = `${CachesDirectoryPath}/${mediaId}-thumbraw-staging.bin`;
      // The JPEG encoder ignores the extension; only AVAssetWriter cares.
      await extractThumbnail(stagingPath, 1000, rawThumbPath, 640, 0.8);

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

    const ext = passThrough
      ? (VIDEO_MIME_EXT[sourceMimeType] ?? 'mp4')
      : 'mp4';

    return {
      videoPath: stagingPath,
      mimeType: passThrough ? sourceMimeType : 'video/mp4',
      fileName: `${mediaId}.${ext}`,
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
    await unlink(transcodePath).catch(() => {});

    // Stop the native job if it is still running
    try {
      cancelTranscode(mediaId);
    } catch {
      // Best effort
    }

    throw e;
  } finally {
    progressSubscription.remove();
    options?.signal?.removeEventListener('abort', onAbort);

    // Clean up raw paths that might remain
    if (transcodeWritten) {
      await unlink(transcodePath).catch(() => {});
    }
    if (rawThumbPath) {
      await unlink(rawThumbPath).catch(() => {});
    }
  }
}
