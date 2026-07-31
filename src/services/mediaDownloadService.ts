/**
 * Media download service — orchestrates streaming download, two-pass streaming
 * decrypt, and cache operations.
 *
 * Flow:
 * 1. Cache check — if local_path is set in DB and file exists on disk, return immediately
 * 2. Key check — if attachment_key or attachment_digest is null, throw
 * 3. Inflight dedup — Map<string, Promise<string>> prevents duplicate concurrent downloads
 * 4. Acquire semaphore slot — wait if 3 downloads already in flight
 * 5. Update state → 'downloading' in both DB and store
 * 6. Clean start — unlink the plaintext .tmp AND the ciphertext staging file
 * 7. Disk preflight — reserve 2x the ciphertext ceiling (both files coexist in pass 2)
 * 8. Download — downloadMediaToFile() streams ciphertext to Caches staging
 * 9. PASS 1 — verifyPush/verifyFinalize over the staged blob: HMAC + SHA-256
 *    digest are checked BEFORE any plaintext exists
 * 10. PASS 2 — decryptPush/decryptFinalize, appending base64 plaintext to .tmp
 * 11. Size assert, unlink staging, atomic moveFile .tmp → final path
 * 12. Persist — 'downloaded' + localPath in both DB and store
 * 13. Error → set state, unlink .tmp AND staging, release reservation + slot
 *
 * SECURITY (F1): atomic write prevents partial plaintext files on crash.
 * SECURITY (F6): inflight dedup map clears in a finally block.
 * SECURITY: nothing is decrypted before pass 1 verifies HMAC + digest in Rust.
 * SECURITY (TOCTOU): pass 2 re-derives the HMAC and decryptFinalize() requires
 *   it to match pass 1's. A blob modified BETWEEN the passes can still emit
 *   attacker-influenced plaintext into .tmp before finalize rejects — safety is
 *   procedural: `.tmp` is never promoted before decryptFinalize() returns Ok, is
 *   unlinked on every failure path, and is NEVER a resumable artifact.
 * SECURITY: the ciphertext staging file is always unlinked, on both paths.
 * SECURITY: destroy() is called on the decryptor on both success and failure.
 * SECURITY: content is never logged — only lengths and states.
 *
 * RETIRED (#578): F5/T2 ("ciphertext ArrayBuffer released before base64
 * encoding") no longer apply — neither the ciphertext nor the plaintext is ever
 * held in a JS buffer. Base64 passes straight from RNFS to Rust and from Rust to
 * appendFile, so the whole-buffer path those invariants guarded is gone.
 */

import { downloadMediaToFile } from './api/media';
import { createAttachmentDecryptor } from './crypto/attachmentCrypto';
import type { StreamingAttachmentDecryptor } from './crypto/attachmentCrypto';
import { base64DecodedLength } from './crypto/utils';
import {
  getMedia,
  updateDownloadState,
} from '../database/repositories/mediaRepository';
import { useAppStore } from '../stores/useAppStore';
import { createSemaphore } from '../utils/semaphore';
import {
  read,
  writeFile,
  appendFile,
  exists,
  getFSInfo,
  mkdir,
  moveFile,
  stat,
  unlink,
  readDir,
  CachesDirectoryPath,
} from '@dr.pogodin/react-native-fs';
import { NotFoundError } from './api/errors';
import { ciphertextByteCeiling } from './api/media';
import {
  MAX_CIPHERTEXT_BYTES,
  STREAM_READ_SIZE_BYTES,
} from './media/mediaLimits';
import { MEDIA_DIR, toStoredMediaPath, resolveMediaPath } from './media/mediaPaths';
import type { MediaRow } from '../database/repositories/mediaRepository';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum concurrent downloads */
const MAX_CONCURRENT = 3;

/** Sentinel error message for abort-path rejections */
export const DOWNLOAD_ABORTED_MESSAGE = 'Download aborted';

/**
 * Free-space margin required beyond the download itself. Filling the last byte
 * of a device is worse than failing the download.
 */
const DISK_HEADROOM_BYTES = 64 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Semaphore — limits concurrent downloads to MAX_CONCURRENT
// ---------------------------------------------------------------------------

const mediaSemaphore = createSemaphore(MAX_CONCURRENT);

// ---------------------------------------------------------------------------
// Inflight dedup — prevents duplicate concurrent downloads for the same media
// ---------------------------------------------------------------------------

