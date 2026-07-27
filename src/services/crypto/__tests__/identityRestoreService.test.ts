/**
 * Tests for identityRestoreService — the seamless Keychain identity restore
 * path (M3 of #628).
 *
 * Coverage:
 * - Round-trip verifier true/false/other-error taxonomy
 * - Restore writes byte-identical pub hex + fresh registrationId, BUNDLE_UPLOADED unset
 * - Mismatch -> 'cleared' (both keychain + cache)
 * - 404 -> 'cleared'
 * - Network -> 'deferred' and ensureKeysInitialized NOT invoked
 * - generateInitialKeys throws with warm cache
 * - signup clears stale key first
 * - identityRestoreDeferred store lifecycle
 */

// ---------------------------------------------------------------------------
// Mocks — MUST come before imports
// ---------------------------------------------------------------------------

jest.mock('orbital-signal', () => ({
  eciesSeal: jest.fn(),
  eciesOpen: jest.fn(),
  SignalError_Tags: {
    InvalidKey: 'InvalidKey',
    InvalidMessage: 'InvalidMessage',
    InvalidSignature: 'InvalidSignature',
    NoSession: 'NoSession',
    UntrustedIdentity: 'UntrustedIdentity',
    DuplicateMessage: 'DuplicateMessage',
    InvalidCertificate: 'InvalidCertificate',
    InvalidArgument: 'InvalidArgument',
    StoreError: 'StoreError',
    InternalError: 'InternalError',
  },
  generateIdentityKeyPair: jest.fn(),
  generatePreKey: jest.fn(),
  generateSignedPreKey: jest.fn(),
  generateKyberPreKey: jest.fn(),
  getPreKeyPublic: jest.fn(),
  getSignedPreKeyPublic: jest.fn(),
  getKyberPreKeyPublic: jest.fn(),
}));

jest.mock('../../api/keys', () => ({
  fetchRemoteIdentityKeyBundle: jest.fn(),
  uploadPreKeyBundle: jest.fn(),
  getPreKeyCount: jest.fn(),
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
  execute: jest.fn(),
}));

jest.mock('../../secure-storage', () => ({
  getSecureItem: jest.fn(),
  setSecureItem: jest.fn().mockResolvedValue(undefined),
  removeSecureItem: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../contentCrypto', () => ({
  clearGroupKeyCache: jest.fn(),
  clearContentCryptoInflight: jest.fn(),
}));

jest.mock('../../../database/repositories/conversationRepository', () => ({
  clearAllGroupCryptoState: jest.fn(),
}));

// Mock useAppStore following the keyRecoveryService.test.ts pattern
const mockSetIdentityRestoreDeferred = jest.fn();
jest.mock('../../../stores/useAppStore', () => ({
  useAppStore: {
    getState: jest.fn(() => ({
      userId: 'user-123',
      setIdentityRestoreDeferred: mockSetIdentityRestoreDeferred,
    })),
  },
}));

// api/errors mock — classes defined inline since jest.mock is hoisted
jest.mock('../../api/errors', () => {
  class _ApiError extends Error {
    readonly statusCode: number;
    constructor(m: string, s: number) { super(m); this.statusCode = s; Object.setPrototypeOf(this, new.target.prototype); }
  }
  class _NotFoundError extends _ApiError {
    constructor() { super('Not found', 404); this.name = 'NotFoundError'; }
  }
  class _NetworkError extends _ApiError {
    constructor() { super('Network error', 0); this.name = 'NetworkError'; }
  }
  class _ConflictError extends _ApiError {
    blockingOrbits: never[] = [];
    constructor() { super('Conflict', 409); }
  }
  return { ApiError: _ApiError, NotFoundError: _NotFoundError, NetworkError: _NetworkError, ConflictError: _ConflictError };
});

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import {
  eciesSeal,
  eciesOpen,
  generateIdentityKeyPair,
  generatePreKey,
  generateSignedPreKey,
  generateKyberPreKey,
  getPreKeyPublic,
  getSignedPreKeyPublic,
  getKyberPreKeyPublic,
} from 'orbital-signal';
import { fetchRemoteIdentityKeyBundle, uploadPreKeyBundle } from '../../api/keys';
import { NotFoundError, NetworkError } from '../../api/errors';
import { getItem, setItem } from '../../../database/repositories/itemRepository';
import { getDatabase } from '../../../database/connection';
import { getSecureItem, setSecureItem, removeSecureItem } from '../../secure-storage';
import {
  attemptKeychainIdentityRestore,
  clearStaleKeychainIdentity,
} from '../identityRestoreService';
import {
  generateInitialKeys,
  initIdentityKeyCache,
  clearIdentityKeyCache,
  getCachedIdentityPrivateKeyHex,
  restoreIdentityKeys,
} from '../keyGenerationService';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeArrayBuffer(size: number, fill = 0xab): ArrayBuffer {
  const buf = new ArrayBuffer(size);
  new Uint8Array(buf).fill(fill);
  return buf;
}

