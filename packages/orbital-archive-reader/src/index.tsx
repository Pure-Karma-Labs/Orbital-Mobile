/**
 * HAND-WRITTEN wrapper over the archive reader (#920, plan §3 and §10).
 *
 * THIS FILE IS NOT GENERATED. ubrn's own loader lives in `bindings.tsx`
 * (`turboModule.entrypoint` in ubrn.config.yaml); `--and-generate` must never
 * write this file. If a regeneration ever rewrites it, the entrypoint override
 * was lost: check `turboModule.entrypoint` and the `noOverwrite` list in
 * `packages/orbital-archive-reader/ubrn.config.yaml`, which the generated-files
 * table in `docs/uniffi-toolchain.md` enumerates per package.
 *
 * ## What the wrapper is for
 *
 * 1. **Nothing native happens at import (F11).** Both the Rust bindings and
 *    the glue TurboModule are reached only through lazy `require`s. Importing
 *    this module installs no JSI bindings, runs no uniffi checksum assertion
 *    and performs no `TurboModuleRegistry` lookup, so a screen that merely
 *    sits in the navigator's import graph costs nothing and a checksum
 *    mismatch surfaces as `ARCHIVE_INTERNAL` at feature entry instead of a
 *    bundle-load crash.
 * 2. **One error type, codes only.** Every failure becomes an
 *    `ArchiveReaderError` with a code from `ArchiveErrorCode` and a FIXED
 *    message per code. Anything unrecognised becomes `ARCHIVE_INTERNAL`.
 *    Nothing carries a path, an entry name, a URI or file content.
 * 3. **`bigint` is narrowed here.** Rust `u64`s arrive as `bigint`; Rust has
 *    already saturated the per-entry sizes and marked such an entry
 *    `ENTRY_CORRUPT` (F6), so narrowing clamps rather than throws.
 * 4. **Part tokens are opaque.** A caller persists `session.parts` and hands
 *    them back on resume; it never sees a bookmark blob or a `content://` URI.
 *
 *    **Token revocation.** This is the ONE statement of that invariant; the
 *    `ArchivePartToken` and `openArchive` docs, `releaseArchiveParts`, the
 *    TurboModule spec and both glue files only point here.
 *
 *    Releasing is NOT revoking on either platform:
 *      - **Android:** `releaseArchiveParts` drops only the PERSISTED SAF grant.
 *        The transient grant the picker handed this process lives until the
 *        process dies, so a resume in the same process still opens the parts
 *        after a release.
 *      - **iOS:** `releaseArchiveParts` and `releaseAllPersistedParts` are
 *        no-ops, because the bookmark IS the capability. It follows a move, and
 *        survives a Files "Delete" into Recently Deleted for up to 30 days;
 *        `ARCHIVE_ACCESS_LOST` appears only once the file is purged or its
 *        provider is gone.
 *      - **Consequence for `#921`/`#926`:** deleting the persisted token is
 *        iOS's only revocation, so a token must not be retained past a
 *        completed or cancelled import — delete the stored row. If a cancelled
 *        import must be unreachable IMMEDIATELY, `#926`'s session layer has to
 *        enforce that; neither platform will.
 * 5. **Cancellation is a real native cancel (F4)**, plus a grace-timer
 *    backstop that swallows the late settle and cleans up after it.
 * 6. **The fd contract is enforced here (F2).** `openArchive` runs
 *    `openParts`, then the Rust open (which dups), then `closeParts` in a
 *    `finally` on every path.
 *
 * ## entryId is opaque
 *
 * `ArchiveEntry.entryId` must never be parsed, split, shortened, truncated or
 * derived from. See the Rust doc comment on `ArchiveEntry::entry_id`.
 */

import type {
  ArchiveEntry as NativeArchiveEntry,
  ArchivePartInfo as NativeArchivePartInfo,
  ArchivePartInput as NativeArchivePartInput,
  ArchiveSessionLike as NativeSession,
  CancelTokenLike as NativeCancelToken,
  EntryKind as NativeEntryKind,
  EntrySkipCode as NativeEntrySkipCode,
  ExtractOutcome as NativeExtractOutcome,
  JsonOutcome as NativeJsonOutcome,
  PeekOutcome as NativePeekOutcome,
  RejectedCount as NativeRejectedCount,
  UriResolution as NativeUriResolution,
  UriSkipCode as NativeUriSkipCode,
} from './generated/orbital_archive_reader';
import type { ArchivePartHandle, Spec as GlueSpec } from './NativeOrbitalArchiveAccess';

// ---------------------------------------------------------------------------
// Public codes and types
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
  | 'ENTRY_IS_VIDEO'
  | 'ENTRY_UNSUPPORTED_IMAGE_FORMAT'
  | 'ENTRY_SNIFF_INDETERMINATE';

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
 * `"oar1:" + base64url(JSON { v, p, ref, persist, fp? })`. Never parse it;
 * `#921` stores `JSON.stringify(ArchivePartToken[])` in `archive_bookmark`.
 *
 * Deleting a stored token is the only immediate revocation of the access it
 * carries — see the token-revocation invariant in this file's header (§4).
 */
export type ArchivePartToken = string & {
  // A string-literal brand, NOT `unique symbol`: a unique symbol is nominal
  // per declaration, so the copy in `__mocks__/orbital-archive-reader.ts`
  // would be an unrelated type and every token a test hands to app code
  // would need a cast. This brand is structural, so the two agree.
  readonly __archivePartToken: 'ArchivePartToken';
};

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

