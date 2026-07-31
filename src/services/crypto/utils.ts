export function encodeUTF8(str: string): Uint8Array {
  const arr = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) {
    arr[i] = str.charCodeAt(i);
  }
  return arr;
}

export function toArrayBuffer(u8: Uint8Array): ArrayBuffer {
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer;
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

export function hexToUint8Array(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) {
    throw new Error('Invalid hex string: odd length');
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    const byte = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) {
      throw new Error(`Invalid hex character at position ${i * 2}`);
    }
    bytes[i] = byte;
  }
  return bytes;
}

export function uint8ArrayToHex(bytes: Uint8Array): string {
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16);
  }
  return hex;
}

export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  const g = globalThis as unknown as { btoa: (s: string) => string };
  return g.btoa(binary);
}

/**
 * Decode a base64 string to Uint8Array.
 *
 * Uses atob, which is available in Hermes via the react-native polyfills and
 * tolerates embedded whitespace/newlines (iOS RNFS `read()` returns
 * line-broken base64).
 */
export function base64ToUint8Array(base64: string): Uint8Array {
  const g = globalThis as unknown as { atob: (s: string) => string };
  const binary = g.atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const bytes = base64ToUint8Array(base64);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/**
 * Number of bytes a canonically-padded base64 string decodes to, WITHOUT
 * decoding it.
 *
 * The streaming media download path (#578) hands base64 straight from RNFS to
 * Rust and straight from Rust to `appendFile` — JS never materialises the
 * bytes, so the read loop's position bookkeeping and the emitted-plaintext
 * accumulator have to derive lengths from the string itself.
 *
 * ASCII whitespace is ignored (iOS `read()` returns line-broken base64, and
 * `atob` accepts it), so this stays consistent with what a decoder would
 * actually produce. Structurally invalid input throws rather than returning a
 * plausible-but-wrong length: a silently wrong length desynchronises the read
 * position and would surface as an opaque HMAC failure much later.
 */
export function base64DecodedLength(base64: string): number {
  let dataChars = 0;
  let padChars = 0;

  for (let i = 0; i < base64.length; i++) {
    const code = base64.charCodeAt(i);
    // ASCII whitespace: \t \n \v \f \r and space
    if (code === 32 || (code >= 9 && code <= 13)) continue;
    if (code === 61 /* '=' */) {
      padChars++;
      continue;
    }
    if (padChars > 0) {
      throw new Error('Invalid base64: data after padding');
    }
    dataChars++;
  }

  const total = dataChars + padChars;
  if (total % 4 !== 0) {
    throw new Error('Invalid base64: length is not a multiple of 4');
  }
  if (padChars > 2) {
    throw new Error('Invalid base64: excess padding');
  }
  return (total / 4) * 3 - padChars;
}

/**
 * Fill a fresh Uint8Array of `size` bytes with cryptographically secure
 * randomness from the Hermes-polyfilled global crypto object.
 */
export function getSecureRandom(size: number): Uint8Array {
  const buf = new Uint8Array(size);
  (globalThis as unknown as { crypto: { getRandomValues: (a: Uint8Array) => void } }).crypto.getRandomValues(buf);
  return buf;
}
