/**
 * Tests for attachmentCrypto — the TypeScript wrapper around Rust attachment crypto.
 *
 * The native module (orbital-signal) is mocked since it requires a native build.
 * These tests verify:
 * - Key generation produces correct-length keys with base64 encoding
 * - encryptAttachment calls the Rust FFI with correct ArrayBuffer conversions
 * - decryptAttachment calls the Rust FFI with correct ArrayBuffer conversions
 * - Return values are properly converted from ArrayBuffer to Uint8Array
 */

const mockAttachmentEncrypt = jest.fn();
const mockAttachmentDecrypt = jest.fn();

jest.mock('orbital-signal', () => ({
  attachmentEncrypt: (...args: unknown[]) => mockAttachmentEncrypt(...args),
  attachmentDecrypt: (...args: unknown[]) => mockAttachmentDecrypt(...args),
}));

import {
  generateAttachmentKeys,
  encryptAttachment,
  decryptAttachment,
} from '../attachmentCrypto';

beforeEach(() => {
  jest.clearAllMocks();
});

// ---------------------------------------------------------------------------
// generateAttachmentKeys
// ---------------------------------------------------------------------------

describe('generateAttachmentKeys', () => {
  it('generates a 64-byte key', () => {
    const { keys } = generateAttachmentKeys();
    expect(keys).toBeInstanceOf(Uint8Array);
    expect(keys.length).toBe(64);
  });

  it('returns a base64-encoded string', () => {
    const { keysBase64 } = generateAttachmentKeys();
    expect(typeof keysBase64).toBe('string');
    expect(keysBase64.length).toBeGreaterThan(0);
  });

  it('generates unique keys each call', () => {
    const result1 = generateAttachmentKeys();
    const result2 = generateAttachmentKeys();
    expect(result1.keysBase64).not.toBe(result2.keysBase64);
  });
});

// ---------------------------------------------------------------------------
// encryptAttachment
// ---------------------------------------------------------------------------

describe('encryptAttachment', () => {
  it('calls attachmentEncrypt with ArrayBuffer arguments', () => {
    const mockResult = {
      ciphertext: new ArrayBuffer(64),
      digest: new ArrayBuffer(32),
      plaintextHash: new ArrayBuffer(32),
    };
    mockAttachmentEncrypt.mockReturnValue(mockResult);

    const plaintext = new Uint8Array([1, 2, 3, 4]);
    const keys = new Uint8Array(64);

    encryptAttachment(plaintext, keys);

    expect(mockAttachmentEncrypt).toHaveBeenCalledTimes(1);
    const [plaintextArg, keysArg] = mockAttachmentEncrypt.mock.calls[0];
    expect(plaintextArg).toBeInstanceOf(ArrayBuffer);
    expect(keysArg).toBeInstanceOf(ArrayBuffer);
  });

  it('returns ciphertext and digest as Uint8Array, plaintextHash as base64 string', () => {
    // Create mock ArrayBuffers with known content
    const ctBytes = new Uint8Array([10, 20, 30]);
    const digestBytes = new Uint8Array([40, 50]);
    const hashBytes = new Uint8Array([60, 70]);

    mockAttachmentEncrypt.mockReturnValue({
      ciphertext: ctBytes.buffer.slice(
        ctBytes.byteOffset,
        ctBytes.byteOffset + ctBytes.byteLength,
      ),
      digest: digestBytes.buffer.slice(
        digestBytes.byteOffset,
        digestBytes.byteOffset + digestBytes.byteLength,
      ),
      plaintextHash: hashBytes.buffer.slice(
        hashBytes.byteOffset,
        hashBytes.byteOffset + hashBytes.byteLength,
      ),
    });

    const result = encryptAttachment(new Uint8Array([1]), new Uint8Array(64));

    expect(result.ciphertext).toBeInstanceOf(Uint8Array);
    expect(result.ciphertext).toEqual(ctBytes);
    expect(result.digest).toBeInstanceOf(Uint8Array);
    expect(result.digest).toEqual(digestBytes);
    expect(typeof result.plaintextHash).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// decryptAttachment
// ---------------------------------------------------------------------------

describe('decryptAttachment', () => {
  it('calls attachmentDecrypt with ArrayBuffer arguments', () => {
    mockAttachmentDecrypt.mockReturnValue(new ArrayBuffer(4));

    const ciphertext = new Uint8Array([1, 2, 3]);
    const keys = new Uint8Array(64);
    const digest = new Uint8Array(32);

    decryptAttachment(ciphertext, keys, digest);

    expect(mockAttachmentDecrypt).toHaveBeenCalledTimes(1);
    const [ctArg, keysArg, digestArg] = mockAttachmentDecrypt.mock.calls[0];
    expect(ctArg).toBeInstanceOf(ArrayBuffer);
    expect(keysArg).toBeInstanceOf(ArrayBuffer);
    expect(digestArg).toBeInstanceOf(ArrayBuffer);
  });

  it('returns decrypted plaintext as Uint8Array', () => {
    const plainBytes = new Uint8Array([100, 200, 255]);
    mockAttachmentDecrypt.mockReturnValue(
      plainBytes.buffer.slice(
        plainBytes.byteOffset,
        plainBytes.byteOffset + plainBytes.byteLength,
      ),
    );

    const result = decryptAttachment(
      new Uint8Array([1]),
      new Uint8Array(64),
      new Uint8Array(32),
    );

    expect(result).toBeInstanceOf(Uint8Array);
    expect(result).toEqual(plainBytes);
  });

  it('propagates errors from the native module', () => {
    mockAttachmentDecrypt.mockImplementation(() => {
      throw new Error('decryption failed');
    });

    expect(() =>
      decryptAttachment(
        new Uint8Array([1]),
        new Uint8Array(64),
        new Uint8Array(32),
      ),
    ).toThrow('decryption failed');
  });
});
