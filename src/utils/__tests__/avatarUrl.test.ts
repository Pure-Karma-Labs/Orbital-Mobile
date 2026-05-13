import { getAvatarUrl } from '../avatarUrl';

describe('getAvatarUrl', () => {
  it('returns full URL for valid avatar path', () => {
    expect(getAvatarUrl('/avatars/abc-123.jpg')).toBe(
      'https://api.orbitl.org/avatars/abc-123.jpg',
    );
  });

  it('handles underscores and dots in filename', () => {
    expect(getAvatarUrl('/avatars/user_id-1234567890.png')).toBe(
      'https://api.orbitl.org/avatars/user_id-1234567890.png',
    );
  });

  it('returns null for null input', () => {
    expect(getAvatarUrl(null)).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(getAvatarUrl('')).toBeNull();
  });

  it('rejects path traversal attempts', () => {
    expect(getAvatarUrl('../etc/passwd')).toBeNull();
    expect(getAvatarUrl('/avatars/../etc/passwd')).toBeNull();
    expect(getAvatarUrl('/avatars/../../etc/passwd')).toBeNull();
  });

  it('rejects absolute URLs', () => {
    expect(getAvatarUrl('https://evil.com/avatar.jpg')).toBeNull();
    expect(getAvatarUrl('http://evil.com/img.png')).toBeNull();
  });

  it('rejects double-slash open redirect', () => {
    expect(getAvatarUrl('//evil.com/img.jpg')).toBeNull();
  });

  it('rejects paths outside /avatars/', () => {
    expect(getAvatarUrl('/uploads/avatar.jpg')).toBeNull();
    expect(getAvatarUrl('/api/users/me')).toBeNull();
  });

  it('rejects file:// protocol', () => {
    expect(getAvatarUrl('file:///etc/passwd')).toBeNull();
  });

  it('rejects paths with query strings', () => {
    expect(getAvatarUrl('/avatars/img.jpg?callback=evil')).toBeNull();
  });

  it('rejects paths with spaces or special chars', () => {
    expect(getAvatarUrl('/avatars/img file.jpg')).toBeNull();
    expect(getAvatarUrl('/avatars/img<script>.jpg')).toBeNull();
  });
});
