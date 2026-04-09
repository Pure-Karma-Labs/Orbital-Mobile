import {
  generateIdentityKeyPair,
  generatePreKey,
  generateSignedPreKey,
  generateKyberPreKey,
  getPreKeyPublic,
  getSignedPreKeyPublic,
  getKyberPreKeyPublic,
} from 'orbital-signal';
import { getItem, setItem, removeItem } from '../../database/repositories/itemRepository';
import { savePreKey } from '../../database/repositories/signalPreKeyRepository';
import { saveSignedPreKey } from '../../database/repositories/signalSignedPreKeyRepository';
import { saveKyberPreKey } from '../../database/repositories/signalKyberPreKeyRepository';
import { getDatabase } from '../../database/connection';
import { queryOne } from '../../database/queryHelpers';
import {
  uploadPreKeyBundle as uploadBundle,
  getPreKeyCount,
} from '../api/keys';
import {
  hexToUint8Array,
  uint8ArrayToHex,
  arrayBufferToBase64,
  toArrayBuffer,
} from './utils';
import type {
  UploadPreKeyBundleRequest,
  PreKeyPublicUpload,
  KyberPreKeyPublicUpload,
} from '../../types/api';
import { getSecureItem, setSecureItem } from '../secure-storage';
import { SecureKeys } from '../secure-storage/constants';

const ITEM_KEYS = {
  IDENTITY_KEY_PUBLIC: 'identityKeyPublic',
  REGISTRATION_ID: 'registrationId',
  NEXT_PRE_KEY_ID: 'nextPreKeyId',
  NEXT_SIGNED_PRE_KEY_ID: 'nextSignedPreKeyId',
  NEXT_KYBER_PRE_KEY_ID: 'nextKyberPreKeyId',
  LAST_SIGNED_PRE_KEY_ROTATION: 'lastSignedPreKeyRotation',
  ACTIVE_SIGNED_PRE_KEY_ID: 'activeSignedPreKeyId',
  LAST_RESORT_KYBER_PRE_KEY_ID: 'lastResortKyberPreKeyId',
  BUNDLE_UPLOADED: 'bundleUploaded',
} as const;

const PRE_KEY_BATCH_SIZE = 100;
const REPLENISHMENT_THRESHOLD = 20;
const SIGNED_PRE_KEY_ROTATION_SECONDS = 7 * 24 * 60 * 60;
const DEVICE_ID = 1;

let cachedPrivateKeyHex: string | null = null;
let initializationPromise: Promise<void> | null = null;

/**
 * Load the identity private key into the module-scoped cache.
 *
 * On first boot after migration: key will be in Keychain already.
 * On pre-migration installs: key is in SQLCipher — migrate it to Keychain
 * then remove the plaintext copy from the database.
 */
export async function initIdentityKeyCache(): Promise<void> {
  // 1. Try Keychain first (new installs and migrated users)
  const fromKeychain = await getSecureItem(SecureKeys.IDENTITY_KEY_PRIVATE);
  if (fromKeychain !== null) {
    cachedPrivateKeyHex = fromKeychain;
    return;
  }

  // 2. Fallback: read from SQLCipher items table (pre-migration users)
  const fromDb = getItem('identityKeyPrivate');
  if (fromDb === null) {
    return; // No identity key anywhere — user hasn't registered yet
  }

  // 3. Migrate: write to Keychain, then remove from SQLCipher
  await setSecureItem(SecureKeys.IDENTITY_KEY_PRIVATE, fromDb);
  removeItem('identityKeyPrivate');
  cachedPrivateKeyHex = fromDb;
}

export function getCachedIdentityPrivateKeyHex(): string | null {
  return cachedPrivateKeyHex;
}

type KeyDataRow = { key_data: Uint8Array };

