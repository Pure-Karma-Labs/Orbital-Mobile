/**
 * Tests for the hkdfSha256 / hmacSha256 stubs in `__mocks__/orbital-signal.ts`.
 *
 * The stubs deliberately ENFORCE the argument validation of the real Rust
 * exports (`packages/orbital-signal/rust/orbital_signal/src/kdf.rs`) instead of
 * being permissive no-ops. #924's dedup-key tests assert that an empty UTF-8
 * encode is caught and that a bad `output_len` is rejected; against a
 * permissive stub both pass vacuously — the stub would happily derive a key
 * from nothing — and the encodeUTF8-truncation bug class (#373) would ship
 * green and fail on device.
 *
 * These tests exist so the stub cannot quietly regress into permissiveness,
 * and so its error vocabulary stays identical to the Rust `reason` strings
 * (a test asserting on a message must be testing one vocabulary, not two).
 * They resolve `orbital-signal` through jest's moduleNameMapper, which points
 * at the mock; there is intentionally no per-file `jest.mock` here.
 */

// `require` (not `import`): the stub is untyped CommonJS. The bare `export {}`
// makes this file a module so its top-level bindings don't collide with the
// script-scoped mock's own declarations.
export {};
const { hkdfSha256, hmacSha256 } = require('orbital-signal');

/** A non-empty ArrayBuffer whose bytes depend on `seed`. */
const buf = (byteLength: number, seed = 1): ArrayBuffer => {
  const out = new Uint8Array(byteLength);
  for (let i = 0; i < byteLength; i++) out[i] = (i + seed) & 0xff;
  return out.buffer;
};

const EMPTY = new ArrayBuffer(0);
const IKM = buf(32, 0x11);
const SALT = buf(22, 0x22);
const INFO = buf(36, 0x33);
const KEY = buf(32, 0x44);
const INPUT = buf(24, 0x55);

const bytes = (ab: ArrayBuffer): number[] => Array.from(new Uint8Array(ab));

