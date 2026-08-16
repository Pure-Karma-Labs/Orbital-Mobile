/**
 * Public wrapper for the OrbitalMediaTranscoder TurboModule.
 *
 * Consumers import from 'orbital-media-transcoder' only -- never from
 * ./NativeOrbitalMediaTranscoder directly.
 *
 * Contract notes:
 * - Every path argument is a PLAIN absolute path on the native side. This
 *   wrapper strips a leading `file://` so callers may pass either form; the
 *   native layer never sees a scheme. (Scheme handling regressed twice in
 *   videoProcessing.ts against the previous library.)
 * - Video destPaths MUST end in `.mp4`: AVAssetWriter derives the container
 *   type from the file extension and fails outright on anything else.
 * - Rejections are normalized to MediaTranscoderError with a `code` field
 *   read from the native rejection code -- never match on message text.
 * - cancelTranscode is a REQUEST, not an acknowledgement: the transcode promise
 *   is the only cancellation signal, and on iOS its ECANCELLED rejection is
 *   deferred until the native sample loops drain (bounded in practice by the
 *   "Cancelling..." affordance in useMediaUploadProgress), while Android settles
 *   immediately. Never assume a cancel has settled the promise yet (#726/#727).
 */

import type { EventSubscription } from 'react-native';
import type {
  Spec,
  VideoMetadata,
  VideoTranscodeOptions,
  TranscodeProgressEvent,
} from './NativeOrbitalMediaTranscoder';

export type { VideoMetadata, VideoTranscodeOptions, TranscodeProgressEvent };

/** Image output formats accepted by reencodeImage. */
export type ImageFormat = 'jpeg' | 'png';

export interface ImageReencodeOptions {
  /** Long-side cap in px; 0 = no scaling. Never upscales. */
  maxDimension: number;
  /** 0..1, JPEG only (ignored for png) */
  quality: number;
  format: ImageFormat;
}

/** Native error codes surfaced by the module. */
export type MediaTranscoderErrorCode =
  | 'ENOENT'
  | 'ETRANSCODE'
  | 'ECANCELLED'
  | 'EMETADATA'
  | 'ETHUMBNAIL'
  | 'EIMAGE'
  | 'EINVALID'
  | 'EUNKNOWN';

export class MediaTranscoderError extends Error {
  readonly code: MediaTranscoderErrorCode | string;

  constructor(code: MediaTranscoderErrorCode | string, message?: string) {
    super(message ?? code);
    this.name = 'MediaTranscoderError';
    this.code = code;
  }
}

/** True when the rejection was caused by cancelTranscode (or module teardown). */
export function isCancellation(e: unknown): boolean {
  return (
    typeof e === 'object' &&
    e !== null &&
    (e as { code?: unknown }).code === 'ECANCELLED'
  );
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

let native: Spec | null = null;

/**
 * Resolve the TurboModule on first use. Deliberately lazy: a failed autolink
 * must surface at the first media operation, not as a red screen at app boot
 * (imageSanitizer is reachable from avatar rendering during bootstrap).
 */
function getNative(): Spec {
  if (native === null) {
    native = require('./NativeOrbitalMediaTranscoder').default as Spec;
  }
  return native;
}

/** Strip a leading file:// scheme; native APIs take plain filesystem paths. */
function normalizePath(p: string): string {
  return p.startsWith('file://') ? p.slice('file://'.length) : p;
}

function toTranscoderError(e: unknown): MediaTranscoderError {
  if (e instanceof MediaTranscoderError) {
    return e;
  }
  const code =
    typeof e === 'object' &&
    e !== null &&
    typeof (e as { code?: unknown }).code === 'string'
      ? (e as { code: string }).code
      : 'EUNKNOWN';
  const message =
    e instanceof Error
      ? e.message
      : typeof e === 'string'
        ? e
        : 'Media transcoder failed';
  return new MediaTranscoderError(code, message);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Transcode a video to H.264/AAC non-fragmented MP4 at destPath, overwriting
 * any existing file. destPath MUST end in `.mp4`.
 *
 * @throws MediaTranscoderError (code ECANCELLED when cancelTranscode was called)
 */
export async function transcodeVideo(
  jobId: string,
  sourcePath: string,
  destPath: string,
  options: VideoTranscodeOptions,
): Promise<void> {
  const dest = normalizePath(destPath);
  if (!dest.endsWith('.mp4')) {
    throw new MediaTranscoderError(
      'EINVALID',
      'transcode destination must end in .mp4',
    );
  }
  try {
    await getNative().transcodeVideo(
      jobId,
      normalizePath(sourcePath),
      dest,
      options,
    );
  } catch (e) {
    throw toTranscoderError(e);
  }
}

/** Cancel an in-flight transcode. No-op for unknown or finished jobs. */
export function cancelTranscode(jobId: string): void {
  getNative().cancelTranscode(jobId);
}

/** Rotation-corrected display dimensions plus duration in seconds. */
export async function getVideoMetadata(
  sourcePath: string,
): Promise<VideoMetadata> {
  try {
    return await getNative().getVideoMetadata(normalizePath(sourcePath));
  } catch (e) {
    throw toTranscoderError(e);
  }
}

/**
 * Write a metadata-free JPEG of the frame nearest atMs to destPath.
 * maxDimension caps the long side; the frame is never upscaled.
 */
export async function extractThumbnail(
  sourcePath: string,
  atMs: number,
  destPath: string,
  maxDimension: number,
  quality: number,
): Promise<void> {
  try {
    await getNative().extractThumbnail(
      normalizePath(sourcePath),
      atMs,
      normalizePath(destPath),
      maxDimension,
      quality,
    );
  } catch (e) {
    throw toTranscoderError(e);
  }
}

/**
 * Re-encode an image (JPEG/PNG/WebP/HEIC in) to JPEG or PNG at destPath with
 * EXIF orientation baked in and no metadata written.
 *
 * SECURITY: this is defense-in-depth only. imageSanitizer's byte-level strip
 * plus verifyNoImageMetadata remain the authoritative fail-closed layer.
 */
export async function reencodeImage(
  sourcePath: string,
  destPath: string,
  options: ImageReencodeOptions,
): Promise<void> {
  if (options.format !== 'jpeg' && options.format !== 'png') {
    throw new MediaTranscoderError(
      'EINVALID',
      'reencodeImage format must be jpeg or png',
    );
  }
  try {
    await getNative().reencodeImage(
      normalizePath(sourcePath),
      normalizePath(destPath),
      options,
    );
  } catch (e) {
    throw toTranscoderError(e);
  }
}

/**
 * Subscribe to progress (0..1) for one job. The native stream is shared across
 * jobs, so events are filtered by jobId here. Always call remove().
 */
export function subscribeTranscodeProgress(
  jobId: string,
  onProgress: (progress: number) => void,
): EventSubscription {
  return getNative().onTranscodeProgress((event: TranscodeProgressEvent) => {
    if (event.jobId === jobId) {
      onProgress(event.progress);
    }
  });
}
