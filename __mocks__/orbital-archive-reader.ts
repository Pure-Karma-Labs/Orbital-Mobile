/**
 * Mock for the orbital-archive-reader TurboModule wrapper (#920, mapped in
 * jest.config.js moduleNameMapper). Mirrors every export of
 * packages/orbital-archive-reader/src/index.tsx.
 *
 * Nothing here touches `./bindings`, `./NativeOrbitalArchiveAccess` or
 * `TurboModuleRegistry`: the real wrapper reaches native only through lazy
 * `require`s, and this mock reaches it not at all, so importing the mocked
 * specifier performs zero native work in Jest.
 *
 * Three exports are REAL rather than jest.fn()s, deliberately:
 *   - `ArchiveReaderError` is a real class with the real FIXED per-code message
 *     table, so `instanceof`, `e.code` routing and the "a logged message can
 *     carry nothing about the archive" property behave exactly as in
 *     production, and a test can drive every error branch with
 *     `openArchive.mockRejectedValue(new ArchiveReaderError('ARCHIVE_CORRUPT'))`.
 *   - `ARCHIVE_ERROR_DISPOSITIONS` is the real frozen data table. It is pure
 *     data that #926/#928 switch on; a diverging copy here would hide a
 *     mapping bug instead of failing a test.
 *   - `isArchiveCancellation` is the real one-line implementation, for the same
 *     reason `isCancellation` is real-ish in the transcoder mock.
 *
 * TYPES ARE RE-DECLARED, not re-exported. `export type { … } from
 * 'orbital-archive-reader'` would resolve back to THIS file under the
 * moduleNameMapper above (a self-reference), so the public types are copied
 * from the wrapper verbatim. They are structurally identical; a test file
 * typechecks against the real package (tsc does not apply Jest's mapper), so
 * these declarations only serve this file's own signatures.
 */

// ---------------------------------------------------------------------------
// Public codes and types (copied verbatim from the wrapper)
// ---------------------------------------------------------------------------

/** Archive-wide failures. Thrown, never returned. */
export type ArchiveErrorCode =
  | 'ARCHIVE_NOT_ZIP'
  | 'ARCHIVE_CORRUPT'
  | 'ARCHIVE_UNSUPPORTED'
  | 'ARCHIVE_TOO_MANY_ENTRIES'
  | 'ARCHIVE_TOO_MANY_PARTS'
  | 'ARCHIVE_SESSION_BYTES_EXCEEDED'
  | 'ARCHIVE_DUPLICATE_PART'
  | 'ARCHIVE_NOT_SEEKABLE'
  | 'ARCHIVE_READ_FAILED'
  | 'ARCHIVE_ACCESS_LOST'
  | 'ARCHIVE_CHANGED'
  | 'ARCHIVE_STAGING_UNAVAILABLE'
  | 'ARCHIVE_STAGING_IN_USE'
  | 'ARCHIVE_NO_SPACE'
  | 'ECANCELLED'
  | 'ARCHIVE_SESSION_CLOSED'
  | 'ARCHIVE_BUSY'
  | 'PICKER_BUSY'
  | 'ARCHIVE_INTERNAL';

/** Per-entry outcomes Rust produces. Values, never thrown. */
export type RustEntrySkipCode =
  | 'ENTRY_PATH_INVALID'
  | 'ENTRY_PATH_TRAVERSAL'
  | 'ENTRY_SYMLINK'
  | 'ENTRY_SPECIAL_FILE'
  | 'ENTRY_ENCRYPTED'
  | 'ENTRY_NESTED_ARCHIVE'
  | 'ENTRY_UNSUPPORTED_METHOD'
  | 'ENTRY_DUPLICATE'
  | 'ENTRY_OVER_CAP'
  | 'ENTRY_RATIO_EXCEEDED'
  | 'ENTRY_CORRUPT'
  | 'ENTRY_KIND_NOT_ENABLED'
  | 'ENTRY_KIND_MISMATCH'
  | 'ENTRY_NOT_UTF8'
  | 'ENTRY_NOT_ALLOWLISTED';

/**
 * Per-entry outcomes the APP SERVICE adds after sniffing `peekHead` output
 * (F1). Rust never produces these three.
 */
