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
 * NOTE (issue #924): the hkdfSha256 / hmacSha256 stubs near the bottom are
 * likewise not permissive — they enforce kdf.rs's argument validation. See the
 * comment block there.
 *
 * NOTE (issue #578): unlike the other stubs above, the AttachmentDecryptor
 * stub below deliberately enforces the real object's phase machine (verify
 * pass, then decrypt pass, poison-on-error) instead of being a permissive
 * no-op — a permissive stub would make every phase-ordering test in the
 * service layer vacuously pass.
 */

const noopBuffer = () => new ArrayBuffer(0);

/**
 * Distinctness stub for hkdfSha256 / hmacSha256 (#917) — not a crypto oracle.
 *
 * Output depends on every input byte, with a part boundary mixed in, so dedup
 * tests (#924) can tell items apart. Real expected values come from the Rust
 * `orbital_import_kat` fixture, not from here; a test that needs them should
 * install a per-file jest.mock.
 *
 * The sizes and the input dependence are both deliberate. `noopBuffer` is
 * zero-length, which would make #924's 16-byte slice silently empty; an
 * all-zero buffer of the right size is no better, because every item would
 * derive the same import_key, so "distinct items get distinct keys" could not
 * pass and "re-import reports duplicate" would pass for the wrong reason.
 *
 * The output byte is the HIGH byte of the state, not the low one (#924). With
 * the low byte, the whole stub had exactly 8 BITS of distinctness: the low
 * byte of `x * 0x01000193` is a function of the low byte of `x` alone, so
 * every output byte — and therefore the entire buffer — depended only on
 * `h & 0xff`. Two of four sample userIds collided, which is the one failure
 * mode this stub exists to prevent. Measured after the change: 20,000 distinct
 * inputs give 20,000 distinct 16-byte outputs, where before they gave 256.
 */
const mixStub = (outputLen: number, ...parts: ArrayBuffer[]): ArrayBuffer => {
  let h = 0x811c9dc5;
  const out = new Uint8Array(outputLen);
  for (const part of parts) {
    for (const byte of new Uint8Array(part)) h = Math.imul(h ^ byte, 0x01000193) >>> 0;
    h = Math.imul(h ^ 0xff, 0x01000193) >>> 0; // part boundary
  }
  for (let i = 0; i < outputLen; i++) {
    h = Math.imul(h ^ i, 0x01000193) >>> 0;
    out[i] = (h >>> 24) & 0xff;
  }
  return out.buffer;
};

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
 * decryptor) unless a test installs an output hook.
 *
 * Failure injection: set the static hooks below to force a failure at a
 * specific step without replacing the class, e.g.
 *   AttachmentDecryptor.failVerifyFinalize = true;
 * Forced failures throw and poison the instance exactly like a real
 * Rust-side failure.
 *
 * Output injection: set decryptPushOutput / decryptFinalizeOutput to make the
 * stub emit real base64 so callers' byte bookkeeping can be asserted. These
 * run AFTER the phase check, so the phase machine still holds.
 *
 * All statics leak across tests within a file — call
 * AttachmentDecryptor.reset() in beforeEach.
 */
class AttachmentDecryptor {
  static failVerifyPush = false;
  static failVerifyFinalize = false;
  static failDecryptPush = false;
  static failDecryptFinalize = false;
  static decryptPushOutput: ((chunkB64: string) => string) | null = null;
  static decryptFinalizeOutput: (() => string) | null = null;

