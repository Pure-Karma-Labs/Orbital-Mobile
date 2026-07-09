/* eslint-disable @typescript-eslint/no-require-imports */
jest.mock('../../../database/repositories/itemRepository', () => ({
  getItem: jest.fn(() => '05' + 'aa'.repeat(32)),
}));

jest.mock('../keyGenerationService', () => ({
  getCachedIdentityPrivateKeyHex: jest.fn(() => 'bb'.repeat(32)),
}));

const mockGetIdentityKey = jest.fn();
const mockSaveIdentityKey = jest.fn();
jest.mock('../../../database/repositories/signalIdentityKeyRepository', () => ({
  getIdentityKey: (...args: unknown[]) => mockGetIdentityKey(...args),
  saveIdentityKey: (...args: unknown[]) => mockSaveIdentityKey(...args),
}));

const mockFetchRemoteIdentityKeyBundle = jest.fn();
jest.mock('../../api/keys', () => ({
  fetchRemoteIdentityKeyBundle: (...args: unknown[]) => mockFetchRemoteIdentityKeyBundle(...args),
}));

import { resolveRemoteIdentityKey, getIdentityKeyPair, compareAndPersistIdentityKey, refreshAndCompareIdentityKey } from '../identityKeyAccess';
import { arrayBufferToBase64 } from '../utils';

beforeEach(() => {
  jest.clearAllMocks();
});

describe('resolveRemoteIdentityKey', () => {
  const selfUserId = 'self-user-id';

  it('returns own public key for self short-circuit', async () => {
    const result = await resolveRemoteIdentityKey(selfUserId, selfUserId);
    expect(result).toBeInstanceOf(ArrayBuffer);
    expect(mockGetIdentityKey).not.toHaveBeenCalled();
    expect(mockFetchRemoteIdentityKeyBundle).not.toHaveBeenCalled();
  });

  it('returns stored identity key from local DB', async () => {
    const storedKey = new Uint8Array(33);
    storedKey[0] = 0x05;
    mockGetIdentityKey.mockReturnValueOnce({
      address: 'remote-user',
      identity_key: storedKey,
      verified: 0,
      first_use: 1000,
      nonblocking_approval: 0,
    });

    const result = await resolveRemoteIdentityKey('remote-user', selfUserId);
    expect(result).toBeInstanceOf(ArrayBuffer);
    expect(new Uint8Array(result).length).toBe(33);
    expect(mockGetIdentityKey).toHaveBeenCalledWith('remote-user');
    expect(mockFetchRemoteIdentityKeyBundle).not.toHaveBeenCalled();
  });

  it('fetches via fetchRemoteIdentityKeyBundle when not in local DB', async () => {
    mockGetIdentityKey.mockReturnValueOnce(null);
    const bundleKey = new Uint8Array(33);
    bundleKey[0] = 0x05;
    bundleKey.fill(0xcc, 1);
    mockFetchRemoteIdentityKeyBundle.mockResolvedValueOnce({
      identityKey: arrayBufferToBase64(bundleKey.buffer),
    });

    const result = await resolveRemoteIdentityKey('new-user', selfUserId);
    expect(result).toBeInstanceOf(ArrayBuffer);
    expect(mockFetchRemoteIdentityKeyBundle).toHaveBeenCalledWith('new-user');
    expect(mockSaveIdentityKey).toHaveBeenCalledWith(
      expect.objectContaining({
        address: 'new-user',
        verified: 0,
      }),
    );
  });

  it('handles 32-byte key by prepending type prefix', async () => {
    mockGetIdentityKey.mockReturnValueOnce(null);
    const rawKey = new Uint8Array(32);
    rawKey.fill(0xdd);
    mockFetchRemoteIdentityKeyBundle.mockResolvedValueOnce({
      identityKey: arrayBufferToBase64(rawKey.buffer),
    });

    const result = await resolveRemoteIdentityKey('raw-key-user', selfUserId);
    const resultBytes = new Uint8Array(result);
    expect(resultBytes.length).toBe(33);
    expect(resultBytes[0]).toBe(0x05);
    expect(mockSaveIdentityKey).toHaveBeenCalled();
  });

  it('rejects invalid key lengths', async () => {
    mockGetIdentityKey.mockReturnValueOnce(null);
    const badKey = new Uint8Array(50);
    mockFetchRemoteIdentityKeyBundle.mockResolvedValueOnce({
      identityKey: arrayBufferToBase64(badKey.buffer),
    });

    await expect(
      resolveRemoteIdentityKey('bad-key-user', selfUserId),
    ).rejects.toThrow('Invalid identity key length');
    expect(mockSaveIdentityKey).not.toHaveBeenCalled();
  });

  it('coalesces concurrent calls for the same userId', async () => {
    mockGetIdentityKey.mockReturnValue(null);
    const bundleKey = new Uint8Array(33);
    bundleKey[0] = 0x05;
    mockFetchRemoteIdentityKeyBundle.mockResolvedValue({
      identityKey: arrayBufferToBase64(bundleKey.buffer),
    });

    const [r1, r2, r3] = await Promise.all([
      resolveRemoteIdentityKey('coalesce-user', selfUserId),
      resolveRemoteIdentityKey('coalesce-user', selfUserId),
      resolveRemoteIdentityKey('coalesce-user', selfUserId),
    ]);

    expect(mockFetchRemoteIdentityKeyBundle).toHaveBeenCalledTimes(1);
    expect(r1).toBe(r2);
    expect(r2).toBe(r3);
  });
});

