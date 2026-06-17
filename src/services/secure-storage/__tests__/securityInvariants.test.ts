/**
 * Security invariant tests — verify that cryptographic and storage
 * primitives enforce the correct security properties.
 */

// ---------------------------------------------------------------------------
// a) Keychain accessibility level invariant
// ---------------------------------------------------------------------------

jest.mock('react-native-keychain', () => ({
  setGenericPassword: jest.fn().mockResolvedValue(true),
  getGenericPassword: jest.fn().mockResolvedValue(false),
  resetGenericPassword: jest.fn().mockResolvedValue(true),
  ACCESSIBLE: { AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 'AfterFirstUnlockThisDeviceOnly' },
  ACCESS_CONTROL: { BIOMETRY_ANY: 'BiometryAny' },
}));

jest.mock('react-native', () => ({
  Platform: { OS: 'ios' },
}));

import * as Keychain from 'react-native-keychain';
import { setSecureItem } from '../secureStorage';

const mockKeychain = Keychain as jest.Mocked<typeof Keychain>;

describe('Keychain accessibility invariant', () => {
  beforeEach(() => jest.clearAllMocks());

  it('setSecureItem uses AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY', async () => {
    await setSecureItem('test.key', 'test-value');
    expect(mockKeychain.setGenericPassword).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.objectContaining({
        accessible: Keychain.ACCESSIBLE.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// b) ECIES downgrade-rejection invariant
// ---------------------------------------------------------------------------

jest.mock('orbital-signal', () => ({
  aesGcmEncrypt: jest.fn(),
  aesGcmDecrypt: jest.fn(),
  eciesSeal: jest.fn(() => new ArrayBuffer(190)),
  eciesOpen: jest.fn(() => new ArrayBuffer(32)),
}));

jest.mock('../../../database/repositories/conversationRepository', () => ({
  getGroupMasterKey: jest.fn(),
  setGroupMasterKey: jest.fn(),
  clearGroupMasterKey: jest.fn(),
}));

jest.mock('../../../database/repositories/itemRepository', () => ({
  getItem: jest.fn(() => '05' + 'aa'.repeat(32)),
  setItem: jest.fn(),
  getAllItems: jest.fn(() => []),
}));

jest.mock('../../crypto/keyGenerationService', () => ({
  getCachedIdentityPrivateKeyHex: jest.fn(() => 'bb'.repeat(32)),
}));

const mockResolveRemoteIdentityKey = jest.fn();
jest.mock('../../crypto/identityKeyAccess', () => ({
  getIdentityKeyPair: jest.fn(() => ({
    privateKey: new ArrayBuffer(32),
    publicKey: new ArrayBuffer(33),
  })),
  resolveRemoteIdentityKey: (...args: unknown[]) => mockResolveRemoteIdentityKey(...args),
}));

jest.mock('../../../database/repositories/signalIdentityKeyRepository', () => ({
  getIdentityKey: jest.fn(),
  saveIdentityKey: jest.fn(),
}));

jest.mock('../../../stores/useAppStore', () => ({
  useAppStore: {
    getState: jest.fn(() => ({ userId: 'test-self-user' })),
  },
}));

// Must be imported after mocks are set up
const { processReceivedGroupKey } = require('../../crypto/contentCrypto');
const { arrayBufferToBase64 } = require('../../crypto/utils');

describe('ECIES downgrade rejection invariant', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockResolveRemoteIdentityKey.mockResolvedValue(new ArrayBuffer(33));
    // Clear downgrade protection state between tests
    const { clearEciesLockState } = require('../../crypto/downgradeProtection');
    clearEciesLockState();
  });

  it('rejects raw key after ECIES envelope locks a group', async () => {
    // Step 1: Process an ECIES envelope — this locks the group
    const envelope = new Uint8Array(190);
    envelope[0] = 0x02;
    const envelopeB64 = arrayBufferToBase64(envelope.buffer);
    await processReceivedGroupKey('downgrade-test-group', envelopeB64, 'sender-user');

    // Step 2: Attempt a raw 32-byte key for the same group — must reject
    const raw = new Uint8Array(32);
    const rawB64 = arrayBufferToBase64(raw.buffer);

    await expect(
      processReceivedGroupKey('downgrade-test-group', rawB64, null),
    ).rejects.toThrow('Downgrade rejected');
  });
});
