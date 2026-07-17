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
 * 2. prepareVideoForUpload (compress, GPS strip, metadata, thumbnail)
 * 3. Upload thumbnail as separate encrypted media (recursive uploadMedia)
 * 4. Same phases 3-10 as images, with duration + thumbnail* envelope fields
 *
 * SECURITY: Crypto operations delegated to attachmentCrypto (Rust FFI).
 * SECURITY: Plaintext never held entirely in memory -- streamed in 1MB reads.
 * SECURITY: Image EXIF/GPS stripped by imageSanitizer (not by picker re-encode).
 * SECURITY: Video GPS stripped by mp4GpsSanitizer (not by react-native-compressor).
 */

import type { PickedMedia } from '../hooks/useMediaPicker';
import { generateAttachmentKeys, createAttachmentEncryptor } from './crypto/attachmentCrypto';
import { encryptContent, getOrFetchGroupKey } from './crypto/contentCrypto';
import { arrayBufferToBase64, toArrayBuffer } from './crypto/utils';
import { uploadChunk, completeUpload } from './api/media';
import { saveMedia } from '../database/repositories/mediaRepository';
import { isDatabaseInitialized } from '../database/connection';
import { useAppStore } from '../stores/useAppStore';
import { generateUUID } from '../utils/uuid';
import { sanitizeStillImage } from './media/imageSanitizer';
import { prepareVideoForUpload } from './media/videoProcessing';
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
  DocumentDirectoryPath,
} from '@dr.pogodin/react-native-fs';
import type { MediaItem } from '../types/store';
import type { MediaRow } from '../database/repositories/mediaRepository';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Maximum file size in bytes (50MB).
 *
 * The ceiling is set by the receiver-side one-shot decrypt, which holds ~3.3x
 * the file size in transient memory (ciphertext + plaintext + intermediate
 * buffers). Streaming decrypt (#578) will raise this further.
 */
const MAX_UPLOAD_SIZE_BYTES = 50 * 1024 * 1024;

/** Chunk size in bytes (5MB) for chunked upload to backend */
const CHUNK_SIZE_BYTES = 5 * 1024 * 1024;

/** Read size for streaming encryption phase (1MB) */
const ENCRYPT_READ_SIZE_BYTES = 1 * 1024 * 1024;

/** Maximum retry attempts per chunk */
const MAX_RETRIES = 3;

/** Base delay for exponential backoff (ms) */
const BASE_RETRY_DELAY_MS = 1000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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
  /** Progress callback (0-1) */
  onProgress?: (progress: number) => void;
  /** Phase progress callback */
  onPhase?: (phase: 'compressing' | 'encrypting' | 'uploading') => void;
  /** AbortSignal for cancellation */
  signal?: AbortSignal;
  /** Internal: marks this upload as a thumbnail child (no thread/reply association) */
  _isThumbnail?: boolean;
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
 * Decode a base64 string to Uint8Array.
 * Uses atob which is available in Hermes via react-native polyfills.
 */
function base64ToUint8Array(base64: string): Uint8Array {
  const g = globalThis as unknown as { atob: (s: string) => string };
  const binary = g.atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

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
    onPhase,
    signal,
    _isThumbnail,
  } = options;

  let { mimeType, fileName, width, height, duration } = options;

  const mediaId = generateUUID();

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
      onPhase?.('compressing');

      const videoResult = await prepareVideoForUpload(sourcePath, mediaId, {
        signal,
        onProgress: (p) => onProgress?.(p * 0.3), // First 30% for compression
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
            signal,
          });
          thumbnailSizeBytes = thumbStat.size;
          thumbnailLocalPath = videoResult.thumbnailPath;
          // TODO: extract thumbnail dimensions from metadata; for now use reasonable defaults
          thumbnailWidth = Math.min(videoResult.width, 640);
          thumbnailHeight = Math.round(
            (Math.min(videoResult.width, 640) / videoResult.width) * videoResult.height,
          );
        } catch (e) {
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

    onPhase?.('encrypting');

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

    // 3. Generate attachment keys
    const generated = generateAttachmentKeys();
    keys = generated.keys;

    // 4. PHASE 1 -- Stream encrypt plaintext to ciphertext file
    const enc = createAttachmentEncryptor(keys);
    try {
      for (let pos = 0; pos < fileSize; pos += ENCRYPT_READ_SIZE_BYTES) {
        // Abort check
        if (signal?.aborted) {
          throw new Error('Upload cancelled');
        }

        const n = Math.min(ENCRYPT_READ_SIZE_BYTES, fileSize - pos);
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
    // SECURITY: Metadata (fileName, contentType, dimensions) is encrypted so the
    // server never sees user filenames or content types (zero-knowledge).
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

    onPhase?.('uploading');

    // 7. PHASE 2 -- Upload chunks from ciphertext file
    for (let i = 0; i < totalChunks; i++) {
      // Check for cancellation
      if (signal?.aborted) {
        throw new Error('Upload cancelled');
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
                // First chunk includes metadata and IV
                ...(i === 0
                  ? { encryptedMetadata: metadata, encryptionIv: ivBase64 }
                  : {}),
              },
              signal,
            );
            lastError = null;
            break;
          } catch (e) {
            lastError = e instanceof Error ? e : new Error(String(e));

            // Don't retry auth or validation errors
            if (lastError.message.includes('401') || lastError.message.includes('403')) {
              throw lastError;
            }

            // Don't retry on cancellation
            if (signal?.aborted) {
              throw new Error('Upload cancelled');
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

      // Report progress (for videos: 30-100% is upload; for images: 0-100%)
      const baseProgress = isVideoMime(mimeType) ? 0.3 : 0;
      const uploadRange = 1 - baseProgress;
      onProgress?.(baseProgress + ((i + 1) / totalChunks) * uploadRange);
    }

    // 8. Complete the upload
    await completeUpload(mediaId, groupId);

    // 9. Copy plaintext to canonical path so file survives app restarts
    //    (picker URIs in /tmp/ are evicted by iOS)
    const ext = fileName.split('.').pop() ?? 'dat';
    const mediaDirPath = `${DocumentDirectoryPath}/media`;
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

    // 10. Persist to local DB
    const mediaRow = buildMediaRow(
      mediaId, threadId ?? null, replyId ?? null, mimeType,
      fileName, fileSize, width, height, keys, digestBytes,
      savedLocalPath ? 'downloaded' : 'pending', 'done',
      {
        duration: duration != null ? Math.round(duration * 1000) : null,
        thumbnail_media_id: thumbnailResult?.mediaId ?? null,
        is_thumbnail: _isThumbnail ? 1 : 0,
      },
    );
    mediaRow.local_path = savedLocalPath;
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
  } finally {
    // Best-effort cleanup of ciphertext temp file and staging file
    await unlink(ctPath).catch(() => {});
    if (stagingPath && stagingPath !== sourcePath) {
      await unlink(stagingPath).catch(() => {});
    }
    // Clean up sanitized staging if it was created and is different from sourcePath
    if (!stagingPath && sourcePath === sanitizedStagingPath) {
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

/**
 * Upload a batch of picked media files sequentially.
 *
 * This is a convenience wrapper used by ComposeThreadScreen and
 * ThreadDetailScreen (ReplyComposer) to avoid duplicating the
 * upload-loop pattern.
 *
 * @param items - Array of PickedMedia from useMediaPicker.
 * @param groupId - The group to upload into.
 * @param opts - Optional parameters (onPhase callback).
 * @returns Array of mediaIds in the same order as the input items.
 */
export async function uploadMediaBatch(
  items: PickedMedia[],
  groupId: string,
  opts?: { onPhase?: (phase: 'compressing' | 'encrypting' | 'uploading') => void },
): Promise<string[]> {
  const ids: string[] = [];
  for (const media of items) {
    const result = await uploadMedia({
      fileUri: media.uri,
      mimeType: media.type,
      fileName: media.fileName,
      width: media.width,
      height: media.height,
      duration: media.duration,
      groupId,
      onPhase: opts?.onPhase,
    });
    ids.push(result.mediaId);
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
  try {
    const files = await readDir(CachesDirectoryPath);
    const now = Date.now();
    for (const file of files) {
      const isChunk = file.name.includes('-chunk-') && file.name.endsWith('.bin');
      const isCipher = file.name.endsWith('-cipher.bin');
      const isStaging = file.name.endsWith('-staging.bin');
      if (isChunk || isCipher || isStaging) {
        const mtime = file.mtime ? new Date(file.mtime).getTime() : 0;
        const age = now - mtime;
        if (age > 3600_000) {
          await unlink(file.path).catch(() => {});
        }
      }
    }
  } catch {
    // Best-effort -- failures are silently ignored
  }
}
