/**
 * Central environment configuration module.
 *
 * This is the ONLY file in the codebase that imports from react-native-config.
 * All other modules import their config values from here.
 *
 * Validation runs at module load time — if a required value is invalid,
 * the app crashes immediately rather than failing silently later.
 */

import Config from 'react-native-config';

// ============================================================
// Sentry DSN (optional — empty/missing disables Sentry)
// ============================================================

export const SENTRY_DSN: string | undefined =
  Config.SENTRY_DSN?.trim() || undefined;

// ============================================================
// API Base URL (required in production, defaults to localhost in dev)
// ============================================================

const DEFAULT_API_URL = __DEV__ ? 'http://localhost:3000' : '';

const rawApiUrl = (Config.API_URL?.trim() || DEFAULT_API_URL).replace(
  /\/+$/,
  '',
);

// Fail fast in production if no API URL is configured
if (!rawApiUrl) {
  throw new Error(
    '[Config] API_URL is required in production builds. ' +
      'Create a .env file with API_URL=https://your-api-host or set it in CI secrets.',
  );
}

// Validate URL format
try {
  new URL(rawApiUrl); // eslint-disable-line no-new
} catch {
  throw new Error(
    `[Config] API_URL is not a valid URL: "${rawApiUrl}". ` +
      'Must be a full URL including protocol (e.g., https://api.orbitl.org).',
  );
}

// Enforce HTTPS in production
if (!__DEV__ && !rawApiUrl.startsWith('https://')) {
  throw new Error(
    `[Config] API_URL must use HTTPS in production. Got: "${rawApiUrl}".`,
  );
}

export const API_BASE_URL: string = rawApiUrl;

// ============================================================
// WebSocket URL (derived from API base URL)
// ============================================================

export const WS_URL: string =
  API_BASE_URL.replace(/^https:\/\//, 'wss://').replace(
    /^http:\/\//,
    'ws://',
  ) + '/v1/websocket';

// ============================================================
// Dev startup log
// ============================================================

if (__DEV__) {
  console.log('[Config]', {
    API_BASE_URL,
    WS_URL,
    SENTRY_DSN: SENTRY_DSN ? '(set)' : '(not set)',
  });
}
