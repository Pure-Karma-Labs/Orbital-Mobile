import { createMMKV } from 'react-native-mmkv';
import { createJSONStorage } from 'zustand/middleware';
import type { StateStorage } from 'zustand/middleware';

let mmkvInstance: ReturnType<typeof createMMKV> | null = null;

/**
 * Initialize MMKV with an encryption key retrieved from Keychain.
 * Must be called once during app bootstrap (see src/bootstrap.ts), before
 * any Zustand store that uses persist middleware is accessed.
 *
 * Throws if called more than once to prevent silent re-initialization.
 */
export function initMMKV(encryptionKey: string): void {
  if (mmkvInstance !== null) {
    throw new Error('MMKV already initialized');
  }
  mmkvInstance = createMMKV({ id: 'orbital-app-store', encryptionKey });
}

/**
 * Returns the initialized MMKV instance.
 * Throws a descriptive error if initMMKV() has not been called yet.
 */
export function getMMKVInstance(): ReturnType<typeof createMMKV> {
  if (mmkvInstance === null) {
    throw new Error(
      'MMKV not initialized — call initMMKV() in bootstrap before accessing the store. ' +
        'See src/bootstrap.ts for the initialization sequence.',
    );
  }
  return mmkvInstance;
}

/**
 * Reset MMKV for testing — creates an unencrypted instance.
 * Never call this in production code.
 */
export function resetMMKVForTesting(): void {
  mmkvInstance = createMMKV({ id: 'orbital-test-store' });
}

/**
 * Raw StateStorage adapter — maps Zustand's string-based storage interface
 * to the react-native-mmkv v4 API. Access is lazy so the store module can
 * be imported before bootstrap initializes MMKV.
 */
export const mmkvStateStorage: StateStorage = {
  getItem: (name: string) => {
    if (mmkvInstance === null) { return null; }
    return mmkvInstance.getString(name) ?? null;
  },
  setItem: (name: string, value: string) => {
    if (mmkvInstance === null) { return; }
    mmkvInstance.set(name, value);
  },
  removeItem: (name: string) => {
    if (mmkvInstance === null) { return; }
    mmkvInstance.remove(name);
  },
};

/**
 * JSON-serialising storage suitable for Zustand's persist middleware.
 * Pass this as `storage` in the persist options.
 */
export function createMMKVStorage<S>() {
  return createJSONStorage<S>(() => mmkvStateStorage);
}
