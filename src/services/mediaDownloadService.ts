/**
 * Media download service — orchestrates download, decrypt, and cache operations.
 *
 * Flow:
 * 1. Cache check — if local_path is set in DB and file exists on disk, return immediately
 * 2. Key check — if attachment_key is null, throw (caller shows "no keys" placeholder)
 * 3. Inflight dedup — Map<string, Promise<string>> prevents duplicate concurrent downloads
 * 4. Acquire semaphore slot — wait if 3 downloads already in flight
 * 5. Update state → 'downloading' in both DB and store
 * 6. Download — downloadMedia() from api/media → { data: ArrayBuffer }
 * 7. Decrypt — decryptAttachment(ciphertext, keys, digest)
 * 8. Atomic write to disk — .tmp + moveFile → final path
 * 9. Persist — 'downloaded' + localPath in both DB and store
 * 10. Error → set 'failed' state, clean up temp file, release semaphore slot
 *
 * SECURITY: Ciphertext ArrayBuffer is released before base64 encoding (F5/T2).
 * SECURITY: Atomic write prevents partial plaintext files on crash (F1).
 * SECURITY: Inflight dedup map clears in finally block (F6).
 */

import { downloadMedia } from './api/media';
import { decryptAttachment } from './crypto/attachmentCrypto';
import { arrayBufferToBase64, toArrayBuffer } from './crypto/utils';
import {
  getMedia,
  updateDownloadState,
} from '../database/repositories/mediaRepository';
import { useAppStore } from '../stores/useAppStore';
import { createSemaphore } from '../utils/semaphore';
import {
  writeFile,
  exists,
  mkdir,
  moveFile,
  unlink,
  readDir,
  DocumentDirectoryPath,
} from '@dr.pogodin/react-native-fs';
import type { MediaRow } from '../database/repositories/mediaRepository';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum concurrent downloads */
const MAX_CONCURRENT = 3;

/** Sentinel error message for abort-path rejections */
export const DOWNLOAD_ABORTED_MESSAGE = 'Download aborted';

/** Media directory path */
const MEDIA_DIR = `${DocumentDirectoryPath}/media`;

// ---------------------------------------------------------------------------
// Semaphore — limits concurrent downloads to MAX_CONCURRENT
// ---------------------------------------------------------------------------

const mediaSemaphore = createSemaphore(MAX_CONCURRENT);

// ---------------------------------------------------------------------------
// Inflight dedup — prevents duplicate concurrent downloads for the same media
// ---------------------------------------------------------------------------

const inflight = new Map<string, Promise<string>>();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SAFE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SAFE_EXT_RE = /^[a-zA-Z0-9]{1,10}$/;

/** Validate mediaId is a UUID and extension is alphanumeric to prevent path injection. */
function validatePathComponents(mediaId: string, ext: string): void {
  if (!SAFE_ID_RE.test(mediaId)) {
    throw new Error(`Invalid mediaId format: ${mediaId.substring(0, 20)}`);
  }
  if (!SAFE_EXT_RE.test(ext)) {
    throw new Error(`Invalid extension format: ${ext.substring(0, 10)}`);
  }
}

/** Ensure the media directory exists. */
async function ensureMediaDir(): Promise<void> {
  const dirExists = await exists(MEDIA_DIR);
  if (!dirExists) {
    // TODO(F2): Per-file NSURLIsExcludedFromBackupKey is not available via RNFS
    // writeFile/moveFile — only mkdir exposes it. Using directory-level exclusion
    // as the best available option. Filed as a follow-up for a native bridge.
    await mkdir(MEDIA_DIR, { NSURLIsExcludedFromBackupKey: true });
  }
}

/** Derive file extension from content type or file name. */
function getExtension(row: MediaRow): string {
  if (row.file_name) {
    const parts = row.file_name.split('.');
    if (parts.length > 1) return parts.pop()!;
  }
  // Fallback: derive from content type
  const ct = row.content_type;
  if (ct.startsWith('image/jpeg')) return 'jpg';
  if (ct.startsWith('image/png')) return 'png';
  if (ct.startsWith('image/gif')) return 'gif';
  if (ct.startsWith('image/webp')) return 'webp';
  if (ct.startsWith('video/mp4')) return 'mp4';
  if (ct.startsWith('video/quicktime')) return 'mov';
  if (ct.startsWith('video/x-m4v')) return 'm4v';
  return 'dat';
}

// ---------------------------------------------------------------------------
// Stale-path recovery — check if files exist on disk for non-downloaded rows
// ---------------------------------------------------------------------------

/**
 * Check a batch of media rows for files that exist on disk but have stale DB
 * state (pending/failed). Updates DB and store for any recovered items.
 *
 * Returns the IDs of recovered items so the caller can trigger a re-render.
 */
