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

// ---------------------------------------------------------------------------
// OrbitalSpinner — global mock (#731)
//
// OrbitalSpinner drives its continuous rotation with a recursive
// Animated.timing chain (OrbitalSpinner.tsx:14-41) under `useNativeDriver:
// true`, so in Jest it routes through React Native's native-animation mock
// (react-native/jest/mocks/NativeModules.js:96-99):
//
//   startAnimatingNode: (id, tag, cfg, cb) => setTimeout(() => cb({finished: true}), 16)
//   stopAnimation:      jest.fn()   // no-op
//
// The mock re-arms the chain every 16 ms and unconditionally reports
// `finished: true`, while the component's cleanup call to
// `rotation.stopAnimation()` cancels nothing. That leaves `alive.current =
// false` as the only working brake, and it runs on unmount alone. A suite that
// leaves a renderer mounted — or whose test times out before teardown — leaks
// the chain into later tests ("Can't access .root on unmounted test renderer")
// or wedges the run outright.
//
// Ten of the twelve suites that render a spinner already mocked it file by
// file for this reason. The two that did not — ThreadDetailScreen and
// LightboxVideoPage — are exactly the two that flaked and hung CI. Hoisting the
// mock here removes the failure mode for every suite, present and future.
// Per-file `jest.mock()` calls still take precedence over this one.
// ---------------------------------------------------------------------------
jest.mock('./src/components/OrbitalSpinner', () => {
  const { createElement } = require('react');
  return {
    OrbitalSpinner: () => createElement('View', { testID: 'orbital-spinner' }),
  };
});