/**
 * How `#926`/`#928` should react to a thrown code (F5).
 *
 * `ARCHIVE_SESSION_CLOSED` and `ARCHIVE_STAGING_IN_USE` are not in F5's table:
 * both mean the caller used a handle it had already given up, so a retry can
 * never succeed and they sit with the other terminal codes. `ARCHIVE_BUSY` is
 * the only "all job slots taken" code and IS retryable — keeping
 * `ARCHIVE_STAGING_IN_USE` distinct from it is what stops a backoff loop
 * spinning forever on a caller bug.
 */
export type ArchiveErrorDisposition =
  | 'retryable-pause'
  | 'requires-repick'
  | 'terminal-for-run'
  | 'user-action';

/** Exported as DATA so `#926`/`#928` can switch on it without a copy. */
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
 * One FIXED message per code. Never interpolated: a crash report, a Sentry
 * breadcrumb or a `console.warn` of one of these strings can carry nothing
 * about the archive's contents.
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

/** The only error type this module throws or rejects with. */
export class ArchiveReaderError extends Error {
  readonly code: ArchiveErrorCode;
  /**
   * Which part failed: a zero-based COUNT, never a name.
   *
   * THE authoritative statement of this field. The glue files, the TurboModule
   * spec and the per-method docs below all point here rather than restate it.
   *
   *  - It indexes the `tokens` array handed to `openArchive`, in that order —
   *    which is also the order of `ArchiveSession.parts` and of `#926`'s
   *    persisted token array, so `tokens[partIndex]` is the part to re-pick.
   *  - ONE index space for all three producers: the Android glue, the iOS glue
   *    and Rust all count the same array, so a consumer never has to ask which
   *    layer rejected.
   *  - It is set on every `ARCHIVE_ACCESS_LOST` and `ARCHIVE_CHANGED` thrown
   *    from `openArchive` or from a session method — i.e. everywhere a
   *    `tokens` array exists to index — and on no other code.
   *    `pickArchiveParts` is the exception that proves the scope: iOS can
   *    reject it `ARCHIVE_ACCESS_LOST` when a picked document yields no
   *    bookmark (`OrbitalArchiveAccess.mm`, inside the picker delegate's
   *    bookmark loop), and that rejection carries NO index, because the user
   *    has not handed us a token array yet.
   *  - It is nevertheless typed OPTIONAL, so a consumer MUST tolerate
   *    `undefined`: anything that is not a safe non-negative integer is
   *    dropped rather than guessed at (`asPartIndex`), and an older native
   *    binary paired with this JS would send nothing at all.
   */
  readonly partIndex?: number;

  constructor(code: ArchiveErrorCode, partIndex?: number) {
    super(ARCHIVE_ERROR_MESSAGES[code]);
    this.name = 'ArchiveReaderError';
    this.code = code;
    if (partIndex !== undefined) this.partIndex = partIndex;
  }
}

/**
 * Mirrors `isCancellation` / `isUploadCancellation`: the cancel code is
 * `ECANCELLED`, so those guards already recognise this error unchanged (F4).
 */
export function isArchiveCancellation(e: unknown): boolean {
  return e instanceof ArchiveReaderError && e.code === 'ECANCELLED';
}

// ---------------------------------------------------------------------------
// Lazy native access (F11)
// ---------------------------------------------------------------------------

type Bindings = typeof import('./generated/orbital_archive_reader');

let bindings: Bindings | null = null;
let glue: GlueSpec | null = null;

/**
 * The ONLY path to the Rust bindings.
 *
 * `require`, not a static import: a static import would run `bindings.tsx`'s
 * `installRustCrate()` and the uniffi checksum assertions at bundle load, in
 * every app launch, whether or not the user ever imports an archive. Any
 * failure in there — a stale binary whose checksums no longer match the
 * generated TypeScript being the realistic one — becomes `ARCHIVE_INTERNAL` at
 * first use instead of a white screen.
 */
function getNative(): Bindings {
  if (bindings !== null) return bindings;
  let loaded: Bindings;
  try {
    loaded = require('./bindings') as Bindings;
  } catch {
    throw new ArchiveReaderError('ARCHIVE_INTERNAL');
  }
  assertNativeSurface(loaded);
  bindings = loaded;
  return loaded;
}

/** The ONLY path to the glue TurboModule. `getEnforcing` is a native lookup. */
function getGlue(): GlueSpec {
  if (glue !== null) return glue;
  try {
    glue = (require('./NativeOrbitalArchiveAccess') as { default: GlueSpec }).default;
  } catch {
    throw new ArchiveReaderError('ARCHIVE_INTERNAL');
  }
  if (glue === null || glue === undefined) throw new ArchiveReaderError('ARCHIVE_INTERNAL');
  return glue;
}

/**
 * Fails closed when Rust has grown an enum member this file does not map.
 *
 * The per-member lookups below are compile-checked (a RENAMED member is a type
 * error), but an ADDED member would silently become `undefined` and travel
 * into `#925` as a missing skip code. uniffi emits numeric enums with a
 * reverse mapping, so `Object.keys` is exactly twice the member count.
 */
function assertNativeSurface(b: Bindings): void {
  const pairs: ReadonlyArray<readonly [object, number]> = [
    [b.EntrySkipCode, SKIP_CODE_NAMES.length],
    [b.UriSkipCode, URI_SKIP_CODE_NAMES.length],
    [b.EntryKind, ENTRY_KIND_NAMES.length],
  ];
  for (const [enumObject, expected] of pairs) {
    if (Object.keys(enumObject).length !== expected * 2) {
      throw new ArchiveReaderError('ARCHIVE_INTERNAL');
    }
  }
  if (Object.keys(b.ArchiveError_Tags).length !== Object.keys(ERROR_CODE_BY_TAG).length) {
    throw new ArchiveReaderError('ARCHIVE_INTERNAL');
  }
}

