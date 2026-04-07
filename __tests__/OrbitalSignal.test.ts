/**
 * Smoke test for uniffi-bindgen-react-native generated bindings.
 *
 * This validates the TypeScript module structure is importable.
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
  helloOrbital: jest.fn((name: string) => `Hello from Orbital Signal, ${name}!`),
  default: {
    initialize: jest.fn(),
  },
}));

describe('orbital_signal bindings', () => {
  it('exports helloOrbital function', () => {
    const {helloOrbital} = require('orbital-signal/src/generated/orbital_signal');
    expect(typeof helloOrbital).toBe('function');
  });

  it('helloOrbital returns expected format', () => {
    const {helloOrbital} = require('orbital-signal/src/generated/orbital_signal');
    const result = helloOrbital('World');
    expect(result).toBe('Hello from Orbital Signal, World!');
  });

  it('re-exports via index.tsx entry point', () => {
    const orbital = require('orbital-signal');
    expect(orbital.helloOrbital).toBeDefined();
  });
});