export type ServiceEntrySkipCode =
  'ENTRY_IS_VIDEO' | 'ENTRY_UNSUPPORTED_IMAGE_FORMAT' | 'ENTRY_SNIFF_INDETERMINATE';

export type EntrySkipCode = RustEntrySkipCode | ServiceEntrySkipCode;

export type UriSkipCode =
  | 'URI_INVALID'
  | 'URI_OUTSIDE_ALLOWLIST'
  | 'URI_UNRESOLVED'
  | 'URI_AMBIGUOUS'
  | 'URI_UNSUPPORTED_KIND';

/** Kinds that may be extracted. `'video'` is listed but never opened. */
export type MediaKind = 'image';
export type EntryKind = 'json' | MediaKind | 'video';

/**
 * An opaque, persistable handle to one picked archive part.
 *
 * `"oar1:" + base64url(JSON { v, p, ref, persist, fp? })`. Never parse it.
 */
export type ArchivePartToken = string & { readonly __archivePartToken: unique symbol };

export interface ArchiveEntry {
  /** OPAQUE. Never parse, split, shorten or derive from this. */
  readonly entryId: string;
  /** Archive-relative path after the wrapper strip. */
  readonly path: string;
  readonly kind: EntryKind;
  readonly declaredSize: number;
  readonly skip: RustEntrySkipCode | null;
}

export type UriResolution =
  | { readonly ok: true; readonly entryId: string }
  | { readonly ok: false; readonly skip: UriSkipCode };

export type PeekResult =
  | { readonly ok: true; readonly head: Uint8Array }
  | { readonly ok: false; readonly skip: RustEntrySkipCode };

export type ExtractResult =
  | {
      readonly ok: true;
      readonly path: string;
      readonly byteLength: number;
      /** At most 128 bytes of plaintext head, for a content sniff. */
      readonly head: Uint8Array;
    }
  | { readonly ok: false; readonly skip: RustEntrySkipCode };

export type JsonResult =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly skip: RustEntrySkipCode };

export interface ArchiveCallOptions {
  readonly signal?: AbortSignal;
}

export interface ArchiveSession {
  /** Refreshed and fingerprinted. `#926` persists exactly these. */
  readonly parts: readonly ArchivePartToken[];
  /** Every allowlisted entry; `skip` is set when Rust rejected it. */
  readonly entries: readonly ArchiveEntry[];
  /** Rejected allowlisted entries plus non-allowlisted records (counted only). */
  readonly rejectedCounts: Readonly<Partial<Record<RustEntrySkipCode, number>>>;
  /** Synchronous, cross-part, batch-only: one call per parsed JSON file (F7). */
  resolveMediaUris(uris: readonly string[]): UriResolution[];
  /** At most 128 inflated bytes. No staging file, not charged to the budget (F1). */
  peekHead(entryId: string, options?: ArchiveCallOptions): Promise<PeekResult>;
  /** In memory, strict UTF-8, at most the JSON kind cap. No file is written. */
  readJson(entryId: string, options?: ArchiveCallOptions): Promise<JsonResult>;
  /** Extracts into a glue-created staging file. The CALLER unlinks `path`. */
  extractEntry(
    entryId: string,
    kind: MediaKind,
    options?: ArchiveCallOptions,
  ): Promise<ExtractResult>;
  /** Releases one staging path from the live-staging ceiling (F8). Idempotent. */
  releaseStaging(path: string): void;
  /** Cancels in-flight jobs and drops Rust's descriptor dups. Idempotent. */
  close(): void;
}

/** How `#926`/`#928` should react to a thrown code (F5). */
export type ArchiveErrorDisposition =
  'retryable-pause' | 'requires-repick' | 'terminal-for-run' | 'user-action';

// ---------------------------------------------------------------------------
// Real data and real error type
// ---------------------------------------------------------------------------

/**
 * The real table, copied verbatim. Pure data that callers switch on, so the
 * mock must not diverge: a wrong disposition here would make a retry-loop bug
 * pass its own unit test.
 */
export const ARCHIVE_ERROR_DISPOSITIONS: Readonly<
  Record<ArchiveErrorCode, ArchiveErrorDisposition>
