/**
 * Tests for mediaPaths — resolveMediaPath, toStoredMediaPath.
 */

jest.mock('@dr.pogodin/react-native-fs', () => ({
  DocumentDirectoryPath: '/tmp/test-docs',
}));

import { resolveMediaPath, toStoredMediaPath, MEDIA_DIR } from '../media/mediaPaths';

describe('MEDIA_DIR', () => {
  it('is derived from DocumentDirectoryPath', () => {
    expect(MEDIA_DIR).toBe('/tmp/test-docs/media');
  });
});

describe('resolveMediaPath', () => {
  it('returns null for null input', () => {
    expect(resolveMediaPath(null)).toBeNull();
  });

  it('returns null for undefined input', () => {
    expect(resolveMediaPath(undefined)).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(resolveMediaPath('')).toBeNull();
  });

  it('resolves new-relative path', () => {
    expect(resolveMediaPath('media/abc.jpg')).toBe('/tmp/test-docs/media/abc.jpg');
  });

  it('resolves legacy-absolute path', () => {
    expect(resolveMediaPath('/var/mobile/Containers/Data/Application/OLD-UUID/Documents/media/abc.jpg'))
      .toBe('/tmp/test-docs/media/abc.jpg');
  });

  it('resolves rotated-container absolute path', () => {
    expect(resolveMediaPath('/var/mobile/Containers/Data/Application/NEW-UUID/Documents/media/abc.jpg'))
      .toBe('/tmp/test-docs/media/abc.jpg');
  });

  it('returns null for path with empty basename (trailing slash)', () => {
    expect(resolveMediaPath('/some/path/')).toBeNull();
  });
});

describe('toStoredMediaPath', () => {
  it('returns null for null input', () => {
    expect(toStoredMediaPath(null)).toBeNull();
  });

  it('returns null for undefined input', () => {
    expect(toStoredMediaPath(undefined)).toBeNull();
  });

  it('converts absolute path to relative', () => {
    expect(toStoredMediaPath('/tmp/test-docs/media/abc.jpg')).toBe('media/abc.jpg');
  });

  it('normalizes already-relative path', () => {
    expect(toStoredMediaPath('media/abc.jpg')).toBe('media/abc.jpg');
  });

  it('handles deep absolute paths', () => {
    expect(toStoredMediaPath('/var/mobile/Containers/foo/bar/media/xyz.png')).toBe('media/xyz.png');
  });

  it('returns null for empty string', () => {
    expect(toStoredMediaPath('')).toBeNull();
  });
});