// ---------------------------------------------------------------------------
// Enum <-> string-code mapping
// ---------------------------------------------------------------------------

/** Rust `EntrySkipCode` members, in declaration order. */
const SKIP_CODE_NAMES = [
  'EntryPathInvalid',
  'EntryPathTraversal',
  'EntrySymlink',
  'EntrySpecialFile',
  'EntryEncrypted',
  'EntryNestedArchive',
  'EntryUnsupportedMethod',
  'EntryDuplicate',
  'EntryOverCap',
  'EntryRatioExceeded',
  'EntryCorrupt',
  'EntryKindNotEnabled',
  'EntryKindMismatch',
  'EntryNotUtf8',
  'EntryNotAllowlisted',
] as const satisfies ReadonlyArray<keyof Bindings['EntrySkipCode']>;

const SKIP_CODES: Readonly<Record<(typeof SKIP_CODE_NAMES)[number], RustEntrySkipCode>> =
  Object.freeze({
    EntryPathInvalid: 'ENTRY_PATH_INVALID',
    EntryPathTraversal: 'ENTRY_PATH_TRAVERSAL',
    EntrySymlink: 'ENTRY_SYMLINK',
    EntrySpecialFile: 'ENTRY_SPECIAL_FILE',
    EntryEncrypted: 'ENTRY_ENCRYPTED',
    EntryNestedArchive: 'ENTRY_NESTED_ARCHIVE',
    EntryUnsupportedMethod: 'ENTRY_UNSUPPORTED_METHOD',
    EntryDuplicate: 'ENTRY_DUPLICATE',
    EntryOverCap: 'ENTRY_OVER_CAP',
    EntryRatioExceeded: 'ENTRY_RATIO_EXCEEDED',
    EntryCorrupt: 'ENTRY_CORRUPT',
    EntryKindNotEnabled: 'ENTRY_KIND_NOT_ENABLED',
    EntryKindMismatch: 'ENTRY_KIND_MISMATCH',
    EntryNotUtf8: 'ENTRY_NOT_UTF8',
    EntryNotAllowlisted: 'ENTRY_NOT_ALLOWLISTED',
  });

const URI_SKIP_CODE_NAMES = [
  'UriInvalid',
  'UriOutsideAllowlist',
  'UriUnresolved',
  'UriAmbiguous',
  'UriUnsupportedKind',
] as const satisfies ReadonlyArray<keyof Bindings['UriSkipCode']>;

const URI_SKIP_CODES: Readonly<Record<(typeof URI_SKIP_CODE_NAMES)[number], UriSkipCode>> =
  Object.freeze({
    UriInvalid: 'URI_INVALID',
    UriOutsideAllowlist: 'URI_OUTSIDE_ALLOWLIST',
    UriUnresolved: 'URI_UNRESOLVED',
    UriAmbiguous: 'URI_AMBIGUOUS',
    UriUnsupportedKind: 'URI_UNSUPPORTED_KIND',
  });

const ENTRY_KIND_NAMES = ['Json', 'Image', 'Video'] as const satisfies ReadonlyArray<
  keyof Bindings['EntryKind']
>;

const ENTRY_KINDS: Readonly<Record<(typeof ENTRY_KIND_NAMES)[number], EntryKind>> = Object.freeze({
  Json: 'json',
  Image: 'image',
  Video: 'video',
});

/** Rust `ArchiveError` tag -> thrown code. `Cancelled` becomes `ECANCELLED` (F4). */
const ERROR_CODE_BY_TAG: Readonly<Record<string, ArchiveErrorCode>> = Object.freeze({
  NotZip: 'ARCHIVE_NOT_ZIP',
  Corrupt: 'ARCHIVE_CORRUPT',
  Unsupported: 'ARCHIVE_UNSUPPORTED',
  TooManyEntries: 'ARCHIVE_TOO_MANY_ENTRIES',
  TooManyParts: 'ARCHIVE_TOO_MANY_PARTS',
  SessionBytesExceeded: 'ARCHIVE_SESSION_BYTES_EXCEEDED',
  DuplicatePart: 'ARCHIVE_DUPLICATE_PART',
  NotSeekable: 'ARCHIVE_NOT_SEEKABLE',
  ReadFailed: 'ARCHIVE_READ_FAILED',
  AccessLost: 'ARCHIVE_ACCESS_LOST',
  Changed: 'ARCHIVE_CHANGED',
  StagingUnavailable: 'ARCHIVE_STAGING_UNAVAILABLE',
  NoSpace: 'ARCHIVE_NO_SPACE',
  Cancelled: 'ECANCELLED',
  SessionClosed: 'ARCHIVE_SESSION_CLOSED',
  Busy: 'ARCHIVE_BUSY',
  StagingInUse: 'ARCHIVE_STAGING_IN_USE',
  Internal: 'ARCHIVE_INTERNAL',
});

/** Codes a native glue rejection may carry. Anything else is internal. */
const GLUE_ERROR_CODES: ReadonlySet<string> = new Set<ArchiveErrorCode>([
  'PICKER_BUSY',
  'ARCHIVE_ACCESS_LOST',
  'ARCHIVE_NOT_SEEKABLE',
  'ARCHIVE_STAGING_UNAVAILABLE',
  'ARCHIVE_NO_SPACE',
  'ECANCELLED',
  'ARCHIVE_INTERNAL',
]);

function skipCode(native: Bindings, value: NativeEntrySkipCode): RustEntrySkipCode {
  const name = (native.EntrySkipCode as unknown as Record<number, string>)[value as number];
  const code = (SKIP_CODES as Record<string, RustEntrySkipCode | undefined>)[name];
  if (code === undefined) throw new ArchiveReaderError('ARCHIVE_INTERNAL');
  return code;
}

