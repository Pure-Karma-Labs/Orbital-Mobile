/**
 * Pure scrub/filter primitives for the Sentry payload boundary (#746).
 *
 * MODULE RULE: this file is PURE — it imports the Sentry SDK for TYPES only
 * and sends nothing — so it may be imported from paths where Sentry itself is
 * banned (crypto, secure-storage, database). Anything that calls the Sentry
 * client belongs in `telemetry.ts`, which IS banned there.
 *
 * E2EE constraints — telemetry is the only place failures reach a server we do
 * not control, so the payload is deliberately minimal:
 *   - Nothing derived from plaintext, ciphertext, key, IV or digest BYTES; a
 *     malformed-key byte COUNT (`contentCrypto.ts:75/:109`) may appear in a
 *     message.
 *   - Identifier scrub, scoped: full UUIDs and 24+ character hex runs become
 *     `<id>`, JWT-shaped strings become `<token>` and email addresses become
 *     `<email>`. Short ids, truncated UUIDs and base64url tokens are NOT
 *     covered — the guarantee is the producer obligation below, and the
 *     regexes are defence-in-depth, not the boundary.
 *   - No file names, URIs or filesystem paths: `scrubErrorMessage()` strips
 *     them, because RNFS/native errors routinely embed the picker URI (which
 *     on Android carries the user's file name).
 *   - The captured Error is a rebuilt copy, never the original object
 *     (`toReportableError`). That is what keeps custom fields off the event —
 *     `ApiError.serverMessage` and `QuotaExceededError.usage` would otherwise
 *     be one integration away from being serialized.
 *
 * PRODUCER OBLIGATION. Since #746 this boundary covers every capture site, not
 * just the upload pipeline: auth, key recovery, orbit create/join and upload.
 * Those producers must never interpolate invite codes, email addresses, orbit
 * or thread titles, display names or message bodies into a thrown message, a
 * breadcrumb message or breadcrumb data. The patterns below are a second line
 * of defence and cannot recognise a family name or an orbit title.
 *
 * USER ID: `event.user` is the one deliberate exception to the id rule.
 * `App.tsx` calls `setUser({ id })` so events are attributable to an account;
 * `scrubEvent` keeps `user.id` verbatim and drops every other `user` field.
 * The same id appearing in `extra` / breadcrumb data IS scrubbed to `<id>` —
 * attribution rides on `event.user`, nowhere else.
 *
 * Breadcrumb `data` is rebuilt from PRIMITIVES ONLY, so the scrub is
 * structural: it does not depend on the producer sending a known shape, and a
 * nested object added later cannot smuggle content past the string patterns.
 */

import type { Breadcrumb, ErrorEvent } from '@sentry/react-native';

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
 * UUIDs and long hex runs — group / media ids (and user ids outside
 * `event.user`, see the header) must never reach Sentry.
 * No leading `\b`: an id glued to a prefix (`group_<uuid>`, `media<hex>`) has
 * no word boundary in front of it and would otherwise survive.
 */
const ID_PATTERN =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b|[0-9a-f]{24,}\b/gi;
/** JWT-shaped strings (`eyJ…`.`…`.`…`) — an auth token must never reach Sentry. */
const JWT_PATTERN = /eyJ[\w-]+\.[\w-]+\.[\w-]+/g;
/**
 * Email addresses. Login, invite and key-recovery messages are the widened
 * scope's realistic leak (`no account for a@b.com`), and an email is directly
 * identifying — unlike the opaque ids the other patterns cover.
 */
const EMAIL_PATTERN = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
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
    // EMAIL runs before ID so the local part of `3f9a…@x.com` is replaced as a
    // whole address rather than half-scrubbed into `<id>@x.com`.
    .replace(EMAIL_PATTERN, '<email>')
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
export function toReportableError(e: unknown): Error {
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
 * Breadcrumb categories that are dropped outright.
 *
 * `touch` and `ui.multiClick` come from `Sentry.wrap`'s TouchEventBoundary and
 * carry the pressed element's `accessibilityLabel` or its rendered text — at
 * least a dozen of ours interpolate DECRYPTED content (`Thread: ${title}`,
 * orbit names, display names). This drop is the primary defence; the
 * boundary's own props (App.tsx) are the secondary one.
 *
 * `ui.tap` is sentry-cocoa's native interaction category. Its data is the
 * view's `accessibilityIdentifier` (RN maps that from `testID`, not the
 * label), so it is not a known content leak — but it is an interaction crumb
 * merged in natively, and dropping it costs nothing.
 *
 * `console` is belt-and-braces: console breadcrumbs are also disabled at the
 * source via `breadcrumbsIntegration({ console: false })` in sentryInit.ts.
 */
const DROPPED_CATEGORIES = new Set([
  'touch',
  'ui.multiClick',
  'ui.tap',
  'console',
]);

/**
 * `beforeBreadcrumb`: drop request/UI crumbs and scrub what survives.
 *
 * `type === 'http'` covers both producers: the JS xhr/fetch crumbs from
 * `breadcrumbsIntegration`, and — via the re-filter inside `scrubEvent` — the
 * native crumbs sentry-cocoa/android merge in later. Request URLs carry orbit,
 * thread and media UUIDs, and `setUser({ id })` makes them attributable.
 *
 * Returns a NEW breadcrumb; the input is never mutated. Wrapped in try/catch
 * because core's `addBreadcrumb` does not guard this hook — a throw here would
 * propagate into whatever code was recording a crumb.
 */
