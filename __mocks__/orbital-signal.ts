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
 *
 * NOTE (issue #578): unlike the other stubs above, the AttachmentDecryptor
 * stub below deliberately enforces the real object's phase machine (verify
 * pass, then decrypt pass, poison-on-error) instead of being a permissive
 * no-op — a permissive stub would make every phase-ordering test in the
 * service layer vacuously pass.
 */

const noopBuffer = () => new ArrayBuffer(0);

/**
 * Stub AttachmentEncryptor class for Jest.
 *
 * push() returns an empty ArrayBuffer (no whole blocks); finalize() returns
 * zero-filled tail/digest/plaintextHash buffers. Tests that need specific
 * behavior should mock the class per-file.
 */
class AttachmentEncryptor {
  constructor(_keys: ArrayBuffer) {
    // no-op — native binary unavailable in Jest
  }

  push(_plaintext: ArrayBuffer): ArrayBuffer {
    return new ArrayBuffer(0);
  }

  finalize(): { tail: ArrayBuffer; digest: ArrayBuffer; plaintextHash: ArrayBuffer } {
    return {
      tail: new ArrayBuffer(0),
      digest: new ArrayBuffer(32),
      plaintextHash: new ArrayBuffer(32),
    };
  }

  uniffiDestroy(): void {
    // no-op
  }
}

type DecryptorPhase = 'verifying' | 'decrypting' | 'terminated';

/**
 * Stub AttachmentDecryptor class for Jest.
 *
 * Encodes the real Rust object's phase machine rather than being a permissive
 * no-op:
 *   pass 1 = verifyPush()* then verifyFinalize()
 *   pass 2 = decryptPush()* then decryptFinalize() (terminal)
 * Calling a method out of phase throws, and ANY thrown error (ordering
 * violation or forced failure) poisons the instance — every subsequent call
 * throws "decryptor is no longer usable".
 *
 * decryptPush()/decryptFinalize() return '' (this is a stub, not a real
 * decryptor) unless a test overrides the class entirely.
 *
 * Failure injection: set the static hooks below to force a failure at a
 * specific step without replacing the class, e.g.
 *   AttachmentDecryptor.failVerifyFinalize = true;
 * Forced failures throw and poison the instance exactly like a real
 * Rust-side failure. These statics leak across tests within a file — call
 * AttachmentDecryptor.reset() in beforeEach.
 */
class AttachmentDecryptor {
  static failVerifyPush = false;
  static failVerifyFinalize = false;
  static failDecryptPush = false;
  static failDecryptFinalize = false;

  static reset(): void {
    AttachmentDecryptor.failVerifyPush = false;
    AttachmentDecryptor.failVerifyFinalize = false;
    AttachmentDecryptor.failDecryptPush = false;
    AttachmentDecryptor.failDecryptFinalize = false;
  }

  private phase: DecryptorPhase = 'verifying';

  constructor(_keys: ArrayBuffer, _expectedDigest: ArrayBuffer) {
    // no-op — native binary unavailable in Jest
  }

  private fail(message: string): never {
    this.phase = 'terminated';
    throw new Error(message);
  }

  verifyPush(_chunkB64: string): void {
    if (this.phase !== 'verifying') {
      this.fail('AttachmentDecryptor: decryptor is no longer usable');
    }
    if (AttachmentDecryptor.failVerifyPush) {
      this.fail('AttachmentDecryptor: forced verifyPush failure');
    }
  }

  verifyFinalize(): void {
    if (this.phase !== 'verifying') {
      this.fail('AttachmentDecryptor: decryptor is no longer usable');
    }
    if (AttachmentDecryptor.failVerifyFinalize) {
      this.fail('AttachmentDecryptor: forced verifyFinalize failure');
    }
    this.phase = 'decrypting';
  }

  decryptPush(_chunkB64: string): string {
    if (this.phase !== 'decrypting') {
      this.fail('AttachmentDecryptor: decryptor is no longer usable');
    }
    if (AttachmentDecryptor.failDecryptPush) {
      this.fail('AttachmentDecryptor: forced decryptPush failure');
    }
    return '';
  }

  decryptFinalize(): string {
    if (this.phase !== 'decrypting') {
      this.fail('AttachmentDecryptor: decryptor is no longer usable');
    }
    if (AttachmentDecryptor.failDecryptFinalize) {
      this.fail('AttachmentDecryptor: forced decryptFinalize failure');
    }
    this.phase = 'terminated';
    return '';
  }

  uniffiDestroy(): void {
    // no-op
  }
}

module.exports = {
  aesGcmEncrypt: () => ({ ciphertext: '', iv: '' }),
  aesGcmDecrypt: noopBuffer,
  eciesSeal: noopBuffer,
  eciesOpen: noopBuffer,
  attachmentEncrypt: () => ({ ciphertext: new ArrayBuffer(0), digest: new ArrayBuffer(0) }),
  attachmentDecrypt: noopBuffer,
  AttachmentEncryptor,
  AttachmentDecryptor,
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