function uriSkipCode(native: Bindings, value: NativeUriSkipCode): UriSkipCode {
  const name = (native.UriSkipCode as unknown as Record<number, string>)[value as number];
  const code = (URI_SKIP_CODES as Record<string, UriSkipCode | undefined>)[name];
  if (code === undefined) throw new ArchiveReaderError('ARCHIVE_INTERNAL');
  return code;
}

function entryKind(native: Bindings, value: NativeEntryKind): EntryKind {
  const name = (native.EntryKind as unknown as Record<number, string>)[value as number];
  const kind = (ENTRY_KINDS as Record<string, EntryKind | undefined>)[name];
  if (kind === undefined) throw new ArchiveReaderError('ARCHIVE_INTERNAL');
  return kind;
}

/**
 * Anything thrown anywhere below this module's surface becomes an
 * `ArchiveReaderError`.
 *
 * Order matters: an `ArchiveReaderError` passes straight through (it is
 * already normalised, including our own locally-rejected cancellation), then a
 * uniffi `ArchiveError` is read off its `tag`, then a native glue rejection
 * off its `code`, and everything else is `ARCHIVE_INTERNAL`. A plain
 * `AbortError` from a DOM-style abort is treated as a cancellation so an abort
 * that races a native call never surfaces as an internal error.
 */
function normalizeError(e: unknown): ArchiveReaderError {
  if (e instanceof ArchiveReaderError) return e;

  const candidate = e as
    | {
        tag?: unknown;
        inner?: { partIndex?: unknown };
        code?: unknown;
        userInfo?: { partIndex?: unknown } | null;
        name?: unknown;
      }
    | null
    | undefined;
  if (candidate !== null && candidate !== undefined && typeof candidate === 'object') {
    if (typeof candidate.tag === 'string') {
      const code = ERROR_CODE_BY_TAG[candidate.tag];
      if (code !== undefined) {
        return new ArchiveReaderError(code, asPartIndex(candidate.inner?.partIndex));
      }
    }
    if (typeof candidate.code === 'string' && GLUE_ERROR_CODES.has(candidate.code)) {
      // The glue sends `userInfo.partIndex` for ACCESS_LOST and for nothing
      // else (Android: `promise.reject(code, msg, WritableMap)`; iOS: an
      // NSError in `kOAAErrorDomain`). Reading it only for that code is what
      // keeps a stray userInfo from widening the contract.
      return new ArchiveReaderError(
        candidate.code as ArchiveErrorCode,
        asPartIndex(
          candidate.code === 'ARCHIVE_ACCESS_LOST' ? candidate.userInfo?.partIndex : undefined,
        ),
      );
    }
    if (candidate.name === 'AbortError') return new ArchiveReaderError('ECANCELLED');
  }
  return new ArchiveReaderError('ARCHIVE_INTERNAL');
}

/**
 * A bridge value is a usable `partIndex` only if it is a safe non-negative
 * integer. Anything else becomes `undefined`.
 *
 * Shared by the uniffi branch and the glue branch, which is a DELIBERATE
 * TIGHTENING of the uniffi branch: it previously accepted any `typeof ===
 * 'number'`, so a negative, a fraction, `NaN` or `Infinity` would have been
 * handed to `#926` as an index into `tokens` — and `tokens[-1]`,
 * `tokens[1.5]` and `tokens[NaN]` are all silently `undefined`, i.e. a
 * "re-pick that part" prompt about no part at all. Rust cannot produce such a
 * value today (the index is a `u32`), so dropping it loses nothing real and
 * the field's optionality already obliges consumers to cope.
 */
function asPartIndex(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : undefined;
}

// ---------------------------------------------------------------------------
// bigint narrowing
// ---------------------------------------------------------------------------

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

/**
 * Narrow a Rust `u64` to a JS number.
 *
 * CLAMPS rather than throws. Rust has already saturated any per-entry size
 * above `MAX_SAFE_INTEGER` and marked that one entry `ENTRY_CORRUPT` (F6), so
 * a value arriving here above the ceiling means the entry is already skipped;
 * throwing would turn one bad central-directory record into a whole-archive
 * failure.
 */
function narrow(value: bigint): number {
  if (value < 0n) return 0;
  return value > MAX_SAFE ? Number.MAX_SAFE_INTEGER : Number(value);
}

function toBytes(buffer: ArrayBuffer): Uint8Array {
  return new Uint8Array(buffer);
}

// ---------------------------------------------------------------------------
// Part tokens
// ---------------------------------------------------------------------------

const TOKEN_PREFIX = 'oar1:';
const TOKEN_VERSION = 1;

interface TokenPayload {
  v: number;
  /** Platform the token was minted on; a cross-platform ref is meaningless. */
  p: 'ios' | 'android';
  ref: string;
  persist: boolean;
  fp?: string;
}

const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/**
 * UTF-8 encode, hand-rolled — and NOT because `TextEncoder` is missing.
 *
 * Hermes 0.82.1 (the engine the app ships) HAS `TextEncoder`; what it does not
 * have is `TextDecoder`, which Jest's node environment does provide. The
 * asymmetry is a trap worth naming here, because the previous version of this
 * comment asserted the opposite and would have sent the next reader looking
 * for a polyfill that was never needed.
 *
 * This pair stays hand-rolled for two reasons that survive that correction:
 * `utf8Decode` below has no built-in to delegate to on device, and a package
 * must not reach into app `src/` for the strict codec that lives there
 * (`src/utils/utf8.ts`, #925). Both halves only ever see the token codec's
 * ASCII, so neither needs the strict pair's validation.
 *
 * Security invariant 29.8 clause 8 bans `TextDecoder` across `src/` and every
 * package's `src`, so this must never become a wrapper around one.
 */
