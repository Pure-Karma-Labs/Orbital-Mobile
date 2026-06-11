/**
 * Tests for avatarService — encrypted avatar upload, download, caching, and invalidation.
 */

// ---------------------------------------------------------------------------
// Module mocks — must be declared before imports
// ---------------------------------------------------------------------------

jest.mock('@dr.pogodin/react-native-fs');

const mockGenerateAttachmentKeys = jest.fn();
const mockEncryptAttachment = jest.fn();
const mockDecryptAttachment = jest.fn();

jest.mock('../crypto/attachmentCrypto', () => ({
  generateAttachmentKeys: (...args: unknown[]) => mockGenerateAttachmentKeys(...args),
  encryptAttachment: (...args: unknown[]) => mockEncryptAttachment(...args),
  decryptAttachment: (...args: unknown[]) => mockDecryptAttachment(...args),
}));

const mockGetOrFetchGroupKey = jest.fn();
const mockEncryptContent = jest.fn();
const mockDecryptContent = jest.fn();

jest.mock('../crypto/contentCrypto', () => ({
  PendingWrapError: class PendingWrapError extends Error {
    constructor() {
      super('Group key not yet available (pending wrap)');
      this.name = 'PendingWrapError';
    }
  },
  getOrFetchGroupKey: (...args: unknown[]) => mockGetOrFetchGroupKey(...args),
  encryptContent: (...args: unknown[]) => mockEncryptContent(...args),
  decryptContent: (...args: unknown[]) => mockDecryptContent(...args),
}));

jest.mock('../crypto/utils', () => ({
  arrayBufferToBase64: jest.fn(() => 'mock-base64'),
  base64ToArrayBuffer: jest.fn(() => new ArrayBuffer(64)),
  toArrayBuffer: jest.fn((u8: Uint8Array) =>
    u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength),
  ),
}));

const mockRequest = jest.fn();
const mockRequestBinary = jest.fn();

jest.mock('../api/client', () => ({
  request: (...args: unknown[]) => mockRequest(...args),
  requestBinary: (...args: unknown[]) => mockRequestBinary(...args),
}));

const mockListGroups = jest.fn();

jest.mock('../api/groups', () => ({
  listGroups: (...args: unknown[]) => mockListGroups(...args),
}));

const mockSetItem = jest.fn();
const mockGetItem = jest.fn();

jest.mock('../../database/repositories/itemRepository', () => ({
  setItem: (...args: unknown[]) => mockSetItem(...args),
  getItem: (...args: unknown[]) => mockGetItem(...args),
}));

const mockUpdateProfile = jest.fn();

