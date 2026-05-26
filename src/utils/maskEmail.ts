/**
 * Mask an email address for display — show first char of local part + *** + @domain.
 *
 * Examples:
 *   alice@example.com  → a***@example.com
 *   a@example.com      → a***@example.com
 *   @example.com       → ***@example.com
 *   notanemail         → ***
 *   ""                 → ***
 */
export function maskEmail(email: string): string {
  if (!email) return '***';

  const atIndex = email.indexOf('@');
  if (atIndex === -1) return '***';

  const local = email.slice(0, atIndex);
  const domain = email.slice(atIndex); // includes the @

  if (local.length === 0) return `***${domain}`;

  return `${local[0]}***${domain}`;
}