  static reset(): void {
    AttachmentDecryptor.failVerifyPush = false;
    AttachmentDecryptor.failVerifyFinalize = false;
    AttachmentDecryptor.failDecryptPush = false;
    AttachmentDecryptor.failDecryptFinalize = false;
    AttachmentDecryptor.decryptPushOutput = null;
    AttachmentDecryptor.decryptFinalizeOutput = null;
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

  decryptPush(chunkB64: string): string {
    if (this.phase !== 'decrypting') {
      this.fail('AttachmentDecryptor: decryptor is no longer usable');
    }
    if (AttachmentDecryptor.failDecryptPush) {
      this.fail('AttachmentDecryptor: forced decryptPush failure');
    }
    return AttachmentDecryptor.decryptPushOutput?.(chunkB64) ?? '';
  }

  decryptFinalize(): string {
    if (this.phase !== 'decrypting') {
      this.fail('AttachmentDecryptor: decryptor is no longer usable');
    }
    if (AttachmentDecryptor.failDecryptFinalize) {
      this.fail('AttachmentDecryptor: forced decryptFinalize failure');
    }
    this.phase = 'terminated';
    return AttachmentDecryptor.decryptFinalizeOutput?.() ?? '';
  }

  uniffiDestroy(): void {
    // no-op
  }
}

/** RFC 5869 caps HKDF-Expand at 255 * HashLen; SHA-256 ⇒ 8160. Mirrors kdf.rs. */
const HKDF_MAX_OUTPUT_LEN = 255 * 32;

/**
 * Argument validation for the hkdfSha256 / hmacSha256 stubs (#924).
 *
 * Like the AttachmentDecryptor stub above, and unlike the permissive no-ops,
 * these reject exactly what `packages/orbital-signal/rust/orbital_signal/src/
 * kdf.rs` rejects — same checks, same order, same message text. A permissive
 * stub makes the two assertions #924's tests exist to make vacuous: "an empty
 * UTF-8 encode would be caught" (empty ikm/salt/info/key/input) and "a bad
 * output_len is rejected" both pass against a stub that happily derives a key
 * from nothing at all. An empty `info` in particular is the quiet one — it
 * gives every orbit member the same K_import — and an empty hmac `input` is
 * the encodeUTF8-truncation bug class #373 guards against. Both would ship
 * green and fail on device.
 *
 * `outputLen` is normalised through ToUint32 first, because Rust never sees
 * the JS number — it sees uniffi's lowering, which is a
 * `static_cast<uint32_t>` of the double. That cast truncates a non-integer
 * (`32.5` arrives as 32) and is implementation-defined when the value is out
 * of a u32's range: on arm64 `-1` saturates to 0, elsewhere it may wrap. The
 * exact out-of-range value is therefore not something this stub can promise,
 * and it does not matter — every such value is outside `1..=8160` and Rust
 * rejects it. ToUint32 is the closest single rule in JS, so the stub refuses
 * exactly the arguments the real call refuses. The range check comes before
 * the emptiness checks for the reason kdf.rs gives: a huge lifted length must
 * never reach an allocation.
 *
 * Validation only: valid calls fall through to `mixStub` with its bytes
 * unchanged, which is what #924's distinctness tests depend on.
 */
const hkdfSha256 = (
  ikm: ArrayBuffer,
  salt: ArrayBuffer,
  info: ArrayBuffer,
  outputLen: number,
): ArrayBuffer => {
  const len = outputLen >>> 0;
  if (len === 0 || len > HKDF_MAX_OUTPUT_LEN) {
    throw new Error(
      `hkdf_sha256: output_len must be between 1 and ${HKDF_MAX_OUTPUT_LEN}, got ${len}`,
    );
  }
  if (ikm.byteLength === 0) {
    throw new Error('hkdf_sha256: ikm must not be empty');
  }
  if (salt.byteLength === 0) {
    throw new Error('hkdf_sha256: salt must not be empty');
  }
  if (info.byteLength === 0) {
    throw new Error('hkdf_sha256: info must not be empty');
  }
  return mixStub(len, ikm, salt, info);
};

const hmacSha256 = (key: ArrayBuffer, input: ArrayBuffer): ArrayBuffer => {
  if (key.byteLength === 0) {
    throw new Error('hmac_sha256: key must not be empty');
  }
  if (input.byteLength === 0) {
    throw new Error('hmac_sha256: input must not be empty');
  }
  return mixStub(32, key, input);
};

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
  hkdfSha256,
  hmacSha256,
  createProtocolAddress: () => ({ name: '', deviceId: 0 }),
};
