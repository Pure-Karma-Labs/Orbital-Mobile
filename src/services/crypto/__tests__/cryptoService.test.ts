jest.mock('orbital-signal', () => ({
  signalEncrypt: jest.fn(),
  signalDecrypt: jest.fn(),
  signalDecryptPreKey: jest.fn(),
  processPreKeyBundle: jest.fn(),
  parsePrekeyMessageIds: jest.fn(),
  groupEncrypt: jest.fn(),
  groupDecrypt: jest.fn(),
  createSenderKeyDistributionMessage: jest.fn(),
  processSenderKeyDistributionMessage: jest.fn(),
}));

jest.mock('../../../database/repositories/itemRepository', () => ({
  getItem: jest.fn(),
}));

jest.mock('../../../database/repositories/signalSessionRepository', () => ({
  getSession: jest.fn(),
  saveSession: jest.fn(),
}));

jest.mock('../../../database/repositories/signalPreKeyRepository', () => ({
  getPreKey: jest.fn(),
  removePreKey: jest.fn(),
}));

jest.mock('../../../database/repositories/signalSignedPreKeyRepository', () => ({
  getSignedPreKey: jest.fn(),
}));

jest.mock('../../../database/repositories/signalKyberPreKeyRepository', () => ({
  getKyberPreKey: jest.fn(),
  markKyberPreKeyUsed: jest.fn(),
}));

jest.mock('../../../database/repositories/signalIdentityKeyRepository', () => ({
  getIdentityKey: jest.fn(),
  saveIdentityKey: jest.fn(),
}));

jest.mock('../../../database/repositories/signalSenderKeyRepository', () => ({
  getSenderKey: jest.fn(),
  saveSenderKey: jest.fn(),
}));

jest.mock('../../../database/connection', () => ({
  getDatabase: jest.fn(),
}));

jest.mock('../../api/keys', () => ({
  getPreKeyBundle: jest.fn(),
}));

const mockGetCachedPrivateKey = jest.fn();
jest.mock('../keyGenerationService', () => ({
  getCachedIdentityPrivateKeyHex: (...args: unknown[]) => mockGetCachedPrivateKey(...args),
}));

const mockGetState = jest.fn(() => ({ userId: 'local-user-id' }));
jest.mock('../../../stores/useAppStore', () => ({
  useAppStore: {
    getState: () => mockGetState(),
  },
}));

import {
  signalEncrypt,
  signalDecrypt,
  signalDecryptPreKey,
  processPreKeyBundle,
  parsePrekeyMessageIds,
  groupEncrypt,
  groupDecrypt,
  createSenderKeyDistributionMessage,
  processSenderKeyDistributionMessage,
} from 'orbital-signal';
import { getItem } from '../../../database/repositories/itemRepository';
import {
  getSession,
  saveSession,
} from '../../../database/repositories/signalSessionRepository';
import {
  getPreKey,
  removePreKey,
} from '../../../database/repositories/signalPreKeyRepository';
import { getSignedPreKey } from '../../../database/repositories/signalSignedPreKeyRepository';
import {
  getKyberPreKey,
  markKyberPreKeyUsed,
} from '../../../database/repositories/signalKyberPreKeyRepository';
import {
  getIdentityKey,
  saveIdentityKey,
} from '../../../database/repositories/signalIdentityKeyRepository';
import {
  getSenderKey,
  saveSenderKey,
} from '../../../database/repositories/signalSenderKeyRepository';
import { getDatabase } from '../../../database/connection';
import { getPreKeyBundle } from '../../api/keys';

import {
  encrypt,
  decrypt,
  encryptGroup,
  decryptGroup,
  createSenderKeyDistribution,
  processSenderKeyDistribution,
  EnvelopeType,
} from '../cryptoService';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeArrayBuffer(size: number, fill = 0xab): ArrayBuffer {
  const buf = new ArrayBuffer(size);
  new Uint8Array(buf).fill(fill);
  return buf;
}

