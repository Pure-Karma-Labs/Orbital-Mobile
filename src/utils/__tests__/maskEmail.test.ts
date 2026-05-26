import { maskEmail } from '../maskEmail';

describe('maskEmail', () => {
  it('masks a normal email address', () => {
    expect(maskEmail('alice@example.com')).toBe('a***@example.com');
  });

  it('masks a single-character local part', () => {
    expect(maskEmail('a@example.com')).toBe('a***@example.com');
  });

  it('handles empty local part before @', () => {
    expect(maskEmail('@example.com')).toBe('***@example.com');
  });

  it('returns *** when no @ present', () => {
    expect(maskEmail('notanemail')).toBe('***');
  });

  it('returns *** for empty string', () => {
    expect(maskEmail('')).toBe('***');
  });

  it('splits on the first @ when multiple are present', () => {
    expect(maskEmail('user@sub@domain.com')).toBe('u***@sub@domain.com');
  });
});
