/**
 * Media API endpoints — chunked upload and streaming binary download.
 *
 * Upload uses multipart FormData with snake_case field names (backend expectation).
 * Download streams the ciphertext straight to disk via RNFS `downloadFile` — the
 * response body never crosses the bridge (#578).
 */

import {
  downloadFile,
  stopDownload,
  unlink,
} from '@dr.pogodin/react-native-fs';
import type {
  DownloadBeginCallbackResultT,
  DownloadProgressCallbackResultT,
  DownloadResultT,
} from '@dr.pogodin/react-native-fs';

import {
  API_BASE_URL,
  delayForRateLimit,
  handleUnauthorized,
  mapHttpErrorToApiError,
  request,
  MAX_429_RETRIES,
  NO_ACCESS_TOKEN_MESSAGE,
} from './client';
import { AuthError, NetworkError } from './errors';
import { tokenManager } from './tokenManager';
import { ciphertextByteCeiling } from '../media/mediaLimits';
import type { MediaContentClass, UploadChunkResponse } from '../../types/api';

// ============================================================
// Upload
// ============================================================

export interface UploadChunkParams {
  mediaId: string;
  groupId: string;
  chunkIndex: number;
  totalChunks: number;
  /** Path to temp file containing encrypted chunk bytes */
  chunkFilePath: string;
  /** Plain JSON string of metadata (NOT base64) — first chunk only */
  encryptedMetadata?: string;
  /** Base64-encoded IV extracted from ciphertext — first chunk only */
  encryptionIv?: string;
  /** Coarse media class for server eviction policy — first chunk only; write-only (never echoed) */
  contentClass?: MediaContentClass;
}

/**
 * Upload a single encrypted chunk of a media file.
 *
 * POST /api/media/upload/chunk — multipart FormData with snake_case field names.
 * FormData fields are manually set to snake_case (not using camelToSnake transform,
 * which operates on JSON bodies, not FormData).
 */
export function uploadChunk(
  params: UploadChunkParams,
  signal?: AbortSignal,
): Promise<UploadChunkResponse> {
  const formData = new FormData();
  formData.append('media_id', params.mediaId);
  formData.append('group_id', params.groupId);
  formData.append('chunk_index', String(params.chunkIndex));
  formData.append('total_chunks', String(params.totalChunks));
  formData.append('chunk', {
    uri: `file://${params.chunkFilePath}`,
    type: 'application/octet-stream',
    name: `chunk-${params.chunkIndex}.bin`,
  } as unknown as Blob);
  if (params.encryptedMetadata) {
    formData.append('encrypted_metadata', params.encryptedMetadata);
  }
  if (params.encryptionIv) {
    formData.append('encryption_iv', params.encryptionIv);
  }
  if (params.contentClass) {
    formData.append('content_class', params.contentClass);
  }

  return request<UploadChunkResponse>({
    method: 'POST',
    path: '/api/media/upload/chunk',
    body: formData,
    timeout: 60_000,
    signal,
  });
}

// ============================================================
// Complete upload
// ============================================================

export interface CompleteUploadResponse {
  mediaId: string;
  sizeBytes: number;
  uploadedAt: string;
  expiresAt: string;
  chunksUploaded: number;
}

/**
 * Signal that all chunks for a media upload have been sent.
 *
 * POST /api/media/upload/complete — JSON body.
 */
export function completeUpload(
  mediaId: string,
  groupId: string,
): Promise<CompleteUploadResponse> {
  return request<CompleteUploadResponse>({
    method: 'POST',
    path: '/api/media/upload/complete',
    body: { mediaId, groupId },
  });
}

// ============================================================
// Archive confirm
// ============================================================

export interface ArchiveConfirmResponse {
  mediaId: string;
  confirmedAt: string;
  status: 'available' | 'expired' | 'evicted';
}

/**
 * Confirm that a downloaded media file has been durably archived on this device.
 *
 * POST /api/media/:id/archive-confirm — JSON response.
 */
export function archiveConfirm(mediaId: string): Promise<ArchiveConfirmResponse> {
  return request<ArchiveConfirmResponse>({
    method: 'POST',
    path: `/api/media/${encodeURIComponent(mediaId)}/archive-confirm`,
  });
}