describe('getIdentityKeyPair', () => {
  it('returns privateKey and publicKey as ArrayBuffers', () => {
    const pair = getIdentityKeyPair();
    expect(pair.privateKey).toBeInstanceOf(ArrayBuffer);
    expect(pair.publicKey).toBeInstanceOf(ArrayBuffer);
  });
});

// ---------------------------------------------------------------------------
// compareAndPersistIdentityKey — pure compare-and-persist core
// ---------------------------------------------------------------------------

describe('compareAndPersistIdentityKey', () => {
  it('returns identityChanged=false when stored key matches', () => {
    const keyBytes = new Uint8Array(33);
    keyBytes[0] = 0x05;
    keyBytes.fill(0xaa, 1);
    mockGetIdentityKey.mockReturnValueOnce({
      address: 'user-1',
      identity_key: keyBytes,
      verified: 0,
      first_use: 1000,
      nonblocking_approval: 0,
    });

    const result = compareAndPersistIdentityKey('user-1', keyBytes);

    expect(result.identityChanged).toBe(false);
    expect(result.publicKey).toBeInstanceOf(ArrayBuffer);
    expect(new Uint8Array(result.publicKey)).toEqual(keyBytes);
    // Should NOT save when unchanged
    expect(mockSaveIdentityKey).not.toHaveBeenCalled();
  });

  it('returns identityChanged=true and saves Unverified when stored key differs', () => {
    const oldKey = new Uint8Array(33);
    oldKey[0] = 0x05;
    oldKey.fill(0xaa, 1);
    mockGetIdentityKey.mockReturnValueOnce({
      address: 'user-2',
      identity_key: oldKey,
      verified: 0,
      first_use: 1000,
      nonblocking_approval: 0,
    });

    const newKey = new Uint8Array(33);
    newKey[0] = 0x05;
    newKey.fill(0xbb, 1);

    const result = compareAndPersistIdentityKey('user-2', newKey);

    expect(result.identityChanged).toBe(true);
    expect(new Uint8Array(result.publicKey)).toEqual(newKey);
    expect(mockSaveIdentityKey).toHaveBeenCalledWith(
      expect.objectContaining({
        address: 'user-2',
        verified: 2, // VerifiedStatus.Unverified
      }),
    );
  });

  it('returns identityChanged=false and saves Default for first-seen user', () => {
    mockGetIdentityKey.mockReturnValueOnce(null);

    const keyBytes = new Uint8Array(33);
    keyBytes[0] = 0x05;
    keyBytes.fill(0xcc, 1);

    const result = compareAndPersistIdentityKey('new-user', keyBytes);

    expect(result.identityChanged).toBe(false);
    expect(new Uint8Array(result.publicKey)).toEqual(keyBytes);
    expect(mockSaveIdentityKey).toHaveBeenCalledWith(
      expect.objectContaining({
        address: 'new-user',
        verified: 0, // VerifiedStatus.Default
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// refreshAndCompareIdentityKey — delegates to compareAndPersistIdentityKey
// ---------------------------------------------------------------------------

describe('refreshAndCompareIdentityKey', () => {
  const selfUserId = 'self-user-id';

  it('returns own key for self with identityChanged=false', async () => {
    const result = await refreshAndCompareIdentityKey(selfUserId, selfUserId);
    expect(result.publicKey).toBeInstanceOf(ArrayBuffer);
    expect(result.identityChanged).toBe(false);
    expect(mockFetchRemoteIdentityKeyBundle).not.toHaveBeenCalled();
  });

  it('fetches remote key and delegates to compare logic', async () => {
    const remoteKey = new Uint8Array(33);
    remoteKey[0] = 0x05;
    remoteKey.fill(0xdd, 1);
    mockFetchRemoteIdentityKeyBundle.mockResolvedValueOnce({
      identityKey: arrayBufferToBase64(remoteKey.buffer),
    });
    // First-seen user
    mockGetIdentityKey.mockReturnValueOnce(null);

    const result = await refreshAndCompareIdentityKey('remote-user', selfUserId);

    expect(mockFetchRemoteIdentityKeyBundle).toHaveBeenCalledWith('remote-user');
    expect(result.identityChanged).toBe(false);
    expect(mockSaveIdentityKey).toHaveBeenCalledWith(
      expect.objectContaining({
        address: 'remote-user',
        verified: 0,
      }),
    );
  });

  it('detects key change via delegated compare logic', async () => {
    const oldKey = new Uint8Array(33);
    oldKey[0] = 0x05;
    oldKey.fill(0xaa, 1);
    mockGetIdentityKey.mockReturnValueOnce({
      address: 'changed-user',
      identity_key: oldKey,
      verified: 0,
      first_use: 1000,
      nonblocking_approval: 0,
    });

    const newKey = new Uint8Array(33);
    newKey[0] = 0x05;
    newKey.fill(0xbb, 1);
    mockFetchRemoteIdentityKeyBundle.mockResolvedValueOnce({
      identityKey: arrayBufferToBase64(newKey.buffer),
    });

    const result = await refreshAndCompareIdentityKey('changed-user', selfUserId);

    expect(result.identityChanged).toBe(true);
    expect(mockSaveIdentityKey).toHaveBeenCalledWith(
      expect.objectContaining({
        address: 'changed-user',
        verified: 2, // Unverified
      }),
    );
  });
});