function makeUint8Array(size: number, fill = 0xab): Uint8Array {
  const arr = new Uint8Array(size);
  arr.fill(fill);
  return arr;
}

const IDENTITY_PUBLIC_HEX = '01'.repeat(33);
const IDENTITY_PRIVATE_HEX = '02'.repeat(32);

const mockDb = { executeSync: jest.fn() };

const mockAddress = { name: 'recipient-uuid', deviceId: 1 };

function setupDefaultMocks(): void {
  mockGetState.mockReturnValue({ userId: 'local-user-id' });
  (getDatabase as jest.Mock).mockReturnValue(mockDb);
  mockDb.executeSync.mockReturnValue(undefined);

  mockGetCachedPrivateKey.mockReturnValue(IDENTITY_PRIVATE_HEX);

  (getItem as jest.Mock).mockImplementation((key: string) => {
    if (key === 'identityKeyPublic') return IDENTITY_PUBLIC_HEX;
    if (key === 'registrationId') return '12345';
    return null;
  });

  (signalEncrypt as jest.Mock).mockResolvedValue({
    ciphertext: {
      messageType: 'Whisper',
      serialized: makeArrayBuffer(64, 0x10),
    },
    updatedSessionRecord: makeArrayBuffer(128, 0x11),
  });

  (signalDecrypt as jest.Mock).mockResolvedValue({
    plaintext: makeArrayBuffer(16, 0x20),
    updatedSessionRecord: makeArrayBuffer(128, 0x21),
  });

  (signalDecryptPreKey as jest.Mock).mockResolvedValue({
    plaintext: makeArrayBuffer(16, 0x30),
    updatedSessionRecord: makeArrayBuffer(128, 0x31),
    senderIdentityKey: makeArrayBuffer(33, 0x32),
    identityChanged: false,
    consumedPreKeyId: 42,
    consumedKyberPreKeyId: 101,
  });

  (processPreKeyBundle as jest.Mock).mockResolvedValue({
    updatedSessionRecord: makeArrayBuffer(128, 0x40),
    identityKey: makeArrayBuffer(33, 0x41),
    identityChanged: false,
  });

  (parsePrekeyMessageIds as jest.Mock).mockResolvedValue({
    preKeyId: 42,
    signedPreKeyId: 1,
    kyberPreKeyId: 101,
  });

  (groupEncrypt as jest.Mock).mockResolvedValue({
    ciphertext: makeArrayBuffer(64, 0x50),
    updatedSenderKeyRecord: makeArrayBuffer(128, 0x51),
  });

  (groupDecrypt as jest.Mock).mockResolvedValue({
    plaintext: makeArrayBuffer(16, 0x60),
    updatedSenderKeyRecord: makeArrayBuffer(128, 0x61),
  });

  (createSenderKeyDistributionMessage as jest.Mock).mockResolvedValue({
    distributionMessage: makeArrayBuffer(64, 0x70),
    updatedSenderKeyRecord: makeArrayBuffer(128, 0x71),
  });

  (processSenderKeyDistributionMessage as jest.Mock).mockResolvedValue({
    updatedSenderKeyRecord: makeArrayBuffer(128, 0x81),
  });

  (getPreKeyBundle as jest.Mock).mockResolvedValue({
    registrationId: 99,
    deviceId: 1,
    identityKey: 'AQID',
    signedPreKey: { keyId: 1, publicKey: 'BQYH', signature: 'CAQK' },
    preKey: { keyId: 42, publicKey: 'DAMF' },
    kyberPreKey: { keyId: 101, publicKey: 'EAYG', signature: 'FgcJ' },
  });
}

beforeEach(() => {
  jest.resetAllMocks();
  setupDefaultMocks();
});

// ---------------------------------------------------------------------------
// encrypt
// ---------------------------------------------------------------------------