export async function recoverStalePaths(
  rows: ReadonlyArray<{ id: string; download_state: string; local_path: string | null; content_type: string; file_name: string | null }>,
): Promise<string[]> {
  const recovered: string[] = [];
  for (const row of rows) {
    if (row.download_state === 'downloaded' || row.download_state === 'downloading') continue;

    const ext = getExtension(row as MediaRow);
    const expectedPath = `${MEDIA_DIR}/${row.id}.${ext}`;
    try {
      const fileExists = await exists(expectedPath);
      if (fileExists) {
        updateDownloadState(row.id, 'downloaded', expectedPath);
        useAppStore
          .getState()
          .updateMediaDownloadState(row.id, 'downloaded', expectedPath);
        recovered.push(row.id);
      }
    } catch {
      // Best-effort
    }
  }
  return recovered;
}

// ---------------------------------------------------------------------------
// Core download function
// ---------------------------------------------------------------------------

/**
 * Download, decrypt, and cache a media file.
 *
 * @param mediaId - The media ID to download.
 * @param signal  - Optional AbortSignal for cancellation.
 * @returns The local file path of the decrypted file.
 * @throws Error if keys are missing or download/decrypt fails.
 */
export async function downloadAndDecryptMedia(
  mediaId: string,
  signal?: AbortSignal,
): Promise<string> {
  // 1. Cache check — if already downloaded and file exists, return immediately
  let row: MediaRow | null = null;
  try {
    row = getMedia(mediaId);
  } catch {
    // DB may not be initialized
  }

  if (row?.local_path) {
    const fileExists = await exists(row.local_path);
    if (fileExists) return row.local_path;
    // File missing — reset state and re-download
  }

  // 2. Key check — receiver doesn't have keys in v1
  if (!row?.attachment_key) {
    throw new Error('No attachment keys available');
  }

  // 3. Inflight dedup — must clear in finally block (F6)
  const existing = inflight.get(mediaId);
  if (existing) return existing;

  const promise = (async (): Promise<string> => {
    await mediaSemaphore.acquire();

    // Paths declared outside try so catch can clean up the temp file.
    // getExtension/validatePathComponents moved inside try so any throw
    // releases the semaphore via finally (previously leaked a slot).
    let tmpPath: string | undefined;
    let finalPath: string | undefined;

    try {
      const ext = getExtension(row!);
      validatePathComponents(mediaId, ext);
      tmpPath = `${MEDIA_DIR}/${mediaId}.${ext}.tmp`;
      finalPath = `${MEDIA_DIR}/${mediaId}.${ext}`;

      // Abort check post-acquire: if signal was aborted while queued,
      // restore to 'pending' so the item is self-healing on remount.
      if (signal?.aborted) {
        throw new Error(DOWNLOAD_ABORTED_MESSAGE);
      }

      // 5. Update state → 'downloading'
      try {
        updateDownloadState(mediaId, 'downloading');
      } catch {
        // DB may not be initialized
      }
      useAppStore.getState().updateMediaDownloadState(mediaId, 'downloading');

      // Ensure media directory exists
      await ensureMediaDir();

      // 6. Download ciphertext from server
      const { data: ciphertextBuffer } = await downloadMedia(mediaId, signal);

      // 7. Decrypt — attachment_key and digest are stored as raw BLOB (Uint8Array)
      const keys = row!.attachment_key!;
      if (!row!.attachment_digest) {
        throw new Error('No attachment digest available — cannot verify ciphertext integrity');
      }
      const digest = row!.attachment_digest;

      // Scope ciphertext so it can be GC'd before base64 encoding
      let plaintext: Uint8Array;
      {
        const ciphertextBytes = new Uint8Array(ciphertextBuffer);
        plaintext = decryptAttachment(ciphertextBytes, keys, digest);
      }

      // 8. Atomic write — .tmp + moveFile (F1)
      const plaintextBase64 = arrayBufferToBase64(toArrayBuffer(plaintext));
      await writeFile(tmpPath, plaintextBase64, 'base64');
      await unlink(finalPath).catch(() => {});
      await moveFile(tmpPath, finalPath);

      // 9. Persist → 'downloaded' + localPath
      try {
        updateDownloadState(mediaId, 'downloaded', finalPath);
      } catch {
        // DB may not be initialized
      }
      useAppStore.getState().updateMediaDownloadState(mediaId, 'downloaded', finalPath);

      return finalPath;
    } catch (e) {
      // Aborted downloads restore to 'pending' (self-healing for windowing);
      // genuine failures land on 'failed' as before.
      const nextState = signal?.aborted ? 'pending' : 'failed';

      try {
        updateDownloadState(mediaId, nextState);
      } catch {
        // DB may not be initialized
      }
      useAppStore.getState().updateMediaDownloadState(mediaId, nextState);

      // Best-effort cleanup of temp file
      if (tmpPath) {
        await unlink(tmpPath).catch(() => {});
      }

      // Normalize ALL abort-path rejections to the sentinel message so
      // consumers (useMediaDownload) can reliably detect aborts regardless
      // of fetch-layer error text (engine-specific NetworkError, etc.).
      if (signal?.aborted && (!(e instanceof Error) || e.message !== DOWNLOAD_ABORTED_MESSAGE)) {
        throw new Error(DOWNLOAD_ABORTED_MESSAGE);
      }

      throw e;
    } finally {
      mediaSemaphore.release();
    }
  })();

  inflight.set(mediaId, promise);

  try {
    return await promise;
  } finally {
    // Must clear in finally block — even on rejection (F6)
    inflight.delete(mediaId);
  }
}