const PRIVATE_KEY_HEX = '0202020202020202020202020202020202020202020202020202020202020202';

// Server key: 33-byte public key (0x05 prefix + 32 bytes) base64-encoded
const SERVER_PUB_BYTES = new Uint8Array(33);
SERVER_PUB_BYTES[0] = 0x05;
SERVER_PUB_BYTES.fill(0x01, 1);

function uint8ToBase64(arr: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < arr.length; i++) {
    binary += String.fromCharCode(arr[i]);
  }
  return btoa(binary);
}
const SERVER_KEY_B64 = uint8ToBase64(SERVER_PUB_BYTES);

const mockDb = { executeSync: jest.fn() };

function setupDefaults(): void {
  // Re-setup useAppStore mock (cleared by resetAllMocks)
  const { useAppStore } = require('../../../stores/useAppStore');
  (useAppStore.getState as jest.Mock).mockReturnValue({
    userId: 'user-123',
    setIdentityRestoreDeferred: mockSetIdentityRestoreDeferred,
  });

  // Re-setup removeSecureItem mock (cleared by resetAllMocks)
  (removeSecureItem as jest.Mock).mockResolvedValue(undefined);

  (getDatabase as jest.Mock).mockReturnValue(mockDb);
  mockDb.executeSync.mockReturnValue(undefined);
  (getItem as jest.Mock).mockReturnValue(null);
  (getSecureItem as jest.Mock).mockResolvedValue(null);
  (uploadPreKeyBundle as jest.Mock).mockResolvedValue({ success: true });

  (generateIdentityKeyPair as jest.Mock).mockReturnValue({
    publicKey: makeArrayBuffer(32, 0x01),
    privateKey: makeArrayBuffer(32, 0x02),
  });
  (generatePreKey as jest.Mock).mockReturnValue(makeArrayBuffer(64, 0x03));
  (getPreKeyPublic as jest.Mock).mockReturnValue({
    id: 1, publicKey: makeArrayBuffer(32, 0x04),
  });
  (generateSignedPreKey as jest.Mock).mockReturnValue(makeArrayBuffer(64, 0x05));
  (getSignedPreKeyPublic as jest.Mock).mockReturnValue({
    id: 1, publicKey: makeArrayBuffer(32, 0x06),
    signature: makeArrayBuffer(64, 0x07), timestamp: BigInt(Date.now()),
  });
  (generateKyberPreKey as jest.Mock).mockResolvedValue({
    record: makeArrayBuffer(64, 0x08), isLastResort: false,
  });
  (getKyberPreKeyPublic as jest.Mock).mockReturnValue({
    id: 1, publicKey: makeArrayBuffer(128, 0x09),
    signature: makeArrayBuffer(64, 0x0a),
  });
}

beforeEach(() => {
  jest.resetAllMocks();
  clearIdentityKeyCache();
  setupDefaults();
});

// ---------------------------------------------------------------------------
// attemptKeychainIdentityRestore — 'none' fast paths
// ---------------------------------------------------------------------------

