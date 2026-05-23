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

const mockGetPreKeyBundle = jest.fn();
jest.mock('../../api/keys', () => ({
  getPreKeyBundle: (...args: unknown[]) => mockGetPreKeyBundle(...args),
}));

import { resolveRemoteIdentityKey, getIdentityKeyPair } from '../identityKeyAccess';
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
    expect(mockGetPreKeyBundle).not.toHaveBeenCalled();
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
    expect(mockGetPreKeyBundle).not.toHaveBeenCalled();
  });

  it('fetches via getPreKeyBundle when not in local DB', async () => {
    mockGetIdentityKey.mockReturnValueOnce(null);
    const bundleKey = new Uint8Array(33);
    bundleKey[0] = 0x05;
    bundleKey.fill(0xcc, 1);
    mockGetPreKeyBundle.mockResolvedValueOnce({
      identityKey: arrayBufferToBase64(bundleKey.buffer),
      registrationId: 1,
      deviceId: 1,
      signedPreKey: { keyId: 1, publicKey: '', signature: '' },
      preKey: null,
      kyberPreKey: null,
    });

    const result = await resolveRemoteIdentityKey('new-user', selfUserId);
    expect(result).toBeInstanceOf(ArrayBuffer);
    expect(mockGetPreKeyBundle).toHaveBeenCalledWith('new-user');
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
    mockGetPreKeyBundle.mockResolvedValueOnce({
      identityKey: arrayBufferToBase64(rawKey.buffer),
      registrationId: 1,
      deviceId: 1,
      signedPreKey: { keyId: 1, publicKey: '', signature: '' },
      preKey: null,
      kyberPreKey: null,
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
    mockGetPreKeyBundle.mockResolvedValueOnce({
      identityKey: arrayBufferToBase64(badKey.buffer),
      registrationId: 1,
      deviceId: 1,
      signedPreKey: { keyId: 1, publicKey: '', signature: '' },
      preKey: null,
      kyberPreKey: null,
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
    mockGetPreKeyBundle.mockResolvedValue({
      identityKey: arrayBufferToBase64(bundleKey.buffer),
      registrationId: 1,
      deviceId: 1,
      signedPreKey: { keyId: 1, publicKey: '', signature: '' },
      preKey: null,
      kyberPreKey: null,
    });

    const [r1, r2, r3] = await Promise.all([
      resolveRemoteIdentityKey('coalesce-user', selfUserId),
      resolveRemoteIdentityKey('coalesce-user', selfUserId),
      resolveRemoteIdentityKey('coalesce-user', selfUserId),
    ]);

    expect(mockGetPreKeyBundle).toHaveBeenCalledTimes(1);
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
