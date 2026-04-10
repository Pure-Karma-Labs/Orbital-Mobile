export const SERVICE_PREFIX = 'com.orbital.mobile';

export const SecureKeys = {
  ACCESS_TOKEN: `${SERVICE_PREFIX}.jwt-access-token`,
  REFRESH_TOKEN: `${SERVICE_PREFIX}.jwt-refresh-token`,
  MMKV_ENCRYPTION_KEY: `${SERVICE_PREFIX}.mmkv-encryption-key`,
  DATABASE_ENCRYPTION_KEY: `${SERVICE_PREFIX}.database-encryption-key`,
  INSTALLED_SENTINEL: `${SERVICE_PREFIX}.installed`,
  IDENTITY_KEY_PRIVATE: `${SERVICE_PREFIX}.identity-key-private`,
} as const;

export type SecureKey = (typeof SecureKeys)[keyof typeof SecureKeys];

export const KEYCHAIN_USERNAME = 'orbital';
