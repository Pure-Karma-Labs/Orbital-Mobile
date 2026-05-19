/**
 * cryptoService — Signal Protocol encryption/decryption orchestration.
 *
 * Uses the preloaded store pattern: TypeScript reads store data from SQLCipher
 * repositories, passes serialized data to Rust via typed Input records, Rust runs
 * libsignal, returns crypto output + store mutations. TypeScript applies mutations
 * in a BEGIN IMMEDIATE ... COMMIT transaction.
 *
 * All write operations acquire a per-address promise-queue lock to prevent
 * concurrent access to the same session state.
 *
 * SECURITY: Private key material (identity key private) appears only in Input types
 * passed to Rust — it is never logged, returned, or persisted by this module.
 */

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
import type {
  EncryptInput,
  EncryptResult,
  DecryptInput,
  DecryptResult,
  DecryptPreKeyInput,
  DecryptPreKeyResult,
  ProcessPreKeyBundleInput,
  ProcessPreKeyBundleResult,
  GroupEncryptInput,
  GroupEncryptResult,
  GroupDecryptInput,
  GroupDecryptResult,
  CreateSenderKeyDistributionInput,
  CreateSenderKeyDistributionResult,
  ProcessSenderKeyDistributionInput,
  ProcessSenderKeyDistributionResult,
  CiphertextMessageData,
  ProtocolAddressData,
  PreKeyBundleData,
  IdentityKeyPairData,
} from 'orbital-signal';
import { getDatabase } from '../../database/connection';
import { getItem } from '../../database/repositories/itemRepository';
import { getSession, saveSession } from '../../database/repositories/signalSessionRepository';
import {
  getPreKey,
  removePreKey,
} from '../../database/repositories/signalPreKeyRepository';
import { getSignedPreKey } from '../../database/repositories/signalSignedPreKeyRepository';
import {
  getKyberPreKey,
  markKyberPreKeyUsed,
} from '../../database/repositories/signalKyberPreKeyRepository';
import {
  getIdentityKey,
  saveIdentityKey,
} from '../../database/repositories/signalIdentityKeyRepository';
import {
  getSenderKey,
  saveSenderKey,
} from '../../database/repositories/signalSenderKeyRepository';
import { getPreKeyBundle } from '../api/keys';
import {
  hexToUint8Array,
  toArrayBuffer,
  base64ToArrayBuffer,
} from './utils';
import type { PreKeyBundleResponse } from '../../types/api';
import { VerifiedStatus } from '../../types/database';
import { useAppStore } from '../../stores/useAppStore';
import { getCachedIdentityPrivateKeyHex } from './keyGenerationService';

// ---------------------------------------------------------------------------
// Per-address operation lock
// ---------------------------------------------------------------------------

const addressLocks = new Map<string, Promise<unknown>>();

async function withAddressLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const existing = addressLocks.get(key) ?? Promise.resolve();
  const next = existing.then(fn, fn);
  addressLocks.set(key, next);
  try {
    return await next;
  } finally {
    if (addressLocks.get(key) === next) {
      addressLocks.delete(key);
    }
  }
}

function addrKey(name: string, deviceId: number): string {
  return `${name}:${deviceId}`;
}

// ---------------------------------------------------------------------------
// Transaction helper
// ---------------------------------------------------------------------------

