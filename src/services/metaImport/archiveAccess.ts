/**
 * The app's ONLY door to `orbital-archive-reader` (#920).
 *
 * Security invariant 29a (`archive-reader-import-restricted`) enforces that:
 * nothing else in `src/` may import `'orbital-archive-reader'`, nor reach it
 * by a relative or absolute path into `packages/orbital-archive-reader`. The
 * reason is that everything in this file is a POLICY layer over the native
 * reader, and a second importer would be a second policy:
 *
 *  1. **A denied-root tripwire** (F17). The Rust allowlist already decides
 *     what may be opened, and `messages/` entries are never listed. This is
 *     defence in depth on the OTHER side of the FFI: if a listing ever
 *     contains an entry under a denied root, the session is closed and the run
 *     fails. The real guarantee is the Rust hostile matrix's recording-source
 *     assertion; this is the cheap second lock.
 *  2. **A content sniff before every extract** (F1). Extension is not
 *     evidence. `peekHead` inflates at most 128 bytes, and
 *     `sniffContentType` decides: video bytes under an image name are held
 *     (`ENTRY_IS_VIDEO`), a non-image is refused
 *     (`ENTRY_UNSUPPORTED_IMAGE_FORMAT`), and an unrecognised head is refused
 *     distinctly (`ENTRY_SNIFF_INDETERMINATE`) — never an extension fallback.
 *  3. **Staging-file lifecycle.** Every extract is consumed inside a
 *     `try/finally` that unlinks the file and calls `releaseStaging(path)`, so
 *     the live-staging ceiling cannot leak and no plaintext media outlives the
 *     consumer. A paused run closes its session; a resume re-extracts.
 *  4. **A free-space preflight** against `DISK_HEADROOM_BYTES` (F8) and a
 *     re-stat against the reported `byteLength` immediately before the bytes
 *     are handed on.
 *  5. **Codes-only errors and bucketed telemetry** (F18). Nothing leaving this
 *     module carries a path, an entry name, a URI or a count derived from
 *     path-level rejections.
 *
 * ## What this module does NOT do
 *
 * It does not parse Meta JSON (#925), does not drive the import run (#926) and
 * does not touch the UI (#928). It hands out `readJson` text and extracted
 * file paths, and it refuses anything the policy above refuses.
 */

import { getFSInfo, stat } from '@dr.pogodin/react-native-fs';
import {
  ARCHIVE_ERROR_DISPOSITIONS,
  ArchiveReaderError,
  abortAllArchiveSessions as abortAllArchiveSessionsNative,
  isArchiveCancellation,
  openArchive,
  pickArchiveParts,
  releaseAllPersistedParts as releaseAllPersistedPartsNative,
  releaseArchiveParts,
  unlinkStagingFile,
  type ArchiveCallOptions,
  type ArchiveEntry,
  type ArchiveErrorCode,
  type ArchivePartToken,
  type ArchiveSession,
  type EntrySkipCode,
  type RustEntrySkipCode,
  type UriResolution,
} from 'orbital-archive-reader';
import { sniffContentType } from '../media/contentType';
import { DISK_HEADROOM_BYTES } from '../media/mediaLimits';

export type {
  ArchiveCallOptions,
  ArchiveEntry,
  ArchiveErrorCode,
  ArchivePartToken,
  ArchiveSession,
  EntrySkipCode,
  RustEntrySkipCode,
  UriResolution,
};
export { ARCHIVE_ERROR_DISPOSITIONS, ArchiveReaderError, isArchiveCancellation };

/**
 * Root segments that must never appear in a listing (F17).
 *
 * `messages` and `inbox` are the reason this feature was allowed to exist at
 * all: a Meta export contains the user's entire private message history, and
 * Orbital imports POSTS. The other four are personal data an import has no
 * use for. Checked on the PRE-STRIP path, because the wrapper strip removes a
 * leading wrapper segment and a hostile export can name that segment after a
 * denied root to push the real root one level down.
 */
const DENIED_ROOTS: ReadonlySet<string> = new Set([
  'messages',
  'inbox',
  'friends_and_followers',
  'ads_information',
  'security_and_login_information',
  'personal_information',
]);