describe('encrypt', () => {
  it('encrypts with existing session and writes updated session in transaction', async () => {
    (getSession as jest.Mock).mockReturnValue({
      record: makeUint8Array(128, 0x99),
    });
    (getIdentityKey as jest.Mock).mockReturnValue({
      identity_key: makeUint8Array(33, 0x88),
    });

    const result = await encrypt(mockAddress, makeUint8Array(16, 0x01));

    expect(signalEncrypt).toHaveBeenCalledTimes(1);
    expect(result.messageType).toBe('Whisper');
    expect(mockDb.executeSync).toHaveBeenCalledWith('BEGIN IMMEDIATE');
    expect(mockDb.executeSync).toHaveBeenCalledWith('COMMIT');
    expect(saveSession).toHaveBeenCalledTimes(1);
  });

  it('auto-establishes session if none exists then encrypts', async () => {
    (getSession as jest.Mock)
      .mockReturnValueOnce(null) // first check: no session
      .mockReturnValue({ record: makeUint8Array(128, 0x40) }); // after establish
    (getIdentityKey as jest.Mock).mockReturnValue(null);

    await encrypt(mockAddress, makeUint8Array(16));

    expect(getPreKeyBundle).toHaveBeenCalledWith('recipient-uuid');
    expect(processPreKeyBundle).toHaveBeenCalledTimes(1);
    expect(signalEncrypt).toHaveBeenCalledTimes(1);
  });

  it('throws if identity keys are not initialized', async () => {
    (getItem as jest.Mock).mockReturnValue(null);
    mockGetCachedPrivateKey.mockReturnValue(null);

    await expect(encrypt(mockAddress, makeUint8Array(16))).rejects.toThrow(
      'Identity key pair not initialized',
    );
  });
});

// ---------------------------------------------------------------------------
// decrypt — type 1 (SignalMessage)
// ---------------------------------------------------------------------------

describe('decrypt type 1 (SignalMessage)', () => {
  it('decrypts and writes updated session in transaction', async () => {
    (getSession as jest.Mock).mockReturnValue({
      record: makeUint8Array(128, 0x99),
    });
    (getIdentityKey as jest.Mock).mockReturnValue({
      identity_key: makeUint8Array(33, 0x88),
    });

    const plaintext = await decrypt(
      mockAddress,
      makeUint8Array(64, 0x10),
      EnvelopeType.CIPHERTEXT,
    );

    expect(signalDecrypt).toHaveBeenCalledTimes(1);
    expect(plaintext).toBeInstanceOf(Uint8Array);
    expect(mockDb.executeSync).toHaveBeenCalledWith('BEGIN IMMEDIATE');
    expect(mockDb.executeSync).toHaveBeenCalledWith('COMMIT');
    expect(saveSession).toHaveBeenCalledTimes(1);
  });

  it('throws when no session exists', async () => {
    (getSession as jest.Mock).mockReturnValue(null);

    await expect(
      decrypt(mockAddress, makeUint8Array(64), EnvelopeType.CIPHERTEXT),
    ).rejects.toThrow('No session found');
  });
});

// ---------------------------------------------------------------------------
// establishSession
// ---------------------------------------------------------------------------

