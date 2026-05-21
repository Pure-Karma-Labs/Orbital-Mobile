// Mock all external dependencies before any imports

jest.mock('orbital-signal', () => ({
  generateIdentityKeyPair: jest.fn(),
  generatePreKey: jest.fn(),
  generateSignedPreKey: jest.fn(),
  generateKyberPreKey: jest.fn(),
  getPreKeyPublic: jest.fn(),
  getSignedPreKeyPublic: jest.fn(),
  getKyberPreKeyPublic: jest.fn(),
}));

jest.mock('../../../database/repositories/itemRepository', () => ({
  getItem: jest.fn(),
  setItem: jest.fn(),
  removeItem: jest.fn(),
}));

jest.mock('../../../database/repositories/signalPreKeyRepository', () => ({
  savePreKey: jest.fn(),
}));

jest.mock('../../../database/repositories/signalSignedPreKeyRepository', () => ({
  saveSignedPreKey: jest.fn(),
}));

jest.mock('../../../database/repositories/signalKyberPreKeyRepository', () => ({
  saveKyberPreKey: jest.fn(),
}));

jest.mock('../../../database/connection', () => ({
  getDatabase: jest.fn(),
  isDatabaseInitialized: jest.fn(() => true),
}));

jest.mock('../../../database/queryHelpers', () => ({
  queryOne: jest.fn(),
}));

jest.mock('../../api/keys', () => ({
  uploadPreKeyBundle: jest.fn(),
  getPreKeyCount: jest.fn(),
}));

jest.mock('../../secure-storage', () => ({
  getSecureItem: jest.fn(),
  setSecureItem: jest.fn().mockResolvedValue(undefined),
}));

import {
  generateIdentityKeyPair,
  generatePreKey,
  generateSignedPreKey,
  generateKyberPreKey,
  getPreKeyPublic,
  getSignedPreKeyPublic,
  getKyberPreKeyPublic,
} from 'orbital-signal';
import { getItem, setItem, removeItem } from '../../../database/repositories/itemRepository';
import { savePreKey } from '../../../database/repositories/signalPreKeyRepository';
import { saveSignedPreKey } from '../../../database/repositories/signalSignedPreKeyRepository';
import { saveKyberPreKey } from '../../../database/repositories/signalKyberPreKeyRepository';
import { getDatabase, isDatabaseInitialized } from '../../../database/connection';
import { queryOne } from '../../../database/queryHelpers';
import { uploadPreKeyBundle, getPreKeyCount } from '../../api/keys';
import { getSecureItem, setSecureItem } from '../../secure-storage';

import {
  generateInitialKeys,
  uploadInitialPreKeyBundle,
  checkAndReplenishPreKeys,
  checkAndRotateSignedPreKey,
  ensureKeysInitialized,
  initIdentityKeyCache,
} from '../keyGenerationService';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeArrayBuffer(size: number, fill = 0xab): ArrayBuffer {
  const buf = new ArrayBuffer(size);
  const view = new Uint8Array(buf);
  view.fill(fill);
  return buf;
}

function makeUint8Array(size: number, fill = 0xab): Uint8Array {
  const arr = new Uint8Array(size);
  arr.fill(fill);
  return arr;
}

const mockDb = {
  executeSync: jest.fn(),
};

function setupDbMock(): void {
  (getDatabase as jest.Mock).mockReturnValue(mockDb);
  mockDb.executeSync.mockReturnValue(undefined);
}

function setupIdentityKeyPair(): void {
  (generateIdentityKeyPair as jest.Mock).mockReturnValue({
    publicKey: makeArrayBuffer(32, 0x01),
    privateKey: makeArrayBuffer(32, 0x02),
  });
}

function setupPreKeyMock(): void {
  (generatePreKey as jest.Mock).mockReturnValue(makeArrayBuffer(64, 0x03));
  (getPreKeyPublic as jest.Mock).mockImplementation((_: ArrayBuffer, id?: number) => ({
    id: id ?? 1,
    publicKey: makeArrayBuffer(32, 0x04),
  }));
}

