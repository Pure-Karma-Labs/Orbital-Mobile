/**
 * Error routing for invite-code creation (`createInviteCode` →
 * `POST /api/groups/:groupId/invite-codes`), shared by the route's two callers:
 * CreateOrbitScreen's invite step and ManageOrbitsScreen's New Code modal.
 *
 * One pure function so the two entry points cannot word or route the same
 * outcome differently. Each screen maps the result onto its own two slots (a
 * field error under the email input, and a banner) and owns the capture call.
 */

import {
  ApiError,
  AuthError,
  NetworkError,
  NotFoundError,
  ValidationError,
} from '../services/api/errors';
import { RATE_LIMIT_MESSAGE } from './errorMessages';
import { groupKeyFailureCopy } from './groupKeyErrorCopy';

/**
 * Permanent refusals: the orbit, not the email, is the problem, and no retry
 * will change the answer. 403 covers both of the route's forbiddenError cases
 * (not the creator, and the demo-account boundary); a 403 body is never parsed
 * by this client, so they share one message.
 */
const INVITE_NOT_ALLOWED_MESSAGE = "You can't create invites for this orbit";
const INVITE_ORBIT_GONE_MESSAGE = 'This orbit no longer exists';

/**
 * Transient or unattributable: retrying is honest advice.
 */
const INVITE_GENERIC_FAILURE_MESSAGE =
  'Failed to generate invite code. Please try again.';

export interface InviteCreateErrorRoute {
  /** A verdict on the typed invitee address: render under the email input. */
  fieldError?: string;
  /** Everything else: render on the banner. */
  bannerError?: string;
  /** Present only when the outcome should be reported via `captureError`. */
  captureTags?: Record<string, string>;
}

/**
 * Map a `createInviteCode` failure to the slot it belongs in.
 *
 * The client pre-flight (`validateEmail`) runs before the request in both
 * screens, so a coded `EMAIL_FORMAT` here is the safety net for any divergence
 * between the client and backend rules (#786). On this route the reason is
 * emitted by `normalizeEmail(target_email)` before any DB access, so it judges
 * nothing but the invitee address (Backend #294).
 */
export function routeInviteCreateError(err: unknown): InviteCreateErrorRoute {
  if (err instanceof NetworkError) {
    return { bannerError: err.message };
  }
  if (err instanceof ApiError && err.code === 'RATE_LIMITED') {
    return { bannerError: RATE_LIMIT_MESSAGE };
  }
  if (err instanceof ValidationError && err.reason === 'EMAIL_FORMAT') {
    // `err.message` is client copy selected by the code (errors.ts), never
    // server text.
    return { fieldError: err.message };
  }
  if (err instanceof AuthError && err.statusCode === 403) {
    return { bannerError: INVITE_NOT_ALLOWED_MESSAGE };
  }
  if (err instanceof NotFoundError) {
    return { bannerError: INVITE_ORBIT_GONE_MESSAGE };
  }
  // Every group-key failure (#912): the transient pending wrap AND each
  // terminal self-heal outcome, which used to fall through to the generic
  // banner below WITH a capture. Both halves of that were wrong: the budgeted
  // reporter in `services/groupKeyTelemetry` already captured the failure once
  // per (group, outcome) with content-free codes, so this emitted a second
  // event for the same thing; and "Failed to generate invite code. Please try
  // again." buried a reason retrying cannot change. So: no captureTags, and
  // the copy for the actual outcome, from the one selector every other surface
  // reads — a group-key failure on the invite route is the same failure it is
  // in a composer, and must not be worded differently here.
  const keyCopy = groupKeyFailureCopy(err);
  if (keyCopy) {
    return { bannerError: keyCopy.message };
  }

  // Everything unattributable: 401, 5xx, an uncoded 400 (a client-contract bug
  // on this route), a code hash collision, and local crypto faults. Silent
  // before #871, so a permanent identity-key fault (#675 class) looked like a
  // transient retry prompt with no telemetry.
  //
  // `captureError` adds status/api_code for an ApiError (#746), and `api_code`
  // is `VALIDATION_ERROR` for every 400. `validation_reason_routed: 'false'`
  // marks a reason that IS on the client's allowlist (errors.ts) but that this
  // route's routing above does not handle. A code the backend adds later is
  // dropped by the allowlist parse (`reason === undefined`) and is not covered
  // by this tag. See the tag vocabulary in services/telemetry.ts.
  const captureTags: Record<string, string> = { feature: 'orbit-invite-create' };
  if (err instanceof ValidationError && err.reason !== undefined) {
    captureTags.validation_reason_routed = 'false';
  }
  return { bannerError: INVITE_GENERIC_FAILURE_MESSAGE, captureTags };
}