// ---------------------------------------------------------------------------
// Convenience exports
// ---------------------------------------------------------------------------

/**
 * Retry a failed download — resets state and re-triggers download.
 */
export async function retryDownload(
  mediaId: string,
  signal?: AbortSignal,
): Promise<string> {
  try {
    updateDownloadState(mediaId, 'pending');
  } catch {
    // DB may not be initialized
  }
  useAppStore.getState().updateMediaDownloadState(mediaId, 'pending');

  return downloadAndDecryptMedia(mediaId, signal);
}

/**
 * Check if a media file is cached on disk.
 */
export async function isMediaCached(mediaId: string): Promise<boolean> {
  let row: MediaRow | null = null;
  try {
    row = getMedia(mediaId);
  } catch {
    return false;
  }
  if (!row?.local_path) return false;
  return exists(row.local_path);
}

// ---------------------------------------------------------------------------
// Orphaned media cleanup
// ---------------------------------------------------------------------------

/**
 * Clean up orphaned media files and stale DB rows.
 *
 * Semantics (F7):
 * 1. Sweep ${DocumentDirectoryPath}/media/ for files with no matching DB row → delete
 * 2. Sweep DB rows where local_path is set but file does not exist → reset to 'pending', clear local_path
 * 3. Sweep .tmp files older than 1 hour → delete
 *
 * Called from bootstrap.ts (mirrors cleanupOrphanedChunks pattern).
 */
export async function cleanupOrphanedMedia(): Promise<void> {
  try {
    const dirExists = await exists(MEDIA_DIR);
    if (!dirExists) return;

    const files = await readDir(MEDIA_DIR);
    const now = Date.now();

    for (const file of files) {
      try {
        // Skip directories
        if (file.isDirectory?.()) continue;

        // 3. Sweep .tmp files older than 1 hour
        if (file.name.endsWith('.tmp')) {
          const mtime = file.mtime ? new Date(file.mtime).getTime() : 0;
          if (now - mtime > 3600_000) {
            await unlink(file.path).catch(() => {});
          }
          continue;
        }

        // 1. Sweep files with no matching DB row
        // Extract mediaId from filename (format: {mediaId}.{ext})
        const dotIndex = file.name.indexOf('.');
        if (dotIndex === -1) continue;
        const fileMediaId = file.name.substring(0, dotIndex);

        let row: MediaRow | null = null;
        try {
          row = getMedia(fileMediaId);
        } catch {
          // DB may not be initialized — don't delete files we can't verify
          continue;
        }

        if (!row) {
          await unlink(file.path).catch(() => {});
          continue;
        }

        // 1b. Row exists, file on disk, but DB state is stale (failed/pending) —
        // recover by updating DB to 'downloaded' with the actual file path.
        if (
          row.download_state !== 'downloaded' &&
          row.download_state !== 'downloading'
        ) {
          try {
            updateDownloadState(row.id, 'downloaded', file.path);
            useAppStore
              .getState()
              .updateMediaDownloadState(row.id, 'downloaded', file.path);
          } catch {
            // Best-effort recovery
          }
          continue;
        }

        // 2. Row exists but points to a different path — skip
        // (handled separately below via DB sweep)
      } catch {
        // Per-file resilience — continue with other files
      }
    }

    // 2. Sweep DB rows where local_path is set but file does not exist
    // Lazy import to avoid pulling in full query helpers at module level
    const { queryMany } = await import('../database/queryHelpers');
    const rows = queryMany<MediaRow>(
      "SELECT * FROM orbital_media WHERE local_path IS NOT NULL AND download_state = 'downloaded'",
    );

    for (const row of rows) {
      try {
        if (row.local_path) {
          const fileExists = await exists(row.local_path);
          if (!fileExists) {
            updateDownloadState(row.id, 'pending');
          }
        }
      } catch {
        // Per-row resilience
      }
    }
  } catch {
    // Best-effort — failures are silently ignored
  }
}
