import { validatePassword } from '../validatePassword';

describe('validatePassword', () => {
  it('returns null for a valid password', () => {
    expect(validatePassword('StrongPass123')).toBeNull();
  });

  it('rejects passwords shorter than 12 characters', () => {
    expect(validatePassword('Short1Aa')).toBe('Password must be at least 12 characters');
  });

  it('rejects passwords missing an uppercase letter', () => {
    expect(validatePassword('alllowercase1')).toBe('Password must include an uppercase letter');
  });

  it('rejects passwords missing a lowercase letter', () => {
    expect(validatePassword('ALLUPPERCASE1')).toBe('Password must include a lowercase letter');
  });

  it('rejects passwords missing a number', () => {
    expect(validatePassword('NoNumbersHere!')).toBe('Password must include a number');
  });

  it('rejects empty string', () => {
    expect(validatePassword('')).toBe('Password must be at least 12 characters');
  });

  it('accepts a password at exactly 12 characters', () => {
    expect(validatePassword('Abcdefghij1k')).toBeNull();
  });
});