/**
 * Whether a listed path's first segment is a denied root.
 *
 * NOTE ON WHAT IS CHECKABLE HERE: the FFI exposes only the POST-strip path
 * (`ArchiveEntry.path`), by design — a pre-strip name is a raw
 * attacker-controlled byte string and the Rust side deliberately never hands
 * one across. So this runs on the listed path. That is strictly weaker than
 * the plan's "pre-strip" wording, and it is sound only because the strip
 * itself refuses to remove a known root key (Rust `is_known_root_key`, which
 * covers every denied root and is pinned by invariant 29): a wrapper segment
 * named `messages` is therefore never stripped, so it is still the first
 * segment of the listed path when this check runs.
 */
export function startsWithDeniedRoot(path: string): boolean {
  const slash = path.indexOf('/');
  const first = slash === -1 ? path : path.slice(0, slash);
  return DENIED_ROOTS.has(first);
}

// ---------------------------------------------------------------------------
// Telemetry: bucketed counts only (F18)
// ---------------------------------------------------------------------------

export type CountBucket = '0' | '1' | '2-10' | '11-100' | '101-1k' | '1k+';

/**
 * Bucket a count before it leaves the device.
 *
 * An exact count of, say, allowlisted media entries is a fingerprint of the
 * user's export. Buckets keep the operational signal ("were there any?", "was
 * it big?") and drop the identifying precision.
 */
export function bucketCount(n: number): CountBucket {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n === 1) return '1';
  if (n <= 10) return '2-10';
  if (n <= 100) return '11-100';
  if (n <= 1000) return '101-1k';
  return '1k+';
}

export interface ArchiveSessionTelemetry {
  readonly parts: CountBucket;
  readonly listed: CountBucket;
  readonly jsonEntries: CountBucket;
  readonly imageEntries: CountBucket;
  readonly videoEntries: CountBucket;
  /**
   * Rejection buckets, EXCLUDING every path-level and denied-root code (F18):
   * those counts are derived from attacker-controlled names and are not sent.
   */
  readonly rejected: Readonly<Partial<Record<RustEntrySkipCode, CountBucket>>>;
}

/** Rejection codes whose counts are never reported (F18). */
const UNREPORTABLE_SKIP_CODES: ReadonlySet<RustEntrySkipCode> = new Set<RustEntrySkipCode>([
  'ENTRY_PATH_INVALID',
  'ENTRY_PATH_TRAVERSAL',
  'ENTRY_NOT_ALLOWLISTED',
]);

export function summarizeSession(session: ArchiveSession): ArchiveSessionTelemetry {
  let json = 0;
  let image = 0;
  let video = 0;
  for (const entry of session.entries) {
    if (entry.kind === 'json') json++;
    else if (entry.kind === 'image') image++;
    else video++;
  }
  const rejected: Partial<Record<RustEntrySkipCode, CountBucket>> = {};
  for (const [code, count] of Object.entries(session.rejectedCounts)) {
    const typed = code as RustEntrySkipCode;
    if (UNREPORTABLE_SKIP_CODES.has(typed)) continue;
    rejected[typed] = bucketCount(count ?? 0);
  }
  return {
    parts: bucketCount(session.parts.length),
    listed: bucketCount(session.entries.length),
    jsonEntries: bucketCount(json),
    imageEntries: bucketCount(image),
    videoEntries: bucketCount(video),
    rejected,
  };
}

// ---------------------------------------------------------------------------
// Session handle
// ---------------------------------------------------------------------------

/** What `readEntryJson` returns. `skip` is a value, never a throw. */
export type ArchiveJsonOutcome =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly skip: EntrySkipCode };

/**
 * What `extractImageEntry` returns.
 *
 * On success the caller MUST consume `path` and then call `release()` — which
 * unlinks the file and gives its bytes back to the live-staging ceiling —
 * exactly once, in a `finally`. `contentType` is the SNIFFED type, never the
 * extension's claim.
 */
export type ArchiveExtractOutcome =
  | {
      readonly ok: true;
      readonly path: string;
      readonly byteLength: number;
      readonly contentType: string;
      readonly release: () => void;
    }
  | { readonly ok: false; readonly skip: EntrySkipCode };

