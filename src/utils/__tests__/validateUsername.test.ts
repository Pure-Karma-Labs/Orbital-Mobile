import { validateUsername } from '../validateUsername';

describe('validateUsername', () => {
  it('returns null for a valid username', () => {
    expect(validateUsername('alice')).toBeNull();
  });

  it('accepts a username at exactly 3 characters', () => {
    expect(validateUsername('abc')).toBeNull();
  });

  it('accepts a username at exactly 50 characters', () => {
    expect(validateUsername('a'.repeat(50))).toBeNull();
  });

  it('rejects a username of 2 characters', () => {
    expect(validateUsername('ab')).toBe(
      'Username must be between 3 and 50 characters',
    );
  });

  it('rejects a username of 51 characters', () => {
    expect(validateUsername('a'.repeat(51))).toBe(
      'Username must be between 3 and 50 characters',
    );
  });

  it('rejects a username containing a space', () => {
    expect(validateUsername('bad name')).toBe(
      'Username can only contain letters, numbers, and underscores',
    );
  });

  it('rejects a username containing a hyphen', () => {
    expect(validateUsername('bad-name')).toBe(
      'Username can only contain letters, numbers, and underscores',
    );
  });

  it('rejects a username containing a period', () => {
    expect(validateUsername('bad.name')).toBe(
      'Username can only contain letters, numbers, and underscores',
    );
  });

  it('accepts underscores', () => {
    expect(validateUsername('good_name')).toBeNull();
  });

  it('accepts digits', () => {
    expect(validateUsername('user123')).toBeNull();
  });

  it('rejects empty string with the length message', () => {
    expect(validateUsername('')).toBe(
      'Username must be between 3 and 50 characters',
    );
  });
});
