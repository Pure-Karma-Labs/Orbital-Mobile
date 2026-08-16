/**
 * Media upload service -- orchestrates streaming file encryption, chunked upload,
 * and store persistence for images and videos.
 *
 * Flow (images):
 * 1. Normalize URI (copy content:// to staging in Caches)
 * 2. sanitizeStillImage (strip EXIF/GPS metadata, fail-closed verify)
 * 3. stat() for authoritative file size; reject > 50MB or === 0
 * 4. Compute ciphertext length: 16 (IV) + padded_data + 32 (HMAC)
 * 5. PHASE 1 -- stream-encrypt plaintext to a ciphertext file using 1MB reads
 * 6. Build metadata JSON (v, contentType, fileName, width, height, digest, attachmentKey)
 * 7. Extract IV from ciphertext file (first 16 bytes)
 * 8. PHASE 2 -- read 5MB chunks from ciphertext file, upload sequentially
 * 9. Complete upload
 * 10. Copy plaintext to canonical path; persist to local DB and store
 *
 * Flow (videos):
 * 1. Normalize URI
 * 2. prepareVideoForUpload (transcode, GPS strip, metadata, thumbnail)
 * 3. Upload thumbnail as separate encrypted media (recursive uploadMedia)
 * 4. Same phases 3-10 as images, with duration + thumbnail* envelope fields
 *
 * SECURITY: Crypto operations delegated to attachmentCrypto (Rust FFI).
 * SECURITY: Plaintext never held entirely in memory -- streamed in 1MB reads.
 * SECURITY: Image EXIF/GPS stripped by imageSanitizer (not by picker re-encode).
 * SECURITY: Video GPS stripped by mp4GpsSanitizer (not by the native transcoder).
 */

import type { PickedMedia } from '../hooks/useMediaPicker';
import { generateAttachmentKeys, createAttachmentEncryptor } from './crypto/attachmentCrypto';
import { encryptContent, getOrFetchGroupKey } from './crypto/contentCrypto';
import { arrayBufferToBase64, base64ToUint8Array, toArrayBuffer } from './crypto/utils';
import { MAX_UPLOAD_SIZE_BYTES, STREAM_READ_SIZE_BYTES } from './media/mediaLimits';
import { isStagingResidueName } from './media/stagingResidue';
import { uploadChunk, completeUpload } from './api/media';
import { QuotaExceededError, AuthError } from './api/errors';
import { saveMedia, deleteMedia } from '../database/repositories/mediaRepository';
import { isDatabaseInitialized } from '../database/connection';
import { useAppStore } from '../stores/useAppStore';
import { generateUUID } from '../utils/uuid';
import { sanitizeStillImage } from './media/imageSanitizer';
import { prepareVideoForUpload, isCancellation } from './media/videoProcessing';
import { UPLOAD_CANCELLED_MESSAGE } from './media/uploadCancellation';
import {
  read,
  writeFile,
  appendFile,
  copyFile,
  stat,
  unlink,
  readDir,
  mkdir,
  exists,
  CachesDirectoryPath,
} from '@dr.pogodin/react-native-fs';
import type { MediaContentClass } from '../types/api';
import type { MediaItem } from '../types/store';
import type { MediaRow } from '../database/repositories/mediaRepository';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Chunk size in bytes (5MB) for chunked upload to backend */
const CHUNK_SIZE_BYTES = 5 * 1024 * 1024;

/** Maximum retry attempts per chunk */
const MAX_RETRIES = 3;

/** Base delay for exponential backoff (ms) */
const BASE_RETRY_DELAY_MS = 1000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Coarse phase of an in-flight upload, for the composer's progress label. */
export type UploadPhase = 'compressing' | 'encrypting' | 'uploading';

/**
 * One consistent snapshot of upload progress.
 *
 * A single payload (rather than separate numeric/phase callbacks) guarantees
 * the bar and the MB readout can never disagree for a frame.
 */
export interface UploadProgressEvent {
  /** Blended 0-1. Video: transcode 0→0.3, upload 0.3→1. Image: upload 0→1. */
  fraction: number;
  phase: UploadPhase;
  /** Ciphertext bytes POSTed so far. Upload phase only — undefined otherwise. */
  bytesSent?: number;
  /** Total ciphertext bytes for THIS item. Known from the encrypting phase on. */
  totalBytes?: number;
}

