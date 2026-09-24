/**
 * Sentry telemetry for the compose → upload → post pipeline (#738).
 *
 * Before this module the composer catches logged under `__DEV__` only, so a
 * release-build post failure (the S24 sanitizer bug, #732) produced no signal
 * at all. Every failure reported here carries a `stage` tag plus the
 * breadcrumb trail the pipeline leaves as it advances, so an event says WHERE
 * the post died without needing symbolicated frames.
 *
 * The E2EE constraints this channel obeys — the identifier/path/file-name
 * scrub and the rebuilt-Error rule — now live in `telemetryScrub.ts`, which
 * applies them to EVERY capture site (#746), not just this pipeline. Read that
 * header before adding a field here.
 *
 * Since #747 the thread-create / reply-create messages are whatever the service
 * layer threw — those two catches used to rewrap into a fixed string and now
 * rethrow the original — so the scrub, not the rewrap, is the guarantee that
 * this channel carries no user content.
 *
 * CANCELLATION IS THE CALLER'S JOB. A user-cancelled upload must never be
 * captured, and this module does not re-check: `isUploadCancellation()` lives
 * in mediaUploadService, which imports this file, so importing it back would
 * close a cycle. Every call site filters cancellations before calling in.
 */

import * as Sentry from '@sentry/react-native';
import { QuotaExceededError } from './api/errors';
import { captureError } from './telemetry';

/** Where in the compose → upload → post pipeline the failure happened. */
export type PostPipelineStage =
  /**
   * Video transcode + MP4 GPS strip. As a capture stage this reports the
   * ENCODER failing (fallback to the sanitized source); the integrity-guard
   * pass-through (transcode >= source, routine for already-compressed input)
   * is deliberately not reported, so `stage:transcode` undercounts
   * un-transcoded uploads.
   */
  | 'transcode'
  /** Still-image EXIF strip / re-encode. */
  | 'sanitize'
  /** Best-effort video poster frame upload (degrades to duration-only). */
  | 'thumbnail'
  /** Local poster-frame extraction/sanitize, before any upload (degrades to duration-only). */
  | 'thumbnail-extract'
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
    /**
     * Whether the post was a DM. Set only by the two composer surfaces
     * (screen-level stages); absent for service-internal reports and when the
     * conversation is not in the store, so a `dm:` query is screen-scoped.
     */
    dm?: boolean;
  },
): void {
  const tags: Record<string, string> = {
    feature: 'media-upload',
    stage: ctx.stage,
  };
  if (ctx.surface) tags.surface = ctx.surface;
  if (ctx.dm !== undefined) tags.dm = String(ctx.dm);
  // `status`/`api_code` for an ApiError are added by captureError (#746).
  captureError(e, {
    level: ctx.level ?? (e instanceof QuotaExceededError ? 'warning' : 'error'),
    tags,
  });
}
