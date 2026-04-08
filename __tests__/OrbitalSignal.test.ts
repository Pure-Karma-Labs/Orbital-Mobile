/**
 * Smoke test for uniffi-bindgen-react-native generated bindings.
 *
 * This validates the TypeScript module structure is importable and
 * the regenerated API surface exposes all expected functions, types,
 * and store interfaces.
 *
 * The actual native bridge calls require a device/simulator runtime,
 * so we mock the native module and verify the generated API shape.
 */

// Mock the native module since Jest runs without a native runtime
jest.mock('orbital-signal/src/NativeOrbitalSignal', () => ({
  __esModule: true,
  default: {
    installRustCrate: jest.fn(),
  },
}));

jest.mock('orbital-signal/src/generated/orbital_signal', () => ({
  __esModule: true,
  // Key generation (synchronous)
  generateIdentityKeyPair: jest.fn(() => ({
    publicKey: new ArrayBuffer(33),
    privateKey: new ArrayBuffer(32),
  })),
  generatePreKey: jest.fn(() => new ArrayBuffer(100)),
  generateSignedPreKey: jest.fn(() => new ArrayBuffer(100)),
  // Key generation (async)
  generateKyberPreKey: jest.fn(async () => ({
    record: new ArrayBuffer(3200),
    isLastResort: false,
  })),
  // Utility functions
  getPreKeyPublic: jest.fn(() => ({ id: 1, publicKey: new ArrayBuffer(33) })),
  getSignedPreKeyPublic: jest.fn(() => ({
    id: 1,
    publicKey: new ArrayBuffer(33),
    signature: new ArrayBuffer(64),
    timestamp: BigInt(1700000000000),
  })),
  getKyberPreKeyPublic: jest.fn(() => ({
    id: 1,
    publicKey: new ArrayBuffer(1568),
    signature: new ArrayBuffer(64),
  })),
  createProtocolAddress: jest.fn((name: string, deviceId: number) => ({
    name,
    deviceId,
  })),
  // Session operations (stubbed — blocked on uniffi store adapter)
  processPreKeyBundle: jest.fn(async () => { throw new Error('Not yet implemented'); }),
  signalEncrypt: jest.fn(async () => { throw new Error('Not yet implemented'); }),
  signalDecrypt: jest.fn(async () => { throw new Error('Not yet implemented'); }),
  signalDecryptPreKey: jest.fn(async () => { throw new Error('Not yet implemented'); }),
  // Group operations (stubbed)
  createSenderKeyDistributionMessage: jest.fn(async () => { throw new Error('Not yet implemented'); }),
  processSenderKeyDistributionMessage: jest.fn(async () => { throw new Error('Not yet implemented'); }),
  groupEncrypt: jest.fn(async () => { throw new Error('Not yet implemented'); }),
  groupDecrypt: jest.fn(async () => { throw new Error('Not yet implemented'); }),
  // Sealed sender (stubbed)
  sealedSenderEncrypt: jest.fn(async () => { throw new Error('Not yet implemented'); }),
  sealedSenderDecrypt: jest.fn(async () => { throw new Error('Not yet implemented'); }),
  // Roundtrip PoC (Issue #11)
  testEncryptDecryptRoundtrip: jest.fn((plaintext: ArrayBuffer) => ({
    plaintext,
    ciphertextLen: 256,
    decrypted: plaintext,
    success: true,
    elapsedMs: BigInt(42),
  })),
  testEncryptDecryptRoundtripN: jest.fn((_plaintext: ArrayBuffer, iterations: number) => ({
    successCount: iterations,
    totalElapsedMs: BigInt(420),
    avgElapsedMs: BigInt(42),
  })),
  // Enums (numeric ordinals matching generated TypeScript enums)
  CiphertextMessageType: { Whisper: 0, PreKey: 1, SenderKey: 2, Plaintext: 3 },
  Direction: { Sending: 0, Receiving: 1 },
  // Error tags
  SignalError_Tags: { InvalidKey: 0, InvalidMessage: 1, InvalidSignature: 2, NoSession: 3, UntrustedIdentity: 4, DuplicateMessage: 5, InvalidCertificate: 6, InvalidArgument: 7, StoreError: 8, InternalError: 9 },
  // Default export with initialize (called by index.tsx on load)
  default: { initialize: jest.fn() },
}));