/**
 * True for BOTH shapes a cancelled upload can reject with: our own
 * `UPLOAD_CANCELLED_MESSAGE` sentinel and the native transcoder's
 * `MediaTranscoderError { code: 'ECANCELLED' }`.
 *
 * Consumers MUST use this rather than a message-string check — a bare string
 * check silently misses the transcode-phase cancel, which is the longest phase
 * and therefore the most likely one to be cancelled.
 */
export function isUploadCancellation(e: unknown): boolean {
  return isCancellation(e) || (e instanceof Error && e.message === UPLOAD_CANCELLED_MESSAGE);
}

export interface UploadMediaOptions {
  /** Local file URI (file:// or content://) from picker */
  fileUri: string;
  /** MIME type (e.g. 'image/jpeg') */
  mimeType: string;
  /** File name */
  fileName: string;
  /** Image width in pixels */
  width?: number;
  /** Image height in pixels */
  height?: number;
  /** Video duration in seconds (float) */
  duration?: number;
  /** Group to upload into */
  groupId: string;
  /** Thread to associate with (if uploading for a thread) */
  threadId?: string;
  /** Reply to associate with (if uploading for a reply) */
  replyId?: string;
  /** Progress callback — one consistent {fraction, phase, bytes} snapshot per tick */
  onProgress?: (e: UploadProgressEvent) => void;
  /** AbortSignal for cancellation */
  signal?: AbortSignal;
  /** Internal: marks this upload as a thumbnail child (no thread/reply association) */
  _isThumbnail?: boolean;
  /** Internal: content class inherited from the parent upload (thumbnails inherit the parent's class) */
  _contentClass?: MediaContentClass;
}

