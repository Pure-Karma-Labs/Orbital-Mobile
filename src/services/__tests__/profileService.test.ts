/**
 * Tests for profileService — display name, avatar upload, avatar removal.
 */

jest.mock('../api/users', () => ({
  updateDisplayName: jest.fn(),
  uploadAvatar: jest.fn(),
  deleteAvatar: jest.fn(),
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
import { updateDisplayName, uploadAvatar, deleteAvatar } from '../api/users';

const mockUpdateDisplayName = updateDisplayName as jest.Mock;
const mockUploadAvatar = uploadAvatar as jest.Mock;
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
  it('uploads and updates store on success', async () => {
    mockUploadAvatar.mockResolvedValue({ avatarUrl: '/avatars/new.jpg' });

    const result = await updateUserAvatar('file:///photo.jpg', 'image/jpeg');

    expect(mockUploadAvatar).toHaveBeenCalledTimes(1);
    expect(mockUpdateProfile).toHaveBeenCalledWith({ avatarPath: '/avatars/new.jpg' });
    expect(result).toBe('/avatars/new.jpg');
  });

  it('rejects unsupported MIME types', async () => {
    await expect(updateUserAvatar('file:///photo.heic', 'image/heic')).rejects.toThrow(
      'Unsupported image type',
    );
    expect(mockUploadAvatar).not.toHaveBeenCalled();
    expect(mockUpdateProfile).not.toHaveBeenCalled();
  });

  it('accepts image/png', async () => {
    mockUploadAvatar.mockResolvedValue({ avatarUrl: '/avatars/new.png' });

    await updateUserAvatar('file:///photo.png', 'image/png');

    const formData = mockUploadAvatar.mock.calls[0][0] as FormData;
    expect(formData).toBeInstanceOf(FormData);
  });

  it('accepts image/gif', async () => {
    mockUploadAvatar.mockResolvedValue({ avatarUrl: '/avatars/new.gif' });

    await updateUserAvatar('file:///photo.gif', 'image/gif');
    expect(mockUploadAvatar).toHaveBeenCalledTimes(1);
  });

  it('accepts image/webp', async () => {
    mockUploadAvatar.mockResolvedValue({ avatarUrl: '/avatars/new.webp' });

    await updateUserAvatar('file:///photo.webp', 'image/webp');
    expect(mockUploadAvatar).toHaveBeenCalledTimes(1);
  });

  it('does not update store on upload failure', async () => {
    mockUploadAvatar.mockRejectedValue(new Error('Upload failed'));

    await expect(updateUserAvatar('file:///photo.jpg', 'image/jpeg')).rejects.toThrow(
      'Upload failed',
    );
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