// ============================================================
// Download — streaming to disk (#578)
// ============================================================

/**
 * Stall timeout: the maximum time the transfer may make NO progress.
 *
 * This is the PRIMARY guard. It is the only stall guard iOS honours
 * (`connectionTimeout` is Android-only), and unlike an end-to-end deadline it
 * cannot kill a slow-but-progressing transfer — the exact regime #578 exists
 * to unlock (a 200MB download at 1 Mbps is ~27 minutes of honest progress).
 */
export const MEDIA_DOWNLOAD_STALL_TIMEOUT_MS = 30_000;

/**
 * JS-side stall watchdog window — twice the native `readTimeout`.
 *
 * The native stall guard is not trustworthy on its own: iOS routes a
 * `readTimeout` expiry that carries resume data to a path that invokes NO
 * callback, so the native promise can simply never settle and the stall goes
 * undetected. This timer is armed per attempt and reset on every `begin` and
 * `progress` tick, so it only fires when the transfer has genuinely gone quiet
 * for longer than the native guard should have taken to notice.
 */
const JS_STALL_WATCHDOG_MS = 2 * MEDIA_DOWNLOAD_STALL_TIMEOUT_MS;

/**
 * Absolute backstop for one download attempt. The end-to-end deadline is
 * retained ONLY as a last-resort liveness guarantee for the case where neither
 * the native promise, the stall watchdog, nor any callback ever fires, so it is
 * deliberately generous and flat rather than throughput-derived — a slow but
 * honestly-progressing 200MB transfer must never trip it.
 */
export const MEDIA_DOWNLOAD_BACKSTOP_MS = 30 * 60_000;

/** Progress callback cadence (ms). */
const PROGRESS_INTERVAL_MS = 250;

/**
 * How long to let a native download settle before removing the destination.
 *
 * When an attempt ends because a JS arm of the race rejected, the native writer
 * may still hold the file open, so unlinking immediately can race it. But the
 * native promise is NOT guaranteed to settle at all, so this wait must be
 * BOUNDED — cleanup can never depend on native settlement.
 */
const NATIVE_SETTLE_GRACE_MS = 250;

export interface DownloadMediaToFileOptions {
  mediaId: string;
  /** Absolute destination path for the ciphertext blob (staging, not final). */
  toFile: string;
  /**
   * Size of the blob from the media row, when known. Drives the byte ceiling
   * ONLY — never a deadline of any kind. Both timers here are flat.
   *
   * NOTE: this is server truth (ciphertext length) for received media, but the
   * uploader's own row records the PLAINTEXT length, so the ceiling adds the
   * maximum wire-format overhead before clamping.
   */
  expectedBytes?: number | null;
  signal?: AbortSignal;
  /**
   * Transport-level byte progress. Deliberately NOT threaded into
   * mediaDownloadService — the progress-ring UI (#578 follow-up) wires it when
   * there is an actual consumer, rather than shipping an unwired surface.
   */
  onProgress?: (bytesWritten: number, contentLength: number) => void;
}

export interface DownloadMediaToFileResult {
  /** Bytes written to `toFile`. */
  bytesWritten: number;
}

/** Message used for abort-path rejections from this transport. */
const ABORTED_MESSAGE = 'Media download aborted';

/** Message used for every byte-ceiling rejection (begin, progress, result). */
const OVERSIZE_MESSAGE = 'Media download exceeds the maximum allowed size';

function toNetworkError(err: unknown): NetworkError {
  return new NetworkError(
    err instanceof Error ? err.message : 'Media download failed',
  );
}

/**
 * Run one `downloadFile` attempt under a settlement contract that does not
 * trust the native promise.
 *
 * The vendored fork's iOS `Downloader.mm` has a path where a non-cancel error
 * carrying resume data invokes NO callback at all, so `job.promise` is not
 * guaranteed to settle. Every rejection therefore comes from a JS-owned arm of
 * the race (deadline, abort, byte ceiling); `stopDownload` is a best-effort
 * side effect and cleanup never waits on native settlement.
 *
 * The `resumable` option is FORBIDDEN here: enabling it puts the iOS native
 * side on the `cancelByProducingResumeData` path, which is precisely the
 * no-callback case above. Ranged resume is a separate follow-up.
 */