export async function generateInitialKeys(): Promise<void> {
  if (getItem(ITEM_KEYS.IDENTITY_KEY_PUBLIC) !== null) {
    return;
  }

  const buf = new Uint8Array(4);
  const cryptoGlobal = (globalThis as unknown as { crypto: { getRandomValues: (a: Uint8Array) => void } }).crypto;
  cryptoGlobal.getRandomValues(buf);
  const registrationId =
    (((buf[0] | (buf[1] << 8) | (buf[2] << 16) | ((buf[3] & 0x3f) << 24)) >>> 0) %
      0x3fffffff) +
    1;

  const identityKeyPair = generateIdentityKeyPair();
  const nowBigInt = BigInt(Date.now());
  const nowSeconds = Math.floor(Date.now() / 1000);

  const firstPreKeyId = 1;
  const preKeyRecords: { id: number; record: ArrayBuffer }[] = [];
  for (let i = 0; i < PRE_KEY_BATCH_SIZE; i++) {
    const id = firstPreKeyId + i;
    preKeyRecords.push({ id, record: generatePreKey(id) });
  }

  const signedPreKeyId = 1;
  const signedPreKeyRecord = generateSignedPreKey(signedPreKeyId, identityKeyPair, nowBigInt);

  const firstKyberPreKeyId = 1;
  const kyberPreKeyRecords: { id: number; record: ArrayBuffer; isLastResort: boolean }[] = [];
  for (let i = 0; i < PRE_KEY_BATCH_SIZE; i++) {
    const id = firstKyberPreKeyId + i;
    const result = await generateKyberPreKey(id, identityKeyPair, nowBigInt, false);
    kyberPreKeyRecords.push({ id, record: result.record, isLastResort: false });
  }
  const lastResortKyberId = firstKyberPreKeyId + PRE_KEY_BATCH_SIZE;
  const lastResortResult = await generateKyberPreKey(
    lastResortKyberId,
    identityKeyPair,
    nowBigInt,
    true,
  );
  kyberPreKeyRecords.push({ id: lastResortKyberId, record: lastResortResult.record, isLastResort: true });

  const privateHex = uint8ArrayToHex(new Uint8Array(identityKeyPair.privateKey));
  await setSecureItem(SecureKeys.IDENTITY_KEY_PRIVATE, privateHex);
  cachedPrivateKeyHex = privateHex;

  const db = getDatabase();
  db.executeSync('BEGIN IMMEDIATE');
  try {
    setItem(ITEM_KEYS.IDENTITY_KEY_PUBLIC, uint8ArrayToHex(new Uint8Array(identityKeyPair.publicKey)));
    setItem(ITEM_KEYS.REGISTRATION_ID, String(registrationId));
    setItem(ITEM_KEYS.NEXT_PRE_KEY_ID, String(firstPreKeyId + PRE_KEY_BATCH_SIZE));
    setItem(ITEM_KEYS.NEXT_SIGNED_PRE_KEY_ID, String(signedPreKeyId + 1));
    setItem(ITEM_KEYS.NEXT_KYBER_PRE_KEY_ID, String(lastResortKyberId + 1));
    setItem(ITEM_KEYS.LAST_SIGNED_PRE_KEY_ROTATION, String(nowSeconds));
    setItem(ITEM_KEYS.ACTIVE_SIGNED_PRE_KEY_ID, String(signedPreKeyId));
    setItem(ITEM_KEYS.LAST_RESORT_KYBER_PRE_KEY_ID, String(lastResortKyberId));

    for (const { id, record } of preKeyRecords) {
      savePreKey({ id, key_data: new Uint8Array(record), created_at: nowSeconds });
    }

    saveSignedPreKey({
      id: signedPreKeyId,
      key_data: new Uint8Array(signedPreKeyRecord),
      created_at: nowSeconds,
      confirmed: 0,
    });

    for (const { id, record, isLastResort } of kyberPreKeyRecords) {
      saveKyberPreKey({
        id,
        key_data: new Uint8Array(record),
        is_last_resort: isLastResort ? 1 : 0,
        created_at: nowSeconds,
      });
    }

    db.executeSync('COMMIT');
  } catch (err) {
    db.executeSync('ROLLBACK');
    throw err;
  }
}

