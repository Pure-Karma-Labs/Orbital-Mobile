jest.mock('orbital-signal', () => ({
  inviteEncryptGroupKey: jest.fn(() => new ArrayBuffer(60)),
  inviteDecryptGroupKey: jest.fn(() => new ArrayBuffer(32)),
}));

import {
  generateInviteCode,
  formatInviteCode,
  stripInviteCode,
  encryptGroupKeyForInvite,
  decryptGroupKeyFromInvite,
} from '../inviteCrypto';
import {inviteEncryptGroupKey, inviteDecryptGroupKey} from 'orbital-signal';

const CROCKFORD_CHARS = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

describe('inviteCrypto', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('generateInviteCode', () => {
    it('produces a 20-character string', () => {
      const code = generateInviteCode();
      expect(code).toHaveLength(20);
    });

    it('uses only Crockford Base32 characters', () => {
      const code = generateInviteCode();
      for (const ch of code) {
        expect(CROCKFORD_CHARS).toContain(ch);
      }
    });

    it('produces different codes on successive calls', () => {
      const codes = new Set(Array.from({length: 10}, () => generateInviteCode()));
      expect(codes.size).toBe(10);
    });
  });

  describe('formatInviteCode', () => {
    it('inserts dashes every 4 characters', () => {
      expect(formatInviteCode('ABCDEFGHJKMNPQRSTVW0')).toBe('ABCD-EFGH-JKMN-PQRS-TVW0');
    });

    it('returns empty string for empty input', () => {
      expect(formatInviteCode('')).toBe('');
    });
  });

  describe('stripInviteCode', () => {
    it('removes dashes and uppercases', () => {
      expect(stripInviteCode('abcd-efgh-jkmn-pqrs-tvw0')).toBe('ABCDEFGHJKMNPQRSTVW0');
    });

    it('handles code without dashes', () => {
      expect(stripInviteCode('ABCDEFGHJKMNPQRSTVW0')).toBe('ABCDEFGHJKMNPQRSTVW0');
    });
  });

  describe('encryptGroupKeyForInvite', () => {
    it('calls inviteEncryptGroupKey with UTF-8 encoded inputs', () => {
      const groupKey = new Uint8Array(32).fill(0x42);
      const result = encryptGroupKeyForInvite(groupKey, 'TESTCODE1234567890AB', 'group-uuid-123');

      expect(inviteEncryptGroupKey).toHaveBeenCalledTimes(1);
      const [keyArg, codeArg, groupIdArg] = (inviteEncryptGroupKey as jest.Mock).mock.calls[0];
      expect(new Uint8Array(keyArg)).toEqual(groupKey);
      expect(new Uint8Array(codeArg)).toEqual(new TextEncoder().encode('TESTCODE1234567890AB'));
      expect(new Uint8Array(groupIdArg)).toEqual(new TextEncoder().encode('group-uuid-123'));
      expect(typeof result).toBe('string'); // base64
    });
  });

  describe('decryptGroupKeyFromInvite', () => {
    it('calls inviteDecryptGroupKey and returns Uint8Array', () => {
      // Create a fake 60-byte blob as base64
      const fakeBlob = new Uint8Array(60).fill(0xAA);
      const g = globalThis as unknown as {btoa: (s: string) => string};
      const base64Blob = g.btoa(String.fromCharCode(...fakeBlob));

      const result = decryptGroupKeyFromInvite(base64Blob, 'TESTCODE1234567890AB', 'group-uuid-123');

      expect(inviteDecryptGroupKey).toHaveBeenCalledTimes(1);
      expect(result).toBeInstanceOf(Uint8Array);
      expect(result).toHaveLength(32);
    });
  });
});