export interface ArchiveImportSession {
  readonly parts: readonly ArchivePartToken[];
  readonly entries: readonly ArchiveEntry[];
  readonly telemetry: ArchiveSessionTelemetry;
  resolveMediaUris(uris: readonly string[]): UriResolution[];
  readEntryJson(entryId: string, options?: ArchiveCallOptions): Promise<ArchiveJsonOutcome>;
  extractImageEntry(
    entryId: string,
    options?: ArchiveCallOptions,
  ): Promise<ArchiveExtractOutcome>;
  close(): void;
}

class ImportSession implements ArchiveImportSession {
  readonly parts: readonly ArchivePartToken[];
  readonly entries: readonly ArchiveEntry[];
  readonly telemetry: ArchiveSessionTelemetry;

  private readonly session: ArchiveSession;
  /** entryId -> entry. Nothing outside the listing may be addressed. */
  private readonly byId: ReadonlyMap<string, ArchiveEntry>;

  constructor(session: ArchiveSession) {
    this.session = session;
    this.parts = session.parts;
    this.entries = session.entries;
    this.telemetry = summarizeSession(session);
    const map = new Map<string, ArchiveEntry>();
    for (const entry of session.entries) map.set(entry.entryId, entry);
    this.byId = map;
  }

  /**
   * Resolve an entry id against the listing, or throw.
   *
   * An id that is not in `entries` is a caller bug — ids come from this
   * session or from `#926`'s persisted set for THESE parts — so it is
   * `ARCHIVE_INTERNAL`, not a user-facing archive problem. Without this,
   * `#925` could hand a stored id from a different export straight to Rust.
   */
  private require(entryId: string, kind?: ArchiveEntry['kind']): ArchiveEntry {
    const entry = this.byId.get(entryId);
    if (!entry) throw new ArchiveReaderError('ARCHIVE_INTERNAL');
    if (kind !== undefined && entry.kind !== kind) {
      throw new ArchiveReaderError('ARCHIVE_INTERNAL');
    }
    return entry;
  }

  resolveMediaUris(uris: readonly string[]): UriResolution[] {
    return this.session.resolveMediaUris(uris);
  }

  async readEntryJson(
    entryId: string,
    options?: ArchiveCallOptions,
  ): Promise<ArchiveJsonOutcome> {
    const entry = this.require(entryId, 'json');
    if (entry.skip !== null) return { ok: false, skip: entry.skip };
    const result = await this.session.readJson(entryId, options);
    return result.ok ? { ok: true, text: result.text } : { ok: false, skip: result.skip };
  }

  async extractImageEntry(
    entryId: string,
    options?: ArchiveCallOptions,
  ): Promise<ArchiveExtractOutcome> {
    const entry = this.require(entryId);
    if (entry.skip !== null) return { ok: false, skip: entry.skip };
    // A video-by-extension entry is listed so #925 can hold the whole post,
    // and is never opened: no KIND_CAPS row exists for it.
    if (entry.kind !== 'image') return { ok: false, skip: 'ENTRY_KIND_NOT_ENABLED' };

    // (F1) Sniff BEFORE extracting, so MP4 bytes named .jpg never reach disk.
    const peek = await this.session.peekHead(entryId, options);
    if (!peek.ok) return { ok: false, skip: peek.skip };
    const peeked = sniffContentType(peek.head);
    const verdict = classifySniff(peeked);
    if (verdict !== null) return { ok: false, skip: verdict };

    // (F8) Free space, checked against the entry's DECLARED size: the real
    // size is only known once it is on disk, and by then it is too late.
    await assertFreeSpaceFor(entry.declaredSize);

    const extracted = await this.session.extractEntry(entryId, 'image', options);
    if (!extracted.ok) return { ok: false, skip: extracted.skip };

    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      // Order matters only in that both must happen: the unlink frees the
      // disk, releaseStaging frees the session's live-staging ceiling. Skip
      // either and a long run dies on ARCHIVE_NO_SPACE with disk to spare.
      this.session.releaseStaging(extracted.path);
      unlinkStagingFile(extracted.path);
    };

