/**
 * Media upload service — orchestrates file encryption, chunked upload, and store persistence.
 *
 * Flow:
 * 1. Validate file size (max 25MB)
 * 2. Decode base64 from picker → Uint8Array plaintext
 * 3. Generate attachment keys and encrypt via attachmentCrypto
 * 4. Build metadata JSON (contentType, fileName, width, height, digest)
 * 5. Extract IV from ciphertext (first 16 bytes)
 * 6. Split ciphertext into 5MB chunks → Blob per chunk
 * 7. Upload chunks sequentially (first chunk includes metadata + IV)
 * 8. Complete upload
 * 9. Persist to local DB and store
 *
 * SECURITY: plaintextHash is never sent to the server (discarded for now; see TODO).
 * SECURITY: Crypto operations delegated to attachmentCrypto (Rust FFI).
 */

import type { PickedMedia } from '../hooks/useMediaPicker';
import { generateAttachmentKeys, encryptAttachment } from './crypto/attachmentCrypto';
import { encryptContent, getOrFetchGroupKey } from './crypto/contentCrypto';
import { arrayBufferToBase64, toArrayBuffer } from './crypto/utils';
import { uploadChunk, completeUpload } from './api/media';
import { saveMedia } from '../database/repositories/mediaRepository';
import { useAppStore } from '../stores/useAppStore';
import { generateUUID } from '../utils/uuid';
import { writeFile, unlink, CachesDirectoryPath } from '@dr.pogodin/react-native-fs';
import type { MediaItem } from '../types/store';
import type { MediaRow } from '../database/repositories/mediaRepository';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum file size in bytes (25MB) */
const MAX_UPLOAD_SIZE_BYTES = 25 * 1024 * 1024;

/** Chunk size in bytes (5MB) */
const CHUNK_SIZE_BYTES = 5 * 1024 * 1024;

/** Maximum retry attempts per chunk */
const MAX_RETRIES = 3;