export async function uploadInitialPreKeyBundle(): Promise<void> {
  const publicHex = getItem(ITEM_KEYS.IDENTITY_KEY_PUBLIC);
  const registrationIdStr = getItem(ITEM_KEYS.REGISTRATION_ID);
  const nextPreKeyIdStr = getItem(ITEM_KEYS.NEXT_PRE_KEY_ID);
  const activeSignedPreKeyIdStr = getItem(ITEM_KEYS.ACTIVE_SIGNED_PRE_KEY_ID);
  const nextKyberPreKeyIdStr = getItem(ITEM_KEYS.NEXT_KYBER_PRE_KEY_ID);
  const lastResortKyberPreKeyIdStr = getItem(ITEM_KEYS.LAST_RESORT_KYBER_PRE_KEY_ID);

  if (
    publicHex === null ||
    registrationIdStr === null ||
    nextPreKeyIdStr === null ||
    activeSignedPreKeyIdStr === null ||
    nextKyberPreKeyIdStr === null ||
    lastResortKyberPreKeyIdStr === null
  ) {
    throw new Error('Cannot upload bundle — keys not initialized');
  }

  const registrationId = parseInt(registrationIdStr, 10);
  const nextPreKeyId = parseInt(nextPreKeyIdStr, 10);
  const activeSignedPreKeyId = parseInt(activeSignedPreKeyIdStr, 10);
  const nextKyberPreKeyId = parseInt(nextKyberPreKeyIdStr, 10);
  const lastResortKyberPreKeyId = parseInt(lastResortKyberPreKeyIdStr, 10);

  const identityKey = arrayBufferToBase64(toArrayBuffer(hexToUint8Array(publicHex)));

  const preKeys: PreKeyPublicUpload[] = [];
  for (let id = 1; id < nextPreKeyId; id++) {
    const row = queryOne<KeyDataRow>(
      'SELECT key_data FROM signal_pre_keys WHERE id = ?',
      [id],
    );
    if (row === null) continue;
    const pub = getPreKeyPublic(toArrayBuffer(row.key_data));
    preKeys.push({ keyId: pub.id, publicKey: arrayBufferToBase64(pub.publicKey) });
  }

  const signedPreKeyRow = queryOne<KeyDataRow>(
    'SELECT key_data FROM signal_signed_pre_keys WHERE id = ?',
    [activeSignedPreKeyId],
  );
  if (signedPreKeyRow === null) {
    throw new Error(`Signed pre-key ${activeSignedPreKeyId} not found in database`);
  }
  const signedPub = getSignedPreKeyPublic(toArrayBuffer(signedPreKeyRow.key_data));

  const kyberPreKeys: KyberPreKeyPublicUpload[] = [];
  for (let id = 1; id < nextKyberPreKeyId; id++) {
    if (id === lastResortKyberPreKeyId) continue;
    const row = queryOne<KeyDataRow>(
      'SELECT key_data FROM signal_kyber_pre_keys WHERE id = ?',
      [id],
    );
    if (row === null) continue;
    const pub = getKyberPreKeyPublic(toArrayBuffer(row.key_data));
    kyberPreKeys.push({
      keyId: pub.id,
      publicKey: arrayBufferToBase64(pub.publicKey),
      signature: arrayBufferToBase64(pub.signature),
    });
  }

  const lastResortRow = queryOne<KeyDataRow>(
    'SELECT key_data FROM signal_kyber_pre_keys WHERE id = ?',
    [lastResortKyberPreKeyId],
  );
  if (lastResortRow === null) {
    throw new Error(`Last-resort Kyber pre-key ${lastResortKyberPreKeyId} not found in database`);
  }
  const lastResortPub = getKyberPreKeyPublic(toArrayBuffer(lastResortRow.key_data));

  const payload: UploadPreKeyBundleRequest = {
    registrationId,
    deviceId: DEVICE_ID,
    identityKey,
    signedPreKey: {
      keyId: signedPub.id,
      publicKey: arrayBufferToBase64(signedPub.publicKey),
      signature: arrayBufferToBase64(signedPub.signature),
    },
    preKeys,
    kyberPreKeys,
    lastResortKyberPreKey: {
      keyId: lastResortPub.id,
      publicKey: arrayBufferToBase64(lastResortPub.publicKey),
      signature: arrayBufferToBase64(lastResortPub.signature),
      lastResort: true,
    },
  };

  await uploadBundle(payload);
  setItem(ITEM_KEYS.BUNDLE_UPLOADED, '1');
}

