/**
 * The only approved path from a caught error to Sentry (#746).
 *
 * Every `Sentry.captureException` / `captureEvent` call outside this file is a
 * Semgrep ERROR (`no-raw-sentry-capture`), because a raw capture hands Sentry
 * the thrower's own error object: custom fields (`ApiError.serverMessage`,
 * `QuotaExceededError.usage`) are then one enabled integration away from being
 * serialized into the event. `captureError` reports a rebuilt copy instead —
 * class name, scrubbed message and scrubbed frames, nothing else.
 *
 * This is the enforcement layer, not the only one: `beforeSend`/
 * `beforeBreadcrumb` (sentryInit.ts) still scrub whatever reaches the client
 * by another route, including the SDK's own auto-captured events.
 *
 * `captureMessage` is deliberately NOT wrapped here. `scrubEvent` scrubs
 * `event.message` / `logentry`, but that scrub only removes paths, URIs, file
 * names, ids, tokens and emails — it cannot recognise a name or a title. So
 * never interpolate a name, title, invite code or message body into a
 * captureMessage argument; interpolate only closed enum values.
 *
 * Banned from crypto / secure-storage / database paths by ESLint, same as the
 * SDK itself. Those paths may import `telemetryScrub.ts`, which sends nothing.
 */

import * as Sentry from '@sentry/react-native';
import type { SeverityLevel } from '@sentry/react-native';
import { ApiError } from './api/errors';
import { toReportableError } from './telemetryScrub';

/**
 * Validation-reason tag vocabulary. `api_code` is `VALIDATION_ERROR` for every
 * 400, so these two content-free flags are the only way to tell routing gaps
 * apart. Use the one that matches the route; do not invent a third.
 *
 * - `validation_reason_known: 'false'` — a 400 that carried NO allowlisted
 *   reason, on a route where every 400 is coded, so its absence means
 *   backend/client drift (SignupScreen, JoinOrbitScreen).
 * - `validation_reason_routed: 'false'` — a 400 whose reason IS on the client
 *   allowlist but which the screen's routing does not handle, on a route with
 *   legitimate uncoded 400s, where `known` would be noise
 *   (utils/inviteCreateErrors.ts).
 */
export interface CaptureContext {
  /** Indexed, low-cardinality facets. `status`/`api_code` are added for you. */
  tags?: Record<string, string>;
  /** Primitive-only detail. String values are scrubbed by `beforeSend`. */
  extra?: Record<string, string | number | boolean>;
  /** Defaults to the SDK's `error`. */
  level?: SeverityLevel;
}

/**
 * Report a caught error. Callers must have ruled out cancellations and other
 * expected control-flow throws.
 */
export function captureError(e: unknown, ctx?: CaptureContext): void {
  const tags: Record<string, string> = { ...ctx?.tags };
  // Status + machine code are the two non-content facts that separate "server
  // said no" from "the device broke"; ApiError.message is already generic.
  // Owned here so no call site has to hand-spread them (and none can forget).
  if (e instanceof ApiError) {
    tags.status = String(e.statusCode);
    tags.api_code = e.code;
  }

  const scope: CaptureContext = {};
  if (Object.keys(tags).length > 0) scope.tags = tags;
  if (ctx?.extra !== undefined) scope.extra = ctx.extra;
  if (ctx?.level !== undefined) scope.level = ctx.level;

  Sentry.captureException(toReportableError(e), scope);
}
