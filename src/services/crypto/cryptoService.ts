/**
 * cryptoService — Signal Protocol Sender Key group encryption/decryption.
 *
 * 1:1 Signal session code (encrypt, decrypt, establishSession) was removed
 * because Orbital uses ECIES for key wrapping, not Signal sessions.
 * See backend issue #33.
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
  groupEncrypt,
  groupDecrypt,
  createSenderKeyDistributionMessage,
  processSenderKeyDistributionMessage,
} from 'orbital-signal';
import type {
  GroupEncryptInput,
  GroupEncryptResult,
  GroupDecryptInput,
  GroupDecryptResult,
  CreateSenderKeyDistributionInput,
  CreateSenderKeyDistributionResult,
  ProcessSenderKeyDistributionInput,
  ProcessSenderKeyDistributionResult,
} from 'orbital-signal';
import { getDatabase } from '../../database/connection';
import {
  getSenderKey,
  saveSenderKey,
} from '../../database/repositories/signalSenderKeyRepository';
import { toArrayBuffer } from './utils';
import { useAppStore } from '../../stores/useAppStore';

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

function getLocalServiceId(): string {
  const id = useAppStore.getState().userId;
  if (id === null) throw new Error('Not authenticated — userId not available');
  return id;
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
  senderAddress: { name: string; deviceId: number },
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
  senderAddress: { name: string; deviceId: number },
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
  senderAddress: { name: string; deviceId: number },
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
  senderAddress: { name: string; deviceId: number },
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