function withTransaction<T>(fn: () => T): T {
  const db = getDatabase();
  db.executeSync('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.executeSync('COMMIT');
    return result;
  } catch (err) {
    db.executeSync('ROLLBACK');
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Local identity helpers
// ---------------------------------------------------------------------------

function loadIdentityKeyPair(): IdentityKeyPairData {
  const publicHex = getItem('identityKeyPublic');
  const privateHex = getCachedIdentityPrivateKeyHex();
  if (publicHex === null || privateHex === null) {
    throw new Error('Identity key pair not initialized');
  }
  return {
    publicKey: toArrayBuffer(hexToUint8Array(publicHex)),
    privateKey: toArrayBuffer(hexToUint8Array(privateHex)),
  };
}

function loadRegistrationId(): number {
  const str = getItem('registrationId');
  if (str === null) throw new Error('Registration ID not initialized');
  return parseInt(str, 10);
}

function getLocalServiceId(): string {
  const id = useAppStore.getState().userId;
  if (id === null) throw new Error('Not authenticated — userId not available');
  return id;
}

// ---------------------------------------------------------------------------
// Bundle conversion helper
// ---------------------------------------------------------------------------

function bundleResponseToData(resp: PreKeyBundleResponse): PreKeyBundleData {
  return {
    registrationId: resp.registrationId,
    deviceId: resp.deviceId,
    preKeyId: resp.preKey?.keyId,
    preKeyPublic:
      resp.preKey !== null ? base64ToArrayBuffer(resp.preKey.publicKey) : undefined,
    signedPreKeyId: resp.signedPreKey.keyId,
    signedPreKeyPublic: base64ToArrayBuffer(resp.signedPreKey.publicKey),
    signedPreKeySignature: base64ToArrayBuffer(resp.signedPreKey.signature),
    identityKey: base64ToArrayBuffer(resp.identityKey),
    kyberPreKeyId: resp.kyberPreKey?.keyId,
    kyberPreKeyPublic:
      resp.kyberPreKey !== null
        ? base64ToArrayBuffer(resp.kyberPreKey.publicKey)
        : undefined,
    kyberPreKeySignature:
      resp.kyberPreKey !== null
        ? base64ToArrayBuffer(resp.kyberPreKey.signature)
        : undefined,
  };
}

// ---------------------------------------------------------------------------
// establishSession — fetch remote pre-key bundle and run X3DH
// ---------------------------------------------------------------------------

/**
 * Fetch the remote user's pre-key bundle from the server and perform X3DH key
 * agreement to establish an outgoing session. Saves the session and remote identity.
 */
async function establishSession(
  remoteAddress: ProtocolAddressData,
): Promise<void> {
  const localServiceId = getLocalServiceId();
  const bundleResp = await getPreKeyBundle(remoteAddress.name);
  const bundle = bundleResponseToData(bundleResp);

  const identityKeyPair = loadIdentityKeyPair();
  const registrationId = loadRegistrationId();

  const existingSession = getSession(
    localServiceId,
    remoteAddress.name,
    remoteAddress.deviceId,
  );
  const existingIdentity = getIdentityKey(remoteAddress.name);

  const input: ProcessPreKeyBundleInput = {
    identityKeyPair: identityKeyPair,
    registrationId: registrationId,
    remoteAddress: remoteAddress,
    bundle,
    existingSessionRecord: existingSession
      ? toArrayBuffer(existingSession.record)
      : undefined,
    remoteIdentity: existingIdentity
      ? toArrayBuffer(existingIdentity.identity_key)
      : undefined,
  };

  const result: ProcessPreKeyBundleResult = await processPreKeyBundle(input);

  withTransaction(() => {
    saveSession({
      our_service_id: localServiceId,
      service_id: remoteAddress.name,
      device_id: remoteAddress.deviceId,
      record: new Uint8Array(result.updatedSessionRecord),
      version: 2,
    });

    saveIdentityKey({
      address: remoteAddress.name,
      identity_key: new Uint8Array(result.identityKey),
      verified: result.identityChanged
        ? VerifiedStatus.Unverified
        : existingIdentity?.verified ?? VerifiedStatus.Default,
      first_use: existingIdentity?.first_use ?? Math.floor(Date.now() / 1000),
      nonblocking_approval: existingIdentity?.nonblocking_approval ?? 0,
    });
  });
}

// ---------------------------------------------------------------------------
// encrypt — Double Ratchet encrypt (auto-establishes session if needed)
// ---------------------------------------------------------------------------

/**
 * Encrypt a plaintext message for the given remote address using the Double
 * Ratchet protocol. Automatically establishes a session via X3DH if none exists.
 *
 * Returns the ciphertext message data (type + serialized bytes).
 */
export async function encrypt(
  remoteAddress: ProtocolAddressData,
  plaintext: Uint8Array,
): Promise<CiphertextMessageData> {
  const localServiceId = getLocalServiceId();
  const key = addrKey(remoteAddress.name, remoteAddress.deviceId);

  return withAddressLock(key, async () => {
    let session = getSession(
      localServiceId,
      remoteAddress.name,
      remoteAddress.deviceId,
    );

    if (session === null) {
      await establishSession(remoteAddress);
      session = getSession(
        localServiceId,
        remoteAddress.name,
        remoteAddress.deviceId,
      );
      if (session === null) {
        throw new Error(
          `Failed to establish session for ${remoteAddress.name}:${remoteAddress.deviceId}`,
        );
      }
    }

    const identityKeyPair = loadIdentityKeyPair();
    const registrationId = loadRegistrationId();
    const existingIdentity = getIdentityKey(remoteAddress.name);

    const input: EncryptInput = {
      identityKeyPair: identityKeyPair,
      registrationId: registrationId,
      sessionRecord: toArrayBuffer(session.record),
      remoteIdentity: existingIdentity
        ? toArrayBuffer(existingIdentity.identity_key)
        : undefined,
      remoteAddress: remoteAddress,
      plaintext: toArrayBuffer(plaintext),
    };

    const result: EncryptResult = await signalEncrypt(input);

    withTransaction(() => {
      saveSession({
        our_service_id: localServiceId,
        service_id: remoteAddress.name,
        device_id: remoteAddress.deviceId,
        record: new Uint8Array(result.updatedSessionRecord),
        version: 2,
      });
    });

    return result.ciphertext;
  });
}

// ---------------------------------------------------------------------------
// decryptSignalMessage — type 1 (SignalMessage)
// ---------------------------------------------------------------------------

/**
 * Decrypt a type 1 (SignalMessage) envelope. Requires an existing session.
 *
 * Returns the plaintext bytes.
 */
export async function decryptSignalMessage(
  senderAddress: ProtocolAddressData,
  ciphertextBytes: Uint8Array,
): Promise<Uint8Array> {
  const localServiceId = getLocalServiceId();
  const key = addrKey(senderAddress.name, senderAddress.deviceId);

  return withAddressLock(key, async () => {
    const session = getSession(
      localServiceId,
      senderAddress.name,
      senderAddress.deviceId,
    );
    if (session === null) {
      throw new Error(
        `No session found for ${senderAddress.name}:${senderAddress.deviceId}`,
      );
    }

    const identityKeyPair = loadIdentityKeyPair();
    const registrationId = loadRegistrationId();
    const existingIdentity = getIdentityKey(senderAddress.name);

    const input: DecryptInput = {
      identityKeyPair: identityKeyPair,
      registrationId: registrationId,
      senderAddress: senderAddress,
      sessionRecord: toArrayBuffer(session.record),
      remoteIdentity: existingIdentity
        ? toArrayBuffer(existingIdentity.identity_key)
        : undefined,
      ciphertext: toArrayBuffer(ciphertextBytes),
    };

    const result: DecryptResult = await signalDecrypt(input);

    withTransaction(() => {
      saveSession({
        our_service_id: localServiceId,
        service_id: senderAddress.name,
        device_id: senderAddress.deviceId,
        record: new Uint8Array(result.updatedSessionRecord),
        version: 2,
      });
    });

    return new Uint8Array(result.plaintext);
  });
}

// ---------------------------------------------------------------------------
// decryptPreKeyMessage — type 3 (PreKeySignalMessage)
// ---------------------------------------------------------------------------

/**
 * Decrypt a type 3 (PreKeySignalMessage) envelope. Establishes a new incoming
 * session. Consumes pre-keys atomically in a single transaction.
 *
 * Returns the plaintext bytes.
 */
export async function decryptPreKeyMessage(
  senderAddress: ProtocolAddressData,
  ciphertextBytes: Uint8Array,
): Promise<Uint8Array> {
  const localServiceId = getLocalServiceId();
  const key = addrKey(senderAddress.name, senderAddress.deviceId);

  return withAddressLock(key, async () => {
    // Parse message to determine which pre-keys are needed (no crypto)
    const ids = await parsePrekeyMessageIds(toArrayBuffer(ciphertextBytes));

    const identityKeyPair = loadIdentityKeyPair();
    const registrationId = loadRegistrationId();

    const existingSession = getSession(
      localServiceId,
      senderAddress.name,
      senderAddress.deviceId,
    );
    const existingIdentity = getIdentityKey(senderAddress.name);

    // Load the pre-key records identified from the message
    const preKeyRow =
      ids.preKeyId !== undefined ? getPreKey(ids.preKeyId) : null;
    const signedPreKeyRow = getSignedPreKey(ids.signedPreKeyId);
    const kyberPreKeyRow =
      ids.kyberPreKeyId !== undefined
        ? getKyberPreKey(ids.kyberPreKeyId)
        : null;

    if (signedPreKeyRow === null) {
      throw new Error(
        `Signed pre-key ${ids.signedPreKeyId} not found in store`,
      );
    }

    const input: DecryptPreKeyInput = {
      identityKeyPair: identityKeyPair,
      registrationId: registrationId,
      senderAddress: senderAddress,
      existingSessionRecord: existingSession
        ? toArrayBuffer(existingSession.record)
        : undefined,
      remoteIdentity: existingIdentity
        ? toArrayBuffer(existingIdentity.identity_key)
        : undefined,
      preKeyRecord: preKeyRow ? toArrayBuffer(preKeyRow.key_data) : undefined,
      signedPreKeyRecord: toArrayBuffer(signedPreKeyRow.key_data),
      kyberPreKeyRecord: kyberPreKeyRow
        ? toArrayBuffer(kyberPreKeyRow.key_data)
        : undefined,
      ciphertext: toArrayBuffer(ciphertextBytes),
    };

    const result: DecryptPreKeyResult = await signalDecryptPreKey(input);

    // Apply all mutations atomically in a single transaction
    withTransaction(() => {
      saveSession({
        our_service_id: localServiceId,
        service_id: senderAddress.name,
        device_id: senderAddress.deviceId,
        record: new Uint8Array(result.updatedSessionRecord),
        version: 2,
      });

      saveIdentityKey({
        address: senderAddress.name,
        identity_key: new Uint8Array(result.senderIdentityKey),
        verified: result.identityChanged
          ? VerifiedStatus.Unverified
          : existingIdentity?.verified ?? VerifiedStatus.Default,
        first_use:
          existingIdentity?.first_use ?? Math.floor(Date.now() / 1000),
        nonblocking_approval: existingIdentity?.nonblocking_approval ?? 0,
      });

      if (result.consumedPreKeyId !== undefined) {
        removePreKey(result.consumedPreKeyId);
      }

      if (result.consumedKyberPreKeyId !== undefined) {
        markKyberPreKeyUsed(result.consumedKyberPreKeyId);
      }
    });

    return new Uint8Array(result.plaintext);
  });
}

// ---------------------------------------------------------------------------
// decrypt — dispatcher for envelope type
// ---------------------------------------------------------------------------

/** Envelope type constants matching Signal Protocol. */
export const EnvelopeType = {
  /** Standard Double Ratchet message (an ongoing session). */
  CIPHERTEXT: 1,
  /** Pre-key message establishing a new incoming session. */
  PRE_KEY_BUNDLE: 3,
} as const;

export type EnvelopeTypeValue = (typeof EnvelopeType)[keyof typeof EnvelopeType];

/**
 * Decrypt a Signal Protocol envelope. Dispatches to the correct implementation
 * based on envelopeType (1 = SignalMessage, 3 = PreKeySignalMessage).
 */
export async function decrypt(
  senderAddress: ProtocolAddressData,
  ciphertextBytes: Uint8Array,
  envelopeType: EnvelopeTypeValue,
): Promise<Uint8Array> {
  if (envelopeType === EnvelopeType.CIPHERTEXT) {
    return decryptSignalMessage(senderAddress, ciphertextBytes);
  }
  if (envelopeType === EnvelopeType.PRE_KEY_BUNDLE) {
    return decryptPreKeyMessage(senderAddress, ciphertextBytes);
  }
  throw new Error(`Unsupported envelope type: ${String(envelopeType)}`);
}

// ---------------------------------------------------------------------------
// createSenderKeyDistribution
// ---------------------------------------------------------------------------

/**
 * Create a Sender Key Distribution Message for a group. Must be distributed to
 * all group members before sending group messages.
 *
 * Returns the serialized distribution message as a Uint8Array.
 */
export async function createSenderKeyDistribution(
  distributionId: string,
  senderAddress: ProtocolAddressData,
): Promise<Uint8Array> {
  const localServiceId = getLocalServiceId();
  const key = addrKey(senderAddress.name, senderAddress.deviceId);

  return withAddressLock(key, async () => {
    const existingSenderKey = getSenderKey(
      localServiceId,
      senderAddress.name,
      distributionId,
    );

    const input: CreateSenderKeyDistributionInput = {
      senderAddress: senderAddress,
      distributionId: distributionId,
      senderKeyRecord: existingSenderKey
        ? toArrayBuffer(existingSenderKey.record)
        : undefined,
    };

    const result: CreateSenderKeyDistributionResult =
      await createSenderKeyDistributionMessage(input);

    withTransaction(() => {
      saveSenderKey({
        our_service_id: localServiceId,
        sender_id: senderAddress.name,
        distribution_id: distributionId,
        record: new Uint8Array(result.updatedSenderKeyRecord),
        created_at: Math.floor(Date.now() / 1000),
      });
    });

    return new Uint8Array(result.distributionMessage);
  });
}

// ---------------------------------------------------------------------------
// processSenderKeyDistribution
// ---------------------------------------------------------------------------

/**
 * Process an incoming Sender Key Distribution Message from a group member.
 * The distributionId must be provided (available from the group message envelope).
 * Must be called before decrypting group messages from that sender.
 */
export async function processSenderKeyDistribution(
  senderAddress: ProtocolAddressData,
  distributionId: string,
  distributionMessage: Uint8Array,
): Promise<void> {
  const localServiceId = getLocalServiceId();
  const key = addrKey(senderAddress.name, senderAddress.deviceId);

  await withAddressLock(key, async () => {
    const existingSenderKey = getSenderKey(
      localServiceId,
      senderAddress.name,
      distributionId,
    );

    const input: ProcessSenderKeyDistributionInput = {
      senderAddress: senderAddress,
      distributionMessage: toArrayBuffer(distributionMessage),
      senderKeyRecord: existingSenderKey
        ? toArrayBuffer(existingSenderKey.record)
        : undefined,
    };

    const result: ProcessSenderKeyDistributionResult =
      await processSenderKeyDistributionMessage(input);

    withTransaction(() => {
      saveSenderKey({
        our_service_id: localServiceId,
        sender_id: senderAddress.name,
        distribution_id: distributionId,
        record: new Uint8Array(result.updatedSenderKeyRecord),
        created_at: Math.floor(Date.now() / 1000),
      });
    });
  });
}

// ---------------------------------------------------------------------------
// encryptGroup — Sender Key group encryption
// ---------------------------------------------------------------------------

/**
 * Encrypt a plaintext message for a group using Sender Keys.
 * Must have called `createSenderKeyDistribution` and sent the distribution
 * message to all members before the first group message.
 *
 * Returns the serialized ciphertext as a Uint8Array.
 */
export async function encryptGroup(
  distributionId: string,
  senderAddress: ProtocolAddressData,
  plaintext: Uint8Array,
): Promise<Uint8Array> {
  const localServiceId = getLocalServiceId();
  const key = addrKey(senderAddress.name, senderAddress.deviceId);

  return withAddressLock(key, async () => {
    const existingSenderKey = getSenderKey(
      localServiceId,
      senderAddress.name,
      distributionId,
    );

    const input: GroupEncryptInput = {
      senderAddress: senderAddress,
      distributionId: distributionId,
      senderKeyRecord: existingSenderKey
        ? toArrayBuffer(existingSenderKey.record)
        : undefined,
      plaintext: toArrayBuffer(plaintext),
    };

    const result: GroupEncryptResult = await groupEncrypt(input);

    withTransaction(() => {
      saveSenderKey({
        our_service_id: localServiceId,
        sender_id: senderAddress.name,
        distribution_id: distributionId,
        record: new Uint8Array(result.updatedSenderKeyRecord),
        created_at: Math.floor(Date.now() / 1000),
      });
    });

    return new Uint8Array(result.ciphertext);
  });
}

// ---------------------------------------------------------------------------
// decryptGroup — Sender Key group decryption
// ---------------------------------------------------------------------------

/**
 * Decrypt a group message ciphertext using the sender's Sender Key.
 * Must have processed the sender's Sender Key Distribution Message first.
 *
 * Returns the plaintext bytes.
 */
export async function decryptGroup(
  senderAddress: ProtocolAddressData,
  distributionId: string,
  ciphertextBytes: Uint8Array,
): Promise<Uint8Array> {
  const localServiceId = getLocalServiceId();
  const key = addrKey(senderAddress.name, senderAddress.deviceId);

  return withAddressLock(key, async () => {
    const existingSenderKey = getSenderKey(
      localServiceId,
      senderAddress.name,
      distributionId,
    );

    const input: GroupDecryptInput = {
      senderAddress: senderAddress,
      senderKeyRecord: existingSenderKey
        ? toArrayBuffer(existingSenderKey.record)
        : undefined,
      ciphertext: toArrayBuffer(ciphertextBytes),
    };

    const result: GroupDecryptResult = await groupDecrypt(input);

    withTransaction(() => {
      saveSenderKey({
        our_service_id: localServiceId,
        sender_id: senderAddress.name,
        distribution_id: distributionId,
        record: new Uint8Array(result.updatedSenderKeyRecord),
        created_at: Math.floor(Date.now() / 1000),
      });
    });

    return new Uint8Array(result.plaintext);
  });
}
