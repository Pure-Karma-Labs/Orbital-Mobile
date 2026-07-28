/**
 * NOTE for the future 1:1 session service (Issue #200 — "Restore Signal session
 * pipeline for 1:1 DMs", closed 2026-05-28 as a deliberate deferral; DMs reuse
 * the ECIES + AES-GCM group architecture instead): since libsignal v0.95,
 * the session FFI functions (processPreKeyBundle, signalEncrypt, signalDecrypt,
 * signalDecryptPreKey) require a `localAddress` alongside the remote address.
 * Convention: `localAddress = { name: <own userId from auth state>, deviceId: 1 }`.
 * The name MUST stay a bare hyphenated UUID — libsignal parses it as a Signal
 * ACI ServiceId and binds both addresses into the message MAC.
 */
export {
  generateInitialKeys,
  uploadInitialPreKeyBundle,
  checkAndReplenishPreKeys,
  checkAndRotateSignedPreKey,
  ensureKeysInitialized,
  initIdentityKeyCache,
  getCachedIdentityPrivateKeyHex,
  clearIdentityKeyCache,
} from './keyGenerationService';
export {
  encryptGroup,
  decryptGroup,
  createSenderKeyDistribution,
  processSenderKeyDistribution,
} from './cryptoService';
export {
  encryptContent,
  decryptContent,
  encryptGroupName,
  decryptGroupName,
  getOrFetchGroupKey,
  clearGroupKeyCache,
  invalidateGroupKey,
  persistGroupKey,
  generateGroupKey,
} from './contentCrypto';