/** Result from uploadMedia -- includes key/digest for envelope building */
export interface UploadMediaResult {
  /** Server-assigned media ID */
  mediaId: string;
  /** 64-byte attachment key (32 AES + 32 HMAC) */
  attachmentKey: Uint8Array;
  /** SHA-256 digest of the ciphertext */
  digest: Uint8Array;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Write a base64-encoded chunk to a temporary file for upload.
 * Used during Phase 2 (chunk upload) -- reads a slice from the ciphertext file
 * and writes it to a per-chunk temp file for FormData upload.
 */
async function writeChunkToTempFile(
  base64Content: string,
  mediaId: string,
  chunkIndex: number,
): Promise<string> {
  const filePath = `${CachesDirectoryPath}/${mediaId}-chunk-${chunkIndex}.bin`;
  try {
    await writeFile(filePath, base64Content, 'base64');
  } catch (err) {
    await unlink(filePath).catch(() => {});
    throw err;
  }
  return filePath;
}

function unlinkChunkFile(filePath: string): void {
  unlink(filePath).catch(() => {});
}

/**
 * Sleep for a given duration (for retry backoff).
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Resolve a URI to a filesystem path suitable for RNFS operations.
 *
 * For content:// URIs (Android), copies to a staging file in Caches and returns
 * { sourcePath, stagingPath }. For file:// URIs, strips the prefix and returns
 * the bare path (RNFS normalizeFilePath does this internally, but we strip it
 * ourselves for consistency in offset-read calls).
 *
 * @returns sourcePath for reads, and stagingPath (if staging was needed)
 */
async function resolveUri(
  fileUri: string,
  mediaId: string,
): Promise<{ sourcePath: string; stagingPath: string | null }> {
  if (fileUri.startsWith('content://')) {
    // Android content:// URI -- copy to staging so we can do offset reads
    const stagingPath = `${CachesDirectoryPath}/${mediaId}-staging.bin`;
    await copyFile(fileUri, stagingPath);
    return { sourcePath: stagingPath, stagingPath };
  }

  // file:// URI or bare path -- RNFS normalizeFilePath strips file://,
  // but we do it here too for stat/read consistency
  const sourcePath = fileUri.startsWith('file://') ? fileUri.slice(7) : fileUri;
  return { sourcePath, stagingPath: null };
}

/**
 * Check if a MIME type is a video type.
 */
function isVideoMime(mimeType: string): boolean {
  return mimeType.startsWith('video/');
}

// ---------------------------------------------------------------------------
// Main upload function
// ---------------------------------------------------------------------------

/**
 * Upload a media file with streaming encryption and chunked upload.
 *
 * @param options - Upload configuration including file URI and metadata.
 * @returns UploadMediaResult with mediaId, attachmentKey, and digest.
 * @throws Error if file is too large, encryption fails, or upload fails after retries.
 */
export async function uploadMedia(options: UploadMediaOptions): Promise<UploadMediaResult> {
  const {
    fileUri,
    groupId,
    threadId,
    replyId,
    onProgress,
    signal,
    _isThumbnail,
    _contentClass,
  } = options;

  let { mimeType, fileName, width, height, duration } = options;

  const mediaId = generateUUID();

  // Coarse class for the server's eviction policy — sent on the first chunk only.
  // Derived ONCE from the ORIGINAL options.mimeType (not the `let mimeType` that the
  // video branch reassigns post-transcode), so the value is stable for the whole chunk
  // loop. A thumbnail inherits its parent's class via _contentClass rather than
  // assuming every thumbnail has a video parent. Anything that is neither video/* nor
  // image/* is left undefined so the field is omitted and the server keeps its NULL
  // size-floor fallback instead of being handed a mislabelled class.
  const contentClass: MediaContentClass | undefined =
    _contentClass ??
    (isVideoMime(options.mimeType)
      ? 'video'
      : options.mimeType.startsWith('image/')
        ? 'image'
        : undefined);

  // Same post-transcode-reassignment footgun #707 fixed for contentClass: the
  // video branch reassigns `mimeType`, so the progress base must be derived ONCE
  // from the ORIGINAL options.mimeType. A thumbnail child is never a video and
  // owns the whole 0→1 range of its (private) progress channel.
  const isVideoSource = isVideoMime(options.mimeType) && !_isThumbnail;
  /** Fraction the bar sits at once transcoding is done: 0.3 for video, 0 otherwise. */
  const progressBase = isVideoSource ? 0.3 : 0;

  // 0. URI normalization
  const { sourcePath: resolvedPath, stagingPath } = await resolveUri(fileUri, mediaId);
  let sourcePath = resolvedPath;

  // Ciphertext temp file path
  const ctPath = `${CachesDirectoryPath}/${mediaId}-cipher.bin`;

  // Temp paths for sanitized images
  const sanitizedStagingPath = `${CachesDirectoryPath}/${mediaId}-staging.bin`;

  // Track keys/digest for failure-row and metadata
  let keys: Uint8Array | null = null;
  let digestBytes: Uint8Array | null = null;
  let fileSize = 0;

  // Thumbnail upload result (video only)
  let thumbnailResult: UploadMediaResult | null = null;
  let thumbnailLocalPath: string | null = null;
  let thumbnailWidth: number | null = null;
  let thumbnailHeight: number | null = null;
  let thumbnailSizeBytes: number | null = null;
  let videoStagingPath: string | null = null;
  let thumbStagingPath: string | null = null;

  try {
    // -----------------------------------------------------------------------
    // Video branch
    // -----------------------------------------------------------------------
    if (isVideoMime(mimeType) && !_isThumbnail) {
      onProgress?.({ fraction: 0, phase: 'compressing' });

      const videoResult = await prepareVideoForUpload(sourcePath, mimeType, mediaId, {
        signal,
        // First 30% of the bar is the transcode
        onProgress: (p) => onProgress?.({ fraction: p * 0.3, phase: 'compressing' }),
      });

      // Switch source to compressed + sanitized video
      sourcePath = videoResult.videoPath;
      videoStagingPath = videoResult.videoPath;
      mimeType = videoResult.mimeType;
      fileName = videoResult.fileName;
      width = videoResult.width;
      height = videoResult.height;
      duration = videoResult.duration;
      fileSize = videoResult.fileSize;

      // Upload thumbnail as separate encrypted media (best-effort)
      if (videoResult.thumbnailPath) {
        thumbStagingPath = videoResult.thumbnailPath;
        try {
          const thumbStat = await stat(videoResult.thumbnailPath);
          thumbnailResult = await uploadMedia({
            fileUri: `file://${videoResult.thumbnailPath}`,
            mimeType: 'image/jpeg',
            fileName: `${mediaId}-thumb.jpg`,
            groupId,
            // No threadId/replyId -- thumbnails are not associated with threads/replies
            _isThumbnail: true,
            // Inherit the parent's class so a retained video keeps its poster frame
            _contentClass: contentClass,
            signal,
          });
          thumbnailSizeBytes = thumbStat.size;
          thumbnailLocalPath = videoResult.thumbnailPath;
          // Approximate thumbnail dimensions by scaling the video dimensions to a
          // 640px cap. Guard against a 0-width metadata read (0/0 = NaN, which would
          // serialize to null in the envelope and store a confusing 0x0 dimension).
          if (videoResult.width > 0 && videoResult.height > 0) {
            const scale = Math.min(videoResult.width, 640) / videoResult.width;
            thumbnailWidth = Math.round(videoResult.width * scale);
            thumbnailHeight = Math.round(videoResult.height * scale);
          }
        } catch (e) {
          // A cancelled child is NOT a thumbnail failure. Rethrow before the
          // degrade branch so cancel latency stays deterministic across the
          // transcode/thumbnail boundary and a cancel is never logged (or
          // silently absorbed) as a degradation.
          if (isUploadCancellation(e) || signal?.aborted) {
            throw e;
          }
          // Thumbnail upload failure -- degrade to duration-only
          if (__DEV__) {
            console.warn('[uploadMedia] thumbnail upload failed, degrading:', e instanceof Error ? e.message : e);
          }
          thumbnailResult = null;
        }
      }
    }
    // -----------------------------------------------------------------------
    // Image branch (non-thumbnail)
    // -----------------------------------------------------------------------
    else if (!isVideoMime(mimeType) && !_isThumbnail) {
      // Sanitize still image (strip EXIF/GPS metadata, fail-closed verify)
      const targetPath = stagingPath ? stagingPath : sanitizedStagingPath;
      await sanitizeStillImage(sourcePath, mimeType, targetPath);
      sourcePath = targetPath;
    }
    // -----------------------------------------------------------------------
    // Thumbnail branch (_isThumbnail) -- already sanitized by videoProcessing
    // -----------------------------------------------------------------------

    // The 1 MiB encrypt loop below emits nothing: the bar holds at the
    // post-transcode base while the label swaps to "Encrypting…". Re-scaling the
    // fraction budget here would just move the stall somewhere else.
    onProgress?.({ fraction: progressBase, phase: 'encrypting' });

    // 1. stat for authoritative file size
    const st = await stat(sourcePath);
    fileSize = st.size;

    if (fileSize === 0) {
      throw new Error('Cannot upload empty file.');
    }

    if (fileSize > MAX_UPLOAD_SIZE_BYTES) {
      throw new Error(
        `File too large (${Math.round(fileSize / 1024 / 1024)}MB). Maximum is ${MAX_UPLOAD_SIZE_BYTES / 1024 / 1024}MB.`,
      );
    }

    // 2. Compute expected ciphertext length
    //    AES-256-CBC with PKCS7: IV(16) + ceil((plaintext+1)/16)*16 + HMAC(32)
    const paddedLen = (fileSize - (fileSize % 16) + 16);
    const ciphertextLen = 16 + paddedLen + 32;
    const totalChunks = Math.ceil(ciphertextLen / CHUNK_SIZE_BYTES);

    // Re-emit the encrypting phase now that the MB total is known, so the
    // readout can render "0 MB / 32 MB" before the first chunk goes out.
    onProgress?.({ fraction: progressBase, phase: 'encrypting', totalBytes: ciphertextLen });

    // 3. Generate attachment keys
    const generated = generateAttachmentKeys();
    keys = generated.keys;

    // 4. PHASE 1 -- Stream encrypt plaintext to ciphertext file
    const enc = createAttachmentEncryptor(keys);
    try {
      for (let pos = 0; pos < fileSize; pos += STREAM_READ_SIZE_BYTES) {
        // Abort check
        if (signal?.aborted) {
          throw new Error(UPLOAD_CANCELLED_MESSAGE);
        }

        const n = Math.min(STREAM_READ_SIZE_BYTES, fileSize - pos);
        const b64 = await read(sourcePath, n, pos, 'base64');
        const bytes = base64ToUint8Array(b64);

        if (bytes.length !== n) {
          throw new Error('File changed during upload — byte count mismatch.');
        }

        const ct = enc.push(bytes);
        if (ct.length > 0) {
          await appendFile(ctPath, arrayBufferToBase64(toArrayBuffer(ct)), 'base64');
        }
      }

      const { tail, digest } = enc.finalize();
      digestBytes = digest;
      await appendFile(ctPath, arrayBufferToBase64(toArrayBuffer(tail)), 'base64');
    } catch (err) {
      enc.destroy();
      await unlink(ctPath).catch(() => {});
      throw err;
    }
    enc.destroy();

    // Verify ciphertext size
    const ctStat = await stat(ctPath);
    if (ctStat.size !== ciphertextLen) {
      throw new Error(
        `Ciphertext size mismatch: expected ${ciphertextLen}, got ${ctStat.size}`,
      );
    }

    // 5. Build metadata and encrypt with group key (AES-256-GCM)
    // SECURITY: Metadata (fileName, contentType, dimensions, duration) is encrypted so
    // the server never sees user filenames or precise content types. ONE carve-out: the
    // first chunk also carries a coarse `content_class` ('image'/'video') as a separate
    // multipart field, a deliberate write-only one-bit disclosure that drives the
    // server's retention policy (#707). Nothing else about the file leaves this envelope.
    const digestBase64 = arrayBufferToBase64(toArrayBuffer(digestBytes));
    const metadataObj: Record<string, unknown> = {
      v: 1,
      contentType: mimeType,
      fileName,
      ...(width != null ? { width } : {}),
      ...(height != null ? { height } : {}),
      digest: digestBase64,
      attachmentKey: arrayBufferToBase64(toArrayBuffer(keys)),
    };

    // Video-specific envelope fields
    if (duration != null) {
      metadataObj.duration = duration; // seconds (float)
    }
    if (thumbnailResult) {
      metadataObj.thumbnailMediaId = thumbnailResult.mediaId;
      metadataObj.thumbnailKey = arrayBufferToBase64(toArrayBuffer(thumbnailResult.attachmentKey));
      metadataObj.thumbnailDigest = arrayBufferToBase64(toArrayBuffer(thumbnailResult.digest));
      if (thumbnailWidth != null) metadataObj.thumbnailWidth = thumbnailWidth;
      if (thumbnailHeight != null) metadataObj.thumbnailHeight = thumbnailHeight;
      if (thumbnailSizeBytes != null) metadataObj.thumbnailSizeBytes = thumbnailSizeBytes;
    }

    const metadataPlain = JSON.stringify(metadataObj);
    const groupKey = await getOrFetchGroupKey(groupId);
    const encryptedMeta = encryptContent(metadataPlain, groupKey, groupId);
    const metadata = JSON.stringify({
      ciphertext: encryptedMeta.ciphertext,
      iv: encryptedMeta.iv,
    });

    // 6. Extract IV from ciphertext (first 16 bytes)
    const ivBase64 = await read(ctPath, 16, 0, 'base64');

    onProgress?.({
      fraction: progressBase,
      phase: 'uploading',
      bytesSent: 0,
      totalBytes: ciphertextLen,
    });

    // 7. PHASE 2 -- Upload chunks from ciphertext file
    for (let i = 0; i < totalChunks; i++) {
      // Check for cancellation
      if (signal?.aborted) {
        throw new Error(UPLOAD_CANCELLED_MESSAGE);
      }

      const chunkStart = i * CHUNK_SIZE_BYTES;
      const chunkLen = Math.min(CHUNK_SIZE_BYTES, ciphertextLen - chunkStart);
      const sliceB64 = await read(ctPath, chunkLen, chunkStart, 'base64');
      const chunkFilePath = await writeChunkToTempFile(sliceB64, mediaId, i);

      // Retry logic with exponential backoff
      let lastError: Error | null = null;
      try {
        for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
          try {
            await uploadChunk(
              {
                mediaId,
                groupId,
                chunkIndex: i,
                totalChunks,
                chunkFilePath,
                // First chunk includes metadata, IV, and the coarse content class
                ...(i === 0
                  ? { encryptedMetadata: metadata, encryptionIv: ivBase64, contentClass }
                  : {}),
              },
              signal,
            );
            lastError = null;
            break;
          } catch (e) {
            lastError = e instanceof Error ? e : new Error(String(e));

            // Quota and auth failures can never succeed on retry — fail fast with the typed error
            if (lastError instanceof QuotaExceededError || lastError instanceof AuthError) {
              throw lastError;
            }

            // Don't retry auth or validation errors
            if (lastError.message.includes('401') || lastError.message.includes('403')) {
              throw lastError;
            }

            // Don't retry on cancellation
            if (signal?.aborted) {
              throw new Error(UPLOAD_CANCELLED_MESSAGE);
            }

            // Exponential backoff before retry
            if (attempt < MAX_RETRIES - 1) {
              await sleep(BASE_RETRY_DELAY_MS * Math.pow(2, attempt));
            }
          }
        }

        if (lastError) {
          if (isDatabaseInitialized()) {
            try {
              const failedRow = buildMediaRow(
                mediaId, threadId ?? null, replyId ?? null, mimeType,
                fileName, fileSize, width, height, keys, digestBytes,
                'pending', 'failed',
              );
              saveMedia(failedRow);
            } catch {
              // Best-effort persistence -- don't mask the upload error
            }
          }
          throw new Error('Failed to upload media. Please try again.');
        }
      } finally {
        unlinkChunkFile(chunkFilePath);
      }

      // Report progress (for videos: 30-100% is upload; for images: 0-100%).
      // bytesSent is capped at ciphertextLen so the final tick reads exactly
      // "32 MB / 32 MB" rather than overshooting on the short last chunk.
      const uploadRange = 1 - progressBase;
      onProgress?.({
        fraction: progressBase + ((i + 1) / totalChunks) * uploadRange,
        phase: 'uploading',
        bytesSent: Math.min((i + 1) * CHUNK_SIZE_BYTES, ciphertextLen),
        totalBytes: ciphertextLen,
      });
    }

    // 8. Complete the upload. An abort that landed after the final chunk POST
    // must stop here — completeUpload takes no signal and the canonical copy
    // below is seconds-long for a large video, so without this check a cancel
    // in that tail window would resolve the upload (and the batch would then
    // publish the post the user just cancelled).
    if (signal?.aborted) {
      throw new Error(UPLOAD_CANCELLED_MESSAGE);
    }
    await completeUpload(mediaId, groupId);

    // 9. Copy plaintext to canonical path so file survives app restarts
    //    (picker URIs in /tmp/ are evicted by iOS)
    const ext = fileName.split('.').pop() ?? 'dat';
    const { MEDIA_DIR: mediaDirPath, toStoredMediaPath } = await import('./media/mediaPaths');
    const canonicalPath = `${mediaDirPath}/${mediaId}.${ext}`;
    let savedLocalPath: string | null = null;

    try {
      const dirExists = await exists(mediaDirPath);
      if (!dirExists) {
        await mkdir(mediaDirPath, { NSURLIsExcludedFromBackupKey: true });
      }
      await copyFile(sourcePath, canonicalPath);
      savedLocalPath = canonicalPath;
    } catch (e) {
      if (__DEV__) {
        console.warn('[uploadMedia] Failed to copy plaintext to canonical path:', e instanceof Error ? e.message : e);
      }
      // Non-fatal -- upload succeeded, file will be re-downloadable
    }

    // 10. Persist to local DB (DB stores relative path, store keeps absolute)
    const mediaRow = buildMediaRow(
      mediaId, threadId ?? null, replyId ?? null, mimeType,
      fileName, fileSize, width, height, keys, digestBytes,
      savedLocalPath ? 'downloaded' : 'pending', 'done',
      {
        duration: duration != null ? Math.round(duration * 1000) : null,
        thumbnail_media_id: thumbnailResult?.mediaId ?? null,
        is_thumbnail: _isThumbnail ? 1 : 0,
        archive_confirmed: 1,
      },
    );
    mediaRow.local_path = savedLocalPath ? toStoredMediaPath(savedLocalPath) : null;
    if (isDatabaseInitialized()) {
      try {
        saveMedia(mediaRow);
      } catch (e) {
        if (__DEV__) {
          console.warn('[uploadMedia] saveMedia failed (upload succeeded):', e instanceof Error ? e.message : e);
        }
      }
    }

    // 11. Update Zustand store
    const storeItem: MediaItem = {
      id: mediaId,
      threadId: threadId ?? null,
      replyId: replyId ?? null,
      contentType: mimeType,
      fileName,
      fileSize,
      width: width ?? null,
      height: height ?? null,
      duration: duration != null ? Math.round(duration * 1000) : null,
      blurHash: null,
      localPath: savedLocalPath,
      thumbnailPath: thumbnailLocalPath,
      downloadState: savedLocalPath ? 'downloaded' : 'pending',
      uploadState: 'done',
      expiresAt: null,
      hasKeys: true,
      thumbnailMediaId: thumbnailResult?.mediaId ?? null,
      isThumbnail: _isThumbnail ?? false,
    };
    useAppStore.getState().upsertMedia(storeItem);

    return {
      mediaId,
      attachmentKey: keys,
      digest: digestBytes,
    };
  } catch (e) {
    // Normalize EVERY abort-path rejection to the sentinel (mirrors
    // mediaDownloadService). Transport-layer aborts surface as NetworkError
    // ("Aborted"), RNFS reads as platform-specific strings; without this the
    // two-shape guarantee of isUploadCancellation() would hold only by audit.
    if (signal?.aborted && !isUploadCancellation(e)) {
      throw new Error(UPLOAD_CANCELLED_MESSAGE);
    }
    throw e;
  } finally {
    // Best-effort cleanup of ciphertext temp file and staging file.
    // The canonical copy happens before this finally block, so unconditionally
    // unlinking the staging paths is always safe. Unconditional cleanup matters
    // for content:// uploads, where resolveUri returns sourcePath === stagingPath
    // and the sanitized image is written back into the staging file in place —
    // a conditional (stagingPath !== sourcePath) check would leak it.
    await unlink(ctPath).catch(() => {});
    if (stagingPath) {
      await unlink(stagingPath).catch(() => {});
    }
    // Clean up sanitized staging (file:// image path, where no content:// staging existed)
    if (sourcePath === sanitizedStagingPath && sanitizedStagingPath !== stagingPath) {
      await unlink(sanitizedStagingPath).catch(() => {});
    }
    // Clean up video staging paths
    if (videoStagingPath) {
      await unlink(videoStagingPath).catch(() => {});
    }
    if (thumbStagingPath) {
      await unlink(thumbStagingPath).catch(() => {});
    }
  }
}

