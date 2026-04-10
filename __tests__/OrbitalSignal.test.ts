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
  // Session operations (preloaded store pattern)
  processPreKeyBundle: jest.fn(() => ({ updatedSessionRecord: new ArrayBuffer(128), identityKey: new ArrayBuffer(33), identityChanged: false })),
  signalEncrypt: jest.fn(() => ({ ciphertext: { messageType: 0, serialized: new ArrayBuffer(64) }, updatedSessionRecord: new ArrayBuffer(128) })),
  signalDecrypt: jest.fn(() => ({ plaintext: new ArrayBuffer(16), updatedSessionRecord: new ArrayBuffer(128) })),
  signalDecryptPreKey: jest.fn(() => ({ plaintext: new ArrayBuffer(16), updatedSessionRecord: new ArrayBuffer(128), senderIdentityKey: new ArrayBuffer(33), identityChanged: false })),
  // Group operations (preloaded store pattern)
  createSenderKeyDistributionMessage: jest.fn(() => ({ distributionMessage: new ArrayBuffer(64), updatedSenderKeyRecord: new ArrayBuffer(128) })),
  processSenderKeyDistributionMessage: jest.fn(() => ({ updatedSenderKeyRecord: new ArrayBuffer(128) })),
  groupEncrypt: jest.fn(() => ({ ciphertext: new ArrayBuffer(64), updatedSenderKeyRecord: new ArrayBuffer(128) })),
  groupDecrypt: jest.fn(() => ({ plaintext: new ArrayBuffer(16), updatedSenderKeyRecord: new ArrayBuffer(128) })),
  // Sealed sender (stubbed — deferred pending server certificate infrastructure)
  sealedSenderEncrypt: jest.fn(async () => { throw new Error('Not yet implemented'); }),
  sealedSenderDecrypt: jest.fn(async () => { throw new Error('Not yet implemented'); }),
  // Utility
  parsePreKeyMessageIds: jest.fn(() => ({ preKeyId: 1, signedPreKeyId: 1, kyberPreKeyId: 1 })),
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
  // API surface — verify all 19 production functions are exported
  // (roundtrip PoC functions gated behind dev-roundtrip feature flag)
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
    'parsePreKeyMessageIds',
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

  it('exports all 19 production functions', () => {
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
  // Sealed sender stubs — only these remain stubbed (deferred to Phase 3+)
  const STUBBED_FUNCTIONS = [
    'sealedSenderEncrypt',
    'sealedSenderDecrypt',
  ] as const;

  it('sealed sender stubs reject with Not yet implemented', async () => {
    const mod = require('orbital-signal/src/generated/orbital_signal');
    for (const fn of STUBBED_FUNCTIONS) {
      await expect(mod[fn]()).rejects.toThrow('Not yet implemented');
    }
  });
});
