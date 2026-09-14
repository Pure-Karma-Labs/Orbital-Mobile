/**
 * Shared user-facing copy for error outcomes that more than one screen has to
 * render, so the wording cannot drift between forms.
 */

/**
 * Shown when the server answers 429 (`ApiError` with `code === 'RATE_LIMITED'`).
 * Deliberately vague about the window: the backend's bucket size is not a
 * contract the client can see, and stating it would both drift and disclose the
 * limiter configuration.
 */
export const RATE_LIMIT_MESSAGE =
  'Too many attempts — please wait a few minutes and try again';

/**
 * Shown for a 429 on the key-recovery paths (key conflict resolution, Settings
 * recovery), which sit behind the backend's `keyResetLimiter` — 3 attempts per
 * 15 minutes, keyed per user, not the shared IP-keyed auth limiter
 * (`Orbital-Backend/src/middleware/rateLimiters.js:139-147`).
 *
 * The window is stated here on purpose: the caller is an authenticated owner
 * mid-recovery on the app's most fragile flow, "a few minutes" would invite
 * attempts that burn the tiny budget, and a per-user limiter's size discloses
 * nothing about other accounts. Keep this in sync with `keyResetLimiter`.
 */
export const RECOVERY_RATE_LIMIT_MESSAGE =
  'Too many attempts — please wait 15 minutes and try again';