function utf8Encode(text: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < text.length; i++) {
    let cp = text.charCodeAt(i);
    if (cp >= 0xd800 && cp <= 0xdbff && i + 1 < text.length) {
      const low = text.charCodeAt(i + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        cp = (cp - 0xd800) * 0x400 + (low - 0xdc00) + 0x10000;
        i++;
      }
    }
    if (cp < 0x80) out.push(cp);
    else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    else if (cp < 0x10000) {
      out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    } else {
      out.push(
        0xf0 | (cp >> 18),
        0x80 | ((cp >> 12) & 0x3f),
        0x80 | ((cp >> 6) & 0x3f),
        0x80 | (cp & 0x3f),
      );
    }
  }
  return out;
}

function utf8Decode(bytes: number[]): string {
  let out = '';
  let i = 0;
  while (i < bytes.length) {
    const b0 = bytes[i++];
    let cp: number;
    if (b0 < 0x80) cp = b0;
    else if (b0 < 0xe0) cp = ((b0 & 0x1f) << 6) | (bytes[i++] & 0x3f);
    else if (b0 < 0xf0) {
      cp = ((b0 & 0x0f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f);
    } else {
      cp =
        ((b0 & 0x07) << 18) |
        ((bytes[i++] & 0x3f) << 12) |
        ((bytes[i++] & 0x3f) << 6) |
        (bytes[i++] & 0x3f);
    }
    if (cp > 0xffff) {
      const c = cp - 0x10000;
      out += String.fromCharCode(0xd800 + (c >> 10), 0xdc00 + (c & 0x3ff));
    } else {
      out += String.fromCharCode(cp);
    }
  }
  return out;
}

function base64UrlEncode(bytes: number[]): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : undefined;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : undefined;
    out += B64URL[b0 >> 2];
    out += B64URL[((b0 & 0x03) << 4) | (b1 === undefined ? 0 : b1 >> 4)];
    if (b1 === undefined) break;
    out += B64URL[((b1 & 0x0f) << 2) | (b2 === undefined ? 0 : b2 >> 6)];
    if (b2 === undefined) break;
    out += B64URL[b2 & 0x3f];
  }
  return out;
}

function base64UrlDecode(text: string): number[] {
  const out: number[] = [];
  let acc = 0;
  let bits = 0;
  for (let i = 0; i < text.length; i++) {
    const v = B64URL.indexOf(text[i]);
    if (v < 0) throw new ArchiveReaderError('ARCHIVE_INTERNAL');
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 0xff);
    }
  }
  return out;
}

function encodeToken(payload: TokenPayload): ArchivePartToken {
  return (TOKEN_PREFIX +
    base64UrlEncode(utf8Encode(JSON.stringify(payload)))) as ArchivePartToken;
}

/**
 * Decode a token, or throw `ARCHIVE_INTERNAL`.
 *
 * A token is app-minted, so a malformed one is a bug in this app (or a
 * persisted token from a build with a different format), never hostile input
 * and never a user-facing archive problem — hence `ARCHIVE_INTERNAL` rather
 * than `ARCHIVE_CORRUPT`.
 */
function decodeToken(token: string): TokenPayload {
  if (typeof token !== 'string' || !token.startsWith(TOKEN_PREFIX)) {
    throw new ArchiveReaderError('ARCHIVE_INTERNAL');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(utf8Decode(base64UrlDecode(token.slice(TOKEN_PREFIX.length))));
  } catch {
    throw new ArchiveReaderError('ARCHIVE_INTERNAL');
  }
  const p = parsed as Partial<TokenPayload> | null;
  if (
    p === null ||
    typeof p !== 'object' ||
    p.v !== TOKEN_VERSION ||
    (p.p !== 'ios' && p.p !== 'android') ||
    typeof p.ref !== 'string' ||
    p.ref.length === 0 ||
    typeof p.persist !== 'boolean' ||
    (p.fp !== undefined && typeof p.fp !== 'string')
  ) {
    throw new ArchiveReaderError('ARCHIVE_INTERNAL');
  }
  return { v: p.v, p: p.p, ref: p.ref, persist: p.persist, fp: p.fp };
}

