/**
 * Stable device identifier for push notification registration.
 *
 * Generates a UUID v4 on first call and persists it in MMKV so it remains
 * stable across app restarts. Resets only on app reinstall (MMKV data cleared).
 *
 * IMPORTANT: Must be called lazily (not at module scope) because MMKV is not
 * initialized until bootstrap completes. This is safe because the device ID
 * is only needed during push registration, which runs after auth succeeds.
 */

import { getMMKVInstance } from '../stores/middleware/persistence';
import { generateUUID } from '../utils/uuid';

const MMKV_KEY = 'orbital:device-id';

/**
 * Returns a stable device ID for this app install.
 * Creates and persists one if it doesn't exist yet.
 */
export function getDeviceId(): string {
  const mmkv = getMMKVInstance();
  const existing = mmkv.getString(MMKV_KEY);
  if (existing) return existing;

  const id = generateUUID();
  mmkv.set(MMKV_KEY, id);
  return id;
}
