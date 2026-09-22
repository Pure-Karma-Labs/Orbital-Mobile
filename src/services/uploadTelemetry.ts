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
 *   - Nothing derived from plaintext, ciphertext, key, IV or digest BYTES; a
 *     malformed-key byte COUNT (`contentCrypto.ts:75/:109`) may appear in a
 *     message.
 *   - Identifier scrub, scoped: full UUIDs and 24+ character hex runs become
 *     `<id>` and JWT-shaped strings become `<token>`. Short ids, truncated
 *     UUIDs and base64url tokens are NOT covered — the guarantee is that no
 *     producer on this path interpolates them (see the #747 note below), and
 *     the regexes are defence-in-depth, not the boundary.
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
import { ApiError, QuotaExceededError } from './api/errors';

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

/** Longest message we send. Native errors can be kilobytes of stringified state. */
const MAX_MESSAGE_LENGTH = 200;

/** `file://…`, `content://…`, `https://…` — anything scheme-prefixed. */
const URI_PATTERN = /\b[a-z][a-z0-9+.-]*:\/\/\S*/gi;
/**
 * Absolute POSIX paths of two or more segments. Inner segments may contain
 * spaces (`/Pictures/Baby Photos/…` — user-authored directory names are
 * exactly the content this strips); the final segment is space-free so a
 * trailing diagnostic (` not found`) survives the scrub.
 */
const PATH_PATTERN = /(?:\/[^/\n]+)+\/[^\s/]+\/?/g;
/**
 * UUIDs and long hex runs — group / user / media ids must never reach Sentry.
 * No leading `\b`: an id glued to a prefix (`group_<uuid>`, `media<hex>`) has
 * no word boundary in front of it and would otherwise survive.
 */
const ID_PATTERN =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b|[0-9a-f]{24,}\b/gi;
/** JWT-shaped strings (`eyJ…`.`…`.`…`) — an auth token must never reach Sentry. */
const JWT_PATTERN = /eyJ[\w-]+\.[\w-]+\.[\w-]+/g;
const MEDIA_EXTENSIONS =
  'jpe?g|png|heic|heif|gif|webp|avif|bmp|tiff?|dng|jfif|mp4|mov|m4v|3gp|mkv|webm|avi|mpe?g|wav|aac|bin|dat|tmp';
/** Bare file names — an RNFS error can name the file without any directory. */
const FILENAME_PATTERN = new RegExp(
  String.raw`\b[\w.\-()]+\.(?:${MEDIA_EXTENSIONS})\b`,
  'gi',
);
/**
 * File names whose stem contains spaces (`My Vacation Video.mp4`). Requires
 * each stem word to start with an uppercase letter or digit — the shape user
 * file names actually take — so it does not swallow the sentence prefix of a
 * diagnostic like `could not read my movie.mov`. Case-sensitive stems; the
 * extension alternation is expanded to both cases by hand below.
 */
const SPACED_FILENAME_PATTERN = new RegExp(
  String.raw`\b(?:[A-Z0-9][\w.\-()]* ){1,4}[\w.\-()]*\.(?:${MEDIA_EXTENSIONS.replace(
    /[a-z]/g,
    (c) => `[${c}${c.toUpperCase()}]`,
  )})\b`,
  'g',
);

function scrubText(text: string): string {
  return text
    .replace(URI_PATTERN, '<uri>')
    .replace(PATH_PATTERN, '<path>')
    .replace(SPACED_FILENAME_PATTERN, '<file>')
    .replace(FILENAME_PATTERN, '<file>')
    // Identifier scrubs run LAST: `<id>` inserts angle brackets the filename
    // regexes cannot cross, so running it first would let a user file name
    // with a hex stem (`Summer BBQ <hex>.jpg`) leak its stem past the scrub.
    .replace(JWT_PATTERN, '<token>')
    .replace(ID_PATTERN, '<id>');
}

/**
 * Remove anything that could carry user content from an error message.
 *
 * Deliberately over-eager: losing a path from a diagnostic is cheap, leaking a
 * file name to Sentry is not. Exported for the unit tests that pin this.
 */
export function scrubErrorMessage(message: string): string {
  const scrubbed = scrubText(message).trim();
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
  // Keep only real frame lines. A multi-line message spans one stack-header
  // line per newline, so dropping a fixed count would re-emit the UNSCRUBBED
  // remainder as "frames". Scrub the kept block too, so the no-user-content
  // guarantee is structural rather than resting on Sentry's frame parser
  // discarding non-frame lines. Release frames are bundle-relative and pass
  // through untouched, so symbolication is unaffected.
  const frames = source.stack
    ?.split('\n')
    .filter((line) => /^\s*at /.test(line))
    .join('\n');
  reported.stack = frames ? `${name}: ${message}\n${scrubText(frames)}` : undefined;
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