// ---------------------------------------------------------------------------
// Batch upload helper
// ---------------------------------------------------------------------------

/** Progress payload for a batch — the per-item event plus its position. */
export type BatchUploadProgressEvent = UploadProgressEvent & {
  /** Zero-based index of the item currently uploading. */
  itemIndex: number;
  /** Total items in this batch. */
  itemCount: number;
};

/** Error thrown by uploadMediaBatch, carrying whatever completed before it failed. */
export interface BatchUploadError extends Error {
  /**
   * Server-assigned ids of items that fully completed before the batch failed.
   * Their LOCAL half is rolled back on cancellation (see below); the server-side
   * rows persist until retention reaps them — there is no abort endpoint yet.
   */
  uploadedMediaIds?: string[];
}

/**
 * Roll back the LOCAL half of items a cancelled batch had already committed.
 *
 * uploadMedia's tail commits each completed item locally (canonical file copy,
 * saveMedia with upload_state 'done' and thread_id NULL, Zustand upsert). On a
 * mid-batch cancel nothing ever calls updateMediaParent, so those rows would sit
 * in FileLibrary forever (its filter surfaces upload_state='done' rows regardless
 * of parent) and their bytes would count against local storage usage.
 *
 * Best-effort throughout: a rollback failure must never mask the cancellation.
 */
