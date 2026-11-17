/**
 * Regression tests for #999 — "Creating an orbit fails after logout → login
 * until the app is restarted".
 *
 * `localWipe` clears the in-memory identity private key on logout (it must:
 * the key may not sit in memory for an unauthenticated process), but logout
 * with `preserveIdentity: true` keeps BOTH the Keychain copy and the stored
 * `identityKeyPublic`. Nothing on the re-login path put the key back —
 * `attemptKeychainIdentityRestore` returns 'none' the moment it sees a stored
 * public key, and `ensureKeysInitialized` skips generation for the same
 * reason — so every `getIdentityKeyPair()` consumer threw for the rest of the
 * process lifetime.
 *
 * These tests drive the REAL keyGenerationService cache, the REAL
 * identityKeyAccess consumer and the REAL identityKeyProbe over an in-memory
 * Keychain + items table, so the sequence they assert is the user's sequence:
 * app start → logout → login → use the key pair.
 */

// ---------------------------------------------------------------------------
// Mocks — MUST come before imports
// ---------------------------------------------------------------------------

jest.mock('orbital-signal', () => ({
  // The probe's two calls. Left as jest.fn() (resolving to undefined) so the
  // DEFAULT is a successful round trip — a real seal/open needs the native
  // module. Mismatch and inconclusive-failure cases override them.
  eciesSeal: jest.fn(),
  eciesOpen: jest.fn(),
  SignalError_Tags: {
    InvalidKey: 'InvalidKey',
    InvalidMessage: 'InvalidMessage',
    InvalidArgument: 'InvalidArgument',
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

// In-memory items table — shared by keyGenerationService and identityKeyAccess.
const mockItemStore = new Map<string, string>();
jest.mock('../../../database/repositories/itemRepository', () => ({
  getItem: (key: string) => (mockItemStore.has(key) ? (mockItemStore.get(key) as string) : null),
  setItem: (key: string, value: string) => {
    mockItemStore.set(key, value);
  },
  removeItem: (key: string) => {
    mockItemStore.delete(key);
  },
}));

// In-memory Keychain.
const mockKeychainStore = new Map<string, string>();
const mockRemoveSecureItem = jest.fn(async (key: string) => {
  mockKeychainStore.delete(key);
});
jest.mock('../../secure-storage', () => ({
  getSecureItem: async (key: string) =>
    mockKeychainStore.has(key) ? (mockKeychainStore.get(key) as string) : null,
  setSecureItem: async (key: string, value: string) => {
    mockKeychainStore.set(key, value);
  },
  removeSecureItem: (key: string) => mockRemoveSecureItem(key),
}));

jest.mock('../../api/keys', () => ({
  fetchRemoteIdentityKeyBundle: jest.fn(),
  uploadPreKeyBundle: jest.fn(),
  getPreKeyCount: jest.fn(),
}));

jest.mock('../../../database/repositories/signalIdentityKeyRepository', () => ({
  getIdentityKey: jest.fn(() => null),
  saveIdentityKey: jest.fn(),
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
  getDatabase: jest.fn(() => ({ executeSync: jest.fn() })),
  isDatabaseInitialized: jest.fn(() => true),
}));

jest.mock('../../../database/queryHelpers', () => ({
  queryOne: jest.fn(),
  execute: jest.fn(),
}));

// Mocked for the reason the other crypto suites mock them: the real modules
// reach useAppStore (and so MMKV, which has no native module under Jest).
jest.mock('../contentCrypto', () => ({
  clearGroupKeyCache: jest.fn(),
  clearContentCryptoInflight: jest.fn(),
}));
jest.mock('../importCrypto', () => ({
  closeAllImportKeySessions: jest.fn(),
}));
jest.mock('../../../database/repositories/conversationRepository', () => ({
  clearAllGroupCryptoState: jest.fn(),
}));

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import { eciesSeal, eciesOpen } from 'orbital-signal';
import {
  initIdentityKeyCache,
  clearIdentityKeyCache,
  getCachedIdentityPrivateKeyHex,
  reloadIdentityKeyCacheIfEmpty,
} from '../keyGenerationService';
import { getIdentityKeyPair } from '../identityKeyAccess';
import { uint8ArrayToHex } from '../utils';
import { SecureKeys } from '../../secure-storage/constants';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** 32-byte Curve25519 private key. */
const PRIVATE_KEY_HEX = '02'.repeat(32);
/** 33-byte Signal-format public key (0x05 prefix + 32 bytes). */
const PUBLIC_KEY_HEX = `05${'01'.repeat(32)}`;

/** Verbatim reason emitted by ecies_seal on a sender key-pair mismatch. */
const SEAL_MISMATCH_REASON = 'ecies_seal: sender_public_key does not match sender_private_key';

/**
 * Error shaped like a uniffi-lifted SignalError: message is the variant name,
 * `tag` is the discriminant, payload fields live on `inner`.
 */
function makeSignalError(tag: string, reason: string): Error {
  const err = new Error(`SignalError.${tag}`);
  Object.assign(err, { tag, inner: { reason } });
  return err;
}

/** The state logout leaves behind: Keychain + items intact, cache cleared. */
function seedRegisteredIdentity(): void {
  mockKeychainStore.set(SecureKeys.IDENTITY_KEY_PRIVATE, PRIVATE_KEY_HEX);
  mockItemStore.set('identityKeyPublic', PUBLIC_KEY_HEX);
}

beforeEach(() => {
  jest.clearAllMocks();
  // mockReset, not clearAllMocks: a throwing mockImplementation from a
  // mismatch/failure case SURVIVES clearAllMocks and would silently turn
  // every later probe into 'reloaded-unproven'.
  (eciesSeal as jest.Mock).mockReset();
  (eciesOpen as jest.Mock).mockReset();
  mockItemStore.clear();
  mockKeychainStore.clear();
  clearIdentityKeyCache();
});

// ---------------------------------------------------------------------------
// The bug
// ---------------------------------------------------------------------------

describe('#999 logout → login in one process', () => {
  it('leaves the key pair usable after re-login (bug: threw until app restart)', async () => {
    seedRegisteredIdentity();

    // --- App start ---
    await initIdentityKeyCache();
    const before = getIdentityKeyPair();
    expect(uint8ArrayToHex(new Uint8Array(before.privateKey))).toBe(PRIVATE_KEY_HEX);

    // --- Logout (localWipe, preserveIdentity: true) ---
    clearIdentityKeyCache();
    expect(() => getIdentityKeyPair()).toThrow('Identity key pair not available');
    // Logout keeps both durable copies — only memory was cleared.
    expect(mockKeychainStore.get(SecureKeys.IDENTITY_KEY_PRIVATE)).toBe(PRIVATE_KEY_HEX);
    expect(mockItemStore.get('identityKeyPublic')).toBe(PUBLIC_KEY_HEX);

    // --- Login (postAuthBootstrap step 0) ---
    await expect(reloadIdentityKeyCacheIfEmpty()).resolves.toBe('reloaded');

    // --- Every consumer works again, with the SAME key pair ---
    const after = getIdentityKeyPair();
    expect(uint8ArrayToHex(new Uint8Array(after.privateKey))).toBe(PRIVATE_KEY_HEX);
    expect(uint8ArrayToHex(new Uint8Array(after.publicKey))).toBe(PUBLIC_KEY_HEX);
  });

  it('proves the reloaded private key against the STORED public key', async () => {
    seedRegisteredIdentity();

    await reloadIdentityKeyCacheIfEmpty();

    expect(eciesSeal).toHaveBeenCalledTimes(1);
    const sealArgs = (eciesSeal as jest.Mock).mock.calls[0] as ArrayBuffer[];
    // (plaintext, context, recipientPub, senderPriv, senderPub)
    expect(uint8ArrayToHex(new Uint8Array(sealArgs[2]))).toBe(PUBLIC_KEY_HEX);
    expect(uint8ArrayToHex(new Uint8Array(sealArgs[3]))).toBe(PRIVATE_KEY_HEX);
    expect(uint8ArrayToHex(new Uint8Array(sealArgs[4]))).toBe(PUBLIC_KEY_HEX);
  });
});

// ---------------------------------------------------------------------------
// The reload must never resurrect a key that is not this account's
// ---------------------------------------------------------------------------

describe('reloadIdentityKeyCacheIfEmpty — wrong-identity refusal', () => {
  it('leaves the cache EMPTY when the Keychain key is not the stored pair', async () => {
    seedRegisteredIdentity();
    (eciesSeal as jest.Mock).mockImplementation(() => {
      throw makeSignalError('InvalidArgument', SEAL_MISMATCH_REASON);
    });

    await expect(reloadIdentityKeyCacheIfEmpty()).resolves.toBe('mismatch');

    expect(getCachedIdentityPrivateKeyHex()).toBeNull();
    expect(() => getIdentityKeyPair()).toThrow('Identity key pair not available');
  });

  it('does NOT delete the Keychain key on mismatch (only the restore path may)', async () => {
    seedRegisteredIdentity();
    (eciesSeal as jest.Mock).mockImplementation(() => {
      throw makeSignalError('InvalidArgument', SEAL_MISMATCH_REASON);
    });

    await reloadIdentityKeyCacheIfEmpty();

    expect(mockRemoveSecureItem).not.toHaveBeenCalled();
    expect(mockKeychainStore.get(SecureKeys.IDENTITY_KEY_PRIVATE)).toBe(PRIVATE_KEY_HEX);
  });

  it('keeps the key on an INCONCLUSIVE probe failure, reported as unproven', async () => {
    seedRegisteredIdentity();
    (eciesSeal as jest.Mock).mockImplementation(() => {
      throw makeSignalError('InternalError', 'native module unavailable');
    });

    await expect(reloadIdentityKeyCacheIfEmpty()).resolves.toBe('reloaded-unproven');

    // A non-mismatch failure is not evidence of a wrong key: the cache holds
    // exactly what app start would have loaded without any probe at all.
    expect(getCachedIdentityPrivateKeyHex()).toBe(PRIVATE_KEY_HEX);
  });
});

// ---------------------------------------------------------------------------
// Other post-auth shapes
// ---------------------------------------------------------------------------

describe('reloadIdentityKeyCacheIfEmpty — other shapes', () => {
  it('is a no-op when the cache is already warm (no probe, no Keychain read)', async () => {
    seedRegisteredIdentity();
    await initIdentityKeyCache();

    await expect(reloadIdentityKeyCacheIfEmpty()).resolves.toBe('already-loaded');

    expect(eciesSeal).not.toHaveBeenCalled();
    expect(getCachedIdentityPrivateKeyHex()).toBe(PRIVATE_KEY_HEX);
  });

  it("returns 'absent' with an empty cache when no key material exists", async () => {
    await expect(reloadIdentityKeyCacheIfEmpty()).resolves.toBe('absent');

    expect(getCachedIdentityPrivateKeyHex()).toBeNull();
    expect(eciesSeal).not.toHaveBeenCalled();
  });

  it('loads unproven when there is no stored public key (reinstall shape)', async () => {
    // DB wiped, Keychain survived: nothing local to prove against. The key
    // must still be loaded — attemptKeychainIdentityRestore runs next and
    // needs it to perform the server-side proof.
    mockKeychainStore.set(SecureKeys.IDENTITY_KEY_PRIVATE, PRIVATE_KEY_HEX);

    await expect(reloadIdentityKeyCacheIfEmpty()).resolves.toBe('reloaded-unproven');

    expect(getCachedIdentityPrivateKeyHex()).toBe(PRIVATE_KEY_HEX);
    expect(eciesSeal).not.toHaveBeenCalled();
  });

  it('migrates a pre-Keychain private key out of SQLCipher, as app start does', async () => {
    mockItemStore.set('identityKeyPrivate', PRIVATE_KEY_HEX);
    mockItemStore.set('identityKeyPublic', PUBLIC_KEY_HEX);

    await expect(reloadIdentityKeyCacheIfEmpty()).resolves.toBe('reloaded');

    expect(mockKeychainStore.get(SecureKeys.IDENTITY_KEY_PRIVATE)).toBe(PRIVATE_KEY_HEX);
    expect(mockItemStore.has('identityKeyPrivate')).toBe(false);
    expect(getCachedIdentityPrivateKeyHex()).toBe(PRIVATE_KEY_HEX);
  });
});