async function runDownloadAttempt(
  url: string,
  toFile: string,
  token: string,
  ceiling: number,
  deadlineMs: number,
  signal: AbortSignal | undefined,
  onProgress: DownloadMediaToFileOptions['onProgress'],
  tracker: { native: Promise<unknown> | null },
): Promise<DownloadResultT> {
  // A fresh jobId is minted per attempt; the abort listener and deadline timer
  // are registered ONCE and read the ref at fire time.
  const jobRef: { jobId: number | null } = { jobId: null };
  let rejectRace!: (err: unknown) => void;
  let ceilingTripped = false;

  const stopActiveJob = (): void => {
    if (jobRef.jobId !== null) {
      try {
        stopDownload(jobRef.jobId);
      } catch {
        // Best-effort side effect only — never load-bearing.
      }
    }
  };

  const failRace = (err: unknown): void => {
    stopActiveJob();
    rejectRace(err);
  };

  const jsRejection = new Promise<never>((_resolve, reject) => {
    rejectRace = reject;
  });
  // The race arm is always consumed below, but guard against an unhandled
  // rejection if construction throws before the race is entered.
  jsRejection.catch(() => {});

  const deadlineTimer = setTimeout(() => {
    failRace(new NetworkError('Media download exceeded the maximum transfer time'));
  }, deadlineMs);

  // JS-owned stall detection. `readTimeout` is the native guard, but iOS can
  // swallow its expiry entirely (no callback, promise never settles), so JS
  // must own the stall too. Armed now and reset by every begin/progress tick.
  let stallTimer: ReturnType<typeof setTimeout> | null = null;
  const armStallWatchdog = (): void => {
    if (stallTimer !== null) clearTimeout(stallTimer);
    stallTimer = setTimeout(() => {
      failRace(new NetworkError('Media download stalled'));
    }, JS_STALL_WATCHDOG_MS);
  };
  armStallWatchdog();

  const onAbort = (): void => {
    failRace(new NetworkError(ABORTED_MESSAGE));
  };
  signal?.addEventListener('abort', onAbort, { once: true });

  try {
    if (signal?.aborted) {
      throw new NetworkError(ABORTED_MESSAGE);
    }

    const job = downloadFile({
      fromUrl: url,
      toFile,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/octet-stream',
        // Android transparently gunzips a compressed body. Any intermediary
        // transform of the ciphertext would surface as an endlessly-retried
        // opaque HMAC failure, so ask for the bytes as stored.
        'Accept-Encoding': 'identity',
      },
      // No NSURLCache copies of ciphertext outside the paths the reapers know about.
      cacheable: false,
      background: false,
      readTimeout: MEDIA_DOWNLOAD_STALL_TIMEOUT_MS,
      progressInterval: PROGRESS_INTERVAL_MS,
      begin: (res: DownloadBeginCallbackResultT) => {
        armStallWatchdog();
        // A 2xx that is not exactly 200 must be refused here rather than at the
        // result: iOS gates its progress callbacks on `statusCode === 200`, so a
        // chunked 206/202 body would stream to disk with the byte ceiling never
        // being evaluated even once.
        if (
          res.statusCode >= 200 &&
          res.statusCode < 300 &&
          res.statusCode !== 200
        ) {
          failRace(
            new NetworkError('Media download returned an unsupported success status'),
          );
          return;
        }
        if (res.contentLength > ceiling && !ceilingTripped) {
          ceilingTripped = true;
          failRace(new NetworkError(OVERSIZE_MESSAGE));
        }
      },
      progress: (res: DownloadProgressCallbackResultT) => {
        armStallWatchdog();
        onProgress?.(res.bytesWritten, res.contentLength);
        if (res.bytesWritten > ceiling && !ceilingTripped) {
          ceilingTripped = true;
          failRace(new NetworkError(OVERSIZE_MESSAGE));
        }
      },
    });

    jobRef.jobId = job.jobId;
    tracker.native = job.promise;
    // Never let the native promise become an unhandled rejection: the race may
    // settle from a JS arm and drop it entirely.
    job.promise.catch(() => {});

    return await Promise.race([
      job.promise.catch((err: unknown) => {
        throw toNetworkError(err);
      }),
      jsRejection,
    ]);
  } finally {
    clearTimeout(deadlineTimer);
    if (stallTimer !== null) clearTimeout(stallTimer);
    signal?.removeEventListener('abort', onAbort);
  }
}