async function rollbackLocalMedia(mediaIds: string[]): Promise<void> {
  for (const id of mediaIds) {
    const localPath = useAppStore.getState().media[id]?.localPath ?? null;
    if (localPath) {
      await unlink(localPath).catch(() => {});
    }
    if (isDatabaseInitialized()) {
      try {
        deleteMedia(id);
      } catch {
        // Best-effort -- the store removal below still hides the ghost row
      }
    }
    useAppStore.getState().removeMedia(id);
  }
}

/**
 * Upload a batch of picked media files sequentially.
 *
 * This is a convenience wrapper used by ComposeThreadScreen and
 * ThreadDetailScreen (ReplyComposer) to avoid duplicating the
 * upload-loop pattern.
 *
 * Progress is per-item: `fraction`/`bytesSent` describe the CURRENT item only,
 * stamped with `itemIndex`/`itemCount` so the UI can blend a batch-overall bar.
 * A cross-item byte total is deliberately not offered — ciphertext length is
 * only known per item (and a video's source size is not its uploaded size), so
 * any up-front total would jump or regress mid-post.
 *
 * @param items - Array of PickedMedia from useMediaPicker.
 * @param groupId - The group to upload into.
 * @param opts - Abort signal and progress callback.
 * @returns Array of mediaIds in the same order as the input items.
 * @throws BatchUploadError — on cancellation the local rows of completed items
 *   are rolled back first; `uploadedMediaIds` carries the server-side ids.
 */
