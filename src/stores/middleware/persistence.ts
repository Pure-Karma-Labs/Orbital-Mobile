import { createMMKV } from 'react-native-mmkv';
import { createJSONStorage } from 'zustand/middleware';
import type { StateStorage } from 'zustand/middleware';

/**
 * Shared MMKV instance for the app store.
 * Uses react-native-mmkv v4 (Nitro Modules) API.
 */
export const mmkvInstance = createMMKV({ id: 'orbital-app-store' });

/**
 * Raw StateStorage adapter — maps Zustand's string-based storage interface
 * to the react-native-mmkv v4 API.
 */
export const mmkvStateStorage: StateStorage = {
  getItem: (name: string) => mmkvInstance.getString(name) ?? null,
  setItem: (name: string, value: string) => mmkvInstance.set(name, value),
  removeItem: (name: string) => mmkvInstance.remove(name),
};

/**
 * JSON-serialising storage suitable for Zustand's persist middleware.
 * Pass this as `storage` in the persist options.
 */
export function createMMKVStorage<S>() {
  return createJSONStorage<S>(() => mmkvStateStorage);
}