> = Object.freeze({
  ARCHIVE_READ_FAILED: 'retryable-pause',
  ARCHIVE_STAGING_UNAVAILABLE: 'retryable-pause',
  ARCHIVE_NO_SPACE: 'retryable-pause',
  ARCHIVE_BUSY: 'retryable-pause',

  ARCHIVE_ACCESS_LOST: 'requires-repick',
  ARCHIVE_CHANGED: 'requires-repick',
  ARCHIVE_NOT_SEEKABLE: 'requires-repick',

  ARCHIVE_NOT_ZIP: 'terminal-for-run',
  ARCHIVE_CORRUPT: 'terminal-for-run',
  ARCHIVE_UNSUPPORTED: 'terminal-for-run',
  ARCHIVE_TOO_MANY_ENTRIES: 'terminal-for-run',
  ARCHIVE_TOO_MANY_PARTS: 'terminal-for-run',
  ARCHIVE_SESSION_BYTES_EXCEEDED: 'terminal-for-run',
  ARCHIVE_DUPLICATE_PART: 'terminal-for-run',
  ARCHIVE_SESSION_CLOSED: 'terminal-for-run',
  ARCHIVE_STAGING_IN_USE: 'terminal-for-run',
  ARCHIVE_INTERNAL: 'terminal-for-run',

  PICKER_BUSY: 'user-action',
  ECANCELLED: 'user-action',
});

/**
 * One FIXED message per code, copied verbatim from the wrapper. Private there
 * and private here; a test asserts on `e.code`, never on `e.message`, but the
 * messages must match so a snapshot of a rendered error string cannot pass in
 * Jest and differ on device.
 */
const ARCHIVE_ERROR_MESSAGES: Readonly<Record<ArchiveErrorCode, string>> = Object.freeze({
  ARCHIVE_NOT_ZIP: 'This file is not a ZIP archive.',
  ARCHIVE_CORRUPT: 'This archive is damaged.',
  ARCHIVE_UNSUPPORTED: 'This archive uses an unsupported format.',
  ARCHIVE_TOO_MANY_ENTRIES: 'This archive has too many entries.',
  ARCHIVE_TOO_MANY_PARTS: 'Too many archive parts were selected.',
  ARCHIVE_SESSION_BYTES_EXCEEDED: 'This archive would extract too much data.',
  ARCHIVE_DUPLICATE_PART: 'The same archive part was selected twice.',
  ARCHIVE_NOT_SEEKABLE: 'This file cannot be read in place. Copy it to your device first.',
  ARCHIVE_READ_FAILED: 'The archive could not be read.',
  ARCHIVE_ACCESS_LOST: 'Access to the archive was lost. Select the file again.',
  ARCHIVE_CHANGED: 'The archive changed since it was selected. Select it again.',
  ARCHIVE_STAGING_UNAVAILABLE: 'Temporary storage is unavailable.',
  ARCHIVE_STAGING_IN_USE: 'Temporary storage is already in use.',
  ARCHIVE_NO_SPACE: 'Not enough free space.',
  ECANCELLED: 'Cancelled.',
  ARCHIVE_SESSION_CLOSED: 'The archive session is closed.',
  ARCHIVE_BUSY: 'The archive reader is busy.',
  PICKER_BUSY: 'A file picker is already open.',
  ARCHIVE_INTERNAL: 'Something went wrong reading the archive.',
});

/** The only error type the real module throws or rejects with. */
export class ArchiveReaderError extends Error {
  readonly code: ArchiveErrorCode;
  /** A COUNT, not a name: which part failed, when the code carries one. */
  readonly partIndex?: number;

  constructor(code: ArchiveErrorCode, partIndex?: number) {
    super(ARCHIVE_ERROR_MESSAGES[code]);
    this.name = 'ArchiveReaderError';
    this.code = code;
    if (partIndex !== undefined) this.partIndex = partIndex;
  }
}

/** The real guard, not a jest.fn: the cancel code is `ECANCELLED` (F4). */
export function isArchiveCancellation(e: unknown): boolean {
  return e instanceof ArchiveReaderError && e.code === 'ECANCELLED';
}

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

export const pickArchiveParts = jest.fn<Promise<ArchivePartToken[] | null>, []>(() =>
  Promise.resolve([]),
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

export const isArchivePartToken = jest.fn(
  (value: unknown): value is ArchivePartToken =>
    typeof value === 'string' && value.startsWith('oar1:'),
);

export const __resetArchiveReaderForTests = jest.fn<void, []>();