/**
 * Download an encrypted media blob straight to `toFile`.
 *
 * GET /api/media/:id/download. The ciphertext never enters the JS or Java heap —
 * the native downloader writes it to disk and only a small result record crosses
 * the bridge.
 *
 * Only `statusCode === 200` is success. RNFS does not write error bodies to
 * `toFile` (they arrive in `result.body`), which is forwarded to the shared
 * error mapper so MEDIA_EVICTED/EXPIRED discrimination still works.
 *
 * SECURITY: the media route MUST remain redirect-free. iOS re-attaches the
 * Authorization header across cross-origin redirects at session scope, and
 * Android drops both the headers and the read timeout on its manual follow.
 * Certificate pinning (#174) will need a second implementation for this
 * transport.
 */
export async function downloadMediaToFile(
  options: DownloadMediaToFileOptions,
): Promise<DownloadMediaToFileResult> {
  const { mediaId, toFile, expectedBytes, signal, onProgress } = options;

  const token = await tokenManager.getAccessToken();
  if (token === null) {
    throw new AuthError(401, NO_ACCESS_TOKEN_MESSAGE);
  }

  const url = `${API_BASE_URL}/api/media/${encodeURIComponent(mediaId)}/download`;
  const ceiling = ciphertextByteCeiling(expectedBytes);
  const deadlineMs = MEDIA_DOWNLOAD_BACKSTOP_MS;
  const tracker: { native: Promise<unknown> | null } = { native: null };

  /**
   * Wait for the previous attempt's native writer to settle, then remove the
   * destination. Unconditional-before-every-attempt: a stale file from a
   * non-2xx response or a crashed prior attempt would otherwise be treated as
   * a valid ciphertext blob.
   */
  const clearDestination = async (): Promise<void> => {
    if (tracker.native) {
      const native = tracker.native;
      tracker.native = null;
      // Bounded on purpose: a settled attempt (e.g. a 429 we are retrying)
      // resolves this immediately, while an attempt killed by the deadline or
      // abort arm must not be able to wedge cleanup forever.
      await Promise.race([
        native.catch(() => {}),
        new Promise<void>((resolve) => setTimeout(resolve, NATIVE_SETTLE_GRACE_MS)),
      ]);
    }
    await unlink(toFile).catch(() => {});
  };

  try {
    for (let attempt = 0; attempt <= MAX_429_RETRIES; attempt++) {
      await clearDestination();

      const result = await runDownloadAttempt(
        url,
        toFile,
        token,
        ceiling,
        deadlineMs,
        signal,
        onProgress,
        tracker,
      );

      const status = result.statusCode;

      if (status === 429 && attempt < MAX_429_RETRIES) {
        if (__DEV__) {
          console.warn(`[API] 429 on media download — retry ${attempt + 1}/${MAX_429_RETRIES}`);
        }
        await delayForRateLimit(attempt, signal);
        continue;
      }

      if (status !== 200) {
        await handleUnauthorized(status);
        throw mapHttpErrorToApiError(status, result.body);
      }

      if (!(result.bytesWritten > 0)) {
        throw new NetworkError('Media download produced an empty file');
      }
      if (result.bytesWritten > ceiling) {
        throw new NetworkError(OVERSIZE_MESSAGE);
      }

      return { bytesWritten: result.bytesWritten };
    }

    throw mapHttpErrorToApiError(429);
  } catch (err) {
    // Belt-and-braces: never leave a partial or error-path artifact behind.
    await clearDestination();
    throw err;
  }
}
