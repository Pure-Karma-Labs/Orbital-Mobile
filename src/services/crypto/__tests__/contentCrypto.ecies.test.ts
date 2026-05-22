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
}));

jest.mock('../keyGenerationService', () => ({
  getCachedIdentityPrivateKeyHex: jest.fn(() => 'bb'.repeat(32)),
}));

import { eciesSeal, eciesOpen } from 'orbital-signal';
import {
  wrapGroupKey,
  unwrapGroupKey,
  detectKeyFormat,
  evictPendingCache,
} from '../contentCrypto';
import { arrayBufferToBase64 } from '../utils';

describe('ECIES wrapping', () => {
  it('wrapGroupKey calls eciesSeal and returns base64', () => {
    const key = new Uint8Array(32);
    const recipientPub = new ArrayBuffer(33);
    const result = wrapGroupKey(key, recipientPub);
    expect(eciesSeal).toHaveBeenCalled();
    expect(typeof result).toBe('string');
  });

  it('unwrapGroupKey calls eciesOpen and returns Uint8Array', () => {
    const fakeKey = new Uint8Array(32);
    const b64 = arrayBufferToBase64(fakeKey.buffer);
    const senderPub = new ArrayBuffer(33);
    const result = unwrapGroupKey(b64, senderPub);
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

  it('detects ECIES-v1 190-byte envelopes', () => {
    const envelope = new Uint8Array(190);
    envelope[0] = 0x01;
    const b64 = arrayBufferToBase64(envelope.buffer);
    expect(detectKeyFormat(b64)).toBe('ecies-v1');
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