/** Base delay for exponential backoff (ms) */
const BASE_RETRY_DELAY_MS = 1000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UploadMediaOptions {
  /** Base64-encoded file data from picker (with includeBase64: true) */
  fileBase64: string;
  /** MIME type (e.g. 'image/jpeg') */
  mimeType: string;
  /** File name */
  fileName: string;
  /** File size in bytes */
  fileSize: number;
  /** Image width in pixels */
  width?: number;
  /** Image height in pixels */
  height?: number;
  /** Group to upload into */
  groupId: string;
  /** Thread to associate with (if uploading for a thread) */
  threadId?: string;
  /** Reply to associate with (if uploading for a reply) */
  replyId?: string;
  /** Progress callback (0-1) */
  onProgress?: (progress: number) => void;
  /** AbortSignal for cancellation */
  signal?: AbortSignal;
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
 * Write a Uint8Array chunk to a temporary file for upload.
 * Hermes cannot create Blobs from ArrayBuffer, so we write to a temp
 * file and use the file-URI FormData pattern (same as avatar uploads).
 */
async function writeChunkToTempFile(
  bytes: Uint8Array,
  mediaId: string,
  chunkIndex: number,
): Promise<string> {
  const base64 = arrayBufferToBase64(toArrayBuffer(bytes));
  const filePath = `${CachesDirectoryPath}/${mediaId}-chunk-${chunkIndex}.bin`;
  try {
    await writeFile(filePath, base64, 'base64');
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

// ---------------------------------------------------------------------------
// Main upload function
// ---------------------------------------------------------------------------

/**
 * Upload a media file with encryption and chunked upload.
 *
 * @param options - Upload configuration including file data and metadata.
 * @returns The mediaId of the uploaded file.
 * @throws Error if file is too large, encryption fails, or upload fails after retries.
 */
export async function uploadMedia(options: UploadMediaOptions): Promise<string> {
  const {
    fileBase64,
    mimeType,
    fileName,
    fileSize,
    width,
    height,
    groupId,
    threadId,
    replyId,
    onProgress,
    signal,
  } = options;

  // 1. Validate file size
  if (fileSize > MAX_UPLOAD_SIZE_BYTES) {
    throw new Error(
      `File too large (${Math.round(fileSize / 1024 / 1024)}MB). Maximum is ${MAX_UPLOAD_SIZE_BYTES / 1024 / 1024}MB.`,
    );
  }

  // 2. Decode base64 → Uint8Array plaintext
  const plaintext = base64ToUint8Array(fileBase64);

  // 3. Generate attachment keys and encrypt
  const { keys, keysBase64 } = generateAttachmentKeys();
  const { ciphertext, digest, plaintextHash } = encryptAttachment(plaintext, keys);

  // 4. Generate media ID
  const mediaId = generateUUID();

  // 5. Build metadata and encrypt with group key (AES-256-GCM)
  // SECURITY: Metadata (fileName, contentType, dimensions) is encrypted so the
  // server never sees user filenames or content types (zero-knowledge).
  // SECURITY: plaintextHash is NEVER included — content fingerprint breaks zero-knowledge.
  const digestBase64 = arrayBufferToBase64(toArrayBuffer(digest));
  const metadataPlain = JSON.stringify({
    contentType: mimeType,
    fileName,
    ...(width != null ? { width } : {}),
    ...(height != null ? { height } : {}),
    digest: digestBase64,
  });
  const groupKey = await getOrFetchGroupKey(groupId);
  const encryptedMeta = encryptContent(metadataPlain, groupKey, groupId);
  const metadata = JSON.stringify({
    ciphertext: encryptedMeta.ciphertext,
    iv: encryptedMeta.iv,
  });

  // 6. Extract IV from ciphertext (first 16 bytes) and base64-encode
  const iv = ciphertext.slice(0, 16);
  const ivBase64 = arrayBufferToBase64(toArrayBuffer(iv));

  // 7. Split ciphertext into chunks
  const totalChunks = Math.ceil(ciphertext.length / CHUNK_SIZE_BYTES);

  // 8. Upload chunks sequentially
  for (let i = 0; i < totalChunks; i++) {
    // Check for cancellation
    if (signal?.aborted) {
      throw new Error('Upload cancelled');
    }

    const start = i * CHUNK_SIZE_BYTES;
    const end = Math.min(start + CHUNK_SIZE_BYTES, ciphertext.length);
    const chunkBytes = ciphertext.slice(start, end);
    const chunkFilePath = await writeChunkToTempFile(chunkBytes, mediaId, i);

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
        // Mark as failed in DB
        try {
          const failedRow = buildMediaRow(
            mediaId, threadId ?? null, replyId ?? null, mimeType,
            fileName, fileSize, width, height, keysBase64, digestBase64,
            'pending', 'failed',
          );
          saveMedia(failedRow);
        } catch {
          // Best-effort persistence — don't mask the upload error
        }
        throw new Error('Failed to upload media. Please try again.');
      }
    } finally {
      unlinkChunkFile(chunkFilePath);
    }

    // Report progress
    onProgress?.((i + 1) / totalChunks);
  }

  // 9. Complete the upload
  await completeUpload(mediaId, groupId);

  // 10. Persist to local DB
  const mediaRow = buildMediaRow(
    mediaId, threadId ?? null, replyId ?? null, mimeType,
    fileName, fileSize, width, height, keysBase64, digestBase64,
    'pending', 'done',
  );
  saveMedia(mediaRow);

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
    duration: null,
    blurHash: null,
    localPath: null,
    thumbnailPath: null,
    downloadState: 'pending',
    uploadState: 'done',
    expiresAt: null,
    hasKeys: true,
  };
  useAppStore.getState().upsertMedia(storeItem);

  // TODO: persist plaintextHash locally (needs plaintext_hash column in orbital_media)
  // for integrity verification on re-download. Currently discarded.
  void plaintextHash;

  return mediaId;
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
 * @returns Array of mediaIds in the same order as the input items.
 */
export async function uploadMediaBatch(
  items: PickedMedia[],
  groupId: string,
): Promise<string[]> {
  const ids: string[] = [];
  for (const media of items) {
    const id = await uploadMedia({
      fileBase64: media.base64,
      mimeType: media.type,
      fileName: media.fileName,
      fileSize: media.fileSize,
      width: media.width,
      height: media.height,
      groupId,
    });
    ids.push(id);
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
  attachmentKey: string,
  attachmentDigest: string,
  downloadState: string,
  uploadState: string,
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
    duration: null,
    attachment_key: attachmentKey,
    attachment_digest: attachmentDigest,
    cdn_number: null,
    cdn_key: null,
    local_path: null,
    thumbnail_path: null,
    download_state: downloadState,
    upload_state: uploadState,
    created_at: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Orphaned chunk cleanup
// ---------------------------------------------------------------------------

/**
 * Clean up orphaned chunk temp files from interrupted uploads.
 * Call during app bootstrap (best-effort, fire-and-forget).
 */
export async function cleanupOrphanedChunks(): Promise<void> {
  try {
    const { readDir } = await import('@dr.pogodin/react-native-fs');
    const files = await readDir(CachesDirectoryPath);
    const now = Date.now();
    for (const file of files) {
      if (file.name.includes('-chunk-') && file.name.endsWith('.bin')) {
        const mtime = file.mtime ? new Date(file.mtime).getTime() : 0;
        const age = now - mtime;
        if (age > 3600_000) {
          await unlink(file.path).catch(() => {});
        }
      }
    }
  } catch {
    // Best-effort — failures are silently ignored
  }
}