export async function checkAndReplenishPreKeys(): Promise<void> {
  const { count } = await getPreKeyCount();
  if (count >= REPLENISHMENT_THRESHOLD) return;

  const nextPreKeyIdStr = getItem(ITEM_KEYS.NEXT_PRE_KEY_ID);
  const nextKyberPreKeyIdStr = getItem(ITEM_KEYS.NEXT_KYBER_PRE_KEY_ID);
  const identityKeyPublicHex = getItem(ITEM_KEYS.IDENTITY_KEY_PUBLIC);
  const identityKeyPrivateHex = getCachedIdentityPrivateKeyHex();

  if (
    nextPreKeyIdStr === null ||
    nextKyberPreKeyIdStr === null ||
    identityKeyPublicHex === null ||
    identityKeyPrivateHex === null
  ) {
    return;
  }

  const startPreKeyId = parseInt(nextPreKeyIdStr, 10);
  const startKyberKeyId = parseInt(nextKyberPreKeyIdStr, 10);
  const nowSeconds = Math.floor(Date.now() / 1000);
  const nowBigInt = BigInt(Date.now());
  const identityKeyPair = {
    publicKey: toArrayBuffer(hexToUint8Array(identityKeyPublicHex)),
    privateKey: toArrayBuffer(hexToUint8Array(identityKeyPrivateHex)),
  };

  const newPreKeyRecords: { id: number; record: ArrayBuffer }[] = [];
  for (let i = 0; i < PRE_KEY_BATCH_SIZE; i++) {
    const id = startPreKeyId + i;
    newPreKeyRecords.push({ id, record: generatePreKey(id) });
  }

  const newKyberPreKeyRecords: { id: number; record: ArrayBuffer }[] = [];
  for (let i = 0; i < PRE_KEY_BATCH_SIZE; i++) {
    const id = startKyberKeyId + i;
    const result = await generateKyberPreKey(id, identityKeyPair, nowBigInt, false);
    newKyberPreKeyRecords.push({ id, record: result.record });
  }

  const db = getDatabase();
  db.executeSync('BEGIN IMMEDIATE');
  try {
    for (const { id, record } of newPreKeyRecords) {
      savePreKey({ id, key_data: new Uint8Array(record), created_at: nowSeconds });
    }
    for (const { id, record } of newKyberPreKeyRecords) {
      saveKyberPreKey({ id, key_data: new Uint8Array(record), is_last_resort: 0, created_at: nowSeconds });
    }
    setItem(ITEM_KEYS.NEXT_PRE_KEY_ID, String(startPreKeyId + PRE_KEY_BATCH_SIZE));
    setItem(ITEM_KEYS.NEXT_KYBER_PRE_KEY_ID, String(startKyberKeyId + PRE_KEY_BATCH_SIZE));
    db.executeSync('COMMIT');
  } catch (err) {
    db.executeSync('ROLLBACK');
    throw err;
  }

  const registrationIdStr = getItem(ITEM_KEYS.REGISTRATION_ID);
  const activeSignedPreKeyIdStr = getItem(ITEM_KEYS.ACTIVE_SIGNED_PRE_KEY_ID);
  const lastResortKyberPreKeyIdStr = getItem(ITEM_KEYS.LAST_RESORT_KYBER_PRE_KEY_ID);

  if (registrationIdStr === null || activeSignedPreKeyIdStr === null || lastResortKyberPreKeyIdStr === null) {
    return;
  }

  const activeSignedPreKeyId = parseInt(activeSignedPreKeyIdStr, 10);
  const lastResortKyberPreKeyId = parseInt(lastResortKyberPreKeyIdStr, 10);

  const signedPreKeyRow = queryOne<KeyDataRow>(
    'SELECT key_data FROM signal_signed_pre_keys WHERE id = ?',
    [activeSignedPreKeyId],
  );
  const lastResortRow = queryOne<KeyDataRow>(
    'SELECT key_data FROM signal_kyber_pre_keys WHERE id = ?',
    [lastResortKyberPreKeyId],
  );
  if (signedPreKeyRow === null || lastResortRow === null) return;

  const signedPub = getSignedPreKeyPublic(toArrayBuffer(signedPreKeyRow.key_data));
  const lastResortPub = getKyberPreKeyPublic(toArrayBuffer(lastResortRow.key_data));

  const preKeys: PreKeyPublicUpload[] = newPreKeyRecords.map(({ record }) => {
    const pub = getPreKeyPublic(record);
    return { keyId: pub.id, publicKey: arrayBufferToBase64(pub.publicKey) };
  });
  const kyberPreKeys: KyberPreKeyPublicUpload[] = newKyberPreKeyRecords.map(({ record }) => {
    const pub = getKyberPreKeyPublic(record);
    return {
      keyId: pub.id,
      publicKey: arrayBufferToBase64(pub.publicKey),
      signature: arrayBufferToBase64(pub.signature),
    };
  });

  const payload: UploadPreKeyBundleRequest = {
    registrationId: parseInt(registrationIdStr, 10),
    deviceId: DEVICE_ID,
    identityKey: arrayBufferToBase64(toArrayBuffer(hexToUint8Array(identityKeyPublicHex))),
    signedPreKey: {
      keyId: signedPub.id,
      publicKey: arrayBufferToBase64(signedPub.publicKey),
      signature: arrayBufferToBase64(signedPub.signature),
    },
    preKeys,
    kyberPreKeys,
    lastResortKyberPreKey: {
      keyId: lastResortPub.id,
      publicKey: arrayBufferToBase64(lastResortPub.publicKey),
      signature: arrayBufferToBase64(lastResortPub.signature),
      lastResort: true,
    },
  };

  await uploadBundle(payload);
}