export async function uploadMediaBatch(
  items: PickedMedia[],
  groupId: string,
  opts?: {
    signal?: AbortSignal;
    onProgress?: (e: BatchUploadProgressEvent) => void;
  },
): Promise<string[]> {
  const ids: string[] = [];
  const itemCount = items.length;
  const onProgress = opts?.onProgress;

  try {
    for (let itemIndex = 0; itemIndex < itemCount; itemIndex++) {
      // An abort landing in the gap between two items must not start item N+1.
      if (opts?.signal?.aborted) {
        throw new Error(UPLOAD_CANCELLED_MESSAGE);
      }

      const media = items[itemIndex];
      const result = await uploadMedia({
        fileUri: media.uri,
        mimeType: media.type,
        fileName: media.fileName,
        width: media.width,
        height: media.height,
        duration: media.duration,
        groupId,
        signal: opts?.signal,
        onProgress: onProgress
          ? (e) => onProgress({ ...e, itemIndex, itemCount })
          : undefined,
      });
      ids.push(result.mediaId);
    }

    // An abort landing in the last item's unsignalled tail (completeUpload
    // round trip + canonical copy) resolves that item normally — this final
    // check converts it into a cancellation so the catch below rolls back and
    // the composer never publishes a post the user cancelled (panel finding,
    // PR #719 review).
    if (opts?.signal?.aborted) {
      throw new Error(UPLOAD_CANCELLED_MESSAGE);
    }
  } catch (e) {
    if (isUploadCancellation(e) || opts?.signal?.aborted) {
      await rollbackLocalMedia(ids);
    }
    const err: BatchUploadError = e instanceof Error ? e : new Error(String(e));
    err.uploadedMediaIds = ids;
    throw err;
  }

  return ids;
}