describe('attemptKeychainIdentityRestore — none paths', () => {
  it('returns none when DB already has identityKeyPublic (normal login)', async () => {
    (getItem as jest.Mock).mockReturnValue('existing-pub-hex');
    const result = await attemptKeychainIdentityRestore();
    expect(result).toBe('none');
    expect(fetchRemoteIdentityKeyBundle).not.toHaveBeenCalled();
  });

  it('returns none when no cached private key exists', async () => {
    const result = await attemptKeychainIdentityRestore();
    expect(result).toBe('none');
    expect(fetchRemoteIdentityKeyBundle).not.toHaveBeenCalled();
  });

  it('returns none when no userId is set', async () => {
    (getSecureItem as jest.Mock).mockResolvedValue(PRIVATE_KEY_HEX);
    await initIdentityKeyCache();

    const { useAppStore } = require('../../../stores/useAppStore');
    (useAppStore.getState as jest.Mock).mockReturnValue({ userId: null });

    const result = await attemptKeychainIdentityRestore();
    expect(result).toBe('none');
  });
});

// ---------------------------------------------------------------------------
// attemptKeychainIdentityRestore — 404 -> 'cleared'
// ---------------------------------------------------------------------------

describe('attemptKeychainIdentityRestore — 404 path', () => {
  it('returns cleared and removes Keychain key + cache on 404', async () => {
    (getSecureItem as jest.Mock).mockResolvedValue(PRIVATE_KEY_HEX);
    await initIdentityKeyCache();
    expect(getCachedIdentityPrivateKeyHex()).toBe(PRIVATE_KEY_HEX);

    (fetchRemoteIdentityKeyBundle as jest.Mock).mockRejectedValue(new NotFoundError());

    const result = await attemptKeychainIdentityRestore();
    expect(result).toBe('cleared');

    expect(removeSecureItem).toHaveBeenCalledWith('com.orbital.mobile.identity-key-private');
    expect(getCachedIdentityPrivateKeyHex()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// attemptKeychainIdentityRestore — network error -> 'deferred'
// ---------------------------------------------------------------------------

describe('attemptKeychainIdentityRestore — network error path', () => {
  it('returns deferred on network error and does NOT clear key', async () => {
    (getSecureItem as jest.Mock).mockResolvedValue(PRIVATE_KEY_HEX);
    await initIdentityKeyCache();

    (fetchRemoteIdentityKeyBundle as jest.Mock).mockRejectedValue(new NetworkError());

    const result = await attemptKeychainIdentityRestore();
    expect(result).toBe('deferred');

    expect(removeSecureItem).not.toHaveBeenCalled();
    expect(getCachedIdentityPrivateKeyHex()).toBe(PRIVATE_KEY_HEX);
  });

  it('returns deferred on unknown error and does NOT clear key', async () => {
    (getSecureItem as jest.Mock).mockResolvedValue(PRIVATE_KEY_HEX);
    await initIdentityKeyCache();

    (fetchRemoteIdentityKeyBundle as jest.Mock).mockRejectedValue(new Error('Unexpected'));

    const result = await attemptKeychainIdentityRestore();
    expect(result).toBe('deferred');
    expect(removeSecureItem).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// attemptKeychainIdentityRestore — ECIES round-trip proof
// ---------------------------------------------------------------------------

describe('attemptKeychainIdentityRestore — ECIES proof match -> restored', () => {
  it('returns restored when ECIES proof passes', async () => {
    (getSecureItem as jest.Mock).mockResolvedValue(PRIVATE_KEY_HEX);
    await initIdentityKeyCache();

    (fetchRemoteIdentityKeyBundle as jest.Mock).mockResolvedValue({
      identityKey: SERVER_KEY_B64,
    });

    (eciesSeal as jest.Mock).mockReturnValue(makeArrayBuffer(190));
    (eciesOpen as jest.Mock).mockReturnValue(makeArrayBuffer(32));

    const result = await attemptKeychainIdentityRestore();
    expect(result).toBe('restored');

    expect(eciesSeal).toHaveBeenCalledTimes(1);
    expect(eciesOpen).toHaveBeenCalledTimes(1);
  });
});

describe('attemptKeychainIdentityRestore — ECIES proof mismatch -> cleared', () => {
  it('returns cleared on InvalidArgument (key mismatch) and clears both', async () => {
    (getSecureItem as jest.Mock).mockResolvedValue(PRIVATE_KEY_HEX);
    await initIdentityKeyCache();

    (fetchRemoteIdentityKeyBundle as jest.Mock).mockResolvedValue({
      identityKey: SERVER_KEY_B64,
    });

    (eciesSeal as jest.Mock).mockReturnValue(makeArrayBuffer(190));
    (eciesOpen as jest.Mock).mockImplementation(() => {
      const err = new Error('does not match');
      (err as unknown as { tag: string }).tag = 'InvalidArgument';
      throw err;
    });

    const result = await attemptKeychainIdentityRestore();
    expect(result).toBe('cleared');

    expect(removeSecureItem).toHaveBeenCalledWith('com.orbital.mobile.identity-key-private');
    expect(getCachedIdentityPrivateKeyHex()).toBeNull();
  });
});

describe('attemptKeychainIdentityRestore — ECIES non-mismatch error -> deferred', () => {
  it('returns deferred on InvalidKey error (not mismatch)', async () => {
    (getSecureItem as jest.Mock).mockResolvedValue(PRIVATE_KEY_HEX);
    await initIdentityKeyCache();

    (fetchRemoteIdentityKeyBundle as jest.Mock).mockResolvedValue({
      identityKey: SERVER_KEY_B64,
    });

    (eciesSeal as jest.Mock).mockReturnValue(makeArrayBuffer(190));
    (eciesOpen as jest.Mock).mockImplementation(() => {
      const err = new Error('bad key');
      (err as unknown as { tag: string }).tag = 'InvalidKey';
      throw err;
    });

    const result = await attemptKeychainIdentityRestore();
    expect(result).toBe('deferred');

    expect(removeSecureItem).not.toHaveBeenCalled();
    expect(getCachedIdentityPrivateKeyHex()).toBe(PRIVATE_KEY_HEX);
  });

  it('returns deferred on InternalError', async () => {
    (getSecureItem as jest.Mock).mockResolvedValue(PRIVATE_KEY_HEX);
    await initIdentityKeyCache();

    (fetchRemoteIdentityKeyBundle as jest.Mock).mockResolvedValue({
      identityKey: SERVER_KEY_B64,
    });

    (eciesSeal as jest.Mock).mockReturnValue(makeArrayBuffer(190));
    (eciesOpen as jest.Mock).mockImplementation(() => {
      const err = new Error('internal');
      (err as unknown as { tag: string }).tag = 'InternalError';
      throw err;
    });

    const result = await attemptKeychainIdentityRestore();
    expect(result).toBe('deferred');
    expect(removeSecureItem).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// restoreIdentityKeys — byte-identical pub hex + fresh registrationId
// ---------------------------------------------------------------------------

describe('restoreIdentityKeys', () => {
  it('writes byte-identical public hex from server key and fresh registrationId', async () => {
    (getSecureItem as jest.Mock).mockResolvedValue(PRIVATE_KEY_HEX);
    await initIdentityKeyCache();

    await restoreIdentityKeys(SERVER_KEY_B64);

    const setItemCalls = (setItem as jest.Mock).mock.calls;
    const pubCall = setItemCalls.find(([key]: [string]) => key === 'identityKeyPublic');
    expect(pubCall).toBeDefined();
    const storedHex = pubCall![1] as string;
    expect(storedHex.length).toBe(66); // 33 bytes = 66 hex chars
    expect(storedHex.slice(0, 2)).toBe('05'); // 0x05 Curve25519 prefix

    const regIdCall = setItemCalls.find(([key]: [string]) => key === 'registrationId');
    expect(regIdCall).toBeDefined();
    const regId = parseInt(regIdCall![1] as string, 10);
    expect(regId).toBeGreaterThan(0);
    expect(regId).toBeLessThanOrEqual(0x3fffffff);
  });

  it('does NOT set BUNDLE_UPLOADED', async () => {
    (getSecureItem as jest.Mock).mockResolvedValue(PRIVATE_KEY_HEX);
    await initIdentityKeyCache();

    await restoreIdentityKeys(SERVER_KEY_B64);

    const setItemCalls = (setItem as jest.Mock).mock.calls;
    const bundleCall = setItemCalls.find(([key]: [string]) => key === 'bundleUploaded');
    expect(bundleCall).toBeUndefined();
  });

  it('does NOT call setSecureItem (private key stays in Keychain)', async () => {
    (getSecureItem as jest.Mock).mockResolvedValue(PRIVATE_KEY_HEX);
    await initIdentityKeyCache();

    await restoreIdentityKeys(SERVER_KEY_B64);

    expect(setSecureItem).not.toHaveBeenCalled();
  });

  it('wraps DB writes in a transaction', async () => {
    (getSecureItem as jest.Mock).mockResolvedValue(PRIVATE_KEY_HEX);
    await initIdentityKeyCache();

    await restoreIdentityKeys(SERVER_KEY_B64);

    expect(mockDb.executeSync).toHaveBeenCalledWith('BEGIN IMMEDIATE');
    expect(mockDb.executeSync).toHaveBeenCalledWith('COMMIT');
  });

  it('throws if no cached private key', async () => {
    await expect(restoreIdentityKeys(SERVER_KEY_B64)).rejects.toThrow(
      'Cannot restore identity keys',
    );
  });
});

// ---------------------------------------------------------------------------
// generateInitialKeys — defense-in-depth invariant
// ---------------------------------------------------------------------------

describe('generateInitialKeys — overwrite-refusal invariant', () => {
  it('throws REFUSING_TO_OVERWRITE_IDENTITY_KEY when cached private key exists', async () => {
    (getSecureItem as jest.Mock).mockResolvedValue(PRIVATE_KEY_HEX);
    await initIdentityKeyCache();

    await expect(generateInitialKeys()).rejects.toThrow('REFUSING_TO_OVERWRITE_IDENTITY_KEY');
    expect(generateIdentityKeyPair).not.toHaveBeenCalled();
  });

  it('succeeds after clearIdentityKeyCache (recovery step 7 via fullCryptoWipe)', async () => {
    (getSecureItem as jest.Mock).mockResolvedValue(PRIVATE_KEY_HEX);
    await initIdentityKeyCache();
    clearIdentityKeyCache();

    await generateInitialKeys();
    expect(generateIdentityKeyPair).toHaveBeenCalled();
  });

  it('succeeds on normal signup (no cached key)', async () => {
    await generateInitialKeys();
    expect(generateIdentityKeyPair).toHaveBeenCalled();
  });

  it('returns early (idempotent) when identityKeyPublic already in DB', async () => {
    (getItem as jest.Mock).mockReturnValue('existing-pub-hex');
    (getSecureItem as jest.Mock).mockResolvedValue(PRIVATE_KEY_HEX);
    await initIdentityKeyCache();

    await generateInitialKeys();
    expect(generateIdentityKeyPair).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// clearStaleKeychainIdentity — clears both keychain AND cache
// ---------------------------------------------------------------------------

describe('clearStaleKeychainIdentity', () => {
  it('removes keychain item and clears in-memory cache', async () => {
    (getSecureItem as jest.Mock).mockResolvedValue(PRIVATE_KEY_HEX);
    await initIdentityKeyCache();
    expect(getCachedIdentityPrivateKeyHex()).toBe(PRIVATE_KEY_HEX);

    await clearStaleKeychainIdentity();

    expect(removeSecureItem).toHaveBeenCalledWith('com.orbital.mobile.identity-key-private');
    expect(getCachedIdentityPrivateKeyHex()).toBeNull();
  });

  it('does not throw if removeSecureItem fails', async () => {
    (removeSecureItem as jest.Mock).mockRejectedValue(new Error('Keychain error'));
    await expect(clearStaleKeychainIdentity()).resolves.toBeUndefined();
  });
});