jest.mock('../../stores/useAppStore', () => ({
  useAppStore: {
    getState: jest.fn(() => ({
      userId: 'test-user-id',
      updateProfile: mockUpdateProfile,
      contacts: {},
      groups: {},
    })),
  },
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import {
  resolveAvatar,
  invalidateAvatarCache,
  clearAvatarCache,
  uploadEncryptedAvatar,
} from '../avatarService';
import {
  writeFile,
  exists,
  moveFile,
  unlink,
} from '@dr.pogodin/react-native-fs';
import { useAppStore } from '../../stores/useAppStore';

const mockExists = exists as jest.MockedFunction<typeof exists>;
const mockWriteFile = writeFile as jest.MockedFunction<typeof writeFile>;
const mockMoveFile = moveFile as jest.MockedFunction<typeof moveFile>;
const mockUnlink = unlink as jest.MockedFunction<typeof unlink>;


// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const fakeGroupKey = new Uint8Array(32).fill(0xab);
const fakePlaintext = new Uint8Array(80).fill(0xaa);
const fakeKeys = new Uint8Array(64).fill(0xee);
const fakeCiphertext = new Uint8Array(100).fill(0xcc);
const fakeDigest = new Uint8Array(32).fill(0xdd);

// ---------------------------------------------------------------------------
// Global mocks
// ---------------------------------------------------------------------------

const originalFetch = global.fetch;
const originalFormData = (global as Record<string, unknown>).FormData;

beforeEach(() => {
  jest.clearAllMocks();

  // Default: exists returns false (no cache dir, no cached files)
  mockExists.mockResolvedValue(false);

  // Default mocks for crypto
  mockGetOrFetchGroupKey.mockResolvedValue(fakeGroupKey);
  mockDecryptContent.mockReturnValue('fake-keys-base64');
  mockDecryptAttachment.mockReturnValue(fakePlaintext);

  // Default mock for binary download
  mockRequestBinary.mockResolvedValue({ data: fakeCiphertext.buffer });

  // Mock fetch for upload (reading image URI)
  global.fetch = jest.fn().mockResolvedValue({
    arrayBuffer: () => Promise.resolve(fakePlaintext.buffer),
  }) as unknown as typeof fetch;

  // Mock FormData
  (global as Record<string, unknown>).FormData = jest.fn().mockImplementation(() => ({
    append: jest.fn(),
  }));
});

afterAll(() => {
  global.fetch = originalFetch;
  (global as Record<string, unknown>).FormData = originalFormData;
});

// ---------------------------------------------------------------------------
// resolveAvatar
// ---------------------------------------------------------------------------

describe('resolveAvatar', () => {
  it('returns cached file URI when cache file exists', async () => {
    // First exists call: cache dir check → true
    // Second exists call: cache file check → true
    mockExists.mockResolvedValue(true);

    const result = await resolveAvatar(
      'other-user',
      'digest-abc',
      'enc-key',
      'key-iv',
      'group-1',
    );

    expect(result).toMatch(/^file:\/\//);
    expect(result).toContain('other-user');
    // Should NOT call requestBinary since cache hit
    expect(mockRequestBinary).not.toHaveBeenCalled();
  });

  it('downloads and decrypts avatar on cache miss (other user)', async () => {
    // First exists call (dir check) → false (triggers mkdir)
    // Second exists call (file check) → false (triggers download)
    mockExists.mockResolvedValue(false);

    const result = await resolveAvatar(
      'other-user',
      'digest-abc',
      'enc-key',
      'key-iv',
      'group-1',
    );

    expect(result).toMatch(/^file:\/\//);
    expect(mockGetOrFetchGroupKey).toHaveBeenCalledWith('group-1');
    expect(mockDecryptContent).toHaveBeenCalledWith(
      'enc-key',
      'key-iv',
      fakeGroupKey,
      'group-1:other-user',
    );
    expect(mockRequestBinary).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'GET',
        path: '/api/users/other-user/avatar-file',
      }),
    );
    expect(mockDecryptAttachment).toHaveBeenCalled();
    // Atomic write: writeFile to tmp, then moveFile
    expect(mockWriteFile).toHaveBeenCalled();
    expect(mockMoveFile).toHaveBeenCalled();
  });

  it('uses stored attachment key for own avatar (no decryptContent)', async () => {
    mockExists.mockResolvedValue(false);
    mockGetItem.mockReturnValue('own-keys-base64');
    (useAppStore.getState as jest.Mock).mockReturnValue({
      userId: 'self-user',
      updateProfile: mockUpdateProfile,
      contacts: {},
      groups: {},
    });

    const result = await resolveAvatar(
      'self-user',
      'self-digest',
      null,
      null,
      null,
    );

    expect(result).toMatch(/^file:\/\//);
    expect(mockGetItem).toHaveBeenCalledWith('avatarAttachmentKey');
    // Should NOT call decryptContent for own avatar
    expect(mockDecryptContent).not.toHaveBeenCalled();
    expect(mockRequestBinary).toHaveBeenCalled();
  });

  it('returns null when encryptedKey is missing for other user', async () => {
    mockExists.mockResolvedValue(false);

    const result = await resolveAvatar(
      'other-user',
      'digest-abc',
      null,
      null,
      null,
    );

    expect(result).toBeNull();
    expect(mockRequestBinary).not.toHaveBeenCalled();
  });

  it('returns null when decryptContent throws', async () => {
    mockExists.mockResolvedValue(false);
    mockDecryptContent.mockImplementation(() => {
      throw new Error('AES-GCM auth failed');
    });

    const result = await resolveAvatar(
      'other-user',
      'digest-abc',
      'enc-key',
      'key-iv',
      'group-1',
    );

    expect(result).toBeNull();
  });

  it('returns null when requestBinary throws', async () => {
    mockExists.mockResolvedValue(false);
    mockRequestBinary.mockRejectedValue(new Error('network'));

    const result = await resolveAvatar(
      'other-user',
      'digest-abc',
      'enc-key',
      'key-iv',
      'group-1',
    );

    expect(result).toBeNull();
  });

  it('deduplicates inflight requests for same userId:digest', async () => {
    mockExists.mockResolvedValue(false);

    const promise1 = resolveAvatar('user-x', 'digest-1', 'ek', 'iv', 'g1');
    const promise2 = resolveAvatar('user-x', 'digest-1', 'ek', 'iv', 'g1');

    const [result1, result2] = await Promise.all([promise1, promise2]);

    expect(result1).toBe(result2);
    expect(mockRequestBinary).toHaveBeenCalledTimes(1);
  });

  it('returns null when own avatar key is not stored', async () => {
    mockExists.mockResolvedValue(false);
    mockGetItem.mockReturnValue(null);
    (useAppStore.getState as jest.Mock).mockReturnValue({
      userId: 'self-user',
      updateProfile: mockUpdateProfile,
      contacts: {},
      groups: {},
    });

    const result = await resolveAvatar(
      'self-user',
      'self-digest',
      null,
      null,
      null,
    );

    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// invalidateAvatarCache
// ---------------------------------------------------------------------------

describe('invalidateAvatarCache', () => {
  it('completes without error when cache dir exists', async () => {
    mockExists.mockResolvedValue(true);

    await expect(invalidateAvatarCache('user123')).resolves.toBeUndefined();
  });

  it('checks cache dir existence before proceeding', async () => {
    mockExists.mockResolvedValue(true);

    await invalidateAvatarCache('user123');

    expect(mockExists).toHaveBeenCalled();
  });

  it('does nothing when cache dir does not exist', async () => {
    mockExists.mockResolvedValue(false);

    await invalidateAvatarCache('user123');

    expect(mockUnlink).not.toHaveBeenCalled();
  });

  it('swallows errors without throwing', async () => {
    mockExists.mockRejectedValue(new Error('fs error'));

    await expect(invalidateAvatarCache('user123')).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// clearAvatarCache
// ---------------------------------------------------------------------------

describe('clearAvatarCache', () => {
  it('completes without error when cache dir exists', async () => {
    mockExists.mockResolvedValue(true);

    await expect(clearAvatarCache()).resolves.toBeUndefined();
  });

  it('handles missing cache directory gracefully', async () => {
    mockExists.mockResolvedValue(false);

    await expect(clearAvatarCache()).resolves.toBeUndefined();
    expect(mockUnlink).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// uploadEncryptedAvatar
// ---------------------------------------------------------------------------

describe('uploadEncryptedAvatar', () => {
  beforeEach(() => {
    (useAppStore.getState as jest.Mock).mockReturnValue({
      userId: 'test-user-id',
      updateProfile: mockUpdateProfile,
      contacts: {},
      groups: {},
    });

    mockGenerateAttachmentKeys.mockReturnValue({
      keys: fakeKeys,
      keysBase64: 'fake-keys-base64',
    });
    mockEncryptAttachment.mockReturnValue({
      ciphertext: fakeCiphertext,
      digest: fakeDigest,
    });
    mockEncryptContent.mockReturnValue({
      ciphertext: 'encrypted-key-ct',
      iv: 'encrypted-key-iv',
    });
    mockListGroups.mockResolvedValue([
      { groupId: 'g1', memberCount: 3 },
      { groupId: 'g2', memberCount: 2 },
    ]);
    mockRequest.mockResolvedValue({
      avatarUrl: '/avatars/new-avatar.enc',
      updatedAt: '2026-06-01T00:00:00Z',
    });
  });

  it('encrypts, wraps keys per group, uploads, stores key, and updates profile', async () => {
    const result = await uploadEncryptedAvatar('file:///photo.jpg', 'image/jpeg');

    expect(result).toBe('/avatars/new-avatar.enc');

    // Key generation
    expect(mockGenerateAttachmentKeys).toHaveBeenCalled();
    // Encryption
    expect(mockEncryptAttachment).toHaveBeenCalled();
    // Per-group key wrapping
    expect(mockGetOrFetchGroupKey).toHaveBeenCalledTimes(2);
    expect(mockEncryptContent).toHaveBeenCalledTimes(2);
    // Upload
    expect(mockRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'POST',
        path: '/api/users/avatar',
      }),
    );
    // Key persistence
    expect(mockSetItem).toHaveBeenCalledWith('avatarAttachmentKey', 'fake-keys-base64');
    // Profile update
    expect(mockUpdateProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        avatarPath: '/avatars/new-avatar.enc',
      }),
    );
  });

  it('throws when userId is null', async () => {
    (useAppStore.getState as jest.Mock).mockReturnValue({
      userId: null,
      updateProfile: mockUpdateProfile,
      contacts: {},
      groups: {},
    });

    await expect(
      uploadEncryptedAvatar('file:///photo.jpg', 'image/jpeg'),
    ).rejects.toThrow('Not authenticated');
  });

  it('throws when no group keys are available', async () => {
    mockGetOrFetchGroupKey.mockRejectedValue(new Error('no key'));

    await expect(
      uploadEncryptedAvatar('file:///photo.jpg', 'image/jpeg'),
    ).rejects.toThrow('no group keys available');
  });

  it('cleans up temp file on upload failure', async () => {
    mockRequest.mockRejectedValue(new Error('upload failed'));

    await expect(
      uploadEncryptedAvatar('file:///photo.jpg', 'image/jpeg'),
    ).rejects.toThrow('upload failed');

    // Temp file should be cleaned up in the finally block
    expect(mockUnlink).toHaveBeenCalledWith(
      expect.stringContaining('avatar-upload-'),
    );
  });
});
