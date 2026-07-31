/**
 * Tests for base64DecodedLength — the read-loop bookkeeping helper (#578).
 *
 * The streaming download path never decodes base64 in JS, so every read
 * position and every emitted-byte count is derived from the string. A wrong
 * length here desynchronises the read loop and surfaces much later as an
 * opaque HMAC failure, so this helper is tested against a real encoder.
 */

import { base64DecodedLength, base64ToUint8Array, arrayBufferToBase64, toArrayBuffer } from '../utils';

describe('base64DecodedLength', () => {
  it('returns 0 for the empty string', () => {
    expect(base64DecodedLength('')).toBe(0);
  });

  it('agrees with a real encode for every length 0..64 and the padding boundaries', () => {
    const lengths = [
      ...Array.from({ length: 65 }, (_v, i) => i),
      255, 256, 257, 1023, 1024, 1025, 4096,
    ];
    for (const n of lengths) {
      const bytes = new Uint8Array(n).map((_v, i) => (i * 37) % 256);
      const b64 = arrayBufferToBase64(toArrayBuffer(bytes));
      expect(base64DecodedLength(b64)).toBe(n);
    }
  });

  it('agrees with atob-based decoding', () => {
    const bytes = new Uint8Array(1601).map((_v, i) => (i * 31) % 256);
    const b64 = arrayBufferToBase64(toArrayBuffer(bytes));
    expect(base64DecodedLength(b64)).toBe(base64ToUint8Array(b64).length);
  });

  // iOS RNFS read() returns line-broken base64; atob tolerates it, so the
  // length helper has to agree with atob rather than with the raw string length.
  it('ignores embedded ASCII whitespace (iOS line-broken base64)', () => {
    const bytes = new Uint8Array(300).map((_v, i) => i % 256);
    const b64 = arrayBufferToBase64(toArrayBuffer(bytes));
    const wrapped = (b64.match(/.{1,64}/g) ?? []).join('\n') + '\r\n';
    expect(base64DecodedLength(wrapped)).toBe(300);
    expect(base64DecodedLength(`  ${b64}\t`)).toBe(300);
  });

  it('handles the one- and two-pad cases exactly', () => {
    expect(base64DecodedLength('AA==')).toBe(1);
    expect(base64DecodedLength('AAA=')).toBe(2);
    expect(base64DecodedLength('AAAA')).toBe(3);
  });

  it('throws rather than guessing on a truncated (non-multiple-of-4) chunk', () => {
    expect(() => base64DecodedLength('AAA')).toThrow(/multiple of 4/);
    expect(() => base64DecodedLength('A')).toThrow(/multiple of 4/);
  });

  it('throws on data after padding', () => {
    expect(() => base64DecodedLength('AA==AAAA')).toThrow(/after padding/);
  });

  it('throws on excess padding', () => {
    expect(() => base64DecodedLength('A===')).toThrow(/excess padding/);
  });
});