function setupSignedPreKeyMock(): void {
  (generateSignedPreKey as jest.Mock).mockReturnValue(makeArrayBuffer(64, 0x05));
  (getSignedPreKeyPublic as jest.Mock).mockReturnValue({
    id: 1,
    publicKey: makeArrayBuffer(32, 0x06),
    signature: makeArrayBuffer(64, 0x07),
    timestamp: BigInt(Date.now()),
  });
}

function setupKyberPreKeyMock(): void {
  (generateKyberPreKey as jest.Mock).mockResolvedValue({
    record: makeArrayBuffer(64, 0x08),
    isLastResort: false,
  });
  (getKyberPreKeyPublic as jest.Mock).mockReturnValue({
    id: 1,
    publicKey: makeArrayBuffer(128, 0x09),
    signature: makeArrayBuffer(64, 0x0a),
  });
}

const PRIVATE_KEY_HEX = '0202020202020202020202020202020202020202020202020202020202020202';

beforeEach(() => {
  jest.resetAllMocks();

  (isDatabaseInitialized as jest.Mock).mockReturnValue(true);
  setupDbMock();
  setupIdentityKeyPair();
  setupPreKeyMock();
  setupSignedPreKeyMock();
  setupKyberPreKeyMock();

  // Default: no existing keys in DB or Keychain
  (getItem as jest.Mock).mockReturnValue(null);
  (getSecureItem as jest.Mock).mockResolvedValue(null);

  // Default: upload succeeds
  (uploadPreKeyBundle as jest.Mock).mockResolvedValue({ success: true });
});

// ---------------------------------------------------------------------------
// generateInitialKeys
// ---------------------------------------------------------------------------

describe('generateInitialKeys', () => {
  it('returns early (idempotent) if identity key already exists', async () => {
    (getItem as jest.Mock).mockReturnValue('existing-hex-value');

    await generateInitialKeys();

    expect(generateIdentityKeyPair).not.toHaveBeenCalled();
    expect(mockDb.executeSync).not.toHaveBeenCalled();
  });

  it('generates identity key pair and stores public key in SQLCipher', async () => {
    await generateInitialKeys();

    expect(generateIdentityKeyPair).toHaveBeenCalledTimes(1);
    expect(setItem).toHaveBeenCalledWith('identityKeyPublic', expect.any(String));
  });

  it('writes private key to Keychain (not SQLCipher items table)', async () => {
    await generateInitialKeys();

    expect(setSecureItem).toHaveBeenCalledWith(
      'com.orbital.mobile.identity-key-private',
      expect.any(String),
    );
    // Must NOT write identityKeyPrivate to the items table
    const setItemCalls = (setItem as jest.Mock).mock.calls;
    const wrotePrivateToDb = setItemCalls.some(
      ([key]: [string]) => key === 'identityKeyPrivate',
    );
    expect(wrotePrivateToDb).toBe(false);
  });

  it('generates registration ID using crypto.getRandomValues (not Math.random)', async () => {
    const cryptoObj = (globalThis as Record<string, unknown>).crypto as { getRandomValues: (a: Uint8Array) => Uint8Array };
    const getRandomValuesSpy = jest.spyOn(cryptoObj, 'getRandomValues');

    await generateInitialKeys();

    expect(getRandomValuesSpy).toHaveBeenCalled();
    expect(setItem).toHaveBeenCalledWith('registrationId', expect.stringMatching(/^\d+$/));
  });

  it('generates 100 one-time pre-keys', async () => {
    await generateInitialKeys();

    expect(generatePreKey).toHaveBeenCalledTimes(100);
    expect(savePreKey).toHaveBeenCalledTimes(100);
  });

  it('generates 1 signed pre-key', async () => {
    await generateInitialKeys();

    expect(generateSignedPreKey).toHaveBeenCalledTimes(1);
    expect(saveSignedPreKey).toHaveBeenCalledTimes(1);
  });

  it('generates 100 Kyber pre-keys + 1 last-resort Kyber pre-key', async () => {
    await generateInitialKeys();

    expect(generateKyberPreKey).toHaveBeenCalledTimes(101);
    expect(saveKyberPreKey).toHaveBeenCalledTimes(101);

    // Last call should have isLastResort = true
    const calls = (generateKyberPreKey as jest.Mock).mock.calls;
    const lastCall = calls[calls.length - 1];
    expect(lastCall[3]).toBe(true);
  });

  it('wraps all database writes in a transaction', async () => {
    await generateInitialKeys();

    expect(mockDb.executeSync).toHaveBeenCalledWith('BEGIN IMMEDIATE');
    expect(mockDb.executeSync).toHaveBeenCalledWith('COMMIT');
    expect(mockDb.executeSync).not.toHaveBeenCalledWith('ROLLBACK');
  });

  it('rolls back transaction on partial failure', async () => {
    let callCount = 0;
    (savePreKey as jest.Mock).mockImplementation(() => {
      callCount++;
      if (callCount === 50) throw new Error('Simulated DB write failure');
    });

    await expect(generateInitialKeys()).rejects.toThrow('Simulated DB write failure');

    expect(mockDb.executeSync).toHaveBeenCalledWith('BEGIN IMMEDIATE');
    expect(mockDb.executeSync).toHaveBeenCalledWith('ROLLBACK');
    expect(mockDb.executeSync).not.toHaveBeenCalledWith('COMMIT');
  });

  it('stores all counter values in items table', async () => {
    await generateInitialKeys();

    expect(setItem).toHaveBeenCalledWith('nextPreKeyId', '101');
    expect(setItem).toHaveBeenCalledWith('nextSignedPreKeyId', '2');
    expect(setItem).toHaveBeenCalledWith('nextKyberPreKeyId', '102');
    expect(setItem).toHaveBeenCalledWith('activeSignedPreKeyId', '1');
    expect(setItem).toHaveBeenCalledWith('lastResortKyberPreKeyId', '101');
  });
});

