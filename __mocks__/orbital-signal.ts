/**
 * Global Jest mock for the orbital-signal native TurboModule.
 *
 * The native binary is unavailable in the Jest environment. This mock provides
 * no-op stubs for all exported functions. Tests that need specific return values
 * override with jest.mock('orbital-signal', () => ({ ... })) per-file.
 *
 * NOTE (libsignal v0.95+): the session functions (processPreKeyBundle,
 * signalEncrypt, signalDecrypt, signalDecryptPreKey) require `localAddress`
 * in their input records — the real FFI serializer rejects a missing field,
 * but these untyped stubs will NOT. When writing tests for the 1:1 session
 * service (Issue #17), always pass localAddress = { name: <own userId,
 * bare UUID>, deviceId: 1 } or your test will pass while the device fails.
 */

const noopBuffer = () => new ArrayBuffer(0);

module.exports = {
  aesGcmEncrypt: () => ({ ciphertext: '', iv: '' }),
  aesGcmDecrypt: noopBuffer,
  eciesSeal: noopBuffer,
  eciesOpen: noopBuffer,
  attachmentEncrypt: () => ({ ciphertext: new ArrayBuffer(0), digest: new ArrayBuffer(0) }),
  attachmentDecrypt: noopBuffer,
  generateIdentityKeyPair: () => ({ publicKey: new ArrayBuffer(32), privateKey: new ArrayBuffer(32) }),
  generatePreKey: () => ({ id: 1, record: new ArrayBuffer(0) }),
  generateSignedPreKey: () => ({ id: 1, record: new ArrayBuffer(0), signature: new ArrayBuffer(0) }),
  generateKyberPreKey: () => ({ id: 1, record: new ArrayBuffer(0) }),
  createSenderKeyDistribution: noopBuffer,
  processSenderKeyDistribution: () => {},
  encryptGroup: noopBuffer,
  decryptGroup: noopBuffer,
  processPreKeyBundle: () => {},
  messageEncrypt: noopBuffer,
  messageDecrypt: noopBuffer,
  inviteEncryptGroupKey: noopBuffer,
  inviteDecryptGroupKey: noopBuffer,
  createProtocolAddress: () => ({ name: '', deviceId: 0 }),
};