// ---------------------------------------------------------------------------
// DB row builder
// ---------------------------------------------------------------------------

function buildMediaRow(
  id: string,
  threadId: string | null,
  replyId: string | null,
  contentType: string,
  fileName: string,
  fileSize: number,
  width: number | undefined,
  height: number | undefined,
  attachmentKey: Uint8Array,
  attachmentDigest: Uint8Array,
  downloadState: string,
  uploadState: string,
  extras?: {
    duration?: number | null;
    thumbnail_media_id?: string | null;
    is_thumbnail?: number;
    archive_confirmed?: number;
  },
): MediaRow {
  return {
    id,
    thread_id: threadId,
    reply_id: replyId,
    message_id: null,
    content_type: contentType,
    file_name: fileName,
    file_size: fileSize,
    width: width ?? null,
    height: height ?? null,
    duration: extras?.duration ?? null,
    attachment_key: attachmentKey,
    attachment_digest: attachmentDigest,
    cdn_number: null,
    cdn_key: null,
    local_path: null,
    thumbnail_path: null,
    blur_hash: null,
    expires_at: null,
    download_state: downloadState,
    upload_state: uploadState,
    created_at: Date.now(),
    thumbnail_media_id: extras?.thumbnail_media_id ?? null,
    is_thumbnail: extras?.is_thumbnail ?? 0,
    archive_confirmed: extras?.archive_confirmed ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Orphaned chunk cleanup
// ---------------------------------------------------------------------------

/**
 * Clean up orphaned chunk, cipher, and staging temp files from interrupted
 * uploads. Call during app bootstrap (best-effort, fire-and-forget).
 */
export async function cleanupOrphanedChunks(): Promise<void> {
  // One-shot legacy sweep: the outgoing compressor kept plaintext frame JPEGs
  // in Caches/thumbnails and reaped them via its own clearCache(). Nothing
  // deletes them on devices upgraded from 1.7.x, so sweep the directory once.
  try {
    const legacyThumbnailDir = `${CachesDirectoryPath}/thumbnails`;
    if (await exists(legacyThumbnailDir)) {
      await unlink(legacyThumbnailDir).catch(() => {});
    }
  } catch {
    // Best-effort -- failures are silently ignored
  }

  try {
    const files = await readDir(CachesDirectoryPath);
    const now = Date.now();
    for (const file of files) {
      if (isStagingResidueName(file.name)) {
        const mtime = file.mtime ? new Date(file.mtime).getTime() : 0;
        const age = now - mtime;
        if (age > 3600_000) {
          // The readDir snapshot is a point-in-time listing, and this loop can
          // take a while. A concurrent download or upload may have recreated
          // this exact deterministic path in the meantime -- deleting it would
          // silently truncate a live transfer's staging file. Re-stat and skip
          // anything that is young NOW. A stat failure is also a skip: if we
          // cannot confirm the file is stale, we do not delete it.
          try {
            const fresh = await stat(file.path);
            const freshMtime = fresh.mtime ? new Date(fresh.mtime).getTime() : 0;
            if (Date.now() - freshMtime <= 3600_000) continue;
          } catch {
            continue;
          }
          await unlink(file.path).catch(() => {});
        }
      }
    }
  } catch {
    // Best-effort -- failures are silently ignored
  }
}
