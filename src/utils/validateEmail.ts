/**
 * Client-side email format check, run before any auth request that carries an
 * email (signup, login, forgot-password).
 *
 * Rules:
 * - At most 254 characters (RFC 5321)
 * - Matches /^[^\s@]+@[^\s@]+\.[^\s@]+$/
 *
 * PARITY NOTE — `Orbital-Backend/src/utils/emailNormalization.js` `isValidEmail()`
 * (lines 15-28) is the authoritative rule set. Parity is on the **rule only**:
 * the 254-character cap and the regex above. The user-facing wording below
 * deliberately belongs to the client — the backend's "Invalid email format" is
 * a developer string, and `INVALID_EMAIL_MESSAGE` is the copy this app has
 * always shown, so routing a server `EMAIL_FORMAT` reason to it does not
 * regress what users read. Nothing automated verifies the rule parity: the
 * backend function is not exported to us and CI never checks out the sibling
 * repo, so it is maintained by hand whenever the backend rules change. A shared
 * accept/reject fixture covering the username, password and email rules is
 * tracked in Orbital-Mobile #786 ("auth-rule parity").
 *
 * Call this with the same string that is sent to the server (i.e. trimmed).
 * The backend's non-string / falsy guard is deliberately not mirrored: every
 * caller is typed `string`, and `''` returns the message rather than passing.
 */

/** Today's shipped copy for a bad email, kept verbatim so nothing regresses. */
export const INVALID_EMAIL_MESSAGE = 'Please enter a valid email address';

/**
 * Module-private: the rule itself. Callers get the message-or-null shape so a
 * screen can never branch on the predicate and then invent its own copy.
 */
function isEmailFormatValid(email: string): boolean {
  if (email.length > 254) {
    return false;
  }
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

/**
 * @returns null if the email is well-formed, or INVALID_EMAIL_MESSAGE.
 */
export function validateEmail(email: string): string | null {
  return isEmailFormatValid(email) ? null : INVALID_EMAIL_MESSAGE;
}
