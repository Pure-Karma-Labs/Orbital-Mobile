import { INVALID_EMAIL_MESSAGE, validateEmail } from '../validateEmail';

/**
 * The literal copy is asserted directly rather than through the constant:
 * comparing the return value to the constant it is built from would pass even
 * if both changed, and this string is the client's user-facing contract
 * (it is also what the curated `EMAIL_FORMAT` validation reason renders).
 */
const EXPECTED_MESSAGE = 'Please enter a valid email address';

/** `local@example.com` padded so the whole address is exactly `total` chars. */
function emailOfLength(total: number): string {
  const domain = '@example.com';
  return 'a'.repeat(total - domain.length) + domain;
}

describe('validateEmail', () => {
  it('pins the exported message to the shipped copy', () => {
    expect(INVALID_EMAIL_MESSAGE).toBe(EXPECTED_MESSAGE);
  });

  it('returns null for a valid email', () => {
    expect(validateEmail('a@b.co')).toBeNull();
  });

  it.each([
    ['empty string', ''],
    ['no at-sign or dot', 'notanemail'],
    ['no dot in the domain', 'a@b'],
    ['space in the local part', 'a b@c.d'],
    ['double at-sign', 'a@@b.c'],
  ])('rejects %s', (_label, email) => {
    expect(validateEmail(email)).toBe(EXPECTED_MESSAGE);
  });

  it('accepts an address of exactly 254 characters', () => {
    const email = emailOfLength(254);
    expect(email).toHaveLength(254);
    expect(validateEmail(email)).toBeNull();
  });

  it('rejects an address of 255 characters', () => {
    const email = emailOfLength(255);
    expect(email).toHaveLength(255);
    expect(validateEmail(email)).toBe(EXPECTED_MESSAGE);
  });
});
