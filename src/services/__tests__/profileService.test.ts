/**
 * Tests for profileService — display name, avatar upload, avatar removal.
 */

jest.mock('../api/users', () => ({
  updateDisplayName: jest.fn(),
  deleteAvatar: jest.fn(),
}));

const mockUploadEncryptedAvatar = jest.fn();
jest.mock('../avatarService', () => ({
  uploadEncryptedAvatar: (...args: unknown[]) => mockUploadEncryptedAvatar(...args),
}));

const mockUpdateProfile = jest.fn();

jest.mock('../../stores/useAppStore', () => ({
  useAppStore: {
    getState: jest.fn(() => ({
      updateProfile: mockUpdateProfile,
    })),
  },
}));

import {
  updateUserDisplayName,
  updateUserAvatar,
  removeUserAvatar,
} from '../profileService';
import { updateDisplayName, deleteAvatar } from '../api/users';

const mockUpdateDisplayName = updateDisplayName as jest.Mock;
const mockDeleteAvatar = deleteAvatar as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
});

describe('updateUserDisplayName', () => {
  it('calls API and updates store', async () => {
    mockUpdateDisplayName.mockResolvedValue({ displayName: 'New Name' });

    await updateUserDisplayName('New Name');

    expect(mockUpdateDisplayName).toHaveBeenCalledWith('New Name');
    expect(mockUpdateProfile).toHaveBeenCalledWith({ displayName: 'New Name' });
  });

  it('does not update store on API failure', async () => {
    mockUpdateDisplayName.mockRejectedValue(new Error('Server error'));

    await expect(updateUserDisplayName('Fail')).rejects.toThrow('Server error');
    expect(mockUpdateProfile).not.toHaveBeenCalled();
  });
});

describe('updateUserAvatar', () => {
  it('delegates to uploadEncryptedAvatar and returns the URL', async () => {
    mockUploadEncryptedAvatar.mockResolvedValue('/avatars/new.jpg');

    const result = await updateUserAvatar('file:///photo.jpg', 'image/jpeg');

    expect(mockUploadEncryptedAvatar).toHaveBeenCalledWith('file:///photo.jpg', 'image/jpeg');
    expect(result).toBe('/avatars/new.jpg');
  });

  it('accepts any MIME type (encrypted upload is format-agnostic)', async () => {
    mockUploadEncryptedAvatar.mockResolvedValueOnce('/avatars/test.enc');
    await updateUserAvatar('file:///photo.heic', 'image/heic');
    expect(mockUploadEncryptedAvatar).toHaveBeenCalledWith('file:///photo.heic', 'image/heic');
  });

  it('accepts image/png', async () => {
    mockUploadEncryptedAvatar.mockResolvedValue('/avatars/new.png');

    await updateUserAvatar('file:///photo.png', 'image/png');

    expect(mockUploadEncryptedAvatar).toHaveBeenCalledWith('file:///photo.png', 'image/png');
  });

  it('accepts image/gif', async () => {
    mockUploadEncryptedAvatar.mockResolvedValue('/avatars/new.gif');

    await updateUserAvatar('file:///photo.gif', 'image/gif');
    expect(mockUploadEncryptedAvatar).toHaveBeenCalledTimes(1);
  });

  it('accepts image/webp', async () => {
    mockUploadEncryptedAvatar.mockResolvedValue('/avatars/new.webp');

    await updateUserAvatar('file:///photo.webp', 'image/webp');
    expect(mockUploadEncryptedAvatar).toHaveBeenCalledTimes(1);
  });

  it('does not update store on upload failure', async () => {
    mockUploadEncryptedAvatar.mockRejectedValue(new Error('Upload failed'));

    await expect(updateUserAvatar('file:///photo.jpg', 'image/jpeg')).rejects.toThrow(
      'Upload failed',
    );
    // Store update happens inside avatarService (mocked), so updateProfile is not called
    expect(mockUpdateProfile).not.toHaveBeenCalled();
  });
});

describe('removeUserAvatar', () => {
  it('calls API and clears store', async () => {
    mockDeleteAvatar.mockResolvedValue(undefined);

    await removeUserAvatar();

    expect(mockDeleteAvatar).toHaveBeenCalledTimes(1);
    expect(mockUpdateProfile).toHaveBeenCalledWith({ avatarPath: null });
  });

  it('does not update store on API failure', async () => {
    mockDeleteAvatar.mockRejectedValue(new Error('Delete failed'));

    await expect(removeUserAvatar()).rejects.toThrow('Delete failed');
    expect(mockUpdateProfile).not.toHaveBeenCalled();
  });
});
