/**
 * Tests for normalizeMediaPaths — idempotent boot-time path normalization.
 */

jest.mock('@dr.pogodin/react-native-fs', () => ({
  DocumentDirectoryPath: '/tmp/test-docs',
}));

const mockIsDatabaseInitialized = jest.fn(() => true);
jest.mock('../connection', () => ({
  isDatabaseInitialized: () => mockIsDatabaseInitialized(),
}));

const mockQueryMany = jest.fn();
const mockExecute = jest.fn();
jest.mock('../queryHelpers', () => ({
  queryMany: (...args: unknown[]) => mockQueryMany(...args),
  execute: (...args: unknown[]) => mockExecute(...args),
}));

import { normalizeLegacyMediaPaths } from '../migrations/normalizeMediaPaths';

beforeEach(() => {
  jest.clearAllMocks();
  mockIsDatabaseInitialized.mockReturnValue(true);
});

describe('normalizeLegacyMediaPaths', () => {
  it('no-op when database is not initialized', () => {
    mockIsDatabaseInitialized.mockReturnValue(false);
    normalizeLegacyMediaPaths();
    expect(mockQueryMany).not.toHaveBeenCalled();
  });

  it('no-op when no absolute paths exist', () => {
    mockQueryMany.mockReturnValue([]);
    normalizeLegacyMediaPaths();
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('normalizes absolute local_path to relative', () => {
    mockQueryMany.mockReturnValue([
      { id: 'media-1', local_path: '/var/mobile/UUID/Documents/media/abc.jpg', thumbnail_path: null },
    ]);
    normalizeLegacyMediaPaths();
    expect(mockExecute).toHaveBeenCalledWith(
      'UPDATE orbital_media SET local_path = ?, thumbnail_path = ? WHERE id = ?',
      ['media/abc.jpg', null, 'media-1'],
    );
  });

  it('normalizes both local_path and thumbnail_path', () => {
    mockQueryMany.mockReturnValue([
      { id: 'media-2', local_path: '/old/path/media/file.jpg', thumbnail_path: '/old/path/media/thumb.jpg' },
    ]);
    normalizeLegacyMediaPaths();
    expect(mockExecute).toHaveBeenCalledWith(
      'UPDATE orbital_media SET local_path = ?, thumbnail_path = ? WHERE id = ?',
      ['media/file.jpg', 'media/thumb.jpg', 'media-2'],
    );
  });

  it('is idempotent — relative paths are not modified further', () => {
    mockQueryMany.mockReturnValue([]);
    normalizeLegacyMediaPaths();
    normalizeLegacyMediaPaths();
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('per-row resilience — one failed row does not block others', () => {
    mockQueryMany.mockReturnValue([
      { id: 'media-1', local_path: '/old/media/a.jpg', thumbnail_path: null },
      { id: 'media-2', local_path: '/old/media/b.jpg', thumbnail_path: null },
    ]);
    mockExecute.mockImplementationOnce(() => { throw new Error('DB busy'); });
    // Should not throw, and should still process media-2
    normalizeLegacyMediaPaths();
    expect(mockExecute).toHaveBeenCalledTimes(2);
  });
});