// ---------------------------------------------------------------------------
// initIdentityKeyCache
// ---------------------------------------------------------------------------

describe('initIdentityKeyCache', () => {
  it('loads private key from Keychain when present', async () => {
    (getSecureItem as jest.Mock).mockResolvedValue(PRIVATE_KEY_HEX);

    await initIdentityKeyCache();

    expect(getSecureItem).toHaveBeenCalledWith('com.orbital.mobile.identity-key-private');
    // Should not touch SQLCipher
    expect(getItem).not.toHaveBeenCalledWith('identityKeyPrivate');
  });

  it('migrates private key from SQLCipher to Keychain when only in DB', async () => {
    (getSecureItem as jest.Mock).mockResolvedValue(null);
    (getItem as jest.Mock).mockImplementation((key: string) =>
      key === 'identityKeyPrivate' ? PRIVATE_KEY_HEX : null,
    );

    await initIdentityKeyCache();

    expect(setSecureItem).toHaveBeenCalledWith(
      'com.orbital.mobile.identity-key-private',
      PRIVATE_KEY_HEX,
    );
    expect(removeItem).toHaveBeenCalledWith('identityKeyPrivate');
  });

  it('returns without error when no key exists anywhere (new user pre-registration)', async () => {
    (getSecureItem as jest.Mock).mockResolvedValue(null);
    (getItem as jest.Mock).mockReturnValue(null);

    await expect(initIdentityKeyCache()).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// uploadInitialPreKeyBundle
// ---------------------------------------------------------------------------

describe('uploadInitialPreKeyBundle', () => {
  function setupItemsForUpload(): void {
    (getItem as jest.Mock).mockImplementation((key: string) => {
      const values: Record<string, string> = {
        identityKeyPublic: '0101010101010101010101010101010101010101010101010101010101010101',
        registrationId: '12345',
        nextPreKeyId: '2',
        activeSignedPreKeyId: '1',
        nextKyberPreKeyId: '2',
        lastResortKyberPreKeyId: '101',
      };
      return values[key] ?? null;
    });

    (queryOne as jest.Mock).mockReturnValue({ key_data: makeUint8Array(64, 0x05) });
  }

  it('throws if keys are not initialized', async () => {
    (getItem as jest.Mock).mockReturnValue(null);
    await expect(uploadInitialPreKeyBundle()).rejects.toThrow('Cannot upload bundle — keys not initialized');
  });

  it('assembles payload with correct structure and base64-encoded keys', async () => {
    setupItemsForUpload();

    await uploadInitialPreKeyBundle();

    expect(uploadPreKeyBundle).toHaveBeenCalledTimes(1);
    const payload = (uploadPreKeyBundle as jest.Mock).mock.calls[0][0];
    expect(payload).toMatchObject({
      registrationId: 12345,
      deviceId: 1,
      identityKey: expect.any(String),
      signedPreKey: {
        keyId: expect.any(Number),
        publicKey: expect.any(String),
        signature: expect.any(String),
      },
      preKeys: expect.any(Array),
      kyberPreKeys: expect.any(Array),
      lastResortKyberPreKey: {
        keyId: expect.any(Number),
        publicKey: expect.any(String),
        signature: expect.any(String),
        lastResort: true,
      },
    });
  });

  it('sets bundleUploaded after successful upload', async () => {
    setupItemsForUpload();

    await uploadInitialPreKeyBundle();

    expect(setItem).toHaveBeenCalledWith('bundleUploaded', '1');
  });

  it('does NOT set bundleUploaded if upload throws', async () => {
    setupItemsForUpload();
    (uploadPreKeyBundle as jest.Mock).mockRejectedValue(new Error('Network failure'));

    await expect(uploadInitialPreKeyBundle()).rejects.toThrow('Network failure');
    expect(setItem).not.toHaveBeenCalledWith('bundleUploaded', '1');
  });

  it('encodes identityKey as base64 string', async () => {
    setupItemsForUpload();

    await uploadInitialPreKeyBundle();

    const payload = (uploadPreKeyBundle as jest.Mock).mock.calls[0][0];
    // base64 string should only contain valid base64 characters
    expect(payload.identityKey).toMatch(/^[A-Za-z0-9+/]+=*$/);
  });
});

// ---------------------------------------------------------------------------
// checkAndReplenishPreKeys
// ---------------------------------------------------------------------------

describe('checkAndReplenishPreKeys', () => {
  async function setupItemsForReplenishment(): Promise<void> {
    // Seed the module-scoped cache via initIdentityKeyCache
    (getSecureItem as jest.Mock).mockResolvedValue(PRIVATE_KEY_HEX);
    await initIdentityKeyCache();

    (getItem as jest.Mock).mockImplementation((key: string) => {
      const values: Record<string, string> = {
        nextPreKeyId: '101',
        nextKyberPreKeyId: '102',
        identityKeyPublic: '0101010101010101010101010101010101010101010101010101010101010101',
        registrationId: '12345',
        activeSignedPreKeyId: '1',
        lastResortKyberPreKeyId: '101',
      };
      return values[key] ?? null;
    });

    (queryOne as jest.Mock).mockReturnValue({ key_data: makeUint8Array(64, 0x05) });
  }

  it('does nothing when count is at or above threshold', async () => {
    (getPreKeyCount as jest.Mock).mockResolvedValue({ count: 20 });

    await checkAndReplenishPreKeys();

    expect(generatePreKey).not.toHaveBeenCalled();
  });

  it('generates and uploads new keys when count is below threshold', async () => {
    (getPreKeyCount as jest.Mock).mockResolvedValue({ count: 5 });
    await setupItemsForReplenishment();

    await checkAndReplenishPreKeys();

    expect(generatePreKey).toHaveBeenCalledTimes(100);
    expect(generateKyberPreKey).toHaveBeenCalledTimes(100);
    expect(uploadPreKeyBundle).toHaveBeenCalledTimes(1);
  });

  it('updates nextPreKeyId and nextKyberPreKeyId counters after generating', async () => {
    (getPreKeyCount as jest.Mock).mockResolvedValue({ count: 0 });
    await setupItemsForReplenishment();

    await checkAndReplenishPreKeys();

    expect(setItem).toHaveBeenCalledWith('nextPreKeyId', '201');
    expect(setItem).toHaveBeenCalledWith('nextKyberPreKeyId', '202');
  });

  it('wraps DB writes in a transaction', async () => {
    (getPreKeyCount as jest.Mock).mockResolvedValue({ count: 0 });
    await setupItemsForReplenishment();

    await checkAndReplenishPreKeys();

    expect(mockDb.executeSync).toHaveBeenCalledWith('BEGIN IMMEDIATE');
    expect(mockDb.executeSync).toHaveBeenCalledWith('COMMIT');
  });

  it('does nothing if identity keys are missing', async () => {
    (getPreKeyCount as jest.Mock).mockResolvedValue({ count: 0 });
    // Cache is null (reset by jest.resetAllMocks in beforeEach) and getSecureItem returns null
    (getSecureItem as jest.Mock).mockResolvedValue(null);
    await initIdentityKeyCache();
    (getItem as jest.Mock).mockReturnValue(null);

    await checkAndReplenishPreKeys();

    expect(generatePreKey).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// checkAndRotateSignedPreKey
// ---------------------------------------------------------------------------

const SEVEN_DAYS_SECONDS = 7 * 24 * 60 * 60;

describe('checkAndRotateSignedPreKey', () => {
  async function setupItemsForRotation(lastRotationSecondsAgo: number): Promise<void> {
    // Seed the module-scoped cache via initIdentityKeyCache
    (getSecureItem as jest.Mock).mockResolvedValue(PRIVATE_KEY_HEX);
    await initIdentityKeyCache();

    const lastRotation = Math.floor(Date.now() / 1000) - lastRotationSecondsAgo;
    (getItem as jest.Mock).mockImplementation((key: string) => {
      const values: Record<string, string> = {
        lastSignedPreKeyRotation: String(lastRotation),
        nextSignedPreKeyId: '2',
        identityKeyPublic: '0101010101010101010101010101010101010101010101010101010101010101',
        registrationId: '12345',
        lastResortKyberPreKeyId: '101',
      };
      return values[key] ?? null;
    });

    (queryOne as jest.Mock).mockReturnValue({ key_data: makeUint8Array(64, 0x05) });
  }

  it('does nothing when rotation is not due', async () => {
    await setupItemsForRotation(SEVEN_DAYS_SECONDS - 60);

    await checkAndRotateSignedPreKey();

    expect(generateSignedPreKey).not.toHaveBeenCalled();
  });

  it('rotates when last rotation was more than 7 days ago', async () => {
    await setupItemsForRotation(SEVEN_DAYS_SECONDS + 1);

    await checkAndRotateSignedPreKey();

    expect(generateSignedPreKey).toHaveBeenCalledTimes(1);
    expect(saveSignedPreKey).toHaveBeenCalledTimes(1);
    expect(uploadPreKeyBundle).toHaveBeenCalledTimes(1);
  });

  it('updates activeSignedPreKeyId and rotation timestamp after rotate', async () => {
    await setupItemsForRotation(SEVEN_DAYS_SECONDS + 1);

    await checkAndRotateSignedPreKey();

    expect(setItem).toHaveBeenCalledWith('activeSignedPreKeyId', '2');
    expect(setItem).toHaveBeenCalledWith('nextSignedPreKeyId', '3');
    expect(setItem).toHaveBeenCalledWith('lastSignedPreKeyRotation', expect.any(String));
  });

  it('wraps DB writes in a transaction', async () => {
    await setupItemsForRotation(SEVEN_DAYS_SECONDS + 1);

    await checkAndRotateSignedPreKey();

    expect(mockDb.executeSync).toHaveBeenCalledWith('BEGIN IMMEDIATE');
    expect(mockDb.executeSync).toHaveBeenCalledWith('COMMIT');
  });

  it('rotates when lastSignedPreKeyRotation is not set (first run)', async () => {
    // Seed the module-scoped cache via initIdentityKeyCache
    (getSecureItem as jest.Mock).mockResolvedValue(PRIVATE_KEY_HEX);
    await initIdentityKeyCache();

    (getItem as jest.Mock).mockImplementation((key: string) => {
      const values: Record<string, string> = {
        nextSignedPreKeyId: '2',
        identityKeyPublic: '0101010101010101010101010101010101010101010101010101010101010101',
        registrationId: '12345',
        lastResortKyberPreKeyId: '101',
      };
      return values[key] ?? null;
    });
    (queryOne as jest.Mock).mockReturnValue({ key_data: makeUint8Array(64, 0x05) });

    await checkAndRotateSignedPreKey();

    expect(generateSignedPreKey).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// ensureKeysInitialized
// ---------------------------------------------------------------------------

describe('ensureKeysInitialized', () => {
  it('calls generateInitialKeys when identity key is missing', async () => {
    (getItem as jest.Mock).mockReturnValue(null);

    // generateInitialKeys will fail because orbit-signal is mocked but DB etc.
    // needs a full setup — just verify the flow calls through.
    // We stub generateInitialKeys indirectly via its deps.
    try {
      await ensureKeysInitialized();
    } catch {
      // expected to throw in minimal mock setup
    }

    expect(generateIdentityKeyPair).toHaveBeenCalled();
  });

  it('skips generateInitialKeys when identity key already exists', async () => {
    (getItem as jest.Mock).mockImplementation((key: string) => {
      if (key === 'identityKeyPublic') return 'aabbcc';
      if (key === 'bundleUploaded') return '1';
      if (key === 'lastSignedPreKeyRotation') return String(Math.floor(Date.now() / 1000));
      return null;
    });
    (getPreKeyCount as jest.Mock).mockResolvedValue({ count: 50 });
    (queryOne as jest.Mock).mockReturnValue(null);

    await ensureKeysInitialized();

    expect(generateIdentityKeyPair).not.toHaveBeenCalled();
  });

  it('concurrent calls coalesce into a single execution', async () => {
    let resolveFirst: (() => void) | undefined;
    const firstCallPromise = new Promise<void>((resolve) => { resolveFirst = resolve; });

    (getItem as jest.Mock).mockImplementation((key: string) => {
      if (key === 'identityKeyPublic') return 'aabbcc';
      if (key === 'bundleUploaded') return '1';
      if (key === 'lastSignedPreKeyRotation') return String(Math.floor(Date.now() / 1000));
      return null;
    });

    // Make checkAndReplenishPreKeys take a while
    (getPreKeyCount as jest.Mock).mockImplementation(async () => {
      await firstCallPromise;
      return { count: 50 };
    });

    const call1 = ensureKeysInitialized();
    const call2 = ensureKeysInitialized();

    resolveFirst!();

    await Promise.all([call1, call2]);

    // getPreKeyCount should only have been called once despite two concurrent calls
    expect(getPreKeyCount).toHaveBeenCalledTimes(1);
  });

  it('clears the concurrency guard after completion so next call runs fresh', async () => {
    (getItem as jest.Mock).mockImplementation((key: string) => {
      if (key === 'identityKeyPublic') return 'aabbcc';
      if (key === 'bundleUploaded') return '1';
      if (key === 'lastSignedPreKeyRotation') return String(Math.floor(Date.now() / 1000));
      return null;
    });
    (getPreKeyCount as jest.Mock).mockResolvedValue({ count: 50 });
    (queryOne as jest.Mock).mockReturnValue(null);

    await ensureKeysInitialized();
    await ensureKeysInitialized();

    // Both calls completed — second one ran fresh
    expect(getPreKeyCount).toHaveBeenCalledTimes(2);
  });

  it('clears the guard on failure so retry is possible', async () => {
    let callCount = 0;
    (getItem as jest.Mock).mockImplementation((key: string) => {
      if (key === 'identityKeyPublic') return 'aabbcc';
      if (key === 'bundleUploaded') return '1';
      if (key === 'lastSignedPreKeyRotation') return String(Math.floor(Date.now() / 1000));
      return null;
    });
    (getPreKeyCount as jest.Mock).mockImplementation(async () => {
      callCount++;
      if (callCount === 1) throw new Error('Network failure');
      return { count: 50 };
    });
    (queryOne as jest.Mock).mockReturnValue(null);

    await expect(ensureKeysInitialized()).rejects.toThrow('Network failure');
    await ensureKeysInitialized();

    expect(getPreKeyCount).toHaveBeenCalledTimes(2);
  });
});
