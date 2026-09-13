import { validatePassword, PASSWORD_RULE_HINT } from '../validatePassword';

describe('validatePassword', () => {
  it('returns null for a valid password', () => {
    expect(validatePassword('StrongPass123')).toBeNull();
  });

  it('rejects passwords shorter than 12 characters', () => {
    expect(validatePassword('Short1Aa')).toBe('Password must be at least 12 characters');
  });

  it('rejects passwords missing an uppercase letter', () => {
    expect(validatePassword('alllowercase1')).toBe(
      'Password must contain at least one uppercase letter',
    );
  });

  it('rejects passwords missing a lowercase letter', () => {
    expect(validatePassword('ALLUPPERCASE1')).toBe(
      'Password must contain at least one lowercase letter',
    );
  });

  it('rejects passwords missing a number', () => {
    expect(validatePassword('NoNumbersHere!')).toBe(
      'Password must contain at least one number',
    );
  });

  it('rejects empty string', () => {
    expect(validatePassword('')).toBe('Password must be at least 12 characters');
  });

  it('accepts a password at exactly 12 characters', () => {
    expect(validatePassword('Abcdefghij1k')).toBeNull();
  });
});

describe('PASSWORD_RULE_HINT', () => {
  it('mentions all four password rules', () => {
    expect(PASSWORD_RULE_HINT).toMatch(/12 characters/);
    expect(PASSWORD_RULE_HINT).toMatch(/uppercase letter/);
    expect(PASSWORD_RULE_HINT).toMatch(/lowercase letter/);
    expect(PASSWORD_RULE_HINT).toMatch(/number/);
  });
});
