/**
 * Mock for the orbital-archive-reader TurboModule wrapper (#920, #982, mapped
 * in jest.config.js moduleNameMapper). Provides jest.fn() stubs for every
 * entry point and re-exports the REAL types, error class, disposition table
 * and cancellation guard from the wrapper source.
 *
 * Re-exporting the real code rather than copying it:
 *   - `ARCHIVE_ERROR_DISPOSITIONS` is pure frozen data that callers switch on;
 *     a diverging copy would hide a mapping bug instead of failing a test.
 *   - `ArchiveReaderError` is a real class so `instanceof` checks, `e.code`
 *     routing and the "no interpolation" property all behave exactly as in
 *     production.
 *   - `isArchiveCancellation` is a one-liner that must stay identical.
 *
 * The relative import path `'../packages/orbital-archive-reader/src/index'`
 * bypasses the `^orbital-archive-reader$` moduleNameMapper because it is not
 * an exact-match specifier. The wrapper's top-level imports are all `import
 * type {...}`, so loading it performs zero native work. Security invariant 29a
 * exempts `__mocks__/` from the single-importer rule.
 *
 * `isArchivePartToken` delegates to the real decoder rather than a
 * prefix-only stub so that app tests cannot pass a token that would be
 * rejected by the actual `decodeToken`. Its consumer is the
 * `#921`/`#926` persisted-token validation path.
 *
 * `pickArchiveParts` defaults to `Promise.resolve(null)` (user-cancelled) so
 * tests that do not set up the mock do not accidentally receive an empty list.
 *
 * Token fixtures (`MOCK_TOKEN`, `makeOarToken`) produce tokens that pass the
 * real decoder; `wrapper.test.ts` asserts validity once to lock the encoding.
 */

// ---------------------------------------------------------------------------
// Real re-exports (not copied)
// ---------------------------------------------------------------------------

export {
  ARCHIVE_ERROR_DISPOSITIONS,
  ArchiveReaderError,
  isArchiveCancellation,
} from '../packages/orbital-archive-reader/src/index';

export type {
  ArchiveCallOptions,
  ArchiveEntry,
  ArchiveErrorCode,
  ArchiveErrorDisposition,
  ArchivePartToken,
  ArchiveSession,
  EntryKind,
  EntrySkipCode,
  ExtractResult,
  JsonResult,
  MediaKind,
  PeekResult,
  RustEntrySkipCode,
  ServiceEntrySkipCode,
  UriResolution,
  UriSkipCode,
} from '../packages/orbital-archive-reader/src/index';

import {
  isArchivePartToken as realIsArchivePartToken,
} from '../packages/orbital-archive-reader/src/index';

import type {
  ArchiveCallOptions,
  ArchiveEntry,
  ArchivePartToken,
  RustEntrySkipCode,
  UriResolution,
} from '../packages/orbital-archive-reader/src/index';

// ---------------------------------------------------------------------------
// Real-token fixture helpers
// ---------------------------------------------------------------------------

/**
 * Minimal base64url encoder for the ASCII JSON payloads produced by
 * `makeOarToken`.  Matches the wrapper's own `base64UrlEncode` output exactly
 * for ASCII input, without pulling in a polyfill.
 */
function oarBase64url(json: string): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const bytes = Array.from(json, (c) => c.charCodeAt(0));
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    out += alphabet[b0 >> 2];
    out += alphabet[((b0 & 3) << 4) | (b1 === undefined ? 0 : b1 >> 4)];
    if (b1 === undefined) break;
    out += alphabet[((b1 & 15) << 2) | (b2 === undefined ? 0 : b2 >> 6)];
    if (b2 === undefined) break;
    out += alphabet[b2 & 63];
  }
  return out;
}

/**
 * Build a token that the real `decodeToken` accepts: `oar1:` +
 * base64url(`{"v":1,"p":"ios","ref":"<ref>","persist":<persist>}`).
 */
export function makeOarToken(ref: string, persist = false): ArchivePartToken {
  const payload = JSON.stringify({ v: 1, p: 'ios', ref, persist });
  return `oar1:${oarBase64url(payload)}` as ArchivePartToken;
}

/** A ready-to-use token fixture that passes the real decoder. */
export const MOCK_TOKEN: ArchivePartToken = makeOarToken('mock-archive-ref');

// ---------------------------------------------------------------------------
// `isArchivePartToken` -- real decoder, wrapped in a jest.fn
// ---------------------------------------------------------------------------

/**
 * Delegates to the real decoder so that a prefix-only stub cannot hide
 * `decodeToken` regressions in app tests.
 * Consumer: `#921`/`#926` persisted-token validation.
 */
export const isArchivePartToken = jest.fn(realIsArchivePartToken);

// ---------------------------------------------------------------------------
// Session factory
// ---------------------------------------------------------------------------

/**
 * `ArchiveSession` with every method as a jest.Mock, so a test can assert on
 * calls and override individual pieces. The async methods resolve `undefined`
 * by default — a test that reads their result installs its own resolution.
 */
export interface MockArchiveSession {
  parts: ArchivePartToken[];
  entries: ArchiveEntry[];
  rejectedCounts: Partial<Record<RustEntrySkipCode, number>>;
  resolveMediaUris: jest.Mock<UriResolution[], [readonly string[]]>;
  peekHead: jest.Mock;
  readJson: jest.Mock;
  extractEntry: jest.Mock;
  releaseStaging: jest.Mock;
  close: jest.Mock;
}

/**
 * Build a fresh session-shaped object. `openArchive` resolves one of these by
 * default; pass `overrides` to replace individual fields, e.g.
 * `makeMockArchiveSession({ entries: [entry], readJson: jest.fn(...) })`.
 */
export const makeMockArchiveSession = (
  overrides: Partial<MockArchiveSession> = {},
): MockArchiveSession => ({
  parts: [],
  entries: [],
  rejectedCounts: {},
  resolveMediaUris: jest.fn<UriResolution[], [readonly string[]]>(() => []),
  peekHead: jest.fn(),
  readJson: jest.fn(),
  extractEntry: jest.fn(),
  releaseStaging: jest.fn(),
  close: jest.fn(),
  ...overrides,
});

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

/**
 * Default resolves `null` (user-cancelled) so tests that do not configure this
 * do not accidentally receive an empty-list result.
 */
export const pickArchiveParts = jest.fn<Promise<ArchivePartToken[] | null>, []>(() =>
  Promise.resolve(null),
);

export const openArchive = jest.fn<
  Promise<MockArchiveSession>,
  [readonly ArchivePartToken[], ArchiveCallOptions?]
>(() => Promise.resolve(makeMockArchiveSession()));

export const releaseArchiveParts = jest.fn<Promise<void>, [readonly ArchivePartToken[]]>(() =>
  Promise.resolve(),
);

export const releaseAllPersistedParts = jest.fn<Promise<void>, []>(() => Promise.resolve());

/** Synchronous in the real module: `localWipe` phase 1 never awaits it (F3). */
export const abortAllArchiveSessions = jest.fn<void, []>();

/** Synchronous in the real module: swallows everything, returns nothing. */
export const unlinkStagingFile = jest.fn<void, [string]>();

export const __resetArchiveReaderForTests = jest.fn<void, []>();
