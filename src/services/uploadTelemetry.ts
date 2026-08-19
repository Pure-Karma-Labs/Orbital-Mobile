/**
 * Sentry telemetry for the compose → upload → post pipeline (#738).
 *
 * Before this module the composer catches logged under `__DEV__` only, so a
 * release-build post failure (the S24 sanitizer bug, #732) produced no signal
 * at all. Every failure reported here carries a `stage` tag plus the
 * breadcrumb trail the pipeline leaves as it advances, so an event says WHERE
 * the post died without needing symbolicated frames.
 *
 * E2EE constraints — this is the only place upload failures reach a server we
 * do not control, so the payload is deliberately minimal:
 *   - Nothing derived from plaintext, ciphertext, keys, IVs or digests.
 *   - No file names, URIs or filesystem paths: `scrubErrorMessage()` strips
 *     them from the message, because RNFS/native errors routinely embed the
 *     picker URI (which on Android carries the user's file name).
 *   - The captured Error is a rebuilt copy, never the original object. That is
 *     what keeps custom fields off the event — `ApiError.serverMessage` and
 *     `QuotaExceededError.usage` would otherwise be one integration away from
 *     being serialized.
 *   - Breadcrumb data is limited to MIME type, plaintext byte count and chunk
 *     count: coarse shape metadata the server already observes, and the exact
 *     axes a pipeline bug varies along.
 *
 * CANCELLATION IS THE CALLER'S JOB. A user-cancelled upload must never be
 * captured, and this module does not re-check: `isUploadCancellation()` lives
 * in mediaUploadService, which imports this file, so importing it back would
 * close a cycle. Every call site filters cancellations before calling in.
 */

import * as Sentry from '@sentry/react-native';
import { ApiError, QuotaExceededError } from './api/errors';

/** Where in the compose → upload → post pipeline the failure happened. */
export type PostPipelineStage =
  /** Video transcode + MP4 GPS strip. */
  | 'transcode'
  /** Still-image EXIF strip / re-encode. */
  | 'sanitize'
  /** Best-effort video poster frame (degrades to duration-only). */
  | 'thumbnail'
  /** Streaming AES encrypt to the ciphertext temp file. */
  | 'encrypt'
  /** Chunk POST loop + completeUpload. */
  | 'chunk-upload'
  /** Post-upload local commit: canonical copy, DB row, store upsert. */
  | 'local-commit'
  /** Composer-level: anywhere inside uploadMediaBatch. */
  | 'media-upload'
  /** Composer-level: the createThread call after media (if any) succeeded. */
  | 'thread-create'
  /** Composer-level: the postReply call after media (if any) succeeded. */
  | 'reply-create';

/** Which composer surface the user was in. Absent for service-internal reports. */
export type PostSurface = 'compose-thread' | 'thread-reply';

/** Non-content shape metadata attached to a breadcrumb. */
export interface UploadBreadcrumbData {
  /** MIME type only — never the file name. */
  mime?: string;
  /** Plaintext size in bytes. */
  bytes?: number;
  /** Number of ciphertext chunks the upload was split into. */
  chunks?: number;
  /** True for the poster-frame child of a video upload. */
  thumbnail?: boolean;
}

/** Longest message we send. Native errors can be kilobytes of stringified state. */
const MAX_MESSAGE_LENGTH = 200;

/** `file://…`, `content://…`, `https://…` — anything scheme-prefixed. */
const URI_PATTERN = /\b[a-z][a-z0-9+.-]*:\/\/\S*/gi;
/** Absolute POSIX paths of two or more segments (`/var/mobile/Containers/…`). */
const PATH_PATTERN = /(?:\/[^\s/]+){2,}\/?/g;
/** Bare file names — an RNFS error can name the file without any directory. */
const FILENAME_PATTERN =
  /\b[\w.\-()]+\.(?:jpe?g|png|heic|heif|gif|webp|mp4|mov|m4v|3gp|bin|dat|tmp)\b/gi;

/**
 * Remove anything that could carry user content from an error message.
 *
 * Deliberately over-eager: losing a path from a diagnostic is cheap, leaking a
 * file name to Sentry is not. Exported for the unit tests that pin this.
 */
export function scrubErrorMessage(message: string): string {
  const scrubbed = message
    .replace(URI_PATTERN, '<uri>')
    .replace(PATH_PATTERN, '<path>')
    .replace(FILENAME_PATTERN, '<file>')
    .trim();
  return scrubbed.length > MAX_MESSAGE_LENGTH
    ? `${scrubbed.slice(0, MAX_MESSAGE_LENGTH)}…`
    : scrubbed;
}

/**
 * Rebuild the error as a plain Error carrying only class name, scrubbed
 * message and the original frames. The copy is the privacy boundary: whatever
 * the thrower hung off its error object stays local.
 */
function toReportableError(e: unknown): Error {
  const source = e instanceof Error ? e : new Error(String(e));
  const name = source.name || 'Error';
  const message = scrubErrorMessage(source.message ?? '');
  const reported = new Error(message);
  reported.name = name;
  // Drop the stack's header line — it repeats the UNSCRUBBED message — and
  // keep the frames, which are bundle positions and carry no user data.
  const frames = source.stack?.split('\n').slice(1).join('\n');
  reported.stack = frames ? `${name}: ${message}\n${frames}` : undefined;
  return reported;
}

/**
 * Mark the pipeline reaching `stage`. Breadcrumbs are buffered locally and
 * only leave the device attached to an event, so this is free on the happy
 * path.
 */
export function addUploadBreadcrumb(
  stage: PostPipelineStage,
  data?: UploadBreadcrumbData,
): void {
  Sentry.addBreadcrumb({
    category: 'media.upload',
    level: 'info',
    message: stage,
    data,
  });
}

/**
 * Report a post/upload failure. Callers MUST have ruled out cancellation.
 *
 * @param level 'warning' for a degradation the user still gets a post out of
 *              (a dropped thumbnail), 'error' for a failed post. Defaults to
 *              'error', except for a quota rejection: a full orbit is an
 *              expected, user-actionable state, not a bug in the pipeline.
 */
export function captureUploadFailure(
  e: unknown,
  ctx: {
    stage: PostPipelineStage;
    surface?: PostSurface;
    level?: 'error' | 'warning';
  },
): void {
  const tags: Record<string, string> = {
    feature: 'media-upload',
    stage: ctx.stage,
  };
  if (ctx.surface) tags.surface = ctx.surface;
  // Status + machine code are the two non-content facts that separate "server
  // said no" from "the device broke"; ApiError.message is already generic.
  if (e instanceof ApiError) {
    tags.status = String(e.statusCode);
    tags.api_code = e.code;
  }
  Sentry.captureException(toReportableError(e), {
    level: ctx.level ?? (e instanceof QuotaExceededError ? 'warning' : 'error'),
    tags,
  });
}
