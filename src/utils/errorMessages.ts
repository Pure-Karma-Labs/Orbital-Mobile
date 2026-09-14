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