export function filterBreadcrumb(breadcrumb: Breadcrumb): Breadcrumb | null {
  try {
    if (breadcrumb.type === 'http') return null;
    if (typeof breadcrumb.category === 'string' && DROPPED_CATEGORIES.has(breadcrumb.category)) {
      return null;
    }

    const safe: Breadcrumb = {};
    if (breadcrumb.type !== undefined) safe.type = breadcrumb.type;
    if (breadcrumb.category !== undefined) safe.category = breadcrumb.category;
    if (breadcrumb.level !== undefined) safe.level = breadcrumb.level;
    if (breadcrumb.event_id !== undefined) safe.event_id = breadcrumb.event_id;
    if (breadcrumb.timestamp !== undefined) safe.timestamp = breadcrumb.timestamp;
    if (typeof breadcrumb.message === 'string') {
      safe.message = scrubErrorMessage(breadcrumb.message);
    }

    // Primitives only. Arrays, objects, null, undefined and functions are
    // dropped rather than serialized, so the scrub does not depend on the
    // producer sending a shape we already know about.
    const data = breadcrumb.data;
    if (data !== null && typeof data === 'object') {
      const safeData: Record<string, string | number | boolean> = {};
      for (const [key, value] of Object.entries(data)) {
        if (typeof value === 'string') safeData[key] = scrubErrorMessage(value);
        else if (typeof value === 'number' || typeof value === 'boolean') safeData[key] = value;
      }
      if (Object.keys(safeData).length > 0) safe.data = safeData;
    }

    return safe;
  } catch {
    // Unreadable breadcrumb (throwing getter, hostile proxy) — drop it.
    return null;
  }
}

/**
 * Build a content-free stand-in for an event whose scrub threw.
 *
 * Silence would hide a broken scrub; forwarding the unscrubbed event would be
 * exactly the leak this module exists to prevent. The skeleton is built fresh
 * from literals, so nothing from the original can ride along, and it shows up
 * in Sentry as a `scrub:failed` spike.
 */
function scrubFailureSkeleton(event: ErrorEvent): ErrorEvent | null {
  let eventId: string | undefined;
  try {
    // Best-effort only: keeping the id preserves client-report correlation,
    // but the property access is exactly what may have thrown above.
    const id: unknown = event?.event_id;
    if (typeof id === 'string') eventId = id;
  } catch {
    eventId = undefined;
  }
  try {
    return {
      type: undefined,
      event_id: eventId,
      timestamp: Date.now() / 1000,
      level: 'error',
      platform: 'javascript',
      message: 'telemetry-scrub-failed',
      tags: { scrub: 'failed' },
    };
  } catch {
    return null;
  }
}

/**
 * `beforeSend`: the last boundary before an event leaves the device.
 *
 * The event is mutated in place — the SDK hands us ownership at this point.
 *
 * Breadcrumbs are re-filtered here even though `beforeBreadcrumb` already ran:
 * `deviceContextIntegration` merges the NATIVE breadcrumb buffer into the JS
 * event inside an event processor (sort, then slice to `maxBreadcrumbs`), and
 * all of that happens BEFORE `beforeSend`. Native crumbs therefore never pass
 * through `beforeBreadcrumb` at all.
 *
 * Exception `type` and stack frames are left alone: `toReportableError`
 * already scrubbed the frames of everything captured through `telemetry.ts`,
 * and frames are what makes an event actionable.
 */
export function scrubEvent(event: ErrorEvent): ErrorEvent | null {
  try {
    // Every entry, not just the first: linked/`cause` errors each get one.
    for (const value of event.exception?.values ?? []) {
      if (typeof value.value === 'string') value.value = scrubErrorMessage(value.value);
    }

    if (typeof event.message === 'string') event.message = scrubErrorMessage(event.message);
    if (event.logentry && typeof event.logentry.message === 'string') {
      event.logentry.message = scrubErrorMessage(event.logentry.message);
    }
    if (event.logentry && Array.isArray(event.logentry.params)) {
      event.logentry.params = event.logentry.params.map((p: unknown) =>
        typeof p === 'string' ? scrubErrorMessage(p) : typeof p === 'number' || typeof p === 'boolean' ? p : '<dropped>',
      );
    }

    // The deliberate attribution exception (see header): keep `id` verbatim,
    // drop everything else a future `setUser` call might add.
    if (event.user !== null && typeof event.user === 'object') {
      const id: unknown = event.user.id;
      event.user = typeof id === 'string' || typeof id === 'number' ? { id } : {};
    }

    if (Array.isArray(event.breadcrumbs)) {
      event.breadcrumbs = event.breadcrumbs
        .map(filterBreadcrumb)
        .filter((b): b is Breadcrumb => b !== null);
    }

    if (event.extra !== null && typeof event.extra === 'object') {
      // `__serialized__` is core's dump of a non-Error capture argument; it is
      // a whole object graph and nothing on this path needs it.
      delete event.extra.__serialized__;
      for (const [key, value] of Object.entries(event.extra)) {
        if (typeof value === 'string') event.extra[key] = scrubErrorMessage(value);
        else if (typeof value !== 'number' && typeof value !== 'boolean') {
          delete event.extra[key];
        }
      }
    }

    if (event.tags !== null && typeof event.tags === 'object') {
      for (const [key, value] of Object.entries(event.tags)) {
        if (typeof value === 'string') event.tags[key] = scrubErrorMessage(value);
      }
    }

    return event;
  } catch {
    return scrubFailureSkeleton(event);
  }
}
