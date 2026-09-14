/**
 * Client-side username rule check, run before any signup request.
 *
 * Rules:
 * - Between 3 and 50 characters
 * - Letters, numbers and underscores only
 *
 * PARITY NOTE — `Orbital-Backend/src/routes/auth.js` `validateUsername()`
 * (lines 26-38) is the authoritative rule set; the messages below are copied
 * from it verbatim so the client and server never disagree on wording. Nothing
 * automated verifies that parity: the backend function is not exported and CI
 * never checks out the sibling repo, so parity is maintained by hand whenever
 * the backend rules change. A shared accept/reject fixture covering both the
 * username and password rules is tracked in Orbital-Mobile #786 ("auth-rule
 * parity").
 *
 * Call this with the same string that is sent to the server (i.e. trimmed).
 * The backend's leading `'Username is required'` branch is deliberately not
 * mirrored: the caller guards emptiness first, and an empty string here
 * returns the length message.
 *
 * @returns null if valid, or the first failing rule's message.
 */
export function validateUsername(username: string): string | null {
  if (username.length < 3 || username.length > 50) {
    return 'Username must be between 3 and 50 characters';
  }
  if (!/^[A-Za-z0-9_]+$/.test(username)) {
    return 'Username can only contain letters, numbers, and underscores';
  }
  return null;
}
