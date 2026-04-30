/**
 * Global Jest setup — runs after the test framework is installed, before each test file.
 *
 * Provides polyfills for Web APIs that exist in React Native (Hermes) but
 * may be missing in the Node.js test environment.
 */

const g = globalThis as Record<string, unknown>;

// btoa polyfill (base64 encode)
if (typeof g['btoa'] === 'undefined') {
  g['btoa'] = (str: string) => {
    const chars =
      'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    let result = '';
    for (let i = 0; i < str.length; i += 3) {
      const a = str.charCodeAt(i);
      const b = i + 1 < str.length ? str.charCodeAt(i + 1) : 0;
      const c = i + 2 < str.length ? str.charCodeAt(i + 2) : 0;
      result += chars[a >> 2] + chars[((a & 3) << 4) | (b >> 4)];
      result += i + 1 < str.length ? chars[((b & 15) << 2) | (c >> 6)] : '=';
      result += i + 2 < str.length ? chars[c & 63] : '=';
    }
    return result;
  };
}

// atob polyfill (base64 decode)
if (typeof g['atob'] === 'undefined') {
  g['atob'] = (str: string) => {
    const chars =
      'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    let result = '';
    const clean = str.replace(/=+$/, '');
    for (let i = 0; i < clean.length; i += 4) {
      const a = chars.indexOf(clean[i]);
      const b = chars.indexOf(clean[i + 1]);
      const c = chars.indexOf(clean[i + 2]);
      const d = chars.indexOf(clean[i + 3]);
      result += String.fromCharCode((a << 2) | (b >> 4));
      if (c !== -1) result += String.fromCharCode(((b & 15) << 4) | (c >> 2));
      if (d !== -1) result += String.fromCharCode(((c & 3) << 6) | d);
    }
    return result;
  };
}

// Suppress React's act() warnings from VirtualizedList timers firing after test completion.
// These are React internals, not application errors.
const originalConsoleError = console.error;
console.error = (...args: unknown[]) => {
  const msg = typeof args[0] === 'string' ? args[0] : '';
  if (msg.includes('not wrapped in act')) return;
  originalConsoleError(...args);
};

// crypto.getRandomValues polyfill (deterministic for tests)
if (
  typeof g['crypto'] === 'undefined' ||
  !(g['crypto'] as { getRandomValues?: unknown }).getRandomValues
) {
  g['crypto'] = {
    getRandomValues: (buf: Uint8Array) => {
      for (let i = 0; i < buf.length; i++) buf[i] = (i * 37 + 11) & 0xff;
      return buf;
    },
  };
}