    try {
      // The head is re-checked after extraction (F1): peekHead and the real
      // write are two separate inflations, and only this one describes the
      // bytes that are actually on disk.
      const settled = sniffContentType(extracted.head);
      const after = classifySniff(settled);
      if (after !== null) {
        release();
        return { ok: false, skip: after };
      }

      // (F8) Re-stat immediately before handing the bytes on. A mismatch
      // means the reaper, a wipe or another writer touched the file between
      // the extract and now; the caller re-extracts.
      const onDisk = await statSize(extracted.path);
      if (onDisk === null || onDisk !== extracted.byteLength) {
        release();
        return { ok: false, skip: 'ENTRY_CORRUPT' };
      }

      return {
        ok: true,
        path: extracted.path,
        byteLength: extracted.byteLength,
        contentType: settled ?? 'application/octet-stream',
        release,
      };
    } catch (e) {
      release();
      throw e;
    }
  }

  close(): void {
    this.session.close();
  }
}

/**
 * The F1 sniff table. `null` means "proceed to extract".
 *
 * `sniffContentType` is ADVISORY by design elsewhere in the app (a null leaves
 * the declared type standing). Here it is AUTHORITATIVE and fails closed:
 * there is no declared type worth trusting, because the only claim is a file
 * extension inside an archive the user downloaded from a third party.
 */
function classifySniff(sniffed: string | null): EntrySkipCode | null {
  if (sniffed === null) return 'ENTRY_SNIFF_INDETERMINATE';
  if (sniffed.startsWith('video/')) return 'ENTRY_IS_VIDEO';
  if (!sniffed.startsWith('image/')) return 'ENTRY_UNSUPPORTED_IMAGE_FORMAT';
  return null;
}

async function statSize(path: string): Promise<number | null> {
  try {
    const info = await stat(path);
    return typeof info.size === 'number' ? info.size : Number(info.size);
  } catch {
    return null;
  }
}

/**
 * Refuse an extract that would leave the device short of headroom (F8).
 *
 * A `getFSInfo` failure is NOT a refusal — same stance as the download
 * preflight: we cannot tell "no space" from "cannot ask", and refusing on a
 * failed query would make the feature unavailable on a device that is fine.
 * The native side still enforces the real ceilings and maps `ENOSPC` to
 * `ARCHIVE_NO_SPACE`.
 */
async function assertFreeSpaceFor(declaredSize: number): Promise<void> {
  try {
    const { freeSpace } = await getFSInfo();
    if (freeSpace - declaredSize <= DISK_HEADROOM_BYTES) {
      throw new ArchiveReaderError('ARCHIVE_NO_SPACE');
    }
  } catch (e) {
    if (e instanceof ArchiveReaderError) throw e;
  }
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

export { pickArchiveParts, releaseArchiveParts };

/**
 * Open an archive and apply the denied-root tripwire to the listing.
 *
 * The tripwire closes the session before returning, so a listing that should
 * have been impossible cannot be read from at all — not even for the entries
 * that were fine.
 */
export async function openArchiveSession(
  tokens: readonly ArchivePartToken[],
  options?: ArchiveCallOptions,
): Promise<ArchiveImportSession> {
  const session = await openArchive(tokens, options);
  for (const entry of session.entries) {
    if (startsWithDeniedRoot(entry.path)) {
      session.close();
      throw new ArchiveReaderError('ARCHIVE_INTERNAL');
    }
  }
  return new ImportSession(session);
}

/**
 * `localWipe` phase 1 (F3). Synchronous, never awaited.
 *
 * Re-exported through this module rather than imported directly by
 * `authService`, so invariant 29a's single-importer rule stays true and the
 * wipe wiring cannot drift away from the policy layer.
 */
export function abortAllArchiveSessions(): void {
  abortAllArchiveSessionsNative();
}

/**
 * `localWipe` DELETION path only (F3): release every persisted SAF grant.
 *
 * Logout deliberately keeps grants, so the same user on the same device can
 * still resume a paused import after re-authenticating.
 */
export async function releaseAllPersistedParts(): Promise<void> {
  await releaseAllPersistedPartsNative();
}