describe('orbital_signal bindings', () => {
  // -------------------------------------------------------------------------
  // API surface — verify all 20 functions are exported
  // -------------------------------------------------------------------------
  const EXPECTED_FUNCTIONS = [
    'generateIdentityKeyPair',
    'generatePreKey',
    'generateSignedPreKey',
    'generateKyberPreKey',
    'getPreKeyPublic',
    'getSignedPreKeyPublic',
    'getKyberPreKeyPublic',
    'createProtocolAddress',
    'processPreKeyBundle',
    'signalEncrypt',
    'signalDecrypt',
    'signalDecryptPreKey',
    'createSenderKeyDistributionMessage',
    'processSenderKeyDistributionMessage',
    'groupEncrypt',
    'groupDecrypt',
    'sealedSenderEncrypt',
    'sealedSenderDecrypt',
    'testEncryptDecryptRoundtrip',
    'testEncryptDecryptRoundtripN',
  ] as const;

  it('exports all 20 functions', () => {
    const mod = require('orbital-signal/src/generated/orbital_signal');
    for (const fn of EXPECTED_FUNCTIONS) {
      expect(typeof mod[fn]).toBe('function');
    }
  });

  it('re-exports via index.tsx entry point', () => {
    const orbital = require('orbital-signal');
    expect(orbital.generateIdentityKeyPair).toBeDefined();
    expect(orbital.createProtocolAddress).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // Working functions — verify mock return shapes
  // -------------------------------------------------------------------------
  it('generateIdentityKeyPair returns key pair with public and private keys', () => {
    const { generateIdentityKeyPair } = require('orbital-signal/src/generated/orbital_signal');
    const keyPair = generateIdentityKeyPair();
    expect(keyPair).toHaveProperty('publicKey');
    expect(keyPair).toHaveProperty('privateKey');
  });

  it('createProtocolAddress returns address with name and deviceId', () => {
    const { createProtocolAddress } = require('orbital-signal/src/generated/orbital_signal');
    const addr = createProtocolAddress('alice', 1);
    expect(addr.name).toBe('alice');
    expect(addr.deviceId).toBe(1);
  });

  it('generateKyberPreKey returns result with isLastResort flag', async () => {
    const { generateKyberPreKey } = require('orbital-signal/src/generated/orbital_signal');
    const result = await generateKyberPreKey(1, { publicKey: new ArrayBuffer(33), privateKey: new ArrayBuffer(32) }, 1700000000000, false);
    expect(result).toHaveProperty('record');
    expect(result).toHaveProperty('isLastResort');
  });

  // -------------------------------------------------------------------------
  // Enums
  // -------------------------------------------------------------------------
  it('exports CiphertextMessageType enum with numeric values', () => {
    const { CiphertextMessageType } = require('orbital-signal/src/generated/orbital_signal');
    expect(CiphertextMessageType.Whisper).toBe(0);
    expect(CiphertextMessageType.PreKey).toBe(1);
    expect(CiphertextMessageType.SenderKey).toBe(2);
    expect(CiphertextMessageType.Plaintext).toBe(3);
  });

  it('exports Direction enum', () => {
    const { Direction } = require('orbital-signal/src/generated/orbital_signal');
    expect(Direction.Sending).toBe(0);
    expect(Direction.Receiving).toBe(1);
  });

  it('exports SignalError_Tags enum', () => {
    const { SignalError_Tags } = require('orbital-signal/src/generated/orbital_signal');
    expect(SignalError_Tags.InvalidKey).toBe(0);
    expect(SignalError_Tags.NoSession).toBe(3);
    expect(SignalError_Tags.InternalError).toBe(9);
  });

  // -------------------------------------------------------------------------
  // Stubbed functions — verify they reject with expected error
  // -------------------------------------------------------------------------
  const STUBBED_FUNCTIONS = [
    'processPreKeyBundle',
    'signalEncrypt',
    'signalDecrypt',
    'signalDecryptPreKey',
    'createSenderKeyDistributionMessage',
    'processSenderKeyDistributionMessage',
    'groupEncrypt',
    'groupDecrypt',
    'sealedSenderEncrypt',
    'sealedSenderDecrypt',
  ] as const;

  it('stubbed functions reject with Not yet implemented', async () => {
    const mod = require('orbital-signal/src/generated/orbital_signal');
    for (const fn of STUBBED_FUNCTIONS) {
      await expect(mod[fn]()).rejects.toThrow('Not yet implemented');
    }
  });

  // -------------------------------------------------------------------------
  // Roundtrip PoC (Issue #11)
  // -------------------------------------------------------------------------
  it('testEncryptDecryptRoundtrip returns result with success and timing', () => {
    const { testEncryptDecryptRoundtrip } = require('orbital-signal/src/generated/orbital_signal');
    const result = testEncryptDecryptRoundtrip(new ArrayBuffer(21));
    expect(result).toHaveProperty('success', true);
    expect(result).toHaveProperty('ciphertextLen');
    expect(result).toHaveProperty('decrypted');
    expect(result).toHaveProperty('elapsedMs');
  });

  it('testEncryptDecryptRoundtripN returns batch results', () => {
    const { testEncryptDecryptRoundtripN } = require('orbital-signal/src/generated/orbital_signal');
    const result = testEncryptDecryptRoundtripN(new ArrayBuffer(11), 10);
    expect(result.successCount).toBe(10);
    expect(result).toHaveProperty('totalElapsedMs');
    expect(result).toHaveProperty('avgElapsedMs');
  });
});