describe('establishSession (via encrypt auto-establish)', () => {
  it('fetches bundle, processes it, saves session + identity, then encrypts', async () => {
    (getSession as jest.Mock)
      .mockReturnValueOnce(null)
      .mockReturnValue({ record: makeUint8Array(128, 0x40) });
    (getIdentityKey as jest.Mock).mockReturnValue(null);

    await encrypt(mockAddress, makeUint8Array(16));

    expect(getPreKeyBundle).toHaveBeenCalledWith('recipient-uuid');
    expect(processPreKeyBundle).toHaveBeenCalledTimes(1);
    expect(saveIdentityKey).toHaveBeenCalledTimes(1);
    expect(signalEncrypt).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Group operations
// ---------------------------------------------------------------------------

describe('encryptGroup', () => {
  it('encrypts and saves updated sender key', async () => {
    (getSenderKey as jest.Mock).mockReturnValue({
      record: makeUint8Array(128, 0x50),
    });

    const ciphertext = await encryptGroup(
      'dist-uuid',
      mockAddress,
      makeUint8Array(16),
    );

    expect(groupEncrypt).toHaveBeenCalledTimes(1);
    expect(ciphertext).toBeInstanceOf(Uint8Array);
    expect(saveSenderKey).toHaveBeenCalledTimes(1);
    expect(mockDb.executeSync).toHaveBeenCalledWith('BEGIN IMMEDIATE');
    expect(mockDb.executeSync).toHaveBeenCalledWith('COMMIT');
  });
});

describe('decryptGroup', () => {
  it('decrypts and saves updated sender key', async () => {
    (getSenderKey as jest.Mock).mockReturnValue({
      record: makeUint8Array(128, 0x60),
    });

    const plaintext = await decryptGroup(
      mockAddress,
      'dist-uuid',
      makeUint8Array(64),
    );

    expect(groupDecrypt).toHaveBeenCalledTimes(1);
    expect(plaintext).toBeInstanceOf(Uint8Array);
    expect(saveSenderKey).toHaveBeenCalledTimes(1);
  });
});

describe('createSenderKeyDistribution', () => {
  it('creates SKDM and saves sender key', async () => {
    (getSenderKey as jest.Mock).mockReturnValue(null);

    const msg = await createSenderKeyDistribution('dist-uuid', mockAddress);

    expect(createSenderKeyDistributionMessage).toHaveBeenCalledTimes(1);
    expect(msg).toBeInstanceOf(Uint8Array);
    expect(saveSenderKey).toHaveBeenCalledTimes(1);
  });
});

describe('processSenderKeyDistribution', () => {
  it('processes SKDM and saves sender key', async () => {
    (getSenderKey as jest.Mock).mockReturnValue(null);

    await processSenderKeyDistribution(
      mockAddress,
      'dist-uuid',
      makeUint8Array(64),
    );

    expect(processSenderKeyDistributionMessage).toHaveBeenCalledTimes(1);
    expect(saveSenderKey).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Group operations — null sender key
// ---------------------------------------------------------------------------

describe('group operations — null sender key', () => {
  it('encryptGroup passes undefined senderKeyRecord when getSenderKey returns null', async () => {
    (getSenderKey as jest.Mock).mockReturnValue(null);

    await encryptGroup('dist-uuid', mockAddress, makeUint8Array(16));

    expect(groupEncrypt).toHaveBeenCalledTimes(1);
    const input = (groupEncrypt as jest.Mock).mock.calls[0][0];
    expect(input.senderKeyRecord).toBeUndefined();
    expect(saveSenderKey).toHaveBeenCalledTimes(1);
  });

  it('decryptGroup passes undefined senderKeyRecord when getSenderKey returns null', async () => {
    (getSenderKey as jest.Mock).mockReturnValue(null);

    await decryptGroup(mockAddress, 'dist-uuid', makeUint8Array(64));

    expect(groupDecrypt).toHaveBeenCalledTimes(1);
    const input = (groupDecrypt as jest.Mock).mock.calls[0][0];
    expect(input.senderKeyRecord).toBeUndefined();
    expect(saveSenderKey).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Transaction safety
// ---------------------------------------------------------------------------

describe('transaction safety', () => {
  it('rolls back on write failure during encrypt', async () => {
    (getSession as jest.Mock).mockReturnValue({
      record: makeUint8Array(128),
    });
    (getIdentityKey as jest.Mock).mockReturnValue(null);
    (saveSession as jest.Mock).mockImplementation(() => {
      throw new Error('DB write failure');
    });

    await expect(encrypt(mockAddress, makeUint8Array(16))).rejects.toThrow(
      'DB write failure',
    );
    expect(mockDb.executeSync).toHaveBeenCalledWith('BEGIN IMMEDIATE');
    expect(mockDb.executeSync).toHaveBeenCalledWith('ROLLBACK');
    expect(mockDb.executeSync).not.toHaveBeenCalledWith('COMMIT');
  });

  it('rolls back when saveSenderKey throws during encryptGroup', async () => {
    (getSenderKey as jest.Mock).mockReturnValue({
      record: makeUint8Array(128, 0x50),
    });
    (saveSenderKey as jest.Mock).mockImplementation(() => {
      throw new Error('sender key write failure');
    });

    await expect(
      encryptGroup('dist-uuid', mockAddress, makeUint8Array(16)),
    ).rejects.toThrow('sender key write failure');

    expect(mockDb.executeSync).toHaveBeenCalledWith('BEGIN IMMEDIATE');
    expect(mockDb.executeSync).toHaveBeenCalledWith('ROLLBACK');
    expect(mockDb.executeSync).not.toHaveBeenCalledWith('COMMIT');
  });

  it('rolls back when removePreKey throws during decryptPreKeyMessage', async () => {
    // Set up pre-key message mocks
    (getSession as jest.Mock).mockReturnValue(null);
    (getIdentityKey as jest.Mock).mockReturnValue(null);
    (getPreKey as jest.Mock).mockReturnValue({ key_data: makeUint8Array(64, 0x03) });
    (getSignedPreKey as jest.Mock).mockReturnValue({
      key_data: makeUint8Array(128, 0x05),
    });
    (getKyberPreKey as jest.Mock).mockReturnValue({
      key_data: makeUint8Array(256, 0x08),
    });

    (parsePrekeyMessageIds as jest.Mock).mockResolvedValue({
      preKeyId: 42,
      signedPreKeyId: 1,
      kyberPreKeyId: 101,
    });
    (signalDecryptPreKey as jest.Mock).mockResolvedValue({
      plaintext: makeArrayBuffer(16, 0x30),
      updatedSessionRecord: makeArrayBuffer(128, 0x31),
      senderIdentityKey: makeArrayBuffer(33, 0x32),
      identityChanged: false,
      consumedPreKeyId: 42,
      consumedKyberPreKeyId: 101,
    });
    (removePreKey as jest.Mock).mockImplementation(() => {
      throw new Error('removePreKey DB failure');
    });

    await expect(
      decrypt(mockAddress, makeUint8Array(128), EnvelopeType.PRE_KEY_BUNDLE),
    ).rejects.toThrow('removePreKey DB failure');

    expect(mockDb.executeSync).toHaveBeenCalledWith('BEGIN IMMEDIATE');
    expect(mockDb.executeSync).toHaveBeenCalledWith('ROLLBACK');
    expect(mockDb.executeSync).not.toHaveBeenCalledWith('COMMIT');
  });

  it('rolls back when saveSenderKey throws during createSenderKeyDistribution', async () => {
    (getSenderKey as jest.Mock).mockReturnValue(null);
    (saveSenderKey as jest.Mock).mockImplementation(() => {
      throw new Error('sender key write failure');
    });

    await expect(
      createSenderKeyDistribution('dist-uuid', mockAddress),
    ).rejects.toThrow('sender key write failure');

    expect(mockDb.executeSync).toHaveBeenCalledWith('BEGIN IMMEDIATE');
    expect(mockDb.executeSync).toHaveBeenCalledWith('ROLLBACK');
    expect(mockDb.executeSync).not.toHaveBeenCalledWith('COMMIT');
  });

  it('rolls back when saveSenderKey throws during processSenderKeyDistribution', async () => {
    (getSenderKey as jest.Mock).mockReturnValue(null);
    (saveSenderKey as jest.Mock).mockImplementation(() => {
      throw new Error('sender key write failure');
    });

    await expect(
      processSenderKeyDistribution(mockAddress, 'dist-uuid', makeUint8Array(64)),
    ).rejects.toThrow('sender key write failure');

    expect(mockDb.executeSync).toHaveBeenCalledWith('BEGIN IMMEDIATE');
    expect(mockDb.executeSync).toHaveBeenCalledWith('ROLLBACK');
    expect(mockDb.executeSync).not.toHaveBeenCalledWith('COMMIT');
  });
});

// ---------------------------------------------------------------------------
// decrypt — type 3 (PreKeySignalMessage)
// ---------------------------------------------------------------------------

describe('decrypt type 3 (PreKeySignalMessage)', () => {
  beforeEach(() => {
    (getSession as jest.Mock).mockReturnValue(null);
    (getIdentityKey as jest.Mock).mockReturnValue(null);
    (getPreKey as jest.Mock).mockReturnValue({ key_data: makeUint8Array(64, 0x03) });
    (getSignedPreKey as jest.Mock).mockReturnValue({
      key_data: makeUint8Array(128, 0x05),
    });
    (getKyberPreKey as jest.Mock).mockReturnValue({
      key_data: makeUint8Array(256, 0x08),
    });
  });

  it('parses message IDs, loads correct keys, decrypts, and applies all mutations', async () => {
    const plaintext = await decrypt(
      mockAddress,
      makeUint8Array(128, 0x10),
      EnvelopeType.PRE_KEY_BUNDLE,
    );

    expect(parsePrekeyMessageIds).toHaveBeenCalledTimes(1);
    expect(getPreKey).toHaveBeenCalledWith(42);
    expect(getSignedPreKey).toHaveBeenCalledWith(1);
    expect(getKyberPreKey).toHaveBeenCalledWith(101);
    expect(signalDecryptPreKey).toHaveBeenCalledTimes(1);
    expect(plaintext).toBeInstanceOf(Uint8Array);
  });

  it('deletes consumed pre-key and marks kyber used in same transaction', async () => {
    await decrypt(mockAddress, makeUint8Array(128), EnvelopeType.PRE_KEY_BUNDLE);

    expect(mockDb.executeSync).toHaveBeenCalledWith('BEGIN IMMEDIATE');
    expect(saveSession).toHaveBeenCalledTimes(1);
    expect(saveIdentityKey).toHaveBeenCalledTimes(1);
    expect(removePreKey).toHaveBeenCalledWith(42);
    expect(markKyberPreKeyUsed).toHaveBeenCalledWith(101);
    expect(mockDb.executeSync).toHaveBeenCalledWith('COMMIT');
  });

  it('throws when signed pre-key is missing', async () => {
    (getSignedPreKey as jest.Mock).mockReturnValue(null);

    await expect(
      decrypt(mockAddress, makeUint8Array(128), EnvelopeType.PRE_KEY_BUNDLE),
    ).rejects.toThrow('Signed pre-key 1 not found');
  });

  it('identityChanged: true — sets Unverified status on identity change', async () => {
    const newSenderIdentityKey = makeArrayBuffer(33, 0xcc);
    (signalDecryptPreKey as jest.Mock).mockResolvedValue({
      plaintext: makeArrayBuffer(16, 0x30),
      updatedSessionRecord: makeArrayBuffer(128, 0x31),
      senderIdentityKey: newSenderIdentityKey,
      identityChanged: true,
      consumedPreKeyId: 42,
      consumedKyberPreKeyId: 101,
    });

    // Existing identity with Verified status
    (getIdentityKey as jest.Mock).mockReturnValue({
      identity_key: makeUint8Array(33, 0x88),
      verified: 1, // VerifiedStatus.Verified
      first_use: 1000000,
      nonblocking_approval: 1,
    });

    const plaintext = await decrypt(
      mockAddress,
      makeUint8Array(128),
      EnvelopeType.PRE_KEY_BUNDLE,
    );

    expect(plaintext).toBeInstanceOf(Uint8Array);

    expect(saveIdentityKey).toHaveBeenCalledTimes(1);
    const savedIdentity = (saveIdentityKey as jest.Mock).mock.calls[0][0];

    // Identity changed: must set Unverified, NOT preserve prior Verified status
    expect(savedIdentity.verified).toBe(2); // VerifiedStatus.Unverified

    // first_use should be preserved from existing identity
    expect(savedIdentity.first_use).toBe(1000000);
  });

  it('identityChanged: false — preserves existing Verified status', async () => {
    (signalDecryptPreKey as jest.Mock).mockResolvedValue({
      plaintext: makeArrayBuffer(16, 0x30),
      updatedSessionRecord: makeArrayBuffer(128, 0x31),
      senderIdentityKey: makeArrayBuffer(33, 0x88),
      identityChanged: false,
      consumedPreKeyId: 42,
      consumedKyberPreKeyId: 101,
    });

    // Existing identity with Verified status
    (getIdentityKey as jest.Mock).mockReturnValue({
      identity_key: makeUint8Array(33, 0x88),
      verified: 1, // VerifiedStatus.Verified
      first_use: 1000000,
      nonblocking_approval: 1,
    });

    await decrypt(mockAddress, makeUint8Array(128), EnvelopeType.PRE_KEY_BUNDLE);

    const savedIdentity = (saveIdentityKey as jest.Mock).mock.calls[0][0];

    // Identity unchanged: preserve existing Verified status
    expect(savedIdentity.verified).toBe(1); // VerifiedStatus.Verified
  });

  it('skips pre-key load and removal when preKeyId is undefined', async () => {
    (parsePrekeyMessageIds as jest.Mock).mockResolvedValue({
      preKeyId: undefined,
      signedPreKeyId: 1,
      kyberPreKeyId: 101,
    });

    (signalDecryptPreKey as jest.Mock).mockResolvedValue({
      plaintext: makeArrayBuffer(16, 0x30),
      updatedSessionRecord: makeArrayBuffer(128, 0x31),
      senderIdentityKey: makeArrayBuffer(33, 0x32),
      identityChanged: false,
      consumedPreKeyId: undefined,
      consumedKyberPreKeyId: 101,
    });

    await decrypt(mockAddress, makeUint8Array(128), EnvelopeType.PRE_KEY_BUNDLE);

    // getPreKey should NOT be called since preKeyId is undefined
    expect(getPreKey).not.toHaveBeenCalled();

    // signalDecryptPreKey should receive preKeyRecord: undefined
    const input = (signalDecryptPreKey as jest.Mock).mock.calls[0][0];
    expect(input.preKeyRecord).toBeUndefined();

    // removePreKey should NOT be called since consumedPreKeyId is undefined
    expect(removePreKey).not.toHaveBeenCalled();

    // markKyberPreKeyUsed should still be called
    expect(markKyberPreKeyUsed).toHaveBeenCalledWith(101);
  });
});

// ---------------------------------------------------------------------------
// getLocalServiceId
// ---------------------------------------------------------------------------

describe('getLocalServiceId', () => {
  it('throws when userId is null', async () => {
    mockGetState.mockReturnValue({ userId: null as unknown as string });

    await expect(encrypt(mockAddress, makeUint8Array(16))).rejects.toThrow(
      'Not authenticated — userId not available',
    );
  });
});

// ---------------------------------------------------------------------------
// withAddressLock concurrency
// ---------------------------------------------------------------------------

describe('withAddressLock concurrency', () => {
  it('serializes concurrent encrypt calls to the same address', async () => {
    // Use unique address to avoid state conflicts from other tests
    const uniqueAddress = { name: 'concurrency-test-uuid', deviceId: 1 };

    let resolveFirst!: (value: unknown) => void;
    let resolveSecond!: (value: unknown) => void;
    const firstPromise = new Promise(resolve => {
      resolveFirst = resolve;
    });
    const secondPromise = new Promise(resolve => {
      resolveSecond = resolve;
    });

    // Set up mocks: valid session, no identity
    (getSession as jest.Mock).mockReturnValue({
      record: makeUint8Array(128, 0x99),
    });
    (getIdentityKey as jest.Mock).mockReturnValue(null);

    // signalEncrypt returns controlled promises
    (signalEncrypt as jest.Mock)
      .mockReturnValueOnce(firstPromise)
      .mockReturnValueOnce(secondPromise);

    // Fire both encrypt calls without awaiting
    const call1 = encrypt(uniqueAddress, makeUint8Array(16, 0x01));
    const call2 = encrypt(uniqueAddress, makeUint8Array(16, 0x02));

    // Drain microtasks so the first call's signalEncrypt is invoked
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // Only the first call should have reached signalEncrypt (second is blocked by lock)
    expect(signalEncrypt).toHaveBeenCalledTimes(1);

    // Resolve the first encryption
    resolveFirst({
      ciphertext: {
        messageType: 'Whisper',
        serialized: makeArrayBuffer(64, 0x10),
      },
      updatedSessionRecord: makeArrayBuffer(128, 0x11),
    });

    // Await the first call to complete fully
    await call1;

    // Drain microtasks so the second call's signalEncrypt is invoked
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // Now the second call should have reached signalEncrypt
    expect(signalEncrypt).toHaveBeenCalledTimes(2);

    // Resolve the second encryption
    resolveSecond({
      ciphertext: {
        messageType: 'Whisper',
        serialized: makeArrayBuffer(64, 0x10),
      },
      updatedSessionRecord: makeArrayBuffer(128, 0x11),
    });

    await call2;

    // Both should have saved sessions
    expect(saveSession).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// bundleResponseToData with null preKey and kyberPreKey
// ---------------------------------------------------------------------------

describe('bundleResponseToData with null optional keys', () => {
  it('passes undefined preKey and kyberPreKey fields when bundle has nulls', async () => {
    // First call returns null (triggers auto-establish), then returns valid session
    (getSession as jest.Mock)
      .mockReturnValueOnce(null) // encrypt's first check
      .mockReturnValue({ record: makeUint8Array(128, 0x40) }); // establishSession + encrypt recheck
    (getIdentityKey as jest.Mock).mockReturnValue(null);

    // Bundle response with null preKey and kyberPreKey
    (getPreKeyBundle as jest.Mock).mockResolvedValue({
      registrationId: 99,
      deviceId: 1,
      identityKey: 'AQID',
      signedPreKey: { keyId: 1, publicKey: 'BQYH', signature: 'CAQK' },
      preKey: null,
      kyberPreKey: null,
    });

    // processPreKeyBundle should fail because Orbital requires Kyber,
    // but we can still verify how bundleResponseToData mapped the fields
    // by checking the call arguments to processPreKeyBundle
    await encrypt(mockAddress, makeUint8Array(16)).catch(() => {
      // Expected: may throw because kyber is required, but we verify the call args
    });

    expect(processPreKeyBundle).toHaveBeenCalledTimes(1);
    const input = (processPreKeyBundle as jest.Mock).mock.calls[0][0];
    expect(input.bundle.preKeyId).toBeUndefined();
    expect(input.bundle.preKeyPublic).toBeUndefined();
    expect(input.bundle.kyberPreKeyId).toBeUndefined();
    expect(input.bundle.kyberPreKeyPublic).toBeUndefined();
    expect(input.bundle.kyberPreKeySignature).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Unsupported envelope type
// ---------------------------------------------------------------------------

describe('decrypt with unsupported type', () => {
  it('throws for unknown envelope type', async () => {
    await expect(
      decrypt(mockAddress, makeUint8Array(64), 99 as never),
    ).rejects.toThrow('Unsupported envelope type');
  });
});
