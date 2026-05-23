/* eslint-disable @typescript-eslint/no-require-imports */
jest.mock('orbital-signal', () => ({
  aesGcmEncrypt: jest.fn(),
  aesGcmDecrypt: jest.fn(),
  eciesSeal: jest.fn(() => new ArrayBuffer(190)),
  eciesOpen: jest.fn(() => new ArrayBuffer(32)),
}));

jest.mock('../../../database/repositories/conversationRepository', () => ({
  getGroupMasterKey: jest.fn(),
  setGroupMasterKey: jest.fn(),
  clearGroupMasterKey: jest.fn(),
}));

jest.mock('../../../database/repositories/itemRepository', () => ({
  getItem: jest.fn(() => '05' + 'aa'.repeat(32)),
  setItem: jest.fn(),
  getAllItems: jest.fn(() => []),
}));

jest.mock('../keyGenerationService', () => ({
  getCachedIdentityPrivateKeyHex: jest.fn(() => 'bb'.repeat(32)),
}));

const mockResolveRemoteIdentityKey = jest.fn();
jest.mock('../identityKeyAccess', () => ({
  getIdentityKeyPair: jest.fn(() => ({
    privateKey: new ArrayBuffer(32),
    publicKey: new ArrayBuffer(33),
  })),
  resolveRemoteIdentityKey: (...args: unknown[]) => mockResolveRemoteIdentityKey(...args),
}));

jest.mock('../../../database/repositories/signalIdentityKeyRepository', () => ({
  getIdentityKey: jest.fn(),
  saveIdentityKey: jest.fn(),
}));

jest.mock('../../../stores/useAppStore', () => ({
  useAppStore: {
    getState: jest.fn(() => ({ userId: 'test-self-user' })),
  },
}));

import { eciesSeal, eciesOpen } from 'orbital-signal';
import { setGroupMasterKey } from '../../../database/repositories/conversationRepository';
import {
  wrapGroupKey,
  unwrapGroupKey,
  detectKeyFormat,
  evictPendingCache,
  processReceivedGroupKey,
} from '../contentCrypto';
import { arrayBufferToBase64 } from '../utils';

describe('ECIES wrapping', () => {
  it('wrapGroupKey calls eciesSeal and returns base64', () => {
    const key = new Uint8Array(32);
    const recipientPub = new ArrayBuffer(33);
    const result = wrapGroupKey(key, recipientPub, 'test-group-id');
    expect(eciesSeal).toHaveBeenCalled();
    expect(typeof result).toBe('string');
  });

  it('unwrapGroupKey calls eciesOpen and returns Uint8Array', () => {
    const fakeKey = new Uint8Array(32);
    const b64 = arrayBufferToBase64(fakeKey.buffer);
    const senderPub = new ArrayBuffer(33);
    const result = unwrapGroupKey(b64, senderPub, 'test-group-id');
    expect(eciesOpen).toHaveBeenCalled();
    expect(result).toBeInstanceOf(Uint8Array);
  });
});

describe('detectKeyFormat', () => {
  it('detects raw 32-byte keys', () => {
    const raw = new Uint8Array(32);
    const b64 = arrayBufferToBase64(raw.buffer);
    expect(detectKeyFormat(b64)).toBe('raw');
  });

  it('detects ECIES 190-byte envelopes', () => {
    const envelope = new Uint8Array(190);
    envelope[0] = 0x02;
    const b64 = arrayBufferToBase64(envelope.buffer);
    expect(detectKeyFormat(b64)).toBe('ecies');
  });

  it('throws on unknown format', () => {
    const weird = new Uint8Array(50);
    const b64 = arrayBufferToBase64(weird.buffer);
    expect(() => detectKeyFormat(b64)).toThrow('Unknown key format');
  });
});

describe('evictPendingCache', () => {
  it('does not throw', () => {
    expect(() => evictPendingCache('test-group-id')).not.toThrow();
  });
});

describe('processReceivedGroupKey', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockResolveRemoteIdentityKey.mockResolvedValue(new ArrayBuffer(33));
  });

  it('unwraps ECIES-v1 envelope and persists raw key', async () => {
    const envelope = new Uint8Array(190);
    envelope[0] = 0x02;
    const b64 = arrayBufferToBase64(envelope.buffer);

    await processReceivedGroupKey('group-1', b64, 'sender-user');

    expect(mockResolveRemoteIdentityKey).toHaveBeenCalledWith('sender-user', 'test-self-user');
    expect(eciesOpen).toHaveBeenCalled();
    expect(setGroupMasterKey).toHaveBeenCalled();
  });

  it('persists raw 32-byte key without unwrapping', async () => {
    const raw = new Uint8Array(32);
    const b64 = arrayBufferToBase64(raw.buffer);

    await processReceivedGroupKey('group-2', b64, null);

    expect(mockResolveRemoteIdentityKey).not.toHaveBeenCalled();
    expect(eciesOpen).not.toHaveBeenCalled();
    expect(setGroupMasterKey).toHaveBeenCalled();
  });

  it('throws when ECIES envelope has no wrappedBy', async () => {
    const envelope = new Uint8Array(190);
    envelope[0] = 0x02;
    const b64 = arrayBufferToBase64(envelope.buffer);

    await expect(processReceivedGroupKey('group-3', b64, null)).rejects.toThrow(
      'ECIES envelope requires sender identity',
    );
    expect(setGroupMasterKey).not.toHaveBeenCalled();
  });

  it('rejects raw key for ECIES-locked group', async () => {
    const envelope = new Uint8Array(190);
    envelope[0] = 0x02;
    const envelopeB64 = arrayBufferToBase64(envelope.buffer);
    await processReceivedGroupKey('locked-group', envelopeB64, 'sender-user');

    const raw = new Uint8Array(32);
    const rawB64 = arrayBufferToBase64(raw.buffer);

    await expect(processReceivedGroupKey('locked-group', rawB64, null)).rejects.toThrow(
      'Downgrade rejected',
    );
  });
});
