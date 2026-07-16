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
const mockPush = jest.fn();
const mockFinalize = jest.fn();
const mockUniffiDestroy = jest.fn();

jest.mock('orbital-signal', () => ({
  attachmentEncrypt: (...args: unknown[]) => mockAttachmentEncrypt(...args),
  attachmentDecrypt: (...args: unknown[]) => mockAttachmentDecrypt(...args),
  AttachmentEncryptor: jest.fn().mockImplementation(() => ({
    push: mockPush,
    finalize: mockFinalize,
    uniffiDestroy: mockUniffiDestroy,
  })),
}));

import {
  generateAttachmentKeys,
  encryptAttachment,
  decryptAttachment,
  createAttachmentEncryptor,
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

  it('returns ciphertext and digest as Uint8Array', () => {
    const ctBytes = new Uint8Array([10, 20, 30]);
    const digestBytes = new Uint8Array([40, 50]);

    mockAttachmentEncrypt.mockReturnValue({
      ciphertext: ctBytes.buffer.slice(
        ctBytes.byteOffset,
        ctBytes.byteOffset + ctBytes.byteLength,
      ),
      digest: digestBytes.buffer.slice(
        digestBytes.byteOffset,
        digestBytes.byteOffset + digestBytes.byteLength,
      ),
    });

    const result = encryptAttachment(new Uint8Array([1]), new Uint8Array(64));

    expect(result.ciphertext).toBeInstanceOf(Uint8Array);
    expect(result.ciphertext).toEqual(ctBytes);
    expect(result.digest).toBeInstanceOf(Uint8Array);
    expect(result.digest).toEqual(digestBytes);
    expect(result).not.toHaveProperty('plaintextHash');
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

// ---------------------------------------------------------------------------
// createAttachmentEncryptor (streaming wrapper)
// ---------------------------------------------------------------------------

describe('createAttachmentEncryptor', () => {
  beforeEach(() => {
    mockPush.mockReturnValue(new ArrayBuffer(16));
    mockFinalize.mockReturnValue({
      tail: new ArrayBuffer(48),
      digest: new ArrayBuffer(32),
      plaintextHash: new ArrayBuffer(32),
    });
  });

  it('passes keys as ArrayBuffer to the native constructor', () => {
    const { AttachmentEncryptor } = require('orbital-signal');
    const keys = new Uint8Array(64).fill(0xAA);
    createAttachmentEncryptor(keys);

    expect(AttachmentEncryptor).toHaveBeenCalledTimes(1);
    const arg = AttachmentEncryptor.mock.calls[0][0];
    expect(arg).toBeInstanceOf(ArrayBuffer);
    expect(arg.byteLength).toBe(64);
  });

  it('push() converts Uint8Array to ArrayBuffer and returns Uint8Array', () => {
    const enc = createAttachmentEncryptor(new Uint8Array(64));
    const chunk = new Uint8Array([1, 2, 3]);
    const result = enc.push(chunk);

    expect(mockPush).toHaveBeenCalledTimes(1);
    const arg = mockPush.mock.calls[0][0];
    expect(arg).toBeInstanceOf(ArrayBuffer);
    expect(result).toBeInstanceOf(Uint8Array);
    expect(result.length).toBe(16);
  });

  it('finalize() returns tail and digest as Uint8Array, omitting plaintextHash', () => {
    const enc = createAttachmentEncryptor(new Uint8Array(64));
    const result = enc.finalize();

    expect(mockFinalize).toHaveBeenCalledTimes(1);
    expect(result.tail).toBeInstanceOf(Uint8Array);
    expect(result.tail.length).toBe(48);
    expect(result.digest).toBeInstanceOf(Uint8Array);
    expect(result.digest.length).toBe(32);
    expect(result).not.toHaveProperty('plaintextHash');
  });

  it('destroy() delegates to uniffiDestroy()', () => {
    const enc = createAttachmentEncryptor(new Uint8Array(64));
    enc.destroy();

    expect(mockUniffiDestroy).toHaveBeenCalledTimes(1);
  });

  it('destroy() is idempotent — second call does not invoke uniffiDestroy again', () => {
    const enc = createAttachmentEncryptor(new Uint8Array(64));
    enc.destroy();
    enc.destroy();

    expect(mockUniffiDestroy).toHaveBeenCalledTimes(1);
  });
});
