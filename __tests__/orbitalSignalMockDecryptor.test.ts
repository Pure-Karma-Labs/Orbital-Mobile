/**
 * Tests for the AttachmentDecryptor stub in `__mocks__/orbital-signal.ts`.
 *
 * The stub deliberately ENFORCES the real Rust object's phase machine instead
 * of being a permissive no-op. Service-layer tests (issue #578, PR 2) rely on
 * that to prove `mediaDownloadService` never reaches for plaintext before the
 * verification pass has completed — against a permissive stub every one of
 * those assertions would pass vacuously.
 *
 * These tests exist so the stub cannot quietly regress into permissiveness.
 * They resolve `orbital-signal` through jest's moduleNameMapper, which points
 * at the mock; there is intentionally no per-file `jest.mock` here.
 */

// `require` (not `import`): the stub is untyped CommonJS, and the real
// package's types do not describe the injectable failure hooks. The bare
// `export {}` makes this file a module so its top-level bindings don't
// collide with the script-scoped mock's own `AttachmentDecryptor` class.
export {};
const { AttachmentDecryptor } = require('orbital-signal');

const KEYS = new ArrayBuffer(64);
const DIGEST = new ArrayBuffer(32);

const newDecryptor = () => new AttachmentDecryptor(KEYS, DIGEST);

/** Drive a stub through pass 1 so it sits in the decrypting phase. */
const verified = () => {
  const dec = newDecryptor();
  dec.verifyPush('AAAA');
  dec.verifyFinalize();
  return dec;
};

beforeEach(() => {
  AttachmentDecryptor.reset();
});

describe('__mocks__/orbital-signal AttachmentDecryptor stub', () => {
  it('allows the happy path: verify pass, then decrypt pass', () => {
    const dec = verified();
    expect(dec.decryptPush('AAAA')).toBe('');
    expect(dec.decryptFinalize()).toBe('');
  });

  it('throws on decryptPush before verifyFinalize', () => {
    const dec = newDecryptor();
    dec.verifyPush('AAAA');
    expect(() => dec.decryptPush('AAAA')).toThrow();
  });

  it('throws on decryptFinalize before verifyFinalize', () => {
    expect(() => newDecryptor().decryptFinalize()).toThrow();
  });

  it('throws on verifyPush after verifyFinalize', () => {
    const dec = verified();
    expect(() => dec.verifyPush('AAAA')).toThrow();
  });

  it('throws on double verifyFinalize', () => {
    const dec = verified();
    expect(() => dec.verifyFinalize()).toThrow();
  });

  it('throws on decryptPush after decryptFinalize', () => {
    const dec = verified();
    dec.decryptFinalize();
    expect(() => dec.decryptPush('AAAA')).toThrow();
  });

  it('throws on double decryptFinalize', () => {
    const dec = verified();
    dec.decryptFinalize();
    expect(() => dec.decryptFinalize()).toThrow();
  });

  it('poisons the instance after any error — every later call throws', () => {
    const dec = newDecryptor();
    expect(() => dec.decryptPush('AAAA')).toThrow();

    // Poisoned: even the phase-correct pass-1 calls must now fail.
    expect(() => dec.verifyPush('AAAA')).toThrow();
    expect(() => dec.verifyFinalize()).toThrow();
    expect(() => dec.decryptFinalize()).toThrow();
  });

  describe('injectable failure hooks', () => {
    it('failVerifyPush forces a throw and poisons', () => {
      AttachmentDecryptor.failVerifyPush = true;
      const dec = newDecryptor();
      expect(() => dec.verifyPush('AAAA')).toThrow();

      AttachmentDecryptor.failVerifyPush = false;
      expect(() => dec.verifyFinalize()).toThrow();
    });

    it('failVerifyFinalize forces a throw and poisons', () => {
      AttachmentDecryptor.failVerifyFinalize = true;
      const dec = newDecryptor();
      dec.verifyPush('AAAA');
      expect(() => dec.verifyFinalize()).toThrow();

      AttachmentDecryptor.failVerifyFinalize = false;
      expect(() => dec.decryptPush('AAAA')).toThrow();
    });

    it('failDecryptPush forces a throw and poisons', () => {
      AttachmentDecryptor.failDecryptPush = true;
      const dec = verified();
      expect(() => dec.decryptPush('AAAA')).toThrow();

      AttachmentDecryptor.failDecryptPush = false;
      expect(() => dec.decryptFinalize()).toThrow();
    });

    it('failDecryptFinalize forces a throw and poisons', () => {
      AttachmentDecryptor.failDecryptFinalize = true;
      const dec = verified();
      expect(() => dec.decryptFinalize()).toThrow();

      AttachmentDecryptor.failDecryptFinalize = false;
      expect(() => dec.decryptFinalize()).toThrow();
    });

    it('reset() clears every hook', () => {
      AttachmentDecryptor.failVerifyPush = true;
      AttachmentDecryptor.failVerifyFinalize = true;
      AttachmentDecryptor.failDecryptPush = true;
      AttachmentDecryptor.failDecryptFinalize = true;

      AttachmentDecryptor.reset();

      const dec = verified();
      expect(dec.decryptPush('AAAA')).toBe('');
      expect(dec.decryptFinalize()).toBe('');
    });
  });

  it('uniffiDestroy() is a no-op that never throws, in any phase', () => {
    const dec = newDecryptor();
    expect(() => dec.uniffiDestroy()).not.toThrow();
    expect(() => verified().uniffiDestroy()).not.toThrow();
  });
});