export async function checkAndRotateSignedPreKey(): Promise<void> {
  const lastRotationStr = getItem(ITEM_KEYS.LAST_SIGNED_PRE_KEY_ROTATION);
  const nowSeconds = Math.floor(Date.now() / 1000);

  if (lastRotationStr !== null) {
    const elapsed = nowSeconds - parseInt(lastRotationStr, 10);
    if (elapsed < SIGNED_PRE_KEY_ROTATION_SECONDS) return;
  }

  const nextSignedPreKeyIdStr = getItem(ITEM_KEYS.NEXT_SIGNED_PRE_KEY_ID);
  const identityKeyPublicHex = getItem(ITEM_KEYS.IDENTITY_KEY_PUBLIC);
  const identityKeyPrivateHex = getCachedIdentityPrivateKeyHex();
  const registrationIdStr = getItem(ITEM_KEYS.REGISTRATION_ID);
  const lastResortKyberPreKeyIdStr = getItem(ITEM_KEYS.LAST_RESORT_KYBER_PRE_KEY_ID);

  if (
    nextSignedPreKeyIdStr === null ||
    identityKeyPublicHex === null ||
    identityKeyPrivateHex === null ||
    registrationIdStr === null ||
    lastResortKyberPreKeyIdStr === null
  ) {
    return;
  }

  const newSignedPreKeyId = parseInt(nextSignedPreKeyIdStr, 10);
  const identityKeyPair = {
    publicKey: toArrayBuffer(hexToUint8Array(identityKeyPublicHex)),
    privateKey: toArrayBuffer(hexToUint8Array(identityKeyPrivateHex)),
  };

  const newSignedPreKeyRecord = generateSignedPreKey(
    newSignedPreKeyId,
    identityKeyPair,
    BigInt(Date.now()),
  );

  const db = getDatabase();
  db.executeSync('BEGIN IMMEDIATE');
  try {
    saveSignedPreKey({
      id: newSignedPreKeyId,
      key_data: new Uint8Array(newSignedPreKeyRecord),
      created_at: nowSeconds,
      confirmed: 0,
    });
    setItem(ITEM_KEYS.NEXT_SIGNED_PRE_KEY_ID, String(newSignedPreKeyId + 1));
    setItem(ITEM_KEYS.ACTIVE_SIGNED_PRE_KEY_ID, String(newSignedPreKeyId));
    setItem(ITEM_KEYS.LAST_SIGNED_PRE_KEY_ROTATION, String(nowSeconds));
    db.executeSync('COMMIT');
  } catch (err) {
    db.executeSync('ROLLBACK');
    throw err;
  }

  const lastResortKyberPreKeyId = parseInt(lastResortKyberPreKeyIdStr, 10);
  const lastResortRow = queryOne<KeyDataRow>(
    'SELECT key_data FROM signal_kyber_pre_keys WHERE id = ?',
    [lastResortKyberPreKeyId],
  );
  if (lastResortRow === null) return;

  const signedPub = getSignedPreKeyPublic(newSignedPreKeyRecord);
  const lastResortPub = getKyberPreKeyPublic(toArrayBuffer(lastResortRow.key_data));

  const payload: UploadPreKeyBundleRequest = {
    registrationId: parseInt(registrationIdStr, 10),
    deviceId: DEVICE_ID,
    identityKey: arrayBufferToBase64(toArrayBuffer(hexToUint8Array(identityKeyPublicHex))),
    signedPreKey: {
      keyId: signedPub.id,
      publicKey: arrayBufferToBase64(signedPub.publicKey),
      signature: arrayBufferToBase64(signedPub.signature),
    },
    preKeys: [],
    kyberPreKeys: [],
    lastResortKyberPreKey: {
      keyId: lastResortPub.id,
      publicKey: arrayBufferToBase64(lastResortPub.publicKey),
      signature: arrayBufferToBase64(lastResortPub.signature),
      lastResort: true,
    },
  };

  await uploadBundle(payload);
}

export async function ensureKeysInitialized(): Promise<void> {
  if (initializationPromise !== null) {
    return initializationPromise;
  }

  initializationPromise = (async () => {
    if (getItem(ITEM_KEYS.IDENTITY_KEY_PUBLIC) === null) {
      await generateInitialKeys();
    }

    if (getItem(ITEM_KEYS.BUNDLE_UPLOADED) === null) {
      await uploadInitialPreKeyBundle();
    }

    await checkAndRotateSignedPreKey();
    await checkAndReplenishPreKeys();
  })().finally(() => {
    initializationPromise = null;
  });

  return initializationPromise;
}
