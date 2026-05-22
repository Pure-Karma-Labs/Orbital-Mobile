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
}));

jest.mock('../keyGenerationService', () => ({
  getCachedIdentityPrivateKeyHex: jest.fn(() => 'bb'.repeat(32)),
}));

jest.mock('../utils', () => ({
  arrayBufferToBase64: jest.fn((ab: ArrayBuffer) => {
    const bytes = new Uint8Array(ab);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  }),
  base64ToArrayBuffer: jest.fn((b64: string) => {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
  }),
  toArrayBuffer: jest.fn((u8: Uint8Array) => u8.buffer),
  hexToUint8Array: jest.fn((hex: string) => {
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < hex.length; i += 2) bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
    return bytes;
  }),
}));

import { eciesSeal, eciesOpen } from 'orbital-signal';
import {
  wrapGroupKey,
  unwrapGroupKey,
  detectKeyFormat,
  evictPendingCache,
} from '../contentCrypto';

describe('ECIES wrapping', () => {
  it('wrapGroupKey calls eciesSeal and returns base64', () => {
    const key = new Uint8Array(32);
    const recipientPub = new ArrayBuffer(33);
    const result = wrapGroupKey(key, recipientPub);
    expect(eciesSeal).toHaveBeenCalled();
    expect(typeof result).toBe('string');
  });

  it('unwrapGroupKey calls eciesOpen and returns Uint8Array', () => {
    const raw32 = new Uint8Array(32);
    let binary = '';
    for (let i = 0; i < raw32.length; i++) binary += String.fromCharCode(raw32[i]);
    const b64 = btoa(binary);
    const senderPub = new ArrayBuffer(33);
    const result = unwrapGroupKey(b64, senderPub);
    expect(eciesOpen).toHaveBeenCalled();
    expect(result).toBeInstanceOf(Uint8Array);
  });
});

describe('detectKeyFormat', () => {
  it('detects raw 32-byte keys', () => {
    const raw = new Uint8Array(32);
    let binary = '';
    for (let i = 0; i < raw.length; i++) binary += String.fromCharCode(raw[i]);
    expect(detectKeyFormat(btoa(binary))).toBe('raw');
  });

  it('detects ECIES-v1 190-byte envelopes', () => {
    const envelope = new Uint8Array(190);
    envelope[0] = 0x01;
    let binary = '';
    for (let i = 0; i < envelope.length; i++) binary += String.fromCharCode(envelope[i]);
    expect(detectKeyFormat(btoa(binary))).toBe('ecies-v1');
  });

  it('throws on unknown format', () => {
    const weird = new Uint8Array(50);
    let binary = '';
    for (let i = 0; i < weird.length; i++) binary += String.fromCharCode(weird[i]);
    expect(() => detectKeyFormat(btoa(binary))).toThrow('Unknown key format');
  });
});

describe('evictPendingCache', () => {
  it('does not throw', () => {
    expect(() => evictPendingCache('test-group-id')).not.toThrow();
  });
});