/** Exported for the app service's telemetry and for tests. */
export function isArchivePartToken(value: unknown): value is ArchivePartToken {
  if (typeof value !== 'string') return false;
  try {
    decodeToken(value);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Cancellation: native cancel + grace-timer backstop (F4)
// ---------------------------------------------------------------------------

/**
 * How long to wait for a cancelled native call to settle before giving up on
 * it. Mirrors `TRANSCODE_CANCEL_SETTLE_GRACE_MS` in
 * `src/services/media/videoProcessing.ts`.
 */
const CANCEL_SETTLE_GRACE_MS = 1500;

function noop(): void {
  /* intentionally empty */
}

/**
 * Race `native` against a grace timer armed by `signal`.
 *
 * `requestCancel` is the REAL native cancel (`CancelToken.cancel()` or
 * `session.cancel(jobId)`): Rust polls the flag inside its loops, so a
 * cancelled job normally settles immediately and the timer never fires. The
 * timer exists for the case where it does not — a read stuck on an evicted
 * iCloud file, say. When it fires we reject locally with `ECANCELLED` and hand
 * the eventual native settle to `onAbandoned`, which is what unlinks a staging
 * file the Rust side finished writing after we stopped waiting.
 */
function awaitWithBackstop<T>(
  native: Promise<T>,
  signal: AbortSignal | undefined,
  requestCancel: () => void,
  onAbandoned: (settled: T | undefined) => void,
): Promise<T> {
  if (!signal) return native;

  let abandoned = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let abortListener: (() => void) | null = null;

  const backstop = new Promise<never>((_resolve, reject) => {
    const arm = (): void => {
      if (timer !== null) return;
      try {
        requestCancel();
      } catch {
        // A cancel that throws must not stop the local rejection.
      }
      timer = setTimeout(() => {
        abandoned = true;
        reject(new ArchiveReaderError('ECANCELLED'));
      }, CANCEL_SETTLE_GRACE_MS);
    };
    if (signal.aborted) {
      arm();
      return;
    }
    abortListener = arm;
    signal.addEventListener('abort', abortListener);
  });

  // Attached unconditionally, even when native wins the race: a late REJECT of
  // an abandoned call must not surface as an unhandled rejection, and a late
  // RESOLVE means Rust produced something no one will consume. The double
  // `.then` is what swallows the settle before the abandonment check reads it.
  let settled: T | undefined;
  native
    .then(
      (v) => {
        settled = v;
      },
      noop,
    )
    .then(() => {
      if (abandoned) onAbandoned(settled);
    })
    // onAbandoned is local but may call into native; a synchronous throw from
    // it would surface as an unhandled rejection on this detached chain, which
    // is exactly what the chain exists to prevent.
    .catch(noop);

  return Promise.race([native, backstop]).finally(() => {
    if (timer !== null) clearTimeout(timer);
    if (abortListener) signal.removeEventListener('abort', abortListener);
  });
}

// ---------------------------------------------------------------------------
// Epoch: localWipe phase 1 (F3)
// ---------------------------------------------------------------------------

let archiveEpoch = 0;
const liveSessions = new Set<SessionImpl>();

/**
 * Stop every archive session NOW. Synchronous; never awaited.
 *
 * `localWipe` phase 1 calls this next to `cancelAllExports()`, for the same
 * reason: an in-flight extract is writing PLAINTEXT media into Caches, and the
 * wipe's suffix sweep runs later in the same function. Awaiting here would
 * hand control straight back to the extract we are trying to stop.
 *
 * Two things happen, both synchronously:
 *  - every live session is closed, which sets every job's cancel flag and
 *    drops Rust's descriptor dups;
 *  - the epoch is bumped, so any call that is one microtask from starting —
 *    including an `openArchive` whose native open has not returned yet — sees
 *    a stale epoch and refuses with `ARCHIVE_SESSION_CLOSED` rather than
 *    creating a staging file after the sweep.
 */
export function abortAllArchiveSessions(): void {
  archiveEpoch++;
  for (const session of Array.from(liveSessions)) {
    try {
      session.closeForWipe();
    } catch {
      // Best effort: one failing session must not stop the others.
    }
  }
  liveSessions.clear();
}

/**
 * Release EVERY persistable part grant (Android SAF). iOS is a no-op.
 *
 * DELETION PATH ONLY (`preserveIdentity=false`). On logout the grants are kept
 * so a cold-start resume still works for the same user on the same device.
 */
export async function releaseAllPersistedParts(): Promise<void> {
  try {
    await getGlue().releaseAllPersistedParts();
  } catch (e) {
    throw normalizeError(e);
  }
}

let jobCounter = 0;

function nextJobId(): string {
  jobCounter += 1;
  return `oar-${Date.now().toString(36)}-${jobCounter.toString(36)}`;
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

class SessionImpl implements ArchiveSession {
  readonly parts: readonly ArchivePartToken[];
  readonly entries: readonly ArchiveEntry[];
  readonly rejectedCounts: Readonly<Partial<Record<RustEntrySkipCode, number>>>;

  private readonly native: Bindings;
  private readonly session: NativeSession;
  private readonly epoch: number;
  private closed = false;

  constructor(
    native: Bindings,
    session: NativeSession,
    parts: readonly ArchivePartToken[],
    epoch: number,
  ) {
    this.native = native;
    this.session = session;
    this.parts = Object.freeze(parts.slice());
    this.epoch = epoch;
    this.entries = Object.freeze(
      session.entries().map((e) => mapEntry(native, e)),
    );
    const counts: Partial<Record<RustEntrySkipCode, number>> = {};
    for (const row of session.rejectedCounts() as NativeRejectedCount[]) {
      counts[skipCode(native, row.code)] = narrow(row.count);
    }
    this.rejectedCounts = Object.freeze(counts);
  }

  /** Refuse any work once closed, or once a wipe has moved the epoch on. */
  private assertUsable(): void {
    if (this.closed || this.epoch !== archiveEpoch) {
      throw new ArchiveReaderError('ARCHIVE_SESSION_CLOSED');
    }
  }

  resolveMediaUris(uris: readonly string[]): UriResolution[] {
    this.assertUsable();
    try {
      return (this.session.resolveMediaUris(uris.slice()) as NativeUriResolution[]).map((r) =>
        r.tag === this.native.UriResolution_Tags.Resolved
          ? ({ ok: true, entryId: r.inner.entryId } as const)
          : ({ ok: false, skip: uriSkipCode(this.native, r.inner.skip) } as const),
      );
    } catch (e) {
      throw normalizeError(e);
    }
  }

  async peekHead(entryId: string, options?: ArchiveCallOptions): Promise<PeekResult> {
    this.assertUsable();
    const jobId = nextJobId();
    try {
      const outcome = await awaitWithBackstop(
        this.session.peekHead(entryId, jobId),
        options?.signal,
        () => this.cancelJob(jobId),
        noop, // peekHead writes nothing: there is nothing to clean up.
      );
      this.assertUsable();
      const peek = outcome as NativePeekOutcome;
      return peek.tag === this.native.PeekOutcome_Tags.Head
        ? { ok: true, head: toBytes(peek.inner.head) }
        : { ok: false, skip: skipCode(this.native, peek.inner.skip) };
    } catch (e) {
      throw normalizeError(e);
    }
  }

  async readJson(entryId: string, options?: ArchiveCallOptions): Promise<JsonResult> {
    this.assertUsable();
    const jobId = nextJobId();
    try {
      const outcome = await awaitWithBackstop(
        this.session.readJson(entryId, jobId),
        options?.signal,
        () => this.cancelJob(jobId),
        noop, // readJson writes no file.
      );
      this.assertUsable();
      const json = outcome as NativeJsonOutcome;
      return json.tag === this.native.JsonOutcome_Tags.Text
        ? { ok: true, text: json.inner.text }
        : { ok: false, skip: skipCode(this.native, json.inner.skip) };
    } catch (e) {
      throw normalizeError(e);
    }
  }

  async extractEntry(
    entryId: string,
    kind: MediaKind,
    options?: ArchiveCallOptions,
  ): Promise<ExtractResult> {
    this.assertUsable();
    const glueModule = getGlue();
    // The glue creates the staging file: on iOS it must carry an explicit
    // NSFileProtectionCompleteUnlessOpen, which only the native side can set.
    let stagingPath: string;
    try {
      stagingPath = await glueModule.createStagingFile();
    } catch (e) {
      throw normalizeError(e);
    }
    // Re-checked AFTER the await: a wipe that landed while the file was being
    // created must not be followed by an extract into it.
    try {
      this.assertUsable();
    } catch (e) {
      unlinkStagingQuietly(stagingPath);
      throw e;
    }

    const jobId = nextJobId();
    try {
      const outcome = await awaitWithBackstop(
        this.session.extractEntry(entryId, this.nativeKind(kind), stagingPath, jobId),
        options?.signal,
        () => this.cancelJob(jobId),
        // Rust unlinks on its own cancel path, but a job that FINISHED after
        // we stopped waiting leaves a complete plaintext image in Caches that
        // no one will consume. Release the ceiling too, or the budget leaks.
        () => {
          this.releaseStagingQuietly(stagingPath);
          unlinkStagingQuietly(stagingPath);
        },
      );
      // Re-checked AFTER the extract settles, the same way peekHead and
      // readJson do: a wipe that landed while Rust was writing must not have
      // its staging path handed out. The catch below is what releases and
      // unlinks it, and `ArchiveReaderError` passes through normalizeError
      // unchanged, so the caller still sees ARCHIVE_SESSION_CLOSED.
      this.assertUsable();
      const extract = outcome as NativeExtractOutcome;
      if (extract.tag !== this.native.ExtractOutcome_Tags.Extracted) {
        // A skip wrote nothing, but releasing is cheap and idempotent and
        // keeps "every createStagingFile has a release" true on every path.
        this.releaseStagingQuietly(stagingPath);
        unlinkStagingQuietly(stagingPath);
        return { ok: false, skip: skipCode(this.native, extract.inner.skip) };
      }
      return {
        ok: true,
        path: extract.inner.path,
        byteLength: narrow(extract.inner.byteLength),
        head: toBytes(extract.inner.head),
      };
    } catch (e) {
      this.releaseStagingQuietly(stagingPath);
      unlinkStagingQuietly(stagingPath);
      throw normalizeError(e);
    }
  }

  releaseStaging(path: string): void {
    if (this.closed) return;
    try {
      this.session.releaseStaging(path);
    } catch {
      // Idempotent and advisory: a release that fails must not mask the
      // caller's own error in the finally it is called from.
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    liveSessions.delete(this);
    try {
      this.session.close();
    } catch {
      // close() is idempotent in Rust; a throw here is not actionable.
    }
  }

  /** `close()` without the Set mutation — `abortAllArchiveSessions` clears it. */
  closeForWipe(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.session.close();
    } catch {
      // Same as close(): nothing actionable, and the epoch already refuses.
    }
  }

  private cancelJob(jobId: string): void {
    try {
      this.session.cancel(jobId);
    } catch {
      // The backstop rejects locally regardless.
    }
  }

  private releaseStagingQuietly(path: string): void {
    try {
      this.session.releaseStaging(path);
    } catch {
      /* advisory */
    }
  }

  private nativeKind(kind: MediaKind): NativeEntryKind {
    if (kind !== 'image') throw new ArchiveReaderError('ARCHIVE_INTERNAL');
    return this.native.EntryKind.Image;
  }
}

function mapEntry(native: Bindings, e: NativeArchiveEntry): ArchiveEntry {
  return Object.freeze({
    entryId: e.entryId,
    path: e.path,
    kind: entryKind(native, e.kind),
    declaredSize: narrow(e.declaredSize),
    skip: e.skip === undefined ? null : skipCode(native, e.skip),
  });
}

/**
 * Unlink a staging file, swallowing everything.
 *
 * Routed through the glue rather than `react-native-fs` so this package keeps
 * exactly one native dependency, and so the name check lives next to the
 * creation: the glue refuses any path that is not
 * `<its staging dir>/<uuid>-archive-staging.bin`.
 */
function unlinkStagingQuietly(path: string): void {
  try {
    getGlue().unlinkStagingFile(path);
  } catch {
    /* best effort */
  }
}

/** The app service calls this in the `finally` that consumes an extract (F8). */
export function unlinkStagingFile(path: string): void {
  unlinkStagingQuietly(path);
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

/**
 * Present the picker. Resolves `null` when the user cancelled.
 *
 * The returned tokens are NOT fingerprinted yet: `fp` is only known once the
 * archive has been opened, so `#926` persists `session.parts`, not these.
 */
export async function pickArchiveParts(): Promise<ArchivePartToken[] | null> {
  const glueModule = getGlue();
  let refs: Array<string> | null;
  try {
    refs = await glueModule.pickArchiveParts();
  } catch (e) {
    throw normalizeError(e);
  }
  if (refs === null || refs === undefined) return null;
  return refs.map((ref) => encodeToken({ v: TOKEN_VERSION, p: platform(), ref, persist: false }));
}

/**
 * Release the persistable grants behind these tokens. Android only.
 *
 * NOT a revocation: see the token-revocation invariant in this file's header
 * (§4). Deleting the stored token is what revokes access.
 */
export async function releaseArchiveParts(
  tokens: readonly ArchivePartToken[],
): Promise<void> {
  const refs = tokens.map((t) => decodeToken(t).ref);
  try {
    await getGlue().releaseParts(refs);
  } catch (e) {
    throw normalizeError(e);
  }
}

/**
 * Open an archive from picked or persisted tokens.
 *
 * The fd contract (F2): the glue owns every descriptor until `closeParts`, and
 * Rust keeps only a dup. `closeParts` therefore runs in a `finally` on EVERY
 * path — success, throw and abort — and is the last thing to touch the
 * handles.
 *
 * `tokens` defines the part index space: an `ARCHIVE_ACCESS_LOST` or
 * `ARCHIVE_CHANGED` thrown from here carries `partIndex` into THIS array — see
 * `ArchiveReaderError.partIndex`.
 *
 * This is also the resume entry point `#926` calls with persisted tokens, so
 * the token-revocation invariant in this file's header (§4) is the rule about
 * how long those tokens may be kept.
 */
export async function openArchive(
  tokens: readonly ArchivePartToken[],
  options?: ArchiveCallOptions,
): Promise<ArchiveSession> {
  const epoch = archiveEpoch;
  const payloads = tokens.map((t) => decodeToken(t));
  if (payloads.length === 0) throw new ArchiveReaderError('ARCHIVE_NOT_ZIP');

  const glueModule = getGlue();
  const native = getNative();
  const stagingDir = glueModule.getStagingDirectory();
  const cancelToken: NativeCancelToken = new native.CancelToken();

  let handles: ArchivePartHandle[] | null = null;
  try {
    handles = await awaitWithBackstop(
      glueModule.openParts(payloads.map((p) => p.ref)),
      options?.signal,
      () => glueModule.cancelOpenParts(),
      // F2: on abort mid-openParts we still await the native settle, then
      // close exactly what it handed back. The glue closes nothing on our
      // behalf once it has resolved.
      (settled) => {
        if (settled) closePartsQuietly(glueModule, settled);
      },
    );

    const inputs: NativeArchivePartInput[] = handles.map((h, i) => ({
      fd: h.fd,
      byteLength: BigInt(Math.max(0, Math.trunc(h.byteLength))),
      fileId: h.fileId,
      expectedFp: payloads[i]?.fp,
    }));

    const nativeSession = await awaitWithBackstop(
      native.openArchive(inputs, stagingDir, cancelToken),
      options?.signal,
      () => cancelToken.cancel(),
      // A session that opened after we stopped waiting still holds fd dups.
      (settled) => {
        if (settled) {
          try {
            settled.close();
          } catch {
            /* best effort */
          }
        }
      },
    );

    // A wipe that landed during the open: the session is live and holds dups,
    // so close it and refuse rather than hand it out.
    if (epoch !== archiveEpoch) {
      try {
        nativeSession.close();
      } catch {
        /* best effort */
      }
      throw new ArchiveReaderError('ARCHIVE_SESSION_CLOSED');
    }

    const partInfos = nativeSession.parts() as NativeArchivePartInfo[];
    const refreshed = partInfos.map((info, i) => {
      const handle = handles?.[i];
      const payload = payloads[i];
      return encodeToken({
        v: TOKEN_VERSION,
        p: platform(),
        ref: handle?.ref ?? payload.ref,
        persist: handle?.persist ?? payload.persist,
        fp: info.fp,
      });
    });

    const session = new SessionImpl(native, nativeSession, refreshed, epoch);
    liveSessions.add(session);
    return session;
  } catch (e) {
    throw normalizeError(e);
  } finally {
    if (handles) closePartsQuietly(glueModule, handles);
  }
}

function closePartsQuietly(glueModule: GlueSpec, handles: ArchivePartHandle[]): void {
  try {
    glueModule.closeParts(handles.map((h) => h.handleId));
  } catch {
    // Idempotent on both platforms; a throw here would mask the real error.
  }
}

/**
 * Which platform minted a token.
 *
 * `require`d lazily for the same reason as everything else here: `Platform` is
 * cheap, but keeping the module graph free of eager react-native imports is
 * what makes "importing this file performs zero native work" a property of the
 * file rather than of react-native's current internals.
 */
function platform(): 'ios' | 'android' {
  const { Platform } = require('react-native') as { Platform: { OS: string } };
  return Platform.OS === 'ios' ? 'ios' : 'android';
}

/**
 * Test-only reset of this module's process state.
 *
 * Exported because the wrapper's state (the lazy handles, the epoch, the live
 * session set) is module state, and a test that bumps the epoch would
 * otherwise poison every later test in the same file.
 */
export function __resetArchiveReaderForTests(): void {
  bindings = null;
  glue = null;
  archiveEpoch = 0;
  jobCounter = 0;
  liveSessions.clear();
}