describe('__mocks__/orbital-signal hkdfSha256 stub', () => {
  it('accepts valid arguments and returns outputLen bytes', () => {
    expect(hkdfSha256(IKM, SALT, INFO, 32).byteLength).toBe(32);
  });

  describe('output_len validation', () => {
    it('rejects 0 with the Rust message', () => {
      expect(() => hkdfSha256(IKM, SALT, INFO, 0)).toThrow(
        'hkdf_sha256: output_len must be between 1 and 8160, got 0',
      );
    });

    it('rejects 8161 with the Rust message', () => {
      expect(() => hkdfSha256(IKM, SALT, INFO, 8161)).toThrow(
        'hkdf_sha256: output_len must be between 1 and 8160, got 8161',
      );
    });

    it('rejects a negative outputLen, reporting the u32 it lifts to', () => {
      // uniffi lowers outputLen as a u32, so Rust never sees -1: it sees
      // ToUint32(-1) = u32::MAX, which is the value it names in the error.
      expect(() => hkdfSha256(IKM, SALT, INFO, -1)).toThrow(
        'hkdf_sha256: output_len must be between 1 and 8160, got 4294967295',
      );
    });

    it('rejects NaN, which lifts to 0', () => {
      expect(() => hkdfSha256(IKM, SALT, INFO, NaN)).toThrow(
        'hkdf_sha256: output_len must be between 1 and 8160, got 0',
      );
    });

    it('truncates a non-integer outputLen the way the u32 lift does', () => {
      // Not a rejection case on device either: 32.5 lowers to 32.
      expect(hkdfSha256(IKM, SALT, INFO, 32.5).byteLength).toBe(32);
      expect(bytes(hkdfSha256(IKM, SALT, INFO, 32.5))).toEqual(
        bytes(hkdfSha256(IKM, SALT, INFO, 32)),
      );
    });

    it('accepts both boundaries: 1 and 8160', () => {
      expect(hkdfSha256(IKM, SALT, INFO, 1).byteLength).toBe(1);
      expect(hkdfSha256(IKM, SALT, INFO, 8160).byteLength).toBe(8160);
    });
  });

  describe('emptiness validation', () => {
    it('rejects an empty ikm', () => {
      expect(() => hkdfSha256(EMPTY, SALT, INFO, 32)).toThrow('hkdf_sha256: ikm must not be empty');
    });

    it('rejects an empty salt', () => {
      expect(() => hkdfSha256(IKM, EMPTY, INFO, 32)).toThrow('hkdf_sha256: salt must not be empty');
    });

    it('rejects an empty info', () => {
      // RFC 5869 permits an empty info; the export does not, because for #924
      // info is the only per-member input.
      expect(() => hkdfSha256(IKM, SALT, EMPTY, 32)).toThrow('hkdf_sha256: info must not be empty');
    });
  });

  describe('check order matches the Rust export', () => {
    it('reports output_len before an empty ikm', () => {
      expect(() => hkdfSha256(EMPTY, SALT, INFO, 0)).toThrow(
        'hkdf_sha256: output_len must be between 1 and 8160, got 0',
      );
    });

    it('reports output_len before an empty salt or info, even for a lifted u32::MAX', () => {
      expect(() => hkdfSha256(EMPTY, EMPTY, EMPTY, -1)).toThrow(
        'hkdf_sha256: output_len must be between 1 and 8160, got 4294967295',
      );
    });

    it('reports ikm before salt, and salt before info', () => {
      expect(() => hkdfSha256(EMPTY, EMPTY, EMPTY, 32)).toThrow(
        'hkdf_sha256: ikm must not be empty',
      );
      expect(() => hkdfSha256(IKM, EMPTY, EMPTY, 32)).toThrow(
        'hkdf_sha256: salt must not be empty',
      );
    });
  });

  describe('distinctness stub output is unchanged for valid calls', () => {
    it('is deterministic: same inputs give the same bytes', () => {
      expect(bytes(hkdfSha256(IKM, SALT, INFO, 32))).toEqual(
        bytes(hkdfSha256(IKM, SALT, INFO, 32)),
      );
    });

    it('depends on ikm, salt and info independently', () => {
      // The alternates differ in low-order bits, like #924's real inputs: the
      // stub is a 32-bit FNV mix and only the low byte of its state reaches
      // the output, so it is a distinctness aid, not a hash. Real expected
      // values come from the Rust `orbital_import_kat` fixture.
      const base = bytes(hkdfSha256(IKM, SALT, INFO, 32));
      expect(bytes(hkdfSha256(buf(32, 0x12), SALT, INFO, 32))).not.toEqual(base);
      expect(bytes(hkdfSha256(IKM, buf(22, 0x23), INFO, 32))).not.toEqual(base);
      expect(bytes(hkdfSha256(IKM, SALT, buf(36, 0x34), 32))).not.toEqual(base);
    });
  });
});

describe('__mocks__/orbital-signal hmacSha256 stub', () => {
  it('accepts valid arguments and returns a 32-byte tag', () => {
    expect(hmacSha256(KEY, INPUT).byteLength).toBe(32);
  });

  it('rejects an empty key', () => {
    expect(() => hmacSha256(EMPTY, INPUT)).toThrow('hmac_sha256: key must not be empty');
  });

  it('rejects an empty input', () => {
    // HMAC over an empty message is well-defined; #924's input never is, so an
    // empty one means the UTF-8 encoder returned nothing (#373).
    expect(() => hmacSha256(KEY, EMPTY)).toThrow('hmac_sha256: input must not be empty');
  });

  it('reports key before input', () => {
    expect(() => hmacSha256(EMPTY, EMPTY)).toThrow('hmac_sha256: key must not be empty');
  });

  describe('distinctness stub output is unchanged for valid calls', () => {
    it('is deterministic: same inputs give the same bytes', () => {
      expect(bytes(hmacSha256(KEY, INPUT))).toEqual(bytes(hmacSha256(KEY, INPUT)));
    });

    it('depends on key and input independently', () => {
      const base = bytes(hmacSha256(KEY, INPUT));
      expect(bytes(hmacSha256(buf(32, 0x45), INPUT))).not.toEqual(base);
      expect(bytes(hmacSha256(KEY, buf(24, 0x56)))).not.toEqual(base);
    });
  });
});
