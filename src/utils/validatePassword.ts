/**
 * Client-side password rule check, run before any signup / reset request.
 *
 * Rules:
 * - At least 12 characters
 * - At least one uppercase letter [A-Z]
 * - At least one lowercase letter [a-z]
 * - At least one number [0-9]
 *
 * PARITY NOTE — `Orbital-Backend/src/routes/auth.js` `validatePassword()` is the
 * authoritative rule set; the messages below are copied from it verbatim so the
 * client and server never disagree on wording. Nothing automated verifies that
 * parity: the backend function is not exported and CI never checks out the
 * sibling repo, so parity is maintained by hand whenever the backend rules
 * change. A shared accept/reject fixture that would fail in whichever repo
 * drifts first is tracked in Orbital-Mobile #786.
 *
 * Two consequences of that manual parity:
 * - The backend sets no explicit maximum but hashes with bcrypt, whose
 *   effective input ceiling is 72 bytes. The client's `maxLength={128}` on the
 *   password fields is therefore a UI bound, not a contract bound.
 * - `ResetPasswordScreen` maps any server `ValidationError` to "Invalid or
 *   expired code", and `ValidationError` hardcodes its message anyway
 *   (Orbital-Mobile #783), so a backend rule tightened without a matching
 *   client update will surface there as a bogus code error, not a password
 *   error.
 *
 * The backend's leading `'Password is required'` branch is deliberately not
 * mirrored: both call sites guard emptiness before calling this, and `''`
 * returning the length message is pinned by a test.
 *
 * @returns null if valid, or the first failing rule's message.
 */
export function validatePassword(password: string): string | null {
  if (password.length < 12) {
    return 'Password must be at least 12 characters';
  }
  if (!/[A-Z]/.test(password)) {
    return 'Password must contain at least one uppercase letter';
  }
  if (!/[a-z]/.test(password)) {
    return 'Password must contain at least one lowercase letter';
  }
  if (!/[0-9]/.test(password)) {
    return 'Password must contain at least one number';
  }
  return null;
}

/**
 * Single source for the password rule shown as helper text under password
 * fields, so the rule is visible before the user types.
 */
export const PASSWORD_RULE_HINT =
  'At least 12 characters, with an uppercase letter, a lowercase letter and a number';
