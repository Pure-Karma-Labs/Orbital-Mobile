/**
 * Tests for the shared id-level media teardown (#724).
 *
 * The one invariant worth a dedicated suite is ORDER: the DB row must be
 * deleted BEFORE the plaintext file is unlinked. Reversed, a mid-teardown
 * failure leaves a row whose file is gone, which cleanupOrphanedMedia's DB pass
 * re-arms as 'pending' — silently re-downloading the very frame the teardown
 * existed to destroy.
 */

jest.mock('@dr.pogodin/react-native-fs');

const mockDeleteMedia = jest.fn();

jest.mock('../../database/repositories/mediaRepository', () => ({
  deleteMedia: (...args: unknown[]) => mockDeleteMedia(...args),
}));

// `mock`-prefixed so the jest.mock factory may close over it.
const mockDbInitialized = { value: true };

jest.mock('../../database/connection', () => ({
  isDatabaseInitialized: () => mockDbInitialized.value,
}));

const mockRemoveMedia = jest.fn();

jest.mock('../../stores/useAppStore', () => ({
  useAppStore: {
    getState: jest.fn(() => ({ removeMedia: mockRemoveMedia })),
  },
}));

import { teardownLocalMedia } from '../media/mediaTeardown';

const rnfs = require('@dr.pogodin/react-native-fs');

beforeEach(() => {
  jest.clearAllMocks();
  mockDbInitialized.value = true;
  rnfs.unlink.mockResolvedValue(undefined);
});

describe('teardownLocalMedia', () => {
  it('deletes the row, then unlinks the file, then drops the store entry', async () => {
    await teardownLocalMedia('media-1', '/tmp/media/media-1.jpg');

    expect(mockDeleteMedia).toHaveBeenCalledWith('media-1');
    expect(rnfs.unlink).toHaveBeenCalledWith('/tmp/media/media-1.jpg');
    expect(mockRemoveMedia).toHaveBeenCalledWith('media-1');

    expect(mockDeleteMedia.mock.invocationCallOrder[0]).toBeLessThan(
      rnfs.unlink.mock.invocationCallOrder[0],
    );
  });

  it('skips the unlink when there is no local path', async () => {
    await teardownLocalMedia('media-2', null);

    expect(mockDeleteMedia).toHaveBeenCalledWith('media-2');
    expect(rnfs.unlink).not.toHaveBeenCalled();
    expect(mockRemoveMedia).toHaveBeenCalledWith('media-2');
  });

  it('skips the row delete when the database is not initialized', async () => {
    mockDbInitialized.value = false;

    await teardownLocalMedia('media-3', '/tmp/media/media-3.jpg');

    expect(mockDeleteMedia).not.toHaveBeenCalled();
    // The file and the store entry still go: a ghost row is recoverable,
    // a surviving plaintext frame is not.
    expect(rnfs.unlink).toHaveBeenCalledWith('/tmp/media/media-3.jpg');
    expect(mockRemoveMedia).toHaveBeenCalledWith('media-3');
  });

  it('still unlinks and clears the store when the row delete throws', async () => {
    mockDeleteMedia.mockImplementationOnce(() => {
      throw new Error('db locked');
    });

    await teardownLocalMedia('media-4', '/tmp/media/media-4.jpg');

    expect(rnfs.unlink).toHaveBeenCalledWith('/tmp/media/media-4.jpg');
    expect(mockRemoveMedia).toHaveBeenCalledWith('media-4');
  });

  it('swallows an unlink failure and still clears the store', async () => {
    rnfs.unlink.mockRejectedValueOnce(new Error('ENOENT'));

    await expect(
      teardownLocalMedia('media-5', '/tmp/media/media-5.jpg'),
    ).resolves.toBeUndefined();
    expect(mockRemoveMedia).toHaveBeenCalledWith('media-5');
  });
});