const inflight = new Map<string, Promise<string>>();

// ---------------------------------------------------------------------------
// Disk reservation
// ---------------------------------------------------------------------------

/**
 * Bytes promised to in-flight downloads but not yet written.
 *
 * Without this, N concurrent preflights all see the same free space and all
 * pass, then collectively overrun it. Incremented at preflight, released in the
 * same finally block as the semaphore slot.
 */
let reservedDiskBytes = 0;

class InsufficientSpaceError extends Error {
  constructor() {
    super('Not enough free space to download this file.');
    this.name = 'InsufficientSpaceError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Reserve disk space for one download. Returns the reserved amount so the
 * caller can release exactly what it took.
 *
 * The ciphertext staging file and the plaintext .tmp coexist during pass 2,
 * hence 2x. A getFSInfo() failure is not fatal — we still reserve, so the
 * bookkeeping across concurrent downloads stays conservative.
 */
async function reserveDiskSpace(ciphertextBytes: number): Promise<number> {
  const needed = 2 * ciphertextBytes;

  try {
    const { freeSpace } = await getFSInfo();
    if (freeSpace - reservedDiskBytes <= needed + DISK_HEADROOM_BYTES) {
      throw new InsufficientSpaceError();
    }
  } catch (e) {
    if (e instanceof InsufficientSpaceError) throw e;
    // Space is unknowable on this platform/state — proceed, but still reserve.
  }

  reservedDiskBytes += needed;
  return needed;
}

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

/** Path of the ciphertext staging file for a media id. */
function stagingPathFor(mediaId: string): string {
  return `${CachesDirectoryPath}/${mediaId}-dl-cipher.bin`;
}

/**
 * Sanity-check the staged ciphertext length before feeding it to Rust.
 *
 * Asymmetric on purpose. `file_size` is server truth (ciphertext length) for
 * received media, but the uploader's OWN row records the plaintext length — so
 * a legitimately re-downloaded self-upload is 49-64 bytes LONGER than
 * `expectedBytes`. A shorter blob, by contrast, can only be truncation, which
 * is exactly what this check exists to catch cheaply (HMAC + digest would
 * reject it a full pass later). An over-long blob is bounded by the transport
 * ceiling and pinned exactly by pass 1.
 */
function assertStagedCiphertextSize(
  stagedSize: number,
  expectedBytes: number | null,
): void {
  if (stagedSize <= 0) {
    throw new Error('Downloaded ciphertext is empty');
  }
  if (stagedSize > MAX_CIPHERTEXT_BYTES) {
    throw new Error('Downloaded ciphertext exceeds the maximum allowed size');
  }
  if (expectedBytes != null && expectedBytes > 0 && stagedSize < expectedBytes) {
    throw new Error('Downloaded ciphertext is shorter than the expected length');
  }
}

/**
 * Read the next base64 chunk and return it with its decoded byte length.
 *
 * RNFS `read()` returns *up to* n bytes on Android and line-broken base64 on
 * iOS, and JS never decodes the chunk — so the decoded length is derived from
 * the string and the read position advances by THAT, not by n.
 */
async function readChunk(
  path: string,
  requested: number,
  pos: number,
): Promise<{ base64: string; decodedLength: number }> {
  const base64 = await read(path, requested, pos, 'base64');
  const decodedLength = base64DecodedLength(base64);
  if (decodedLength === 0) {
    throw new Error('Ciphertext read returned no bytes before the expected end');
  }
  if (decodedLength > requested) {
    throw new Error('Ciphertext read overran the requested range');
  }
  return { base64, decodedLength };
}

/**
 * PASS 1 — stream the staged ciphertext through the decryptor's verifier.
 *
 * No plaintext exists yet and none can: `decryptPush` is rejected by the Rust
 * phase machine until `verifyFinalize()` has succeeded.
 */
async function verifyCiphertextFromDisk(
  decryptor: StreamingAttachmentDecryptor,
  ciphertextPath: string,
  ciphertextLength: number,
  signal?: AbortSignal,
): Promise<void> {
  let pos = 0;
  while (pos < ciphertextLength) {
    if (signal?.aborted) {
      throw new Error(DOWNLOAD_ABORTED_MESSAGE);
    }
    const requested = Math.min(STREAM_READ_SIZE_BYTES, ciphertextLength - pos);
    const { base64, decodedLength } = await readChunk(ciphertextPath, requested, pos);
    decryptor.verifyPush(base64);
    pos += decodedLength;
  }
  decryptor.verifyFinalize();
}

/**
 * PASS 2 — stream the same blob through the decryptor, appending base64
 * plaintext to `tmpPath`. Returns the number of plaintext bytes emitted.
 *
 * Each append is an independently padded encoding of its own byte range, which
 * is exactly what RNFS produces and what `appendFile(..., 'base64')` decodes —
 * base64 text is never sliced or concatenated.
 */
async function streamDecryptToFile(
  decryptor: StreamingAttachmentDecryptor,
  ciphertextPath: string,
  ciphertextLength: number,
  tmpPath: string,
  signal?: AbortSignal,
): Promise<number> {
  // Truncate (and create) the destination. The attempt already unlinked it;
  // this also guarantees the file exists when a payload emits zero bytes.
  await writeFile(tmpPath, '', 'base64');

  let pos = 0;
  let emittedBytes = 0;

  while (pos < ciphertextLength) {
    if (signal?.aborted) {
      throw new Error(DOWNLOAD_ABORTED_MESSAGE);
    }
    const requested = Math.min(STREAM_READ_SIZE_BYTES, ciphertextLength - pos);
    const { base64, decodedLength } = await readChunk(ciphertextPath, requested, pos);

    const plaintextB64 = decryptor.decryptPush(base64);
    if (plaintextB64.length > 0) {
      await appendFile(tmpPath, plaintextB64, 'base64');
      emittedBytes += base64DecodedLength(plaintextB64);
    }
    pos += decodedLength;
  }

  const tailB64 = decryptor.decryptFinalize();
  if (tailB64.length > 0) {
    await appendFile(tmpPath, tailB64, 'base64');
    emittedBytes += base64DecodedLength(tailB64);
  }

  return emittedBytes;
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
        // DB stores relative; store keeps absolute
        updateDownloadState(row.id, 'downloaded', toStoredMediaPath(expectedPath) ?? undefined);
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
    const resolvedPath = resolveMediaPath(row.local_path);
    if (resolvedPath) {
      const fileExists = await exists(resolvedPath);
      if (fileExists) return resolvedPath;
    }
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

    // Paths declared outside try so catch can clean up the temp files.
    // getExtension/validatePathComponents stay inside try so any throw
    // releases the semaphore via finally.
    let tmpPath: string | undefined;
    let finalPath: string | undefined;
    let stagingPath: string | undefined;
    let reservedBytes = 0;

    try {
      const ext = getExtension(row!);
      validatePathComponents(mediaId, ext);
      tmpPath = `${MEDIA_DIR}/${mediaId}.${ext}.tmp`;
      finalPath = `${MEDIA_DIR}/${mediaId}.${ext}`;
      stagingPath = stagingPathFor(mediaId);

      // Abort check post-acquire: if signal was aborted while queued,
      // restore to 'pending' so the item is self-healing on remount.
      if (signal?.aborted) {
        throw new Error(DOWNLOAD_ABORTED_MESSAGE);
      }

      // attachment_key and attachment_digest are raw BLOBs (Uint8Array).
      // The digest is bound into the decryptor at construction, so a missing
      // one has to fail here rather than silently skipping verification.
      const keys = row!.attachment_key!;
      if (!row!.attachment_digest) {
        throw new Error('No attachment digest available — cannot verify ciphertext integrity');
      }
      const digest = row!.attachment_digest;

      // 5. Update state → 'downloading'
      try {
        updateDownloadState(mediaId, 'downloading');
      } catch {
        // DB may not be initialized
      }
      useAppStore.getState().updateMediaDownloadState(mediaId, 'downloading');

      // Ensure media directory exists
      await ensureMediaDir();

      // 6. Clean start. Both destinations are deterministic paths, so a crashed
      // prior attempt would otherwise leave a stale prefix that HMAC and digest
      // cannot catch (they only ever see what we feed them) — the file would be
      // promoted and confirmArchived would then evict the server copy.
      await unlink(tmpPath).catch(() => {});
      await unlink(stagingPath).catch(() => {});

      // 7. Disk preflight with reservation
      const expectedBytes = row!.file_size;
      reservedBytes = await reserveDiskSpace(ciphertextByteCeiling(expectedBytes));

      // 8. Stream ciphertext to disk — the body never crosses the bridge.
      await downloadMediaToFile({
        mediaId,
        toFile: stagingPath,
        expectedBytes,
        signal,
      });

      const stagedSize = (await stat(stagingPath)).size;
      assertStagedCiphertextSize(stagedSize, expectedBytes);

      // 9/10. Two-pass streaming decrypt. ANY error poisons the decryptor
      // permanently, so there is no resume path — destroy() on both outcomes.
      const decryptor = createAttachmentDecryptor(keys, digest);
      let emittedBytes: number;
      try {
        await verifyCiphertextFromDisk(decryptor, stagingPath, stagedSize, signal);
        emittedBytes = await streamDecryptToFile(
          decryptor,
          stagingPath,
          stagedSize,
          tmpPath,
          signal,
        );
      } finally {
        decryptor.destroy();
      }

      // 11. Size assert before promotion — mirrors the upload ctStat guard.
      // Catches a failed clean-start unlink or a partially-written append.
      const tmpSize = (await stat(tmpPath)).size;
      if (tmpSize !== emittedBytes) {
        throw new Error(
          `Plaintext size mismatch: expected ${emittedBytes}, got ${tmpSize}`,
        );
      }

      await unlink(stagingPath).catch(() => {});
      await unlink(finalPath).catch(() => {});
      await moveFile(tmpPath, finalPath);

      // 12. Persist → 'downloaded' + localPath (DB relative, store absolute)
      try {
        updateDownloadState(mediaId, 'downloaded', toStoredMediaPath(finalPath) ?? undefined);
      } catch (dbErr) {
        // DB write retry-once + warn (D11)
        try {
          updateDownloadState(mediaId, 'downloaded', toStoredMediaPath(finalPath) ?? undefined);
        } catch {
          if (__DEV__) {
            console.warn('[downloadAndDecryptMedia] DB write failed after retry:', dbErr instanceof Error ? dbErr.message : dbErr);
          }
        }
      }
      useAppStore.getState().updateMediaDownloadState(mediaId, 'downloaded', finalPath);

      // Fire-and-forget archive-confirm — never blocks or rolls back the download
      import('./mediaArchiveConfirmService')
        .then(({ confirmArchived }) => { confirmArchived(mediaId).catch(() => {}); })
        .catch(() => {});

      return finalPath;
    } catch (e) {
      // Aborted downloads restore to 'pending' (self-healing for windowing);
      // NotFoundError (404) → 'unavailable' (server purged, no retry);
      // genuine failures land on 'failed' as before.
      const nextState: 'pending' | 'failed' | 'unavailable' = signal?.aborted
        ? 'pending'
        : e instanceof NotFoundError
          ? 'unavailable'
          : 'failed';

      try {
        updateDownloadState(mediaId, nextState);
      } catch {
        // DB may not be initialized
      }
      useAppStore.getState().updateMediaDownloadState(mediaId, nextState);

      // Containment: the partially-decrypted plaintext must never survive a
      // failure, and the ciphertext staging file must never accumulate.
      if (tmpPath) {
        await unlink(tmpPath).catch(() => {});
      }
      if (stagingPath) {
        await unlink(stagingPath).catch(() => {});
      }

      // Normalize ALL abort-path rejections to the sentinel message so
      // consumers (useMediaDownload) can reliably detect aborts regardless
      // of transport-layer error text.
      if (signal?.aborted && (!(e instanceof Error) || e.message !== DOWNLOAD_ABORTED_MESSAGE)) {
        throw new Error(DOWNLOAD_ABORTED_MESSAGE);
      }

      throw e;
    } finally {
      reservedDiskBytes -= reservedBytes;
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
  const resolved = resolveMediaPath(row.local_path);
  if (!resolved) return false;
  return exists(resolved);
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
 * The ciphertext staging file lives in Caches, not here — it is swept by
 * cleanupOrphanedChunks() in mediaUploadService.
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
        // Also auto-promotes unavailable+file-on-disk → downloaded (D10).
        if (
          row.download_state !== 'downloaded' &&
          row.download_state !== 'downloading'
        ) {
          try {
            updateDownloadState(row.id, 'downloaded', toStoredMediaPath(file.path) ?? undefined);
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
          const resolved = resolveMediaPath(row.local_path);
          if (!resolved) {
            updateDownloadState(row.id, 'pending');
            continue;
          }
          const fileExists = await exists(resolved);
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
