/**
 * Automatic manual mock for @sentry/react-native.
 *
 * The published package is ESM-only and is NOT in jest.config.js's
 * transformIgnorePatterns allowlist, so any suite that transitively imports it
 * dies with `SyntaxError: Unexpected token 'export'`. Jest applies manual mocks
 * for node_modules packages automatically, so this file lets telemetry live in
 * shared services (mediaUploadService, uploadTelemetry) without every unrelated
 * suite having to declare its own jest.mock.
 *
 * Suites that assert on Sentry calls may still declare an explicit
 * jest.mock('@sentry/react-native', …); that takes precedence over this file.
 */

export const init = jest.fn();
export const wrap = <T>(component: T): T => component;
export const captureException = jest.fn();
export const captureMessage = jest.fn();
export const addBreadcrumb = jest.fn();
export const setUser = jest.fn();
export const setTag = jest.fn();
export const setTags = jest.fn();
export const setContext = jest.fn();
export const setExtra = jest.fn();
export const withScope = jest.fn();
export const flush = jest.fn(async () => true);
