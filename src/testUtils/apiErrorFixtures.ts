/**
 * Shared fixtures for the backend's `VALIDATION_ERROR` wire body.
 *
 * Kept separate from `./rtr.ts` on purpose: node-query consumers should not be
 * coupled to `services/api/errors`, and this module needs a runtime import of
 * `ValidationError` while `rtr.ts` must stay import-free.
 *
 * Both builders produce a body shaped exactly like the backend's `errorHandler`
 * response (`{ error, message, details: { code } }`) so that the `details.code`
 * → curated-copy mapping under test is exercised through the production parse
 * rather than a hand-set field. The curated copy itself must still be written
 * out as a literal at every call site — importing the reason-code map would
 * make the assertion a tautology.
 */

import { ValidationError } from '../services/api/errors';

/**
 * A `VALIDATION_ERROR` response body.
 *
 * `code` is `unknown` deliberately: the client-side parse is tested against
 * numbers, `null`, objects, arrays and mis-cased strings.
 */
export function codedValidationBody(code: unknown, message = 'server text'): string {
  return JSON.stringify({
    error: 'VALIDATION_ERROR',
    message,
    details: { code },
  });
}

/** A real 400 `ValidationError` carrying a coded `VALIDATION_ERROR` body. */
export function reasonedValidationError(code: string, message = 'server text'): ValidationError {
  return new ValidationError(400, codedValidationBody(code, message));
}
