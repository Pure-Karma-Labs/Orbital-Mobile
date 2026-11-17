/**
 * `importRunner.ts` — the resumable Meta import run (#926 §4.16).
 *
 * ## The database is REAL
 *
 * `importRepository` runs against migration 009's actual DDL on `node:sqlite`
 * (`testUtils/importDbHarness`). The runner's whole model is "the store is a
 * PROJECTION of SQLite", so every claim it makes about resuming, parking,
 * requeuing or finishing is read back out of SQL rather than asserted against
 * a spy that would pass just as happily on the wrong column.
 *
 * ## What is mocked, and why
 *
 *  - the import API (`../api/imports`) — these tests are about what the run
 *    does with each answer, and the transport has its own suite;
 *  - `importCrypto`, because the real module reaches `useAppStore` → MMKV /
 *    nitro, and because a recorded key session is what makes "the session was
 *    closed before the job was deleted" assertable;
 *  - `archiveAccess` and `parseArchive`, so a test can hand the runner an
 *    `ARCHIVE_CHANGED` or a two-post parse without a ZIP;
 *  - `mediaUploadService`, which `importMedia` calls (its own suite owns the
 *    per-file pipeline);
 *  - `conversationService` / `threadService` / `telemetry`, the three
 *    fire-and-forget seams.
 *
 * `api/errors` is REAL: the taxonomy matches on those classes, and a mock of
 * them would make every error-path test a tautology.
 *
 * ## Timers
 *
 * NO fake timers by default (#834). The runner throttles progress with a real
 * 250 ms `setTimeout`, and every phase / summary / pause change flushes
 * immediately, so assertions read the published store directly. The two tests
 * whose SUBJECT is a countdown use `jest.useFakeTimers()` scoped to the one
 * `it`, with `.catch` attached to the run promise before any clock advance.
 *
 * Run: npm test -- importRunner
 */

import { AppState, type AppStateStatus } from 'react-native';

import { closeDatabase } from '../../../database/connection';
import {
  createImportJob,
  finishImportJob,
  getImportJob,
  insertImportItems,
  setImportJobParsed,
  startImportJob,
} from '../../../database/repositories/importRepository';
import {
  AuthError,
  ConflictError,
  NetworkError,
  NotFoundError,
  QuotaExceededError,
  RateLimitError,
  ServerError,
  ValidationError,
} from '../../api/errors';

import type { ImportDbHarness } from '../testUtils/importDbHarness';
import type { ImportItemInsert } from '../../../database/repositories/importRepository';
import type { ImportLimits } from '../../../types/api';
import type { ArchiveImportSession } from '../archiveAccess';
import type { ImportPreflight } from '../importRunner';
import type { ImportSource, ParseSummary, SkipReason } from '../types';

jest.mock('@op-engineering/op-sqlite', () => ({ open: jest.fn() }));

// ---------------------------------------------------------------------------
// The import API
// ---------------------------------------------------------------------------

const mockStartImport = jest.fn();
const mockGetGroupImports = jest.fn();
const mockGetImportSession = jest.fn();
const mockSubmitImportBatch = jest.fn();
const mockCompleteImport = jest.fn();
const mockLookupImportKeys = jest.fn();

jest.mock('../../api/imports', () => ({
  startImport: (...a: unknown[]) => mockStartImport(...a),
  getGroupImports: (...a: unknown[]) => mockGetGroupImports(...a),
  getImportSession: (...a: unknown[]) => mockGetImportSession(...a),
  submitImportBatch: (...a: unknown[]) => mockSubmitImportBatch(...a),
  completeImport: (...a: unknown[]) => mockCompleteImport(...a),
  lookupImportKeys: (...a: unknown[]) => mockLookupImportKeys(...a),
}));

/**
 * The media-complete route, which `importMedia` calls directly for the
 * complete-only retry of a quota-parked file. Mocked beside the JSON routes:
 * the real one would reach the request client, and this suite's whole subject
 * is which calls the runner makes.
 */
const mockCompleteImportUpload = jest.fn();
jest.mock('../../api/media', () => ({
  completeImportUpload: (...a: unknown[]) => mockCompleteImportUpload(...a),
}));

// ---------------------------------------------------------------------------
// importCrypto
// ---------------------------------------------------------------------------

/** Every key session the runner opened, newest last. */
interface RecordedKeySession {
  fingerprint: string;
  closed: number;
  pinChecks: number;
}

const mockKeySessions: RecordedKeySession[] = [];
/** What the next `openImportKeySession` answers with. */
let mockNextFingerprint = 'fp-1';
/** Set to throw from `openImportKeySession` (a pending wrap, say). */
let mockKeyOpenError: unknown = null;
/**
 * Set to hold `openImportKeySession` open: the pre-run window gap 9 is about.
 *
 * `enterJob` awaits this before `runJob` assigns `run`, which is exactly where
 * a second confirm, a fired retry timer or a Stop tap lands.
 */
let mockKeyOpenGate: Promise<void> | null = null;
/** Set to throw from `verifyGroupKeyPin`. */
let mockPinError: unknown = null;
const mockClassifyCryptoError = jest.fn<string | null, [unknown]>(() => null);

jest.mock('../../crypto/importCrypto', () => ({
  importKeyToWire: (bytes: Uint8Array) => Buffer.from(bytes).toString('base64'),
  classifyImportCryptoError: (e: unknown) => mockClassifyCryptoError(e),
  openImportKeySession: async () => {
    if (mockKeyOpenGate !== null) await mockKeyOpenGate;
    if (mockKeyOpenError !== null) throw mockKeyOpenError;
    const recorded = {
      fingerprint: mockNextFingerprint,
      closed: 0,
      pinChecks: 0,
    };
    mockKeySessions.push(recorded);
    return {
      keyFingerprint: recorded.fingerprint,
      deriveImportKey: async () => new Uint8Array(16).fill(0x11),
      sealContent: async (plaintext: string) => ({
        ciphertext: `ct:${plaintext.length}`,
        iv: 'iv',
      }),
      sealImportMeta: async () => ({ encryptedImportMeta: 'meta', importMetaIv: 'miv' }),
      verifyGroupKeyPin: async () => {
        recorded.pinChecks += 1;
        if (mockPinError !== null) throw mockPinError;
      },
      close: () => {
        recorded.closed += 1;
      },
    };
  },
}));

// ---------------------------------------------------------------------------
// archiveAccess
// ---------------------------------------------------------------------------

const mockPickArchiveParts = jest.fn();
const mockOpenArchiveSession = jest.fn();
const mockReleaseArchiveParts = jest.fn();

jest.mock('../archiveAccess', () => {
  class ArchiveReaderError extends Error {
    readonly code: string;
    constructor(code: string) {
      super(`archive: ${code}`);
      this.name = 'ArchiveReaderError';
      this.code = code;
    }
  }
  return {
    // A verbatim copy of the shipped table: the taxonomy reads it with
    // `hasOwnProperty`, so a short mock would silently drop whole arms.
    ARCHIVE_ERROR_DISPOSITIONS: Object.freeze({
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
    }),
    ArchiveReaderError,
    isArchiveCancellation: (e: unknown) =>
      e !== null && typeof e === 'object' && (e as { code?: unknown }).code === 'ECANCELLED',
    pickArchiveParts: (...a: unknown[]) => mockPickArchiveParts(...a),
    openArchiveSession: (...a: unknown[]) => mockOpenArchiveSession(...a),
    releaseArchiveParts: (...a: unknown[]) => mockReleaseArchiveParts(...a),
  };
});

const archiveMock = require('../archiveAccess');
const ArchiveReaderError = archiveMock.ArchiveReaderError as new (code: string) => Error;

// ---------------------------------------------------------------------------
// parseArchive
// ---------------------------------------------------------------------------

const mockParseArchive = jest.fn();
jest.mock('../parseArchive', () => ({
  parseArchive: (...a: unknown[]) => mockParseArchive(...a),
}));

// ---------------------------------------------------------------------------
// mediaUploadService (what importMedia calls)
// ---------------------------------------------------------------------------

const mockUploadMedia = jest.fn();
jest.mock('../../mediaUploadService', () => {
  class ImportMediaStagedError extends Error {
    readonly cause: unknown;
    constructor(cause: unknown) {
      super('Import media upload failed after chunks were staged');
      this.name = 'ImportMediaStagedError';
      this.cause = cause;
    }
  }
  class ImportMediaUnsupportedError extends Error {
    constructor(reason: string) {
      super(`Import media unsupported: ${reason}`);
      this.name = 'ImportMediaUnsupportedError';
    }
  }
  return {
    uploadMedia: (...a: unknown[]) => mockUploadMedia(...a),
    isUploadCancellation: (e: unknown) =>
      (e !== null && typeof e === 'object' && (e as { code?: unknown }).code === 'ECANCELLED') ||
      (e instanceof Error && e.message === 'Upload cancelled'),
    ImportMediaStagedError,
    ImportMediaUnsupportedError,
  };
});

/**
 * The upload service's post-chunk wrapper, reached through the MOCKED module.
 *
 * `uploadMedia` wraps every failure that happens after the server accepted a
 * chunk, so this — not a bare `ConflictError` — is the shape every
 * media-refusal test below must inject.
 */
const uploadServiceMock = require('../../mediaUploadService');
const ImportMediaStagedError = uploadServiceMock.ImportMediaStagedError as new (
  cause: unknown,
) => Error;

// ---------------------------------------------------------------------------
// The three fire-and-forget seams
// ---------------------------------------------------------------------------

const mockFulfillPendingWraps = jest.fn(() => Promise.resolve());
jest.mock('../../conversationService', () => ({
  fulfillPendingWraps: () => mockFulfillPendingWraps(),
}));

const mockLoadThreadsForGroup = jest.fn((..._a: unknown[]) => Promise.resolve([]));
jest.mock('../../threadService', () => ({
  loadThreadsForGroup: (...a: unknown[]) => mockLoadThreadsForGroup(...a),
}));

const mockCaptureError = jest.fn();
jest.mock('../../telemetry', () => ({
  captureError: (...a: unknown[]) => mockCaptureError(...a),
}));

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

let mockStoreState: Record<string, unknown> = {};
jest.mock('../../../stores/useAppStore', () => ({
  useAppStore: { getState: () => mockStoreState },
}));

import {
  canStartFromPreflight,
  cancelImport,
  closeOtherImport,
  confirmAndRunImport,
  discardImportPreflight,
  dismissImportSummary,
  getImportUnmigratedItems,
  importStore,
  pickAndStartParse,
  probeImportAvailability,
  repickArchiveParts,
  resetImportRunnerForTesting,
  resetImportRunnerState,
  resumeImport,
  resumeImportAtLaunch,
} from '../importRunner';
import { openImportDb } from '../testUtils/importDbHarness';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const JOB = 'job-1';
const ORBIT = 'orbit-1';
const IMPORT_ID = 'import-1';
/** 2012-08-26T12:00:00Z */
const POST_DATE = 1345982400000;

const LIMITS: ImportLimits = {
  batchMax: 50,
  mediaPerItemMax: 100,
  metaMaxBytes: 1024,
  ivMax: 64,
  titleMax: 10_000,
  bodyMax: 100_000,
  minDate: '2004-01-01',
  mediaContentClasses: ['image'],
};

function allowance(postsUsed = 0, bytesUsed = 0) {
  return {
    postsUsed,
    bytesUsed,
    postsLimit: 1000,
    bytesLimit: 2 * 1024 * 1024 * 1024,
  };
}

/** A 429 carrying a `Retry-After` of `ms`, built through the real class. */
function rateLimited(ms: number) {
  return new RateLimitError({ get: () => String(ms / 1000) });
}

/**
 * Both sources' buckets, as the preflight GET always returns them (B#352).
 *
 * `over` replaces a WHOLE bucket, the way the response does: there is no
 * partial allowance on the wire, and a half-overridden one would make a
 * missing limit read as "no room left".
 */
function allowances(over: Partial<Record<ImportSource, ReturnType<typeof allowance>>> = {}) {
  return { facebook: allowance(), instagram: allowance(), ...over };
}

/**
 * The preflight GET response.
 *
 * `lookupMax` is spliced into `limits` rather than taken as a whole-`limits`
 * override, because it is the #930 CAPABILITY FLAG: almost every case either
 * wants it absent (today's servers, and the default here) or wants one number
 * in it, and a whole-`limits` override would make every lookup test restate
 * the other eight fields.
 */
function groupImports(over: Record<string, unknown> & { lookupMax?: number } = {}) {
  const { lookupMax, ...rest } = over;
  const base = {
    allowances: allowances(),
    openImport: null,
    limits: lookupMax === undefined ? LIMITS : { ...LIMITS, lookupMax },
  };
  return { ...base, ...rest };
}

/** The open session the preflight reports, defaulting to OUR source. */
function openImport(over: Record<string, unknown> = {}) {
  return {
    importId: IMPORT_ID,
    status: 'open',
    source: 'facebook',
    declaredPosts: 1,
    declaredBytes: 4096,
    createdPosts: 0,
    lastActivityAt: '2012-08-26T00:00:00.000Z',
    ...over,
  };
}

let harness: ImportDbHarness;

/** An `ArchiveImportSession` double whose extract always succeeds. */
/**
 * Post-JSON paths `layout.matchPostJsonPath` recognises, per source.
 *
 * The archive double's `entries` is what `detectSources` reads, so an empty
 * list means "neither source" — which is now a `no_posts` failure, not a
 * harmless default. Every fixture therefore declares what it holds.
 */
const FB_ENTRY = {
  entryId: 'e-fb',
  path: 'your_facebook_activity/posts/your_posts__check_ins__photos_and_videos_1.json',
};
const IG_ENTRY = { entryId: 'e-ig', path: 'your_instagram_activity/content/posts_1.json' };

/** An archive double holding Instagram posts only. */
function instagramArchiveSession(): ArchiveImportSession {
  return archiveSession(['part-a'], [IG_ENTRY]);
}

/** An archive double holding BOTH sources, which is what makes the chooser run. */
function bothSourcesArchiveSession(): ArchiveImportSession {
  return archiveSession(['part-a'], [FB_ENTRY, IG_ENTRY]);
}

/** An archive double whose files hold no post JSON of either source. */
function noPostsArchiveSession(): ArchiveImportSession {
  return archiveSession(['part-a'], []);
}

function archiveSession(
  parts: readonly string[] = ['part-a'],
  entries: readonly { entryId: string; path: string }[] = [FB_ENTRY],
): ArchiveImportSession {
  return {
    parts,
    entries,
    telemetry: {} as never,
    resolveMediaUris: jest.fn(() => []),
    readEntryJson: jest.fn(),
    peekEntryKind: jest.fn(),
    extractImageEntry: jest.fn(async () => ({
      ok: true as const,
      path: '/tmp/staging/x-archive-staging.bin',
      byteLength: 1024,
      contentType: 'image/jpeg',
      release: () => {
        releases += 1;
      },
    })),
    close: () => {
      archiveCloses += 1;
    },
  } as unknown as ArchiveImportSession;
}

/** An archive session whose only entry turns out to be a video on extract. */
function videoArchiveSession(): ArchiveImportSession {
  return {
    ...archiveSession(),
    extractImageEntry: jest.fn(async () => ({ ok: false as const, skip: 'ENTRY_IS_VIDEO' })),
  } as unknown as ArchiveImportSession;
}

let releases = 0;
let archiveCloses = 0;

/** Insert a job plus `count` text-only pending items. */
function seedJob(
  options: {
    status?: 'parsing' | 'ready' | 'in_progress';
    items?: number;
    sessionId?: string | null;
    fingerprint?: string;
    bookmark?: readonly string[] | null;
    skips?: readonly SkipReason[];
    source?: ImportSource;
    mediaEntryIds?: readonly string[];
  } = {},
): void {
  const status = options.status ?? 'in_progress';
  createImportJob({
    id: JOB,
    conversationId: ORBIT,
    source: options.source ?? 'facebook',
    keyFingerprint: options.fingerprint ?? 'fp-1',
    createdAt: POST_DATE,
  });

  const rows: ImportItemInsert[] = [];
  const count = options.items ?? 2;
  for (let i = 0; i < count; i++) {
    rows.push({
      id: `item-${i}`,
      ordinal: i,
      importKey: new Uint8Array(16).fill(i + 1),
      status: 'pending',
      skipReason: null,
      originalDate: POST_DATE,
      body: `body ${i}`,
      sourceFile: 'your_posts_1.json',
      sourceIndex: i,
      idKind: 1,
      ...(i === 0 && options.mediaEntryIds !== undefined
        ? {
            media: options.mediaEntryIds.map((entryId, ordinal) => ({
              ordinal,
              mediaId: `media-${ordinal}`,
              entryId,
              originalDate: null,
            })),
          }
        : {}),
    });
  }
  (options.skips ?? []).forEach((reason, i) => {
    rows.push({
      id: `skip-${i}`,
      ordinal: count + i,
      importKey: null,
      status: 'skipped',
      skipReason: reason,
      originalDate: POST_DATE,
      body: null,
      sourceFile: 'your_posts_1.json',
      sourceIndex: count + i,
      idKind: null,
    });
  });
  insertImportItems(JOB, rows);

  if (status !== 'parsing') {
    setImportJobParsed(JOB, { declaredPosts: count, declaredBytes: 4096 });
  }
  if (status === 'in_progress') {
    startImportJob(JOB, { sessionId: options.sessionId ?? IMPORT_ID });
  }
  if (options.bookmark !== undefined && options.bookmark !== null) {
    harness.sqlite
      .prepare('UPDATE import_jobs SET archive_bookmark = ? WHERE id = ?')
      .run(JSON.stringify(options.bookmark), JOB);
  }
}

/** The one job row, for the parse paths where the id is a fresh UUID. */
function soleJob(): {
  status: string;
  declared_posts: number | null;
  declared_bytes: number | null;
} {
  return harness.sqlite
    .prepare('SELECT status, declared_posts, declared_bytes FROM import_jobs')
    .get() as { status: string; declared_posts: number | null; declared_bytes: number | null };
}

/** The one job row's source, for the paths whose id is a fresh UUID. */
function soleJobSource(): string {
  return (harness.sqlite.prepare('SELECT source FROM import_jobs').get() as { source: string })
    .source;
}

function itemRows(): { id: string; status: string; error_code: string | null }[] {
  return harness.sqlite
    .prepare('SELECT id, status, error_code FROM import_items ORDER BY ordinal')
    .all() as { id: string; status: string; error_code: string | null }[];
}

function jobRow(): { status: string; archive_bookmark: string | null; session_id: string | null } {
  return harness.sqlite
    .prepare('SELECT status, archive_bookmark, session_id FROM import_jobs WHERE id = ?')
    .get(JOB) as { status: string; archive_bookmark: string | null; session_id: string | null };
}

/**
 * The body of every row that was never sent, in ordinal order.
 *
 * `finishImportJob` NULLs them, which is the fact that makes a `failed` job
 * un-resumable: there is nothing left to submit.
 */
function unsentBodies(): (string | null)[] {
  return (
    harness.sqlite
      .prepare(
        "SELECT body FROM import_items WHERE status NOT IN ('created','duplicate') ORDER BY ordinal",
      )
      .all() as { body: string | null }[]
  ).map((row) => row.body);
}

/** How many rows the parse actually wrote. */
function itemCount(): number {
  return (harness.sqlite.prepare('SELECT COUNT(*) AS n FROM import_items').get() as { n: number })
    .n;
}

/** How many job rows exist at all, for the paths whose id is a fresh UUID. */
function jobCount(): number {
  return (harness.sqlite.prepare('SELECT COUNT(*) AS n FROM import_jobs').get() as { n: number }).n;
}

/** A promise plus its settlers: a call held open across an await point. */
function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // The runner is what handles this rejection; the harness must not leave it
  // unhandled in the window before it does.
  promise.catch(() => {});
  return { promise, resolve, reject };
}

/** Let every queued microtask settle. The runner never waits on real I/O. */
async function drain(times = 80): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

/** A parse that emits `posts` importable items and the given skips. */
function parseEmitting(
  posts: number,
  options: {
    skips?: readonly SkipReason[];
    mediaPerPost?: number;
    /** What the PARSER saw besides this source — the real one sets it too. */
    otherSourceDetected?: boolean;
  } = {},
): void {
  mockParseArchive.mockImplementation(
    async (_session: unknown, opts: Record<string, Function>): Promise<ParseSummary> => {
      for (let i = 0; i < posts; i++) {
        await opts.onItem(
          {
            outcome: 'import',
            source: 'facebook',
            sourceFile: 'your_posts_1.json',
            sourceIndex: i,
            sourceItemId: new Uint8Array(8),
            idKind: 1,
            originalDate: POST_DATE,
            body: `body ${i}`,
            media: Array.from({ length: options.mediaPerPost ?? 0 }, (_, m) => ({
              entryId: `entry-${i}-${m}`,
              originalDate: null,
            })),
          },
          new Uint8Array(16).fill(i + 1),
        );
      }
      for (const [i, reason] of (options.skips ?? []).entries()) {
        await opts.onItem(
          {
            outcome: 'skip',
            source: 'facebook',
            sourceFile: 'your_posts_1.json',
            sourceIndex: posts + i,
            sourceItemId: null,
            idKind: null,
            originalDate: POST_DATE,
            reason,
          },
          null,
        );
      }
      opts.onProgress?.({ postsSeen: posts, mediaPeeked: 0 });
      return summaryWith(posts, options.skips ?? [], options.otherSourceDetected ?? false);
    },
  );
}

function zeroSkips(): Record<SkipReason, number> {
  return {
    held_video: 0,
    unsupported_image_format: 0,
    image_too_large: 0,
    media_missing: 0,
    media_unsupported_reference: 0,
    media_unreadable: 0,
    unsupported_post_type: 0,
    empty_post: 0,
    text_too_long: 0,
    invalid_timestamp: 0,
    missing_timestamp: 0,
    duplicate_in_archive: 0,
    malformed_post: 0,
  };
}

function summaryWith(
  importable: number,
  skips: readonly SkipReason[],
  otherSourceDetected = false,
): ParseSummary {
  const skipped = zeroSkips();
  for (const reason of skips) skipped[reason] += 1;
  return {
    importable,
    importableMedia: 0,
    skipped,
    earliestDate: POST_DATE,
    latestDate: POST_DATE,
    fileIssues: [],
    idScheme: { fbid: 0, content: importable },
    otherSourceDetected,
    locationDataRemoved: false,
  };
}

/**
 * A real UUID v4 built from one hex digit. `mapBatchResults` shape-gates the
 * echoed `thread_id`, so a `thread-0` fixture would be stored as null and say
 * nothing about the join (the gate has its own tests in `importBatch.test`).
 */
function threadUuid(d: string): string {
  return `${d.repeat(8)}-${d.repeat(4)}-4${d.repeat(3)}-8${d.repeat(3)}-${d.repeat(12)}`;
}

/** The batch response for every item the runner submitted. */
function createdFor(items: { importKey: string }[]) {
  return {
    results: items.map((item, i) => ({
      importKey: item.importKey,
      status: 'created' as const,
      threadId: threadUuid(String(i)),
      createdAt: '2012-08-26T00:00:00.000Z',
    })),
    allowance: allowance(items.length),
  };
}

/**
 * Every pause cause the store has PUBLISHED during one test.
 *
 * The only way to assert a NEGATIVE about a transient state: "`ARCHIVE_BUSY`
 * retries in place" means the pause set was never non-empty, which a snapshot
 * taken after the run cannot see.
 */
let pauseCauseHistory: string[] = [];
let unsubscribeStore: (() => void) | null = null;

/** Fake-timer-safe microtask flush: no `setTimeout`, so no clock needed. */
async function flushMicrotasks(times = 80): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

let appStateHandler: ((status: AppStateStatus) => void) | null = null;
let appStateRemove: jest.Mock;
let appStateSpy: jest.SpyInstance;

beforeEach(() => {
  jest.clearAllMocks();
  harness = openImportDb();
  mockKeySessions.length = 0;
  mockNextFingerprint = 'fp-1';
  mockKeyOpenError = null;
  mockKeyOpenGate = null;
  mockPinError = null;
  releases = 0;
  archiveCloses = 0;
  mockStoreState = {
    isAuthenticated: true,
    needsTermsAcceptance: false,
    identityKeyConflict: false,
    keyRecoveryInProgress: false,
    conversations: { [ORBIT]: { contentRetentionDays: 90 } },
  };
  mockClassifyCryptoError.mockReturnValue(null);
  mockGetGroupImports.mockResolvedValue(groupImports());
  mockStartImport.mockResolvedValue({
    importId: IMPORT_ID,
    status: 'open',
    source: 'facebook',
    declaredPosts: 2,
    declaredBytes: 4096,
    allowance: allowance(),
    limits: LIMITS,
  });
  mockGetImportSession.mockResolvedValue({
    importId: IMPORT_ID,
    groupId: ORBIT,
    status: 'open',
    source: 'facebook',
    declaredPosts: 2,
    declaredBytes: 4096,
    createdPosts: 0,
    createdAt: '2012-08-26T00:00:00.000Z',
    lastActivityAt: '2012-08-26T00:00:00.000Z',
    completedAt: null,
    allowance: allowance(),
    limits: LIMITS,
  });
  mockSubmitImportBatch.mockImplementation(async (_id: string, body: { items: unknown[] }) =>
    createdFor(body.items as { importKey: string }[]),
  );
  mockCompleteImport.mockResolvedValue({
    importId: IMPORT_ID,
    status: 'completed',
    createdPosts: 2,
    completedAt: '2012-08-26T00:00:00.000Z',
  });
  // No matches by default. The pre-check (#930) is gated on the server
  // advertising `lookup_max`, which `groupImports()` omits, so most of this
  // suite never reaches the call at all — this is the safety net for the ones
  // that do.
  mockLookupImportKeys.mockResolvedValue({ existing: [] });
  mockUploadMedia.mockResolvedValue({ mediaId: 'media-0' });
  // Only the complete-only retry of a parked file reaches this, and only the
  // tests that park one care what it answers.
  mockCompleteImportUpload.mockResolvedValue({ mediaId: 'media-0' });
  mockReleaseArchiveParts.mockResolvedValue(undefined);
  mockOpenArchiveSession.mockImplementation(async () => archiveSession());
  mockPickArchiveParts.mockResolvedValue(['part-a']);

  appStateHandler = null;
  appStateRemove = jest.fn();
  appStateSpy = jest
    .spyOn(AppState, 'addEventListener')
    .mockImplementation((_event: string, handler: (s: AppStateStatus) => void) => {
      appStateHandler = handler;
      return { remove: appStateRemove } as never;
    });

  resetImportRunnerForTesting();

  pauseCauseHistory = [];
  unsubscribeStore = importStore.subscribe((state) => {
    pauseCauseHistory.push(...state.pauseCauses);
  });
});

afterEach(() => {
  unsubscribeStore?.();
  unsubscribeStore = null;
  resetImportRunnerForTesting();
  appStateSpy.mockRestore();
  closeDatabase();
});

// ===========================================================================
// Group: Store / #928
// ===========================================================================

describe('store and the #928 boundary', () => {
  it('starts in hydrating, and leaves it when the launch gate refuses', async () => {
    expect(importStore.getState().phase).toBe('hydrating');

    mockStoreState = { ...mockStoreState, needsTermsAcceptance: true };
    await resumeImportAtLaunch();

    expect(importStore.getState().phase).toBe('idle');
  });

  it('leaves hydrating when there is no job at all', async () => {
    await resumeImportAtLaunch();
    expect(importStore.getState().phase).toBe('idle');
    expect(importStore.getState().jobId).toBeNull();
  });

  it('does not resume behind a key-recovery or key-conflict gate', async () => {
    seedJob();
    mockStoreState = { ...mockStoreState, keyRecoveryInProgress: true };

    await resumeImportAtLaunch();

    expect(importStore.getState().phase).toBe('idle');
    expect(mockGetImportSession).not.toHaveBeenCalled();
    expect(jobRow().status).toBe('in_progress');
  });

  it('keeps the preflight in the store, so it survives an unmount', async () => {
    parseEmitting(3);
    const result = await pickAndStartParse({ conversationId: ORBIT, chooseSource: jest.fn() });

    expect(result.kind).toBe('preflight');
    const state = importStore.getState();
    expect(state.phase).toBe('ready');
    expect(state.preflight).not.toBeNull();
    expect(state.preflight?.importable).toBe(3);
    expect(state.preflight?.contentRetentionDays).toBe(90);
    // The same object the caller got back, not a copy: #928 reads either.
    expect(state.preflight).toBe(result.kind === 'preflight' ? result.preflight : null);
  });

  it('rebuilds the preflight for a ready job at launch, without re-parsing', async () => {
    seedJob({ status: 'ready', items: 4, skips: ['held_video'] });

    await resumeImportAtLaunch();

    const state = importStore.getState();
    expect(state.phase).toBe('ready');
    expect(state.preflight?.importable).toBe(4);
    // Not a parse answer: the `ParseSummary` is not persisted and is not faked.
    expect(state.preflight?.summary).toBeNull();
    expect(state.preflight?.skippedByReason.held_video).toBe(1);
    expect(mockParseArchive).not.toHaveBeenCalled();
  });

  it('answers a job in another orbit with a typed refusal, never a throw', async () => {
    createImportJob({
      id: 'other-job',
      conversationId: 'orbit-2',
      source: 'instagram',
      keyFingerprint: 'fp-1',
      createdAt: POST_DATE,
    });

    const result = await pickAndStartParse({ conversationId: ORBIT, chooseSource: jest.fn() });

    expect(result).toEqual({
      kind: 'refused',
      reason: 'job-running',
      conversationId: 'orbit-2',
    });
    expect(mockPickArchiveParts).not.toHaveBeenCalled();
  });

  it('probes availability once per orbit and reads a 404 as unavailable', async () => {
    const first = await probeImportAvailability(ORBIT);
    const second = await probeImportAvailability(ORBIT);

    expect(first.available).toBe(true);
    expect(first.limits).toEqual(LIMITS);
    // Both buckets, which is what lets the how-to screen price either source
    // without a second round trip (B#352).
    expect(Object.keys(first.allowances ?? {}).sort()).toEqual(['facebook', 'instagram']);
    expect(second).toBe(first);
    expect(mockGetGroupImports).toHaveBeenCalledTimes(1);

    mockGetGroupImports.mockRejectedValueOnce(new NotFoundError());
    const off = await probeImportAvailability('orbit-off');
    expect(off).toEqual({ available: false, allowances: null, limits: null });
  });

  it('never caches a transient probe failure as unavailable', async () => {
    mockGetGroupImports.mockRejectedValueOnce(new NetworkError('offline'));

    await expect(probeImportAvailability(ORBIT)).rejects.toBeInstanceOf(NetworkError);

    const retried = await probeImportAvailability(ORBIT);
    expect(retried.available).toBe(true);
  });

  it('dismisses the summary back to idle', async () => {
    seedJob({ items: 1 });
    await confirmAndRunLaunch();

    expect(importStore.getState().phase).toBe('done');
    dismissImportSummary();
    expect(importStore.getState().phase).toBe('idle');
    expect(importStore.getState().summary).toBeNull();
  });
});

/** Resume an `in_progress` job and wait for it to settle. */
async function confirmAndRunLaunch(): Promise<void> {
  await resumeImportAtLaunch();
  await drain();
}

// ===========================================================================
// Group: Resume
// ===========================================================================

describe('resume at launch', () => {
  it('requeues uploading rows before the first page, and reads bodies from SQLite', async () => {
    seedJob({ items: 2 });
    // A kill between `markItemsUploading` and `applyBatchResults`.
    harness.sqlite
      .prepare("UPDATE import_items SET status = 'uploading' WHERE id = ?")
      .run('item-0');

    await confirmAndRunLaunch();

    expect(mockParseArchive).not.toHaveBeenCalled();
    const submitted = mockSubmitImportBatch.mock.calls[0][1] as {
      items: { encryptedBody: string }[];
    };
    expect(submitted.items).toHaveLength(2);
    // `ct:<len>` from the recorded seal — the body came out of the database.
    expect(submitted.items.map((i) => i.encryptedBody).sort()).toEqual(['ct:6', 'ct:6']);
    expect(itemRows().every((row) => row.status === 'created')).toBe(true);
    expect(jobRow().status).toBe('completed');
  });

  it('deletes the job on a fingerprint mismatch, releasing parts and closing the session', async () => {
    seedJob({ fingerprint: 'fp-OLD', bookmark: ['part-a'] });

    await resumeImportAtLaunch();

    expect(getImportJob(JOB)).toBeNull();
    expect(mockReleaseArchiveParts).toHaveBeenCalledWith(['part-a']);
    expect(mockKeySessions).toHaveLength(1);
    expect(mockKeySessions[0].closed).toBe(1);
    expect(importStore.getState().phase).toBe('idle');
    expect(mockGetImportSession).not.toHaveBeenCalled();
  });

  it('closes the key session on the continue-to-run path too', async () => {
    seedJob({ items: 1 });

    await confirmAndRunLaunch();

    expect(mockKeySessions).toHaveLength(1);
    expect(mockKeySessions[0].closed).toBe(1);
    expect(mockKeySessions[0].pinChecks).toBeGreaterThanOrEqual(1);
  });

  it('stops the run when setArchiveBookmark returns false', async () => {
    seedJob({ items: 1, bookmark: ['part-a'], mediaEntryIds: ['entry-0-0'] });
    // The session re-opens with DIFFERENT parts, so the bookmark must be
    // rewritten — and the job is finished underneath us, so the write misses.
    mockOpenArchiveSession.mockImplementation(async () => archiveSession(['part-b']));
    mockGetImportSession.mockImplementation(async () => {
      harness.sqlite.prepare("UPDATE import_jobs SET status = 'failed' WHERE id = ?").run(JOB);
      return {
        importId: IMPORT_ID,
        groupId: ORBIT,
        status: 'open',
        declaredPosts: 1,
        declaredBytes: 4096,
        createdPosts: 0,
        createdAt: '2012-08-26T00:00:00.000Z',
        lastActivityAt: '2012-08-26T00:00:00.000Z',
        completedAt: null,
        allowance: allowance(),
        limits: LIMITS,
      };
    });

    await confirmAndRunLaunch();

    expect(mockUploadMedia).not.toHaveBeenCalled();
    expect(mockSubmitImportBatch).not.toHaveBeenCalled();
  });

  it('terminates when the per-session GET says the session is closed', async () => {
    seedJob({ items: 1 });
    mockGetImportSession.mockResolvedValue({
      importId: IMPORT_ID,
      groupId: ORBIT,
      status: 'closed',
      declaredPosts: 1,
      declaredBytes: 4096,
      createdPosts: 0,
      createdAt: '2012-08-26T00:00:00.000Z',
      lastActivityAt: '2012-08-26T00:00:00.000Z',
      completedAt: null,
      allowance: allowance(),
      limits: LIMITS,
    });

    await confirmAndRunLaunch();

    expect(jobRow().status).toBe('failed');
    expect(importStore.getState().summary?.errorCode).toBe('SESSION_CLOSED');
    expect(mockSubmitImportBatch).not.toHaveBeenCalled();
  });

  it.each([
    ['a transient network failure', () => new NetworkError('offline'), 'network'],
    ['a 429', () => rateLimited(60_000), 'rate_limited'],
    ['a 5xx', () => new ServerError(503), 'network'],
  ])(
    'leaves an in_progress job untouched when the launch-time session GET answers %s',
    async (_label, make, cause) => {
      seedJob({ items: 2 });
      mockGetImportSession.mockRejectedValue(make());

      await confirmAndRunLaunch();

      // None of these three names a terminal code, so there is nothing to
      // settle: settling anyway finished the job `completed` (nothing had set
      // a terminal, so `terminalStatusFor` answered `completed`), POSTed
      // `complete` for a session that had never been used, and told the member
      // the import had succeeded with every item still queued.
      expect(jobRow().status).toBe('in_progress');
      expect(itemRows().every((row) => row.status === 'pending')).toBe(true);
      expect(mockCompleteImport).not.toHaveBeenCalled();
      expect(mockSubmitImportBatch).not.toHaveBeenCalled();
      expect(mockCaptureError).not.toHaveBeenCalled();
      expect(importStore.getState().summary).toBeNull();
      // A PAUSE carrying the job's identity, not `idle`: the row stays
      // `in_progress`, so `pickAndStartParse` refuses with `job-running` until
      // this resumes, and `idle` left #928 with nothing to render and no retry.
      const state = importStore.getState();
      expect(state.phase).toBe('paused');
      expect(state.pauseCauses).toEqual([cause]);
      expect(state.jobId).toBe(JOB);
      expect(state.conversationId).toBe(ORBIT);
      expect(state.source).toBe('facebook');
      // The job is resumable, so the key session it was opened with is closed.
      expect(mockKeySessions[0].closed).toBe(1);
    },
  );

  it('retries the same job on the NEXT launch after a transient session GET failure', async () => {
    seedJob({ items: 1 });
    mockGetImportSession.mockRejectedValueOnce(new NetworkError('offline'));

    await confirmAndRunLaunch();
    expect(jobRow().status).toBe('in_progress');

    await confirmAndRunLaunch();

    expect(itemRows()[0].status).toBe('created');
    expect(jobRow().status).toBe('completed');
  });

  it('wakes itself up after a transient session GET failure, with no relaunch', async () => {
    jest.useFakeTimers();
    try {
      seedJob({ items: 1 });
      mockGetImportSession.mockRejectedValueOnce(new NetworkError('offline'));

      const launching = resumeImportAtLaunch();
      launching.catch(() => {
        // Attached BEFORE the clock moves (#834 discipline).
      });
      await flushMicrotasks();
      expect(importStore.getState().pauseCauses).toEqual(['network']);
      await launching;

      // The `network` ladder's first rung, armed with no `ActiveRun` to hang it
      // on. Before this the job sat `in_progress` with no timer at all.
      jest.advanceTimersByTime(5_000);
      await flushMicrotasks();

      expect(itemRows()[0].status).toBe('created');
      expect(jobRow().status).toBe('completed');
      expect(importStore.getState().phase).toBe('done');
    } finally {
      jest.useRealTimers();
    }
  });

  it('re-enters the launch gate at once when the member asks to resume', async () => {
    seedJob({ items: 1 });
    mockGetImportSession.mockRejectedValueOnce(new NetworkError('offline'));

    await resumeImportAtLaunch();
    expect(importStore.getState().phase).toBe('paused');

    resumeImport();
    await drain();

    expect(itemRows()[0].status).toBe('created');
    expect(jobRow().status).toBe('completed');
  });

  it('releases and deletes a job stuck in parsing rather than resuming it', async () => {
    seedJob({ status: 'parsing', items: 1, bookmark: ['part-a'] });

    await resumeImportAtLaunch();

    expect(getImportJob(JOB)).toBeNull();
    expect(mockReleaseArchiveParts).toHaveBeenCalledWith(['part-a']);
    expect(importStore.getState().phase).toBe('idle');
  });
});

// ===========================================================================
// Group: Allowance (§4.5)
// ===========================================================================

describe('the allowance gate', () => {
  it('refuses an archive over the remaining POST allowance at preflight', async () => {
    mockGetGroupImports.mockResolvedValue(
      groupImports({ allowances: allowances({ facebook: allowance(200) }) }),
    );
    parseEmitting(900);

    const result = await pickAndStartParse({ conversationId: ORBIT, chooseSource: jest.fn() });

    expect(result.kind).toBe('preflight');
    const preflight = result.kind === 'preflight' ? result.preflight : null;
    expect(preflight?.overAllowance).toBe('posts');
    expect(preflight?.remainingPosts).toBe(800);
    expect(mockStartImport).not.toHaveBeenCalled();
    expect(soleJob().status).toBe('cancelled');
    expect(mockReleaseArchiveParts).toHaveBeenCalledWith(['part-a']);
  });

  it('refuses an archive over the remaining BYTE allowance', async () => {
    mockGetGroupImports.mockResolvedValue(
      groupImports({
        allowances: allowances({
          facebook: { ...allowance(), bytesUsed: 2 * 1024 * 1024 * 1024 - 10 },
        }),
      }),
    );
    mockOpenArchiveSession.mockImplementation(async () => {
      const session = archiveSession();
      return {
        ...session,
        entries: [
          // The post JSON is what `detectSources` reads; the media entry is
          // what `declaredByEntry` prices.
          FB_ENTRY,
          { entryId: 'entry-0-0', path: 'a.jpg', kind: 'image', declaredSize: 4096, skip: null },
        ],
      } as unknown as ArchiveImportSession;
    });
    parseEmitting(1, { mediaPerPost: 1 });

    const result = await pickAndStartParse({ conversationId: ORBIT, chooseSource: jest.fn() });

    const preflight = result.kind === 'preflight' ? result.preflight : null;
    expect(preflight?.overAllowance).toBe('bytes');
    // ceil(4096 * 1.5) + 64 — the clamp, the re-encode headroom, the framing.
    expect(preflight?.estimatedBytes).toBe(6208);
    expect(mockStartImport).not.toHaveBeenCalled();
    expect(soleJob().status).toBe('cancelled');
  });

  it('accepts an archive that fits, and declares exactly what it parsed', async () => {
    mockGetGroupImports.mockResolvedValue(
      groupImports({ allowances: allowances({ facebook: allowance(200) }) }),
    );
    parseEmitting(800);

    const result = await pickAndStartParse({ conversationId: ORBIT, chooseSource: jest.fn() });

    const preflight = result.kind === 'preflight' ? result.preflight : null;
    expect(preflight?.overAllowance).toBeNull();
    expect(preflight?.importable).toBe(800);
    const row = soleJob();
    expect(row.status).toBe('ready');
    expect(row.declared_posts).toBe(800);
  });

  it('refuses a run the preflight already refused', async () => {
    mockGetGroupImports.mockResolvedValue(
      groupImports({ allowances: allowances({ facebook: allowance(999) }) }),
    );
    parseEmitting(50);
    await pickAndStartParse({ conversationId: ORBIT, chooseSource: jest.fn() });

    await confirmAndRunImport();

    expect(mockStartImport).not.toHaveBeenCalled();
    expect(mockSubmitImportBatch).not.toHaveBeenCalled();
  });

  it('treats a start-time IMPORT_ALLOWANCE_EXCEEDED as terminal, with no retry', async () => {
    seedJob({ status: 'ready', items: 2 });
    await resumeImportAtLaunch();
    mockStartImport.mockRejectedValue(
      new ConflictError(
        JSON.stringify({
          error: 'IMPORT_REFUSED',
          details: { code: 'IMPORT_ALLOWANCE_EXCEEDED', allowance: allowance(999) },
        }),
      ),
    );

    await confirmAndRunImport();
    await drain();

    expect(mockStartImport).toHaveBeenCalledTimes(1);
    expect(jobRow().status).toBe('failed');
    expect(importStore.getState().summary?.errorCode).toBe('ALLOWANCE');
  });

  it('refuses an archive with nothing importable in it, without a session', async () => {
    parseEmitting(0, { skips: ['held_video', 'unsupported_post_type'] });

    const result = await pickAndStartParse({ conversationId: ORBIT, chooseSource: jest.fn() });

    const preflight = result.kind === 'preflight' ? result.preflight : null;
    // `declared_posts` must be 1..1000, so a video-only export would otherwise
    // send 0, be answered 400 IMPORT_DECLARED_INVALID, and surface as
    // `job-terminal('CLIENT_BUG')` plus a Sentry event for an archive that is
    // simply empty of posts we can take.
    expect(preflight?.nothingToImport).toBe(true);
    expect(preflight?.importable).toBe(0);
    // Not an allowance fact: #928 renders it with the skip list, not with
    // "export a smaller date range".
    expect(preflight?.overAllowance).toBeNull();
    expect(preflight?.skippedByReason.held_video).toBe(1);
    // No session, no `declared_posts`, no terminal code, nothing reported.
    expect(mockStartImport).not.toHaveBeenCalled();
    expect(soleJob().status).toBe('cancelled');
    expect(soleJob().declared_posts).toBeNull();
    expect(mockCaptureError).not.toHaveBeenCalled();
    expect(importStore.getState().summary).toBeNull();
  });

  it('refuses to run a ready job whose counts leave nothing to submit', async () => {
    seedJob({ status: 'ready', items: 0, skips: ['held_video'] });
    await resumeImportAtLaunch();
    expect(importStore.getState().preflight?.nothingToImport).toBe(true);

    await confirmAndRunImport();
    await drain();

    expect(mockStartImport).not.toHaveBeenCalled();
    expect(mockSubmitImportBatch).not.toHaveBeenCalled();
    expect(mockCaptureError).not.toHaveBeenCalled();
    expect(jobRow().status).toBe('ready');
  });

  it('re-reads the allowance for a second import in the same app session', async () => {
    parseEmitting(1);
    await pickAndStartParse({ conversationId: ORBIT, chooseSource: jest.fn() });
    await confirmAndRunImport();
    await drain();
    expect(importStore.getState().phase).toBe('done');
    dismissImportSummary();

    // The orbit's lifetime counters have advanced by what that run created.
    mockGetGroupImports.mockResolvedValue(
      groupImports({ allowances: allowances({ facebook: allowance(1, 6208) }) }),
    );
    parseEmitting(1);

    const second = await pickAndStartParse({ conversationId: ORBIT, chooseSource: jest.fn() });

    // The session-long probe cache used to gate the second import against the
    // PRE-first-import counters, so it passed preflight and was then refused
    // at start with IMPORT_ALLOWANCE_EXCEEDED — a terminal plus a Sentry event
    // for exactly the condition the preflight exists to catch.
    const preflight = second.kind === 'preflight' ? second.preflight : null;
    expect(preflight?.allowance.postsUsed).toBe(1);
    expect(preflight?.remainingPosts).toBe(999);
    expect(preflight?.remainingBytes).toBe(2 * 1024 * 1024 * 1024 - 6208);
  });

  it('keeps created posts when the batch route reports an allowance overrun', async () => {
    seedJob({ items: 2 });
    mockSubmitImportBatch
      .mockImplementationOnce(async (_id: string, body: { items: { importKey: string }[] }) => ({
        results: [
          {
            importKey: body.items[0].importKey,
            status: 'created' as const,
            threadId: threadUuid('0'),
            createdAt: '2012-08-26T00:00:00.000Z',
          },
        ],
        allowance: allowance(1),
      }))
      .mockRejectedValue(
        new ConflictError(
          JSON.stringify({
            error: 'IMPORT_REFUSED',
            details: { code: 'IMPORT_ALLOWANCE_EXCEEDED', allowance: allowance(1000) },
          }),
        ),
      );

    await confirmAndRunLaunch();

    const summary = importStore.getState().summary;
    expect(summary?.errorCode).toBe('ALLOWANCE');
    expect(summary?.created).toBe(1);
    expect(summary?.notSubmitted).toBe(1);
    expect(jobRow().status).toBe('failed');
  });
});

// ===========================================================================
// Group: the already-in-this-orbit pre-check (#930)
// ===========================================================================

describe('the import pre-check', () => {
  /** `importKeyToWire` is mocked with real base64, so this is the wire key. */
  function wireKey(post: number): string {
    return Buffer.from(new Uint8Array(16).fill(post + 1)).toString('base64');
  }

  /** Every key the runner asked about, across every page, flattened. */
  function askedKeys(): string[] {
    return mockLookupImportKeys.mock.calls.flatMap(
      (call) => (call[1] as { importKeys: string[] }).importKeys,
    );
  }

  /**
   * An archive whose media entries are PRICED, so the byte estimate is real.
   *
   * `parseEmitting(n, {mediaPerPost: m})` names its media `entry-<post>-<m>`;
   * `declaredByEntry` only prices an entry the listing did not skip, so the
   * entries have to be declared here or every post contributes 0 bytes and the
   * byte half of the test would pass vacuously.
   */
  function pricedArchive(posts: number, mediaPerPost: number, declaredSize = 4096): void {
    mockOpenArchiveSession.mockImplementation(async () => {
      const media = [];
      for (let i = 0; i < posts; i++) {
        for (let m = 0; m < mediaPerPost; m++) {
          media.push({
            entryId: `entry-${i}-${m}`,
            path: `media/${i}-${m}.jpg`,
            kind: 'image',
            declaredSize,
            skip: null,
          });
        }
      }
      return {
        ...archiveSession(),
        entries: [FB_ENTRY, ...media],
      } as unknown as ArchiveImportSession;
    });
  }

  /** `estimateImportBytes(4096)`: ceil(4096 * 1.5) + 64. */
  const BYTES_PER_MEDIA = 6208;

  /** The counts behind one job, for the summary identity. */
  function statusCounts(): Record<string, number> {
    const rows = harness.sqlite
      .prepare('SELECT status, COUNT(*) AS n FROM import_items GROUP BY status')
      .all() as { status: string; n: number }[];
    const counts: Record<string, number> = {};
    for (const row of rows) counts[row.status] = row.n;
    return counts;
  }

  beforeEach(() => {
    // The lookup only runs when SOMETHING could match, so every case here
    // needs a non-zero `posts_used` (see the zero-used skip below).
    mockGetGroupImports.mockResolvedValue(
      groupImports({ lookupMax: 1000, allowances: allowances({ facebook: allowance(5) }) }),
    );
  });

  // -------------------------------------------------------------------------
  // 1. Everything in the archive is already here
  // -------------------------------------------------------------------------

  it('refuses an archive whose every post is already in this orbit, with no session', async () => {
    pricedArchive(3, 1);
    parseEmitting(3, { mediaPerPost: 1 });
    mockLookupImportKeys.mockResolvedValue({
      existing: [wireKey(0), wireKey(1), wireKey(2)],
    });

    const result = await pickAndStartParse({ conversationId: ORBIT, chooseSource: jest.fn() });

    const preflight = result.kind === 'preflight' ? result.preflight : null;
    expect(preflight?.alreadyPresent).toBe(3);
    expect(preflight?.alreadyPresentMedia).toBe(3);
    expect(preflight?.importable).toBe(0);
    expect(preflight?.estimatedBytes).toBe(0);
    // The EXISTING refusal arm, reached for a new reason: nothing is left to
    // declare, so `declared_posts` would have been 0 and the server would have
    // answered 400 `IMPORT_DECLARED_INVALID`.
    expect(preflight?.nothingToImport).toBe(true);
    expect(preflight?.overAllowance).toBeNull();
    // No session, no upload, no complete — the whole point of #930.
    expect(mockStartImport).not.toHaveBeenCalled();
    expect(mockUploadMedia).not.toHaveBeenCalled();
    expect(mockCompleteImportUpload).not.toHaveBeenCalled();
    expect(soleJob().status).toBe('cancelled');
    expect(soleJob().declared_posts).toBeNull();
    expect(mockReleaseArchiveParts).toHaveBeenCalledWith(['part-a']);
    expect(itemRows().every((row) => row.status === 'present')).toBe(true);
  });

  // -------------------------------------------------------------------------
  // 2. Partial overlap
  // -------------------------------------------------------------------------

  it('nets a partial overlap out of the declared posts, bytes and media phase', async () => {
    pricedArchive(4, 1);
    parseEmitting(4, { mediaPerPost: 1 });
    // K = 2 of N = 4, and deliberately not the first two: the netting is keyed
    // on the moved rows' ordinals, not on a count.
    mockLookupImportKeys.mockResolvedValue({ existing: [wireKey(0), wireKey(2)] });

    const result = await pickAndStartParse({ conversationId: ORBIT, chooseSource: jest.fn() });

    const preflight = result.kind === 'preflight' ? result.preflight : null;
    expect(preflight?.importable).toBe(2);
    expect(preflight?.alreadyPresent).toBe(2);
    expect(preflight?.alreadyPresentMedia).toBe(2);
    // The two matched posts' media is subtracted EXACTLY: 4 * 6208 - 2 * 6208.
    expect(preflight?.estimatedBytes).toBe(2 * BYTES_PER_MEDIA);
    // Both numbers are persisted as declared, which is what the session will
    // reserve.
    expect(soleJob().declared_posts).toBe(2);
    expect(soleJob().declared_bytes).toBe(2 * BYTES_PER_MEDIA);

    await confirmAndRunImport();
    await drain();

    // Only the two posts that are NOT already here are uploaded...
    expect(mockUploadMedia).toHaveBeenCalledTimes(2);
    // ...and only their keys are submitted.
    expect(askedKeys()).toHaveLength(4);
    const submitted = mockSubmitImportBatch.mock.calls.flatMap(
      (call) => (call[1] as { items: { importKey: string }[] }).items,
    );
    expect(submitted.map((item) => item.importKey).sort()).toEqual([wireKey(1), wireKey(3)].sort());

    const state = importStore.getState();
    // `total` is `declared_posts`, and the progress counters exclude `present`,
    // so the run reaches 100% rather than stalling at half.
    expect(state.total).toBe(2);
    expect(state.created).toBe(2);
    // The member is told ONE number for "already in this orbit": the server's
    // `duplicate` verdicts plus the pre-check's `present` rows.
    expect(state.summary?.created).toBe(2);
    expect(state.summary?.duplicate).toBe(2);
    expect(state.phase).toBe('done');
    expect(soleJob().status).toBe('completed');
  });

  it('keeps the summary-line identity: the lines sum to importable + present', async () => {
    pricedArchive(4, 1);
    parseEmitting(4, { mediaPerPost: 1 });
    mockLookupImportKeys.mockResolvedValue({ existing: [wireKey(0), wireKey(2)] });
    await pickAndStartParse({ conversationId: ORBIT, chooseSource: jest.fn() });

    await confirmAndRunImport();
    await drain();

    const summary = importStore.getState().summary;
    const counts = statusCounts();
    // `importableTotal`'s own opt-in sum, spelled out here so the identity is
    // computed from SQL rather than restated as a constant.
    const importableTotal =
      (counts.pending ?? 0) +
      (counts.uploading ?? 0) +
      (counts.created ?? 0) +
      (counts.duplicate ?? 0) +
      (counts.failed ?? 0);
    const lines =
      (summary?.created ?? 0) +
      (summary?.duplicate ?? 0) +
      (summary?.failed ?? 0) +
      (summary?.heldVideo ?? 0) +
      (summary?.notSubmitted ?? 0);

    // `present` is NOT in `importableTotal` — nothing can submit it — but it
    // IS on the "already in this orbit" line, so the sum the member can do in
    // their head needs that term.
    expect(lines).toBe(importableTotal + (counts.present ?? 0));
    expect(counts.present).toBe(2);
    expect(lines).toBe(4);
  });

  // -------------------------------------------------------------------------
  // 3. Every failure means "no further matches"
  // -------------------------------------------------------------------------

  it.each([
    ['a 404 from a server without the route', new NotFoundError()],
    ['a network failure', new NetworkError('offline')],
    ['a 429', rateLimited(30_000)],
    ['a 5xx', new ServerError('boom', 503)],
    // A 400 is in this list on purpose: a request shape this build gets wrong
    // must degrade to today's behaviour, never stop the member's import.
    ['a 400', new ValidationError('bad import_keys')],
  ])("falls back to today's behaviour on %s", async (_label, error) => {
    pricedArchive(2, 1);
    parseEmitting(2, { mediaPerPost: 1 });
    mockLookupImportKeys.mockRejectedValue(error);

    const result = await pickAndStartParse({ conversationId: ORBIT, chooseSource: jest.fn() });

    const preflight = result.kind === 'preflight' ? result.preflight : null;
    expect(preflight?.alreadyPresent).toBe(0);
    expect(preflight?.importable).toBe(2);
    expect(preflight?.estimatedBytes).toBe(2 * BYTES_PER_MEDIA);
    // Not a pause, not a terminal, not a Sentry event, and not a failure
    // reason: the pre-check is an OPTIMISATION, and the archive is runnable.
    expect(soleJob().status).toBe('ready');
    expect(soleJob().declared_posts).toBe(2);
    expect(importStore.getState().phase).toBe('ready');
    expect(mockCaptureError).not.toHaveBeenCalled();
  });

  it('keeps page 1 applied when page 2 fails', async () => {
    pricedArchive(4, 1);
    parseEmitting(4, { mediaPerPost: 1 });
    mockGetGroupImports.mockResolvedValue(
      groupImports({ lookupMax: 2, allowances: allowances({ facebook: allowance(5) }) }),
    );
    mockLookupImportKeys
      .mockResolvedValueOnce({ existing: [wireKey(0), wireKey(1)] })
      .mockRejectedValue(new NetworkError('offline'));

    const result = await pickAndStartParse({ conversationId: ORBIT, chooseSource: jest.fn() });

    const preflight = result.kind === 'preflight' ? result.preflight : null;
    // Pages already applied STAY applied: a post that is genuinely already in
    // the orbit is still already in the orbit.
    expect(preflight?.alreadyPresent).toBe(2);
    expect(preflight?.importable).toBe(2);
    expect(preflight?.estimatedBytes).toBe(2 * BYTES_PER_MEDIA);
    const statuses = itemRows().map((row) => row.status);
    expect(statuses).toEqual(['present', 'present', 'pending', 'pending']);
    expect(soleJob().status).toBe('ready');
  });

  // -------------------------------------------------------------------------
  // 4. The three skip conditions: no request at all
  // -------------------------------------------------------------------------

  it('asks nothing of a server that advertises no lookup_max', async () => {
    // Production until the migration-050 deploy. The flag IS the capability:
    // a guessed page size would spend a request per page to learn nothing.
    mockGetGroupImports.mockResolvedValue(
      groupImports({ allowances: allowances({ facebook: allowance(5) }) }),
    );
    pricedArchive(2, 1);
    parseEmitting(2, { mediaPerPost: 1 });

    const result = await pickAndStartParse({ conversationId: ORBIT, chooseSource: jest.fn() });

    expect(mockLookupImportKeys).not.toHaveBeenCalled();
    const preflight = result.kind === 'preflight' ? result.preflight : null;
    expect(preflight?.alreadyPresent).toBe(0);
    expect(preflight?.importable).toBe(2);
    expect(soleJob().declared_posts).toBe(2);
  });

  it.each([0, -1, 2.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'asks nothing when lookup_max is %p',
    async (lookupMax) => {
      mockGetGroupImports.mockResolvedValue(
        groupImports({ lookupMax, allowances: allowances({ facebook: allowance(5) }) }),
      );
      parseEmitting(2);

      await pickAndStartParse({ conversationId: ORBIT, chooseSource: jest.fn() });

      expect(mockLookupImportKeys).not.toHaveBeenCalled();
    },
  );

  it('asks nothing when neither source has used a post', async () => {
    // Every import thread is charged to `posts_used`, and the only refund
    // (`admin:delete-import`) DELETES the threads it refunds — so zero across
    // both buckets means this member has no import thread here to match.
    mockGetGroupImports.mockResolvedValue(groupImports({ lookupMax: 1000 }));
    parseEmitting(2);

    await pickAndStartParse({ conversationId: ORBIT, chooseSource: jest.fn() });

    expect(mockLookupImportKeys).not.toHaveBeenCalled();
    expect(importStore.getState().preflight?.alreadyPresent).toBe(0);
  });

  it('asks on the OTHER source alone having used posts', async () => {
    // Keys are not source-scoped: a key created under an Instagram session is
    // found while a Facebook archive is being parsed.
    mockGetGroupImports.mockResolvedValue(
      groupImports({ lookupMax: 1000, allowances: allowances({ instagram: allowance(3) }) }),
    );
    parseEmitting(2);

    await pickAndStartParse({ conversationId: ORBIT, chooseSource: jest.fn() });

    expect(mockLookupImportKeys).toHaveBeenCalledTimes(1);
  });

  it("asks nothing when THIS source's bucket refuses the archive even if every post matched", async () => {
    // Best case is `importable - postsUsed` (the pre-check cannot remove more
    // than this bucket has used); 300 - 200 = 100, still over the 50 left.
    mockGetGroupImports.mockResolvedValue(
      groupImports({
        lookupMax: 1000,
        allowances: allowances({
          facebook: { ...allowance(200), postsLimit: 250 },
          instagram: { ...allowance(5), postsLimit: 1000 },
        }),
      }),
    );
    parseEmitting(300);

    const result = await pickAndStartParse({ conversationId: ORBIT, chooseSource: jest.fn() });

    expect(mockLookupImportKeys).not.toHaveBeenCalled();
    // The refusal the member would have seen anyway.
    expect(result.kind === 'preflight' ? result.preflight.overAllowance : null).toBe('posts');
  });

  it("reads THIS source's bucket, not the other's, for that skip", async () => {
    // The mirror image of the case above: the TIGHT bucket is now Instagram's,
    // and this is a Facebook archive, so the skip must not fire.
    mockGetGroupImports.mockResolvedValue(
      groupImports({
        lookupMax: 1000,
        allowances: allowances({
          facebook: { ...allowance(5), postsLimit: 1000 },
          instagram: { ...allowance(200), postsLimit: 250 },
        }),
      }),
    );
    parseEmitting(300);

    await pickAndStartParse({ conversationId: ORBIT, chooseSource: jest.fn() });

    expect(mockLookupImportKeys).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // 5. Paging
  // -------------------------------------------------------------------------

  it('pages at the advertised lookup_max', async () => {
    mockGetGroupImports.mockResolvedValue(
      groupImports({ lookupMax: 2, allowances: allowances({ facebook: allowance(5) }) }),
    );
    parseEmitting(5);

    await pickAndStartParse({ conversationId: ORBIT, chooseSource: jest.fn() });

    expect(mockLookupImportKeys).toHaveBeenCalledTimes(3);
    expect(
      mockLookupImportKeys.mock.calls.map(
        (call) => (call[1] as { importKeys: string[] }).importKeys.length,
      ),
    ).toEqual([2, 2, 1]);
    // Every key exactly once, in parse order, and the orbit id from the path.
    expect(askedKeys()).toEqual([0, 1, 2, 3, 4].map(wireKey));
    expect(mockLookupImportKeys.mock.calls[0][0]).toBe(ORBIT);
  });

  // -------------------------------------------------------------------------
  // 6. Rule 0
  // -------------------------------------------------------------------------

  it('writes no row and shows no preflight when a wipe lands mid-lookup', async () => {
    parseEmitting(3);
    mockLookupImportKeys.mockImplementation(async () => {
      resetImportRunnerState();
      return { existing: [wireKey(0), wireKey(1), wireKey(2)] };
    });

    const result = await pickAndStartParse({ conversationId: ORBIT, chooseSource: jest.fn() });

    // Rule 0: the account that asked is gone, so nothing may be written for it
    // and nothing may be said to the next one. The job ROW is deliberately not
    // deleted here either — `deleteAllImportJobs` is the wipe's own job, and
    // reaching for the DB after the token moved is exactly what rule 0 forbids.
    expect(result.kind).toBe('cancelled');
    expect(itemRows().every((row) => row.status === 'pending')).toBe(true);
    expect(importStore.getState().preflight).toBeNull();
    expect(soleJob().declared_posts).toBeNull();
  });

  it('aborts the request with the parse, and passes the signal through', async () => {
    parseEmitting(2);

    await pickAndStartParse({ conversationId: ORBIT, chooseSource: jest.fn() });

    const signal = mockLookupImportKeys.mock.calls[0][2] as AbortSignal;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal.aborted).toBe(false);
  });

  // -------------------------------------------------------------------------
  // 7. The response is untrusted shape
  // -------------------------------------------------------------------------

  it('ignores unknown, non-string and non-array entries in the answer', async () => {
    pricedArchive(2, 1);
    parseEmitting(2, { mediaPerPost: 1 });
    mockLookupImportKeys.mockResolvedValue({
      existing: [
        // A key this page never sent: the server does not get to name which
        // local rows are mutated.
        Buffer.from(new Uint8Array(16).fill(0x5a)).toString('base64'),
        null,
        42,
        { importKey: wireKey(0) },
        wireKey(1),
      ],
    });

    const result = await pickAndStartParse({ conversationId: ORBIT, chooseSource: jest.fn() });

    const preflight = result.kind === 'preflight' ? result.preflight : null;
    expect(preflight?.alreadyPresent).toBe(1);
    expect(preflight?.importable).toBe(1);
    expect(itemRows().map((row) => row.status)).toEqual(['pending', 'present']);
  });

  it('applies nothing for a non-array existing', async () => {
    parseEmitting(2);
    mockLookupImportKeys.mockResolvedValue({ existing: 'nope' });

    const result = await pickAndStartParse({ conversationId: ORBIT, chooseSource: jest.fn() });

    expect(result.kind === 'preflight' ? result.preflight.alreadyPresent : null).toBe(0);
    expect(itemRows().every((row) => row.status === 'pending')).toBe(true);
  });

  // -------------------------------------------------------------------------
  // The rebuild paths
  // -------------------------------------------------------------------------

  it('recovers the already-present count from SQLite on a launch rebuild', async () => {
    parseEmitting(3);
    mockLookupImportKeys.mockResolvedValue({ existing: [wireKey(0)] });
    await pickAndStartParse({ conversationId: ORBIT, chooseSource: jest.fn() });
    resetImportRunnerForTesting();

    await resumeImportAtLaunch();

    const preflight = importStore.getState().preflight;
    // The `present` ROWS are persisted, so the count survives a relaunch...
    expect(preflight?.alreadyPresent).toBe(1);
    // ...but the per-post media count was derived from the archive's central
    // directory during the parse and is not, so the photo line falls back to
    // gross.
    expect(preflight?.alreadyPresentMedia).toBe(0);
    // `declared_posts` was already netted before it was persisted: a rebuild
    // must not net it a second time.
    expect(preflight?.importable).toBe(2);
  });

  it('preserves both already-present numbers through closeOtherImport', async () => {
    const OTHER_ID = '99999999-8888-4777-8666-555555555555';
    mockGetGroupImports.mockResolvedValue(
      groupImports({
        lookupMax: 1000,
        allowances: allowances({ facebook: allowance(5) }),
        openImport: openImport({ importId: OTHER_ID, source: 'instagram' }),
      }),
    );
    pricedArchive(3, 2);
    parseEmitting(3, { mediaPerPost: 2 });
    mockLookupImportKeys.mockResolvedValue({ existing: [wireKey(0)] });
    await pickAndStartParse({ conversationId: ORBIT, chooseSource: jest.fn() });
    expect(importStore.getState().preflight?.alreadyPresent).toBe(1);
    mockGetGroupImports.mockResolvedValue(
      groupImports({ lookupMax: 1000, allowances: allowances({ facebook: allowance(5) }) }),
    );

    await expect(closeOtherImport()).resolves.toBe('closed');

    const preflight = importStore.getState().preflight;
    // Both are CAPTURED at call time, like the summary beside them: the
    // pre-check's verdict is a parse-time fact about this archive, and closing
    // someone else's session says nothing about it. Re-deriving them here
    // would drop the "already in this orbit" line and inflate the photo count
    // back to gross on a screen that is only being repriced.
    expect(preflight?.alreadyPresent).toBe(1);
    expect(preflight?.alreadyPresentMedia).toBe(2);
    expect(preflight?.otherOpenImport).toBeNull();
    expect(preflight?.importable).toBe(2);
  });
});

// ===========================================================================
// Group: Reset / wipe (§4.13)
// ===========================================================================

describe('reset and wipe', () => {
  it('writes nothing and captures nothing when a wipe lands mid-batch', async () => {
    seedJob({ items: 2 });
    mockSubmitImportBatch.mockImplementation(async () => {
      resetImportRunnerState();
      throw new NetworkError('socket closed by the wipe');
    });

    await confirmAndRunLaunch();

    expect(jobRow().status).toBe('in_progress');
    expect(importStore.getState().summary).toBeNull();
    expect(importStore.getState().phase).toBe('hydrating');
    expect(mockCaptureError).not.toHaveBeenCalled();
    expect(mockCompleteImport).not.toHaveBeenCalled();
  });

  it('leaves the job untouched and releases the staging file once on a mid-extract wipe', async () => {
    seedJob({ items: 1, bookmark: ['part-a'], mediaEntryIds: ['entry-0-0'] });
    mockUploadMedia.mockImplementation(async () => {
      resetImportRunnerState();
      throw new Error('aborted');
    });

    await confirmAndRunLaunch();

    expect(releases).toBe(1);
    expect(jobRow().status).toBe('in_progress');
    expect(itemRows()[0].status).toBe('pending');
    expect(mockCaptureError).not.toHaveBeenCalled();
  });

  it('leaves no timer and no AppState listener behind, and the store idle', async () => {
    seedJob({ items: 1 });
    mockSubmitImportBatch.mockRejectedValue(rateLimited(5_000));
    void resumeImportAtLaunch();
    await drain();
    expect(importStore.getState().pauseCauses).toEqual(['rate_limited']);

    resetImportRunnerState();

    expect(appStateRemove).toHaveBeenCalledTimes(1);
    expect(importStore.getState()).toEqual(
      expect.objectContaining({ phase: 'hydrating', pauseCauses: [], summary: null }),
    );
    // A released waiter must not resurrect the run.
    await drain();
    expect(jobRow().status).toBe('in_progress');
  });

  it('closes the key session and the archive session synchronously', async () => {
    seedJob({ items: 1, bookmark: ['part-a'], mediaEntryIds: ['entry-0-0'] });
    mockUploadMedia.mockImplementation(() => new Promise(() => {}));
    void resumeImportAtLaunch();
    await drain();
    expect(mockKeySessions).toHaveLength(1);

    resetImportRunnerState();

    expect(mockKeySessions[0].closed).toBe(1);
    expect(archiveCloses).toBe(1);
  });

  it('clears the availability cache, so the next account re-probes', async () => {
    await probeImportAvailability(ORBIT);
    expect(mockGetGroupImports).toHaveBeenCalledTimes(1);

    resetImportRunnerState();
    await probeImportAvailability(ORBIT);

    expect(mockGetGroupImports).toHaveBeenCalledTimes(2);
  });

  it('still writes a terminal status and a summary for a user CANCEL', async () => {
    seedJob({ items: 2 });
    mockSubmitImportBatch.mockImplementation(async () => {
      cancelImport();
      throw new NetworkError('cancelled');
    });

    await confirmAndRunLaunch();

    expect(jobRow().status).toBe('cancelled');
    expect(importStore.getState().summary?.cancelled).toBe(true);
    // A cancel takes the SAME completion path (§4.12): the session is still
    // open, and its `declared_bytes` would be reserved against the orbit's
    // quota — refusing other members' uploads — until B#318's GC reaps it up
    // to six hours later.
    expect(mockCompleteImport).toHaveBeenCalledWith(IMPORT_ID);
    expect(importStore.getState().summary?.errorCode).toBeNull();
  });

  it('completes the server session on a TERMINAL run too, keeping its own code', async () => {
    seedJob({ items: 2 });
    mockSubmitImportBatch.mockRejectedValue(
      new ConflictError(
        JSON.stringify({
          error: 'IMPORT_REFUSED',
          details: { code: 'IMPORT_ALLOWANCE_EXCEEDED', allowance: allowance(1000) },
        }),
      ),
    );

    await confirmAndRunLaunch();

    expect(jobRow().status).toBe('failed');
    expect(mockCompleteImport).toHaveBeenCalledWith(IMPORT_ID);
    // The reason the RUN stopped is the one the member is shown; a `complete`
    // that answers 409 afterwards cannot overwrite it.
    expect(importStore.getState().summary?.errorCode).toBe('ALLOWANCE');
  });

  it('makes no network call at all when the run was RESET, not cancelled', async () => {
    seedJob({ items: 2 });
    mockSubmitImportBatch.mockImplementation(async () => {
      resetImportRunnerState();
      throw new NetworkError('socket closed by the wipe');
    });

    await confirmAndRunLaunch();

    // Rule 0: a logout or a wipe writes nothing and sends nothing — not even
    // the courtesy `complete` every other settled run now sends.
    expect(mockCompleteImport).not.toHaveBeenCalled();
    expect(jobRow().status).toBe('in_progress');
  });
});

// ===========================================================================
// Group: Pause / wake (§4.3.1)
// ===========================================================================

describe('pause causes and their wake-ups', () => {
  it('pauses on a 429 and never fails the item', async () => {
    seedJob({ items: 1 });
    mockSubmitImportBatch.mockRejectedValueOnce(rateLimited(5_000));

    void resumeImportAtLaunch();
    await drain();

    const state = importStore.getState();
    expect(state.phase).toBe('paused');
    expect(state.pauseCauses).toEqual(['rate_limited']);
    expect(state.resumeAtMs).not.toBeNull();
    // "The item stays QUEUED, no retry budget spent": the claim went back, so
    // the row is `pending` again and the wake-up finds it.
    expect(itemRows()[0].status).toBe('pending');
    expect(itemRows()[0].error_code).toBeNull();
  });

  it('resumes when the Retry-After elapses, and the item is created', async () => {
    jest.useFakeTimers();
    try {
      seedJob({ items: 1 });
      mockSubmitImportBatch.mockRejectedValueOnce(rateLimited(5_000));

      const running = resumeImportAtLaunch();
      running.catch(() => {
        // Attached BEFORE the clock moves (#834 discipline).
      });
      await flushMicrotasks();
      expect(importStore.getState().pauseCauses).toEqual(['rate_limited']);

      jest.advanceTimersByTime(5_000);
      await flushMicrotasks();
      await running;

      expect(itemRows()[0].status).toBe('created');
      expect(jobRow().status).toBe('completed');
    } finally {
      jest.useRealTimers();
    }
  });

  it('pauses on key_pending and gives up with KEY_PENDING once the budget is spent', async () => {
    jest.useFakeTimers();
    try {
      seedJob({ items: 1 });
      mockPinError = new Error('pending wrap');
      mockClassifyCryptoError.mockReturnValue('retryable-pause');

      const running = resumeImportAtLaunch();
      running.catch(() => {});
      await flushMicrotasks();
      expect(importStore.getState().pauseCauses).toEqual(['key_pending']);

      // Six waits, then the seventh classification has no budget left.
      for (let i = 0; i < 7; i++) {
        jest.advanceTimersByTime(30_000);
        await flushMicrotasks();
      }
      await running;

      expect(importStore.getState().summary?.errorCode).toBe('KEY_PENDING');
      expect(jobRow().status).toBe('failed');
    } finally {
      jest.useRealTimers();
    }
  });

  it('pauses on a retryable archive failure, and resumeImport() short-circuits the ladder', async () => {
    seedJob({ items: 1, bookmark: ['part-a'], mediaEntryIds: ['entry-0-0'] });
    mockOpenArchiveSession
      .mockImplementationOnce(async () => {
        throw new ArchiveReaderError('ARCHIVE_READ_FAILED');
      })
      .mockImplementation(async () => archiveSession());

    const running = resumeImportAtLaunch();
    running.catch(() => {});
    await drain();
    expect(importStore.getState().pauseCauses).toEqual(['archive_retry']);

    resumeImport();
    await running;

    expect(importStore.getState().phase).toBe('done');
    expect(itemRows()[0].status).toBe('created');
  });

  it('resumes a network pause when the app comes to the foreground', async () => {
    seedJob({ items: 1, bookmark: ['part-a'], mediaEntryIds: ['entry-0-0'] });
    // `media-chunk` is the one stage with NO outer ladder — `uploadMedia`
    // already spent its three attempts, and each outer retry would
    // re-extract, re-sanitize and re-encrypt the whole file.
    mockUploadMedia
      .mockRejectedValueOnce(new NetworkError('offline'))
      .mockResolvedValue({ mediaId: 'media-0' });

    const running = resumeImportAtLaunch();
    running.catch(() => {});
    await drain();
    expect(importStore.getState().pauseCauses).toEqual(['network']);
    expect(mockUploadMedia).toHaveBeenCalledTimes(1);

    appStateHandler?.('active');
    await running;

    expect(itemRows()[0].status).toBe('created');
  });

  it('retries ARCHIVE_BUSY in place without ever pausing', async () => {
    seedJob({ items: 1, bookmark: ['part-a'], mediaEntryIds: ['entry-0-0'] });
    let busy = 0;
    mockUploadMedia.mockImplementation(async () => {
      if (busy++ < 2) throw new ArchiveReaderError('ARCHIVE_BUSY');
      return { mediaId: 'media-0' };
    });

    await confirmAndRunLaunch();

    expect(busy).toBe(3);
    expect(importStore.getState().summary?.created).toBe(1);
    // Never published a pause: the store went straight from running to done.
    expect(pauseCauseHistory).not.toContain('archive_retry');
  });

  it('pauses in the background, but a runner-invoked picker does not', async () => {
    seedJob({ items: 1, bookmark: ['part-a'], mediaEntryIds: ['entry-0-0'] });
    mockUploadMedia.mockImplementation(() => new Promise(() => {}));
    void resumeImportAtLaunch();
    await drain();

    appStateHandler?.('background');
    expect(importStore.getState().pauseCauses).toEqual(['background']);
    appStateHandler?.('active');
    expect(importStore.getState().pauseCauses).toEqual([]);

    // Our own picker: SAF takes the foreground and RN emits 'background'.
    let resolvePick: (v: unknown) => void = () => {};
    mockPickArchiveParts.mockImplementation(() => new Promise((r) => (resolvePick = r)));
    const repick = repickArchiveParts();
    await drain(2);
    appStateHandler?.('background');
    expect(importStore.getState().pauseCauses).toEqual([]);
    resolvePick(null);
    await expect(repick).resolves.toBe('cancelled');
  });

  it('keeps needs_repick above background, and returning from the picker does not resume', async () => {
    seedJob({ items: 1, mediaEntryIds: ['entry-0-0'] });
    // No bookmark at all and media still to upload: only a re-pick can help.
    const running = resumeImportAtLaunch();
    running.catch(() => {});
    await drain();
    // The published pause SET is the only source: the re-pick prompt keys on
    // `pauseCauses[0]`, and the old `needsRepick` mirror had no consumer.
    expect(importStore.getState().pauseCauses).toEqual(['needs_repick']);

    appStateHandler?.('background');
    expect(importStore.getState().pauseCauses).toEqual(['needs_repick', 'background']);
    appStateHandler?.('active');

    // `background` cleared; the run stays paused because the set is not empty.
    expect(importStore.getState().pauseCauses).toEqual(['needs_repick']);
    expect(importStore.getState().phase).toBe('paused');
    expect(mockUploadMedia).not.toHaveBeenCalled();
  });

  it('does not clear needs_repick or background from resumeImport()', async () => {
    seedJob({ items: 1, mediaEntryIds: ['entry-0-0'] });
    const running = resumeImportAtLaunch();
    running.catch(() => {});
    await drain();
    appStateHandler?.('background');

    resumeImport();

    expect(importStore.getState().pauseCauses).toEqual(['needs_repick', 'background']);
  });
});

// ===========================================================================
// Group: Re-pick (§4.2)
// ===========================================================================

describe('re-picking the archive', () => {
  it('resumes the run when the same archive is re-picked', async () => {
    seedJob({ items: 1, mediaEntryIds: ['entry-0-0'] });
    const running = resumeImportAtLaunch();
    running.catch(() => {});
    await drain();
    expect(importStore.getState().pauseCauses).toEqual(['needs_repick']);

    mockPickArchiveParts.mockResolvedValue(['part-a']);
    const outcome = await repickArchiveParts();

    expect(outcome).toBe('resumed');
    // Read BEFORE the run settles: `finishImportJob` NULLs the bookmark in the
    // same UPDATE that makes the job terminal.
    expect(jobRow().archive_bookmark).toBe(JSON.stringify(['part-a']));

    await running;
    expect(itemRows()[0].status).toBe('created');
  });

  it('restarts the job for a modified archive and never reuses stored entry ids', async () => {
    seedJob({ items: 1, bookmark: ['part-a'], mediaEntryIds: ['entry-0-0'] });
    mockOpenArchiveSession.mockImplementation(async () => {
      throw new ArchiveReaderError('ARCHIVE_CHANGED');
    });
    const running = resumeImportAtLaunch();
    running.catch(() => {});
    await drain();
    expect(importStore.getState().pauseCauses).toEqual(['needs_repick']);

    const outcome = await repickArchiveParts();
    await running;

    expect(outcome).toBe('different-archive');
    expect(getImportJob(JOB)).toBeNull();
    expect(mockReleaseArchiveParts).toHaveBeenCalledWith(['part-a']);
    expect(mockUploadMedia).not.toHaveBeenCalled();
    expect(importStore.getState().phase).toBe('idle');
  });

  it('is terminal, keeping created posts, when the archive is lost after a post was created', async () => {
    seedJob({ items: 2, bookmark: ['part-a'], mediaEntryIds: ['entry-0-0'] });
    // The text-only item is created first; then the archive is gone.
    harness.sqlite
      .prepare(
        "UPDATE import_items SET status = 'created', thread_id = 't', body = NULL WHERE id = ?",
      )
      .run('item-1');
    mockOpenArchiveSession.mockImplementation(async () => {
      throw new ArchiveReaderError('ARCHIVE_ACCESS_LOST');
    });

    await confirmAndRunLaunch();

    expect(importStore.getState().summary?.errorCode).toBe('ARCHIVE');
    expect(importStore.getState().pauseCauses).toEqual([]);
    expect(itemRows().find((row) => row.id === 'item-1')?.status).toBe('created');
    expect(jobRow().status).toBe('failed');
  });

  it('answers cancelled when the member backs out of the picker', async () => {
    seedJob({ items: 1, mediaEntryIds: ['entry-0-0'] });
    const running = resumeImportAtLaunch();
    running.catch(() => {});
    await drain();

    mockPickArchiveParts.mockResolvedValue(null);
    await expect(repickArchiveParts()).resolves.toBe('cancelled');
    expect(importStore.getState().pauseCauses).toEqual(['needs_repick']);
  });
});

// ===========================================================================
// Group: Session (§4.7)
// ===========================================================================

describe('the server session', () => {
  it('restarts an abandoned session and resubmits', async () => {
    seedJob({ items: 1 });
    const closed = new ConflictError(
      JSON.stringify({
        error: 'IMPORT_REFUSED',
        details: { code: 'IMPORT_CLOSED', status: 'abandoned' },
      }),
    );
    mockSubmitImportBatch.mockRejectedValueOnce(closed);
    mockStartImport.mockResolvedValue({
      importId: 'import-2',
      status: 'open',
      declaredPosts: 1,
      declaredBytes: 4096,
      allowance: allowance(),
      limits: LIMITS,
    });

    await confirmAndRunLaunch();

    expect(mockStartImport).toHaveBeenCalledTimes(1);
    expect(mockSubmitImportBatch).toHaveBeenCalledTimes(2);
    expect(mockSubmitImportBatch.mock.calls[1][0]).toBe('import-2');
    expect(itemRows()[0].status).toBe('created');
    expect(mockCompleteImport).toHaveBeenCalledWith('import-2');
  });

  it('reaches a network pause instead of looping when the restart is offline', async () => {
    jest.useFakeTimers();
    try {
      seedJob({ items: 1 });
      mockSubmitImportBatch.mockRejectedValue(
        new ConflictError(
          JSON.stringify({
            error: 'IMPORT_REFUSED',
            details: { code: 'IMPORT_CLOSED', status: 'abandoned' },
          }),
        ),
      );
      mockStartImport.mockRejectedValue(new NetworkError('offline'));

      const running = resumeImportAtLaunch();
      running.catch(() => {
        // Attached BEFORE the clock moves (#834 discipline).
      });
      await flushMicrotasks();

      // The start call's own ladder, spent inside the restart: 1 s, 2 s, 4 s.
      for (const ms of [1_000, 2_000, 4_000]) {
        jest.advanceTimersByTime(ms);
        await flushMicrotasks();
      }

      // A `retry-same-call` verdict on the start call used to be reported as
      // "the session was restarted", so the batch was re-POSTed at the dead
      // session, answered IMPORT_CLOSED, and restarted again — a ~1 s loop for
      // as long as the device was offline, which no budget could see because
      // the inner loops passed no attempt counter.
      expect(mockStartImport).toHaveBeenCalledTimes(4);
      expect(importStore.getState().pauseCauses).toEqual(['network']);
      expect(importStore.getState().phase).toBe('paused');
      // The claim went back, so the wake-up finds the item.
      expect(itemRows()[0].status).toBe('pending');
      expect(jobRow().status).toBe('in_progress');
      expect(mockCaptureError).not.toHaveBeenCalled();

      resetImportRunnerState();
      await flushMicrotasks();
      await running;
    } finally {
      jest.useRealTimers();
    }
  });

  it('refuses to adopt the session id it already holds', async () => {
    seedJob({ status: 'ready', items: 1 });
    mockStartImport.mockRejectedValue(
      new ConflictError(
        JSON.stringify({
          error: 'IMPORT_REFUSED',
          details: { code: 'IMPORT_IN_PROGRESS', import_id: IMPORT_ID, source: 'facebook' },
        }),
      ),
    );
    mockGetGroupImports.mockResolvedValue(groupImports({ openImport: openImport() }));
    // The preflight adopts that id, the batch is refused as closed, and the
    // restart is answered with the SAME id: nothing new was learned, and
    // answering `retry` for it would re-POST as fast as the loop can go.
    mockSubmitImportBatch.mockRejectedValue(
      new ConflictError(
        JSON.stringify({
          error: 'IMPORT_REFUSED',
          details: { code: 'IMPORT_CLOSED', status: 'abandoned' },
        }),
      ),
    );

    await resumeImportAtLaunch();
    await confirmAndRunImport();
    await drain();

    expect(importStore.getState().summary?.errorCode).toBe('REFUSED');
    expect(jobRow().status).toBe('failed');
    expect(mockSubmitImportBatch).toHaveBeenCalledTimes(1);
  });

  it('adopts the member open session rather than starting a second one', async () => {
    seedJob({ status: 'ready', items: 1 });
    mockGetGroupImports.mockResolvedValue(
      groupImports({ openImport: openImport({ importId: 'import-open' }) }),
    );

    await resumeImportAtLaunch();
    await confirmAndRunImport();
    await drain();

    expect(mockStartImport).not.toHaveBeenCalled();
    expect(jobRow().session_id).toBe('import-open');
    expect(mockSubmitImportBatch.mock.calls[0][0]).toBe('import-open');
  });

  it('does not re-upload media the previous run finished', async () => {
    seedJob({ items: 1, bookmark: ['part-a'], mediaEntryIds: ['entry-0-0', 'entry-0-1'] });
    harness.sqlite
      .prepare("UPDATE import_item_media SET upload_state = 'uploaded' WHERE ordinal = 0")
      .run();

    await confirmAndRunLaunch();

    expect(mockUploadMedia).toHaveBeenCalledTimes(1);
    expect(
      (mockUploadMedia.mock.calls[0][0] as { import: { mediaId: string } }).import.mediaId,
    ).toBe('media-1');
    expect(itemRows()[0].status).toBe('created');
  });

  it('finishes locally when the server already completed the session', async () => {
    seedJob({ items: 1 });
    mockGetImportSession.mockResolvedValue({
      importId: IMPORT_ID,
      groupId: ORBIT,
      status: 'completed',
      declaredPosts: 1,
      declaredBytes: 4096,
      createdPosts: 1,
      createdAt: '2012-08-26T00:00:00.000Z',
      lastActivityAt: '2012-08-26T00:00:00.000Z',
      completedAt: '2012-08-26T01:00:00.000Z',
      allowance: allowance(1),
      limits: LIMITS,
    });

    await confirmAndRunLaunch();

    expect(mockSubmitImportBatch).not.toHaveBeenCalled();
    expect(mockCompleteImport).not.toHaveBeenCalled();
    expect(jobRow().status).toBe('completed');
    expect(importStore.getState().summary?.errorCode).toBeNull();
  });

  it('is terminal on a 403 from the per-session GET', async () => {
    seedJob({ items: 1 });
    mockGetImportSession.mockRejectedValue(new AuthError(403, undefined));

    await confirmAndRunLaunch();

    expect(jobRow().status).toBe('failed');
    expect(importStore.getState().summary?.errorCode).toBe('FORBIDDEN');
  });

  it('is terminal when imports are not available on this server', async () => {
    seedJob({ items: 1 });
    mockGetImportSession.mockRejectedValue(new NotFoundError());

    await confirmAndRunLaunch();

    expect(importStore.getState().summary?.errorCode).toBe('IMPORTS_UNAVAILABLE');
  });

  it('refetches the orbit threads once the run completes', async () => {
    seedJob({ items: 1 });

    await confirmAndRunLaunch();

    expect(mockLoadThreadsForGroup).toHaveBeenCalledWith(ORBIT);
  });

  it('asks peers to fulfil pending wraps without awaiting them', async () => {
    seedJob({ items: 1 });
    mockFulfillPendingWraps.mockReturnValue(Promise.reject(new Error('403 pending member')));

    await confirmAndRunLaunch();

    expect(mockFulfillPendingWraps).toHaveBeenCalledTimes(1);
    expect(jobRow().status).toBe('completed');
  });
});

// ===========================================================================
// Group: Dropped verdicts (#993 fold round)
// ===========================================================================

/**
 * `terminalStatusFor` answers `completed` for ANY run that reaches
 * {@link settleRun} with no terminal code, so every caller that drops a
 * non-terminal verdict reports a failed import as a success. Four of them did.
 * These are the four, plus the fail-safe that catches the fifth.
 */
describe('a verdict that is dropped rather than acted on', () => {
  it('spends the start ladder in-frame and pauses, instead of reporting success', async () => {
    jest.useFakeTimers();
    try {
      seedJob({ status: 'ready', items: 1 });
      mockStartImport.mockRejectedValue(new NetworkError('offline'));

      await resumeImportAtLaunch();
      const running = confirmAndRunImport();
      running.catch(() => {
        // Attached BEFORE the clock moves (#834 discipline).
      });
      await flushMicrotasks();

      // The start call's own ladder, spent inside the gate: 1 s, 2 s, 4 s.
      for (const ms of [1_000, 2_000, 4_000]) {
        jest.advanceTimersByTime(ms);
        await flushMicrotasks();
      }

      // `retry-same-call` used to be reported to `runJob` as "no session", one
      // start call deep, and `settleRun` then finished the job `completed` with
      // both items pending and no Sentry event.
      expect(mockStartImport).toHaveBeenCalledTimes(4);
      expect(importStore.getState().phase).toBe('paused');
      expect(importStore.getState().pauseCauses).toEqual(['network']);
      // The job row is untouched: a pause is not a settle.
      expect(jobRow().status).toBe('ready');
      expect(jobRow().session_id).toBeNull();
      expect(itemRows()[0].status).toBe('pending');
      expect(mockCompleteImport).not.toHaveBeenCalled();
      expect(mockCaptureError).not.toHaveBeenCalled();
      expect(importStore.getState().summary).toBeNull();

      resetImportRunnerState();
      await flushMicrotasks();
      await running;
    } finally {
      jest.useRealTimers();
    }
  });

  it('pauses on a 429 at the preflight GET, with no session started', async () => {
    seedJob({ status: 'ready', items: 1 });
    let gets = 0;
    // The first GET is the preflight rebuild #928 is shown; the run's own is
    // the one that is rate-limited. A `mockRejectedValueOnce` queue here would
    // leak into the next test.
    mockGetGroupImports.mockImplementation(async () => {
      gets += 1;
      if (gets === 1) return groupImports();
      throw rateLimited(60_000);
    });

    await resumeImportAtLaunch();
    void confirmAndRunImport();
    await drain();

    expect(importStore.getState().phase).toBe('paused');
    expect(importStore.getState().pauseCauses).toEqual(['rate_limited']);
    expect(mockStartImport).not.toHaveBeenCalled();
    expect(jobRow().status).toBe('ready');
    expect(jobRow().session_id).toBeNull();
    expect(itemRows()[0].status).toBe('pending');
    expect(mockCompleteImport).not.toHaveBeenCalled();
    expect(mockCaptureError).not.toHaveBeenCalled();
    expect(importStore.getState().summary).toBeNull();
  });

  it.each([
    ['a TypeError', () => new TypeError('getPendingImportItems is not a function')],
    ['a NetworkError', () => new NetworkError('offline')],
  ])('ends the run as CLIENT_BUG when %s escapes the pump', async (_label, make) => {
    const repository = require('../../../database/repositories/importRepository');
    const spy = jest
      .spyOn(repository, 'getPendingImportItems')
      .mockImplementationOnce((): never => {
        throw make();
      });
    try {
      seedJob({ items: 2 });

      await confirmAndRunLaunch();

      // `runJob`'s catch classified the throw and threw the STEP away: an
      // unexpected error at the pump level answers `item-failed` with no item
      // id, which is `continue`, which left `terminal` null — so the job was
      // finished `completed`, `complete` was POSTed (ending the session the
      // items would have been resumed into) and nothing was reported.
      expect(jobRow().status).toBe('failed');
      expect(importStore.getState().summary?.errorCode).toBe('CLIENT_BUG');
      expect(mockCaptureError).toHaveBeenCalledTimes(1);
      // `failed` is NOT resumable, and the rows below are what says so:
      // `finishImportJob` NULLs the body of every item that is not
      // `created`/`duplicate`, and `failed` is outside `ACTIVE_STATUSES`, so
      // no launch path re-enters this job. Recovery is picking the archive
      // again — which re-parses, and brings the posts this run DID create
      // back as `duplicate`. What `failed` buys is an honest summary and one
      // Sentry event naming the seam, never a requeue.
      expect(itemRows().every((row) => row.status === 'pending')).toBe(true);
      expect(unsentBodies()).toEqual([null, null]);
      expect(importStore.getState().summary?.notSubmitted).toBe(2);
    } finally {
      spy.mockRestore();
    }
  });

  it('never reports a completed import for a session it could not persist', async () => {
    seedJob({ status: 'ready', items: 2 });
    // `startImportJob` writes the session id only while the job is `ready`
    // (it is the one moment the column is writable), so an `in_progress` job
    // with no session id makes that write fail and the gate stop with no
    // verdict of its own. The fail-safe is what keeps that off the happy path.
    harness.sqlite.prepare("UPDATE import_jobs SET status = 'in_progress' WHERE id = ?").run(JOB);

    await confirmAndRunLaunch();

    expect(mockStartImport).toHaveBeenCalledTimes(1);
    expect(jobRow().session_id).toBeNull();
    expect(jobRow().status).toBe('failed');
    expect(importStore.getState().summary?.errorCode).toBe('CLIENT_BUG');
    expect(itemRows().every((row) => row.status === 'pending')).toBe(true);
    expect(mockSubmitImportBatch).not.toHaveBeenCalled();
    expect(mockCompleteImport).not.toHaveBeenCalled();
    expect(mockCaptureError).toHaveBeenCalledTimes(1);
  });

  it('settles completed on the MEDIA path when the server says the session is finished', async () => {
    seedJob({ items: 1, bookmark: ['part-a'], mediaEntryIds: ['entry-0-0'] });
    mockUploadMedia.mockRejectedValue(
      new ImportMediaStagedError(
        new ConflictError(
          JSON.stringify({
            error: 'IMPORT_REFUSED',
            details: { code: 'IMPORT_CLOSED', status: 'completed' },
          }),
        ),
      ),
    );

    await confirmAndRunLaunch();

    // `finish-completed` is reachable from the media routes as well as the
    // batch one (§1.4 C4). Dropping the step there left the pump cycling until
    // the no-progress guard called it a CLIENT_BUG, where the batch path for
    // the same answer settled `completed`.
    expect(jobRow().status).toBe('completed');
    expect(importStore.getState().summary?.errorCode).toBeNull();
    expect(mockCaptureError).not.toHaveBeenCalled();
    expect(mockUploadMedia).toHaveBeenCalledTimes(1);
  });

  it('does not wait for the courtesy complete on the cancelled path', async () => {
    seedJob({ items: 1 });
    // Offline, the transport takes 15 s to give up. The member asked to stop.
    mockCompleteImport.mockImplementation(() => new Promise(() => {}));
    mockSubmitImportBatch.mockImplementation(async () => {
      cancelImport();
      throw new NetworkError('cancelled');
    });

    await confirmAndRunLaunch();

    // Still sent — `declared_bytes` is a lien on the ORBIT until B#318's GC —
    // but not awaited.
    expect(mockCompleteImport).toHaveBeenCalledWith(IMPORT_ID);
    expect(importStore.getState().phase).toBe('done');
    expect(importStore.getState().summary?.cancelled).toBe(true);
    expect(jobRow().status).toBe('cancelled');
  });
});

// ===========================================================================
// Group: Batch (§4.16)
// ===========================================================================

describe('batch failures inside a run', () => {
  /** An `in_progress` session GET that advertises a smaller `batch_max`. */
  function sessionWithBatchMax(batchMax: number): void {
    mockGetImportSession.mockResolvedValue({
      importId: IMPORT_ID,
      groupId: ORBIT,
      status: 'open',
      declaredPosts: 2,
      declaredBytes: 4096,
      createdPosts: 0,
      createdAt: '2012-08-26T00:00:00.000Z',
      lastActivityAt: '2012-08-26T00:00:00.000Z',
      completedAt: null,
      allowance: allowance(),
      limits: { ...LIMITS, batchMax },
    });
  }

  it.each([
    [
      'IMPORT_BATCH_TOO_LARGE',
      () =>
        new ValidationError(
          400,
          JSON.stringify({
            error: 'VALIDATION_ERROR',
            details: { code: 'IMPORT_BATCH_TOO_LARGE' },
          }),
        ),
    ],
    // A BARE 413 is the app-wide `express.json({limit:'10mb'})` refusing the
    // body (F3), which on this route means "halve", not "the orbit is full".
    ['a bare 413', () => new QuotaExceededError()],
  ])('halves twice on %s, then fails the single item and carries on', async (_label, make) => {
    seedJob({ items: 2 });
    sessionWithBatchMax(4);
    mockSubmitImportBatch.mockRejectedValue(make());

    await confirmAndRunLaunch();

    // 4 → both items, 2 → both items, 1 → one item, and at the floor the item
    // that cannot be made smaller is charged locally. Then the SECOND item is
    // sent on its own and goes the same way: the run never stops.
    expect(mockSubmitImportBatch).toHaveBeenCalledTimes(4);
    expect(
      mockSubmitImportBatch.mock.calls.map((call) => (call[1] as { items: [] }).items.length),
    ).toEqual([2, 2, 1, 1]);
    expect(itemRows()).toEqual([
      { id: 'item-0', status: 'failed', error_code: 'IMPORT_ITEM_TOO_LARGE' },
      { id: 'item-1', status: 'failed', error_code: 'IMPORT_ITEM_TOO_LARGE' },
    ]);
    const summary = importStore.getState().summary;
    expect(summary?.errorCode).toBeNull();
    expect(summary?.failed).toBe(2);
    expect(summary?.notSubmitted).toBe(0);
    expect(jobRow().status).toBe('completed');
  });

  it('writes IMPORT_RESULT_UNKNOWN for a rejected code this build does not know', async () => {
    seedJob({ items: 2 });
    mockSubmitImportBatch.mockImplementation(
      async (_id: string, body: { items: { importKey: string }[] }) => ({
        results: [
          { importKey: body.items[0].importKey, status: 'rejected', code: 'IMPORT_SOMETHING_NEW' },
          {
            importKey: body.items[1].importKey,
            status: 'created',
            threadId: threadUuid('1'),
            createdAt: '2012-08-26T00:00:00.000Z',
          },
        ],
        allowance: allowance(1),
      }),
    );

    await confirmAndRunLaunch();

    // The allowlist is what keeps a widened server vocabulary out of
    // `import_items.error_code`, and so out of #927's per-code copy table.
    expect(itemRows()).toEqual([
      { id: 'item-0', status: 'failed', error_code: 'IMPORT_RESULT_UNKNOWN' },
      { id: 'item-1', status: 'created', error_code: null },
    ]);
    expect(importStore.getState().summary?.errorCode).toBeNull();
    expect(jobRow().status).toBe('completed');
  });

  it('does not stop the run for a permanent per-item rejection', async () => {
    seedJob({ items: 2 });
    mockSubmitImportBatch.mockImplementation(
      async (_id: string, body: { items: { importKey: string }[] }) => ({
        results: [
          { importKey: body.items[0].importKey, status: 'rejected', code: 'IMPORT_DATE_INVALID' },
          {
            importKey: body.items[1].importKey,
            status: 'created',
            threadId: threadUuid('1'),
            createdAt: '2012-08-26T00:00:00.000Z',
          },
        ],
        allowance: allowance(1),
      }),
    );

    await confirmAndRunLaunch();

    expect(itemRows()).toEqual([
      { id: 'item-0', status: 'failed', error_code: 'IMPORT_DATE_INVALID' },
      { id: 'item-1', status: 'created', error_code: null },
    ]);
    const summary = importStore.getState().summary;
    expect(summary?.created).toBe(1);
    expect(summary?.failed).toBe(1);
    expect(summary?.errorCode).toBeNull();
    expect(mockCaptureError).not.toHaveBeenCalled();
  });

  it('fails an item whose stored date is NULL, and submits the rest', async () => {
    seedJob({ items: 2 });
    // The column is nullable, and a null date would otherwise reach
    // `sealImportMeta`'s safe-integer guard and throw a `terminal-for-run`
    // crypto invariant — one bad row killing the whole archive (§4.6).
    harness.sqlite
      .prepare('UPDATE import_items SET original_date = NULL WHERE id = ?')
      .run('item-0');

    await confirmAndRunLaunch();

    expect(itemRows()).toEqual([
      { id: 'item-0', status: 'failed', error_code: 'IMPORT_ITEM_INVALID' },
      { id: 'item-1', status: 'created', error_code: null },
    ]);
    // One item, not two: the invalid row never reached the payload.
    expect((mockSubmitImportBatch.mock.calls[0][1] as { items: [] }).items).toHaveLength(1);
    expect(importStore.getState().summary?.errorCode).toBeNull();
    expect(jobRow().status).toBe('completed');
  });
});

// ===========================================================================
// Group: Media refusals after a chunk was staged (§4.10.5, §4.7)
// ===========================================================================

describe('a media refusal the server raised after taking a chunk', () => {
  /** A 409 `IMPORT_REFUSED`, wrapped as `uploadMedia` really emits it. */
  function stagedRefusal(details: Record<string, unknown>): Error {
    return new ImportMediaStagedError(
      new ConflictError(JSON.stringify({ error: 'IMPORT_REFUSED', details })),
    );
  }

  /** The orbit-full refusal, as the media-complete route raises it. */
  function quotaDetails(): Record<string, unknown> {
    return { code: 'IMPORT_QUOTA_EXCEEDED', available_bytes: 10, size_bytes: 20 };
  }

  it('parks a QUOTA refusal, retries it once at end of run, and keeps the run going', async () => {
    // item-0 carries the media; item-1 is text-only.
    seedJob({ items: 2, bookmark: ['part-a'], mediaEntryIds: ['entry-0-0'] });
    mockUploadMedia.mockRejectedValue(stagedRefusal(quotaDetails()));
    // The orbit is still full when the end-of-run pass settles the staged row.
    mockCompleteImportUpload.mockRejectedValue(
      new ConflictError(JSON.stringify({ error: 'IMPORT_REFUSED', details: quotaDetails() })),
    );

    await confirmAndRunLaunch();

    // The park → end-of-run pass → `item-failed('QUOTA')` route, which the
    // unconditional rebind made unreachable: the file was re-uploaded under a
    // fresh id instead, and a second refusal ended the whole run `FORBIDDEN`.
    //
    // ONE upload now, not two: at media complete the server keeps the temp row
    // and every chunk, so the pass retries the settle alone rather than paying
    // for the whole file again.
    expect(mockUploadMedia).toHaveBeenCalledTimes(1);
    expect(mockCompleteImportUpload).toHaveBeenCalledTimes(1);
    const rows = itemRows();
    expect(rows.find((row) => row.id === 'item-0')).toEqual({
      id: 'item-0',
      status: 'failed',
      error_code: 'QUOTA',
    });
    expect(rows.find((row) => row.id === 'item-1')?.status).toBe('created');
    const summary = importStore.getState().summary;
    expect(summary?.errorCode).toBeNull();
    expect(summary?.created).toBe(1);
    expect(summary?.failed).toBe(1);
    expect(summary?.notSubmitted).toBe(0);
    expect(jobRow().status).toBe('completed');
    expect(mockCaptureError).not.toHaveBeenCalled();
  });

  it('creates the parked post when the end-of-run settle succeeds, with no second upload', async () => {
    seedJob({ items: 2, bookmark: ['part-a'], mediaEntryIds: ['entry-0-0'] });
    // Parked once; by the end of the run the orbit has room again.
    mockUploadMedia.mockRejectedValueOnce(stagedRefusal(quotaDetails()));

    await confirmAndRunLaunch();

    // The file was uploaded ONCE and settled by the one call it still owed.
    expect(mockUploadMedia).toHaveBeenCalledTimes(1);
    expect(mockCompleteImportUpload).toHaveBeenCalledTimes(1);
    expect(mockCompleteImportUpload).toHaveBeenCalledWith(IMPORT_ID, 'media-0');
    expect(itemRows().map((row) => row.status)).toEqual(['created', 'created']);
    const summary = importStore.getState().summary;
    expect(summary?.created).toBe(2);
    expect(summary?.failed).toBe(0);
    expect(summary?.notSubmitted).toBe(0);
    expect(summary?.errorCode).toBeNull();
    expect(jobRow().status).toBe('completed');
  });

  it('reports a still-parked row on a terminal that lands before the end-of-run pass', async () => {
    // Two importable posts and one parse skip, so every line is exercised.
    seedJob({
      items: 2,
      bookmark: ['part-a'],
      mediaEntryIds: ['entry-0-0'],
      skips: ['empty_post'],
    });
    mockUploadMedia.mockRejectedValue(stagedRefusal(quotaDetails()));
    // item-1's batch ends the run while item-0 is still parked, so the pass
    // never runs.
    mockSubmitImportBatch.mockRejectedValue(new AuthError(403, undefined));

    await confirmAndRunLaunch();

    const summary = importStore.getState().summary;
    expect(summary?.errorCode).toBe('FORBIDDEN');
    // The park used to be subtracted from `notSubmitted` while being reported
    // on no other line, so one of the member's two posts simply vanished from
    // the summary. Still parked IS still queued: the row is `uploading`, which
    // a later resume requeues.
    expect(summary?.notSubmitted).toBe(2);
    expect(
      (summary?.created ?? 0) +
        (summary?.duplicate ?? 0) +
        (summary?.failed ?? 0) +
        (summary?.heldVideo ?? 0) +
        (summary?.notSubmitted ?? 0),
    ).toBe(2);
    // The skipped line accounts for the rest of what was parsed.
    expect(summary?.skippedByReason.empty_post).toBe(1);
    expect(itemRows().filter((row) => row.status === 'uploading')).toHaveLength(2);
    expect(jobRow().status).toBe('failed');
  });

  it('is terminal with ALLOWANCE at media complete, keeping the posts already created', async () => {
    seedJob({ items: 2, bookmark: ['part-a'], mediaEntryIds: ['entry-0-0'] });
    // item-1 landed in an earlier run; a thread cannot be recalled.
    harness.sqlite
      .prepare(
        "UPDATE import_items SET status = 'created', thread_id = 't', body = NULL WHERE id = ?",
      )
      .run('item-1');
    mockUploadMedia.mockRejectedValue(
      stagedRefusal({
        code: 'IMPORT_ALLOWANCE_EXCEEDED',
        allowance: { posts_used: 1, bytes_used: 2, posts_limit: 1000, bytes_limit: 3 },
      }),
    );

    await confirmAndRunLaunch();

    // The #992 review required this terminal to stay first-class. Under the
    // unconditional rebind it surfaced as `SESSION_CLOSED`, because the server
    // closes the session and deletes the temp row on this one.
    expect(importStore.getState().summary?.errorCode).toBe('ALLOWANCE');
    expect(importStore.getState().summary?.created).toBe(1);
    expect(itemRows().find((row) => row.id === 'item-1')?.status).toBe('created');
    expect(jobRow().status).toBe('failed');
    // One upload: the id is burned, but re-uploading would spend allowance the
    // member does not have.
    expect(mockUploadMedia).toHaveBeenCalledTimes(1);
  });

  /** The soft chunk ceiling: both byte counters present, session still open. */
  function chunkCeilingRefusal(): Error {
    return stagedRefusal({
      code: 'IMPORT_ALLOWANCE_EXCEEDED',
      allowance: { posts_used: 1, bytes_used: 2, posts_limit: 1000, bytes_limit: 3 },
      staged_bytes: 100,
      projected_bytes: 200,
    });
  }

  it('waits the chunk ceiling on its own clock, three times, then fails with ALLOWANCE', async () => {
    jest.useFakeTimers();
    try {
      seedJob({ items: 1, bookmark: ['part-a'], mediaEntryIds: ['entry-0-0'] });
      mockUploadMedia.mockRejectedValue(chunkCeilingRefusal());

      const running = resumeImportAtLaunch();
      running.catch(() => {
        // Attached BEFORE the clock moves (#834 discipline).
      });
      await flushMicrotasks();
      expect(importStore.getState().pauseCauses).toEqual(['allowance_wait']);
      expect(importStore.getState().resumeAtMs).toBe(Date.now() + 30_000);

      // 5 s is the `network` ladder's first rung, and this is not a network
      // pause: the refusal named 30 s, and retrying sooner re-learns it.
      jest.advanceTimersByTime(5_000);
      await flushMicrotasks();
      expect(mockUploadMedia).toHaveBeenCalledTimes(1);

      // Three waits, then the fourth refusal has no budget left. Nothing frees
      // the staged bytes this ceiling counts in 30 s — only a media complete, a
      // hard overrun, `importSessionCleanup` after hours of silence, or the 24 h
      // sweep — so a refusal that keeps coming must terminate. Exempting this
      // pause from its budget (it rode the `network` cause, and a pause with a
      // deadline spent nothing) retried it for ever instead.
      for (let i = 0; i < 3; i++) {
        jest.advanceTimersByTime(30_000);
        await flushMicrotasks();
      }
      await running;

      expect(mockUploadMedia).toHaveBeenCalledTimes(4);
      expect(importStore.getState().summary?.errorCode).toBe('ALLOWANCE');
      expect(jobRow().status).toBe('failed');
      // The post is still queued, not charged to the member: a later import can
      // take it once the member's allowance frees up.
      expect(itemRows()[0].status).toBe('pending');
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not let the foreground wake-up shorten a chunk-ceiling wait', async () => {
    jest.useFakeTimers();
    try {
      seedJob({ items: 1, bookmark: ['part-a'], mediaEntryIds: ['entry-0-0'] });
      mockUploadMedia
        .mockRejectedValueOnce(chunkCeilingRefusal())
        .mockResolvedValue({ mediaId: 'media-0' });

      const running = resumeImportAtLaunch();
      running.catch(() => {
        // Attached BEFORE the clock moves (#834 discipline).
      });
      await flushMicrotasks();
      expect(importStore.getState().pauseCauses).toEqual(['allowance_wait']);

      // Coming back to the app says nothing about the orbit's staged bytes, so
      // the `network`/`background` foreground drop must not touch this cause.
      appStateHandler?.('active');
      await flushMicrotasks();
      expect(importStore.getState().pauseCauses).toEqual(['allowance_wait']);
      expect(mockUploadMedia).toHaveBeenCalledTimes(1);

      jest.advanceTimersByTime(30_000);
      await flushMicrotasks();
      await running;

      expect(mockUploadMedia).toHaveBeenCalledTimes(2);
      expect(itemRows()[0].status).toBe('created');
      expect(jobRow().status).toBe('completed');
    } finally {
      jest.useRealTimers();
    }
  });

  it('counts a post held for video once, never also as not-submitted', async () => {
    seedJob({ items: 1, bookmark: ['part-a'], mediaEntryIds: ['entry-0-0'] });
    // A post-extract hold: the head peek said image, the real inflation says
    // video. The post is parked in `uploading`, which is also where an unsent
    // batch claim lives — the summary must tell them apart.
    mockOpenArchiveSession.mockImplementation(async () => videoArchiveSession());

    await confirmAndRunLaunch();

    const summary = importStore.getState().summary;
    expect(summary?.heldVideo).toBe(1);
    expect(summary?.notSubmitted).toBe(0);
    expect(summary?.failed).toBe(0);
    expect(itemRows()[0].status).toBe('uploading');
    expect(mockUploadMedia).not.toHaveBeenCalled();
    expect(jobRow().status).toBe('completed');
  });

  it('counts a held post once even after a session restart requeues and re-holds it', async () => {
    seedJob({ items: 2, bookmark: ['part-a'], mediaEntryIds: ['entry-0-0'] });
    let videoExtracts = 0;
    mockOpenArchiveSession.mockImplementation(
      async () =>
        ({
          ...archiveSession(),
          extractImageEntry: jest.fn(async () => {
            videoExtracts += 1;
            return { ok: false as const, skip: 'ENTRY_IS_VIDEO' };
          }),
        }) as unknown as ArchiveImportSession,
    );
    // item-1's first batch finds the session abandoned: the restart requeues
    // everything parked in `uploading`, including the held post, which is then
    // held a second time on its next extract.
    mockSubmitImportBatch.mockRejectedValueOnce(
      new ConflictError(
        JSON.stringify({
          error: 'IMPORT_REFUSED',
          details: { code: 'IMPORT_CLOSED', status: 'abandoned' },
        }),
      ),
    );

    await confirmAndRunLaunch();

    expect(mockStartImport).toHaveBeenCalled();
    // The proof the double count had something to double: the post really was
    // extracted, held, requeued and held again.
    expect(videoExtracts).toBe(2);
    const summary = importStore.getState().summary;
    // ONE post was held, so the member is told one — not two, which a counter
    // kept beside `r.held` reported once the restart cleared the set.
    expect(summary?.heldVideo).toBe(1);
    expect(importStore.getState().heldVideo).toBe(1);
    expect(summary?.notSubmitted).toBe(0);
    expect(summary?.created).toBe(1);
    expect(itemRows().find((row) => row.id === 'item-0')?.status).toBe('uploading');
    expect(jobRow().status).toBe('completed');
  });
});

// ===========================================================================
// Group: Telemetry (§4.13)
// ===========================================================================

describe('telemetry', () => {
  it('reports one event per failure code per run', async () => {
    seedJob({ items: 1 });
    mockGetImportSession.mockRejectedValue(new AuthError(403, undefined));

    await confirmAndRunLaunch();

    expect(mockCaptureError).toHaveBeenCalledTimes(1);
    const [error, context] = mockCaptureError.mock.calls[0] as [
      Error,
      { tags: Record<string, string>; extra: Record<string, number> },
    ];
    expect(error.message).toBe('meta import failed');
    expect(context.tags).toEqual({
      import_source: 'facebook',
      import_stage: 'start',
      import_code: 'FORBIDDEN',
    });
    expect(context.extra).toEqual({ created: 0, failed: 0, batch_size: 50 });
  });

  it('never puts a forbidden identifier in either spelling into the payload', async () => {
    seedJob({ items: 1, bookmark: ['part-a'], mediaEntryIds: ['entry-0-0'] });
    mockGetImportSession.mockRejectedValue(new AuthError(403, undefined));

    await confirmAndRunLaunch();

    expect(mockCaptureError).toHaveBeenCalled();
    const serialized = JSON.stringify(mockCaptureError.mock.calls);
    for (const forbidden of [
      'source_file',
      'sourceFile',
      'entry_id',
      'entryId',
      'import_key',
      'importKey',
      'media_id',
      'mediaId',
      'import_id',
      'importId',
      'file_name',
      'fileName',
      'local_path',
      'localPath',
      'original_date',
      'key_fingerprint',
      'keyFingerprint',
      'archive_bookmark',
      'bookmark',
      'parts',
      'groupKey',
      'kImport',
      'attachmentKey',
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
    // `body` is checked separately: the word appears inside no key above, and
    // a substring search for it would match nothing in a counts-only payload.
    expect(serialized).not.toContain('body');
  });

  it('captures nothing at all for a cancelled run', async () => {
    seedJob({ items: 1 });
    mockSubmitImportBatch.mockImplementation(async () => {
      cancelImport();
      throw new NetworkError('cancelled');
    });

    await confirmAndRunLaunch();

    expect(mockCaptureError).not.toHaveBeenCalled();
    expect(importStore.getState().summary?.cancelled).toBe(true);
  });
});

// ===========================================================================
// Group: Cancelling before a run exists (#928 gaps 1 and 7)
// ===========================================================================

describe('cancelling with no ActiveRun', () => {
  /** A parse that blocks until its signal aborts, then reports the cancel. */
  function parseUntilAborted(): void {
    mockParseArchive.mockImplementation(
      async (_session: unknown, opts: { signal: AbortSignal }): Promise<never> => {
        await new Promise<void>((resolve) => {
          opts.signal.addEventListener('abort', () => resolve(), { once: true });
        });
        throw new ArchiveReaderError('ECANCELLED');
      },
    );
  }

  it('hands the abort signal to the archive session and to the parser', async () => {
    parseEmitting(1);

    await pickAndStartParse({ conversationId: ORBIT, chooseSource: jest.fn() });

    expect(mockOpenArchiveSession).toHaveBeenCalledWith(['part-a'], {
      signal: expect.any(AbortSignal),
    });
    expect(mockParseArchive.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });

  it('cancels a live parse, deleting the job and landing on idle', async () => {
    parseUntilAborted();

    const picking = pickAndStartParse({ conversationId: ORBIT, chooseSource: jest.fn() });
    await drain();
    expect(importStore.getState().phase).toBe('parsing');

    // Before gap 1 this was a no-op: `run` is null during a parse, so the
    // member's Cancel left the reader going and the job row `parsing`, which
    // then refused every later pick with `job-running`.
    cancelImport();

    expect(await picking).toEqual({ kind: 'cancelled' });
    expect(jobCount()).toBe(0);
    expect(importStore.getState().phase).toBe('idle');
    expect(importStore.getState().jobId).toBeNull();
    expect(mockReleaseArchiveParts).toHaveBeenCalledWith(['part-a']);
  });

  it('aborts a parse on a wipe and writes nothing after the token bump', async () => {
    const reached = deferred();
    // A parser that does NOT notice the abort: the summary comes back as if
    // the read had finished. Rule 0 is what must stop the writes, not the
    // reader's own courtesy.
    mockParseArchive.mockImplementation(
      async (_session: unknown, opts: { signal: AbortSignal; onItem: Function }) => {
        reached.resolve();
        await new Promise<void>((resolve) => {
          opts.signal.addEventListener('abort', () => resolve(), { once: true });
        });
        await opts.onItem(
          {
            outcome: 'import',
            source: 'facebook',
            sourceFile: 'your_posts_1.json',
            sourceIndex: 0,
            sourceItemId: new Uint8Array(8),
            idKind: 1,
            originalDate: POST_DATE,
            body: 'body 0',
            media: [],
          },
          new Uint8Array(16).fill(1),
        );
        return summaryWith(1, []);
      },
    );

    const picking = pickAndStartParse({ conversationId: ORBIT, chooseSource: jest.fn() });
    await reached.promise;

    resetImportRunnerState();

    expect(await picking).toEqual({ kind: 'cancelled' });
    // No item rows, no allowance GET, no part release and no publish: the
    // wipe's own `deleteAllImportJobs` is what removes the row it left.
    expect(itemCount()).toBe(0);
    expect(mockGetGroupImports).not.toHaveBeenCalled();
    expect(mockReleaseArchiveParts).not.toHaveBeenCalled();
    expect(importStore.getState()).toEqual(importStore.getInitialState());
  });

  it('deletes the parsing row when there is no preflight to show', async () => {
    parseEmitting(1);
    // The allowance probe answers 404: imports are not available here, so
    // `parseIntoJob` has nothing honest to build a preflight from.
    mockGetGroupImports.mockRejectedValue(new NotFoundError());

    const result = await pickAndStartParse({ conversationId: ORBIT, chooseSource: jest.fn() });

    expect(result).toEqual({ kind: 'cancelled' });
    // The row used to survive as `parsing`, which refused every later pick.
    expect(jobCount()).toBe(0);
    expect(importStore.getState().phase).toBe('idle');
    expect(importStore.getState().jobId).toBeNull();
  });

  it('leaves a LIVE parse alone when the launch gate runs mid-parse', async () => {
    parseUntilAborted();
    const picking = pickAndStartParse({ conversationId: ORBIT, chooseSource: jest.fn() });
    await drain();
    expect(importStore.getState().phase).toBe('parsing');

    // Key recovery calls this while the member is still reading their export.
    // The `parsing` branch would have deleted the row underneath the parse.
    await resumeImportAtLaunch();

    expect(jobCount()).toBe(1);
    expect(importStore.getState().phase).toBe('parsing');

    cancelImport();
    await picking;
  });

  it('cancels a pre-run pause into a cancelled summary and a courtesy complete', async () => {
    seedJob({ items: 2, bookmark: ['part-a'] });
    mockGetImportSession.mockRejectedValue(new NetworkError('offline'));

    await resumeImportAtLaunch();
    expect(importStore.getState().phase).toBe('paused');
    expect(importStore.getState().pauseCauses).toEqual(['network']);

    cancelImport();
    await drain();

    // §4.9 asks for a pre-run pause to be visible AND cancellable; before gap
    // 7 the member could only wait for a timer that had nothing left to try.
    expect(importStore.getState().phase).toBe('done');
    expect(importStore.getState().summary?.cancelled).toBe(true);
    expect(jobRow().status).toBe('cancelled');
    expect(mockCompleteImport).toHaveBeenCalledWith(IMPORT_ID);
    expect(mockReleaseArchiveParts).toHaveBeenCalledWith(['part-a']);
    expect(mockStartImport).not.toHaveBeenCalled();
    expect(mockSubmitImportBatch).not.toHaveBeenCalled();
    expect(mockCaptureError).not.toHaveBeenCalled();
  });

  it('ignores a cancel for a pre-run pause that is not the active job', async () => {
    seedJob({ items: 1 });
    mockGetImportSession.mockRejectedValue(new NetworkError('offline'));
    await resumeImportAtLaunch();
    expect(importStore.getState().phase).toBe('paused');

    harness.sqlite.prepare("UPDATE import_jobs SET status = 'completed' WHERE id = ?").run(JOB);
    cancelImport();
    await drain();

    expect(jobRow().status).toBe('completed');
    expect(mockCompleteImport).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// Group: the single-flight pre-run gate (#928 gap 9 / B2)
// ===========================================================================

describe('the pre-run gate is single-flight', () => {
  it('lets a Stop win the race against an in-flight session GET', async () => {
    seedJob({ items: 2 });
    const phases: string[] = [];
    const unsubscribe = importStore.subscribe((state) => phases.push(state.phase));
    const held = deferred<unknown>();
    let gets = 0;
    mockGetImportSession.mockImplementation(() => {
      gets += 1;
      if (gets === 1) return Promise.reject(new NetworkError('offline'));
      return held.promise;
    });

    try {
      await resumeImportAtLaunch();
      expect(importStore.getState().phase).toBe('paused');

      // The retry is in flight and parked on the GET, while the store still
      // reads `paused` — the window a Stop tap lands in.
      const retrying = resumeImportAtLaunch();
      await drain();
      expect(gets).toBe(2);

      cancelImport();
      await drain();

      // The stale entry unwinds only once its GET answers. It must not run.
      held.resolve({
        importId: IMPORT_ID,
        groupId: ORBIT,
        status: 'open',
        declaredPosts: 2,
        declaredBytes: 4096,
        createdPosts: 0,
        createdAt: '2012-08-26T00:00:00.000Z',
        lastActivityAt: '2012-08-26T00:00:00.000Z',
        completedAt: null,
        allowance: allowance(),
        limits: LIMITS,
      });
      await retrying;
      await drain();

      expect(mockStartImport).not.toHaveBeenCalled();
      expect(mockSubmitImportBatch).not.toHaveBeenCalled();
      expect(itemRows().every((row) => row.status === 'pending')).toBe(true);
      expect(jobRow().status).toBe('cancelled');
      expect(importStore.getState().summary?.cancelled).toBe(true);
      // Exactly one settle, and nothing published after it: the stale entry
      // used to republish `running` over the cancelled summary.
      expect(phases.lastIndexOf('done')).toBe(phases.length - 1);
      expect(phases.filter((phase) => phase === 'running')).toHaveLength(0);
    } finally {
      unsubscribe();
    }
  });

  it('answers two resumeImport() taps with one entry', async () => {
    seedJob({ items: 1 });
    const held = deferred<unknown>();
    let gets = 0;
    mockGetImportSession.mockImplementation(() => {
      gets += 1;
      if (gets === 1) return Promise.reject(new NetworkError('offline'));
      return held.promise;
    });

    await resumeImportAtLaunch();
    expect(importStore.getState().phase).toBe('paused');

    resumeImport();
    await drain();
    resumeImport();
    await drain();

    // The second tap joined the first entry rather than opening a second GET,
    // a second key session and a second run.
    expect(gets).toBe(2);
    expect(mockKeySessions).toHaveLength(2);

    held.resolve({
      importId: IMPORT_ID,
      groupId: ORBIT,
      status: 'open',
      declaredPosts: 1,
      declaredBytes: 4096,
      createdPosts: 0,
      createdAt: '2012-08-26T00:00:00.000Z',
      lastActivityAt: '2012-08-26T00:00:00.000Z',
      completedAt: null,
      allowance: allowance(),
      limits: LIMITS,
    });
    await drain();

    expect(mockStartImport).toHaveBeenCalledTimes(0);
    expect(itemRows()[0].status).toBe('created');
    expect(jobRow().status).toBe('completed');
  });

  it('lets a tap racing a fired retry timer enter only once', async () => {
    jest.useFakeTimers();
    try {
      seedJob({ items: 1 });
      const held = deferred<unknown>();
      let gets = 0;
      mockGetImportSession.mockImplementation(() => {
        gets += 1;
        if (gets === 1) return Promise.reject(new NetworkError('offline'));
        return held.promise;
      });

      const launching = resumeImportAtLaunch();
      launching.catch(() => {
        // Attached BEFORE the clock moves (#834 discipline).
      });
      await flushMicrotasks();
      await launching;
      expect(importStore.getState().pauseCauses).toEqual(['network']);

      // The `network` ladder's first rung fires, and the member taps Retry in
      // the same frame.
      jest.advanceTimersByTime(5_000);
      await flushMicrotasks();
      resumeImport();
      await flushMicrotasks();

      expect(gets).toBe(2);
      expect(mockKeySessions).toHaveLength(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it('answers a double confirm with one run', async () => {
    seedJob({ status: 'ready', items: 2 });
    await resumeImportAtLaunch();
    expect(importStore.getState().phase).toBe('ready');

    const gate = deferred();
    mockKeyOpenGate = gate.promise;

    const first = confirmAndRunImport();
    const second = confirmAndRunImport();
    await drain();

    mockKeyOpenGate = null;
    gate.resolve();
    await Promise.all([first, second]);
    await drain();

    // `enterJob` awaits the key session before `runJob` assigns `run`, so the
    // second tap's `run !== null` guard could not see the first one. The
    // session count is what proves the latch rather than the defences behind
    // it: one for the launch rebuild, one for the run, and none for the
    // second tap — without the latch the second tap opens a third, builds a
    // second `ActiveRun` and only then loses to the stale-token checks.
    expect(mockKeySessions).toHaveLength(2);
    expect(mockStartImport).toHaveBeenCalledTimes(1);
    expect(mockSubmitImportBatch).toHaveBeenCalledTimes(1);
    expect(jobRow().status).toBe('completed');
  });

  it('writes nothing from an entry a wipe landed on mid-gate', async () => {
    seedJob({ status: 'ready', items: 1 });
    await resumeImportAtLaunch();

    const gate = deferred();
    mockKeyOpenGate = gate.promise;
    const confirming = confirmAndRunImport();
    await drain();

    resetImportRunnerState();
    mockKeyOpenGate = null;
    gate.resolve();
    await confirming;
    await drain();

    expect(mockStartImport).not.toHaveBeenCalled();
    expect(jobRow().status).toBe('ready');
    expect(itemRows()[0].status).toBe('pending');
    expect(importStore.getState()).toEqual(importStore.getInitialState());
  });
});

// ===========================================================================
// Group: the different-archive re-pick (#928 fix (a))
// ===========================================================================

describe('a re-pick that turns out to be a different archive', () => {
  // The run promise is handed back WRAPPED: returning it bare from an async
  // function would await it, and it only settles once the re-pick has run.
  async function pauseOnRepick(): Promise<{ running: Promise<void> }> {
    seedJob({ items: 1, bookmark: ['part-a'], mediaEntryIds: ['entry-0-0'] });
    mockOpenArchiveSession.mockImplementation(async () => {
      throw new ArchiveReaderError('ARCHIVE_CHANGED');
    });
    const running = resumeImportAtLaunch();
    running.catch(() => {});
    await drain();
    expect(importStore.getState().pauseCauses).toEqual(['needs_repick']);
    return { running };
  }

  it('closes the server session it is walking away from', async () => {
    const { running } = await pauseOnRepick();

    expect(await repickArchiveParts()).toBe('different-archive');
    await running;

    // The session's `declared_bytes` is a lien on the ORBIT — other members'
    // uploads are refused against it — until B#318's GC reaps it up to six
    // hours later. The member's fresh pick would also hit
    // `IMPORT_IN_PROGRESS` and have to adopt this stale session.
    expect(mockCompleteImport).toHaveBeenCalledWith(IMPORT_ID);
    expect(getImportJob(JOB)).toBeNull();
    expect(importStore.getState().phase).toBe('idle');
  });

  it('makes no call at all when a wipe lands during the re-pick', async () => {
    const { running } = await pauseOnRepick();
    mockOpenArchiveSession.mockImplementation(async () => {
      // The wipe lands while the member is in the picker: rule 0 says write
      // nothing and call nothing, not even this courtesy.
      resetImportRunnerState();
      throw new ArchiveReaderError('ARCHIVE_CHANGED');
    });

    expect(await repickArchiveParts()).toBe('different-archive');
    await running;

    expect(mockCompleteImport).not.toHaveBeenCalled();
    expect(getImportJob(JOB)).not.toBeNull();
  });
});

// ===========================================================================
// Group: the pre-run retry budget (#928 fix (b), gap 5, clear matrix)
// ===========================================================================

describe('the pre-run retry budget', () => {
  /** Pause a seeded `in_progress` job before its run, on `network`. */
  async function pauseOnNetwork(): Promise<void> {
    mockGetImportSession.mockRejectedValue(new NetworkError('offline'));
    const launching = resumeImportAtLaunch();
    launching.catch(() => {
      // Attached BEFORE the clock moves (#834 discipline).
    });
    await flushMicrotasks();
    await launching;
  }

  /** Fire `times` pre-run wake-ups. 60 s clears every rung of every ladder. */
  async function burnWakeUps(times: number): Promise<void> {
    for (let i = 0; i < times; i++) {
      jest.advanceTimersByTime(60_000);
      await flushMicrotasks();
    }
  }

  it('publishes the deadline it will retry at', async () => {
    seedJob({ items: 1 });
    const before = Date.now();
    mockGetImportSession.mockRejectedValueOnce(new NetworkError('offline'));

    await resumeImportAtLaunch();

    // Gap 5: without this #928 renders a paused card with no countdown and no
    // way to tell a wait from a stall.
    const resumeAtMs = importStore.getState().resumeAtMs;
    expect(resumeAtMs).not.toBeNull();
    // The `network` ladder's first rung.
    expect(resumeAtMs).toBeGreaterThanOrEqual(before + 5_000);
    expect(resumeAtMs).toBeLessThanOrEqual(Date.now() + 5_000);
    expect(importStore.getState().autoRetryExhausted).toBe(false);
  });

  it('honours a pre-run 429 Retry-After instead of the default minute', async () => {
    jest.useFakeTimers();
    try {
      seedJob({ items: 1 });
      const before = Date.now();
      mockGetImportSession.mockRejectedValueOnce(rateLimited(12_000));

      const launching = resumeImportAtLaunch();
      launching.catch(() => {});
      await flushMicrotasks();
      await launching;

      expect(importStore.getState().pauseCauses).toEqual(['rate_limited']);
      const resumeAtMs = importStore.getState().resumeAtMs ?? 0;
      expect(resumeAtMs - before).toBeGreaterThanOrEqual(11_000);
      expect(resumeAtMs - before).toBeLessThanOrEqual(13_000);

      // The server's own number, not `DEFAULT_RATE_LIMIT_MS`: at 60 s the
      // import would have sat idle for another 48.
      jest.advanceTimersByTime(12_000);
      await flushMicrotasks();

      expect(itemRows()[0].status).toBe('created');
      expect(jobRow().status).toBe('completed');
    } finally {
      jest.useRealTimers();
    }
  });

  it('keeps a resumable paused state once the budget is spent', async () => {
    jest.useFakeTimers();
    try {
      seedJob({ items: 1, source: 'instagram' });
      await pauseOnNetwork();
      await burnWakeUps(10);

      const state = importStore.getState();
      // It used to publish `idle`, which left the member with no card, no
      // Retry, and a job row that refused every new pick with `job-running`.
      expect(state.phase).toBe('paused');
      expect(state.pauseCauses).toEqual(['network']);
      expect(state.autoRetryExhausted).toBe(true);
      expect(state.resumeAtMs).toBeNull();
      // #928 renders the card from these three.
      expect(state.jobId).toBe(JOB);
      expect(state.conversationId).toBe(ORBIT);
      expect(state.source).toBe('instagram');
      expect(jobRow().status).toBe('in_progress');
    } finally {
      jest.useRealTimers();
    }
  });

  it('lets the member retry out of an exhausted budget', async () => {
    jest.useFakeTimers();
    try {
      seedJob({ items: 1 });
      await pauseOnNetwork();
      await burnWakeUps(10);
      expect(importStore.getState().autoRetryExhausted).toBe(true);
      const spent = mockGetImportSession.mock.calls.length;

      mockGetImportSession.mockResolvedValue({
        importId: IMPORT_ID,
        groupId: ORBIT,
        status: 'open',
        declaredPosts: 1,
        declaredBytes: 4096,
        createdPosts: 0,
        createdAt: '2012-08-26T00:00:00.000Z',
        lastActivityAt: '2012-08-26T00:00:00.000Z',
        completedAt: null,
        allowance: allowance(),
        limits: LIMITS,
      });
      resumeImport();
      await flushMicrotasks();

      expect(mockGetImportSession.mock.calls.length).toBe(spent + 1);
      expect(itemRows()[0].status).toBe('created');
      expect(jobRow().status).toBe('completed');
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not spend key_pending budget on network attempts', async () => {
    jest.useFakeTimers();
    try {
      seedJob({ items: 1 });
      await pauseOnNetwork();
      // Six `network` wake-ups — exactly `KEY_PENDING_MAX_ATTEMPTS`.
      await burnWakeUps(6);
      expect(importStore.getState().pauseCauses).toEqual(['network']);
      expect(importStore.getState().autoRetryExhausted).toBe(false);

      // Now the key is the gate instead. With ONE shared counter this pause
      // would be born exhausted, on a budget it had never spent.
      mockKeyOpenError = new Error('pending wrap');
      await burnWakeUps(1);

      expect(importStore.getState().pauseCauses).toEqual(['key_pending']);
      expect(importStore.getState().autoRetryExhausted).toBe(false);
      const resumeAtMs = importStore.getState().resumeAtMs ?? 0;
      expect(resumeAtMs - Date.now()).toBeGreaterThan(20_000);
    } finally {
      jest.useRealTimers();
    }
  });

  it('ignores Retry on a rate_limited wait until its wake-ups are spent', async () => {
    jest.useFakeTimers();
    try {
      seedJob({ items: 1 });
      mockGetImportSession.mockRejectedValue(rateLimited(60_000));
      const launching = resumeImportAtLaunch();
      launching.catch(() => {});
      await flushMicrotasks();
      await launching;
      expect(importStore.getState().pauseCauses).toEqual(['rate_limited']);

      // The server named this wait; shortening it would spend a round trip
      // re-learning the same refusal.
      const spent = mockGetImportSession.mock.calls.length;
      resumeImport();
      await flushMicrotasks();
      expect(mockGetImportSession.mock.calls.length).toBe(spent);

      // Once nothing else will ever re-enter the gate, the tap is the only
      // way out and is honoured.
      await burnWakeUps(10);
      expect(importStore.getState().autoRetryExhausted).toBe(true);
      resumeImport();
      await flushMicrotasks();
      expect(mockGetImportSession.mock.calls.length).toBeGreaterThan(spent);
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not carry an exhausted flag into the next job', async () => {
    jest.useFakeTimers();
    try {
      seedJob({ items: 1 });
      await pauseOnNetwork();
      await burnWakeUps(10);
      expect(importStore.getState().autoRetryExhausted).toBe(true);

      cancelImport();
      await flushMicrotasks();
      harness.sqlite.prepare('DELETE FROM import_items').run();
      harness.sqlite.prepare('DELETE FROM import_jobs').run();

      seedJob({ items: 1 });
      await pauseOnNetwork();

      // A sticky flag would show the next job's FIRST pause as stalled, with
      // a Retry button over a wait that is retrying itself.
      expect(importStore.getState().phase).toBe('paused');
      expect(importStore.getState().autoRetryExhausted).toBe(false);
      expect(importStore.getState().resumeAtMs).not.toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not let one cause exhaustion unlock Retry for the next one', async () => {
    jest.useFakeTimers();
    try {
      seedJob({ items: 1 });
      await pauseOnNetwork();
      await burnWakeUps(10);
      expect(importStore.getState().autoRetryExhausted).toBe(true);

      // The tap re-enters, and this time the server rate-limits: a fresh wait
      // that IS retrying itself, so Retry is not its exit.
      mockGetImportSession.mockRejectedValue(rateLimited(60_000));
      resumeImport();
      await flushMicrotasks();
      expect(importStore.getState().pauseCauses).toEqual(['rate_limited']);
      expect(importStore.getState().autoRetryExhausted).toBe(false);

      const spent = mockGetImportSession.mock.calls.length;
      resumeImport();
      await flushMicrotasks();
      expect(mockGetImportSession.mock.calls.length).toBe(spent);
    } finally {
      jest.useRealTimers();
    }
  });
});

// ===========================================================================
// Group: typed pick failures and the per-file codes (#928 gap 8)
// ===========================================================================

describe('what a pick that fails answers', () => {
  it('names an archive the reader could not open', async () => {
    mockOpenArchiveSession.mockRejectedValue(new ArchiveReaderError('ARCHIVE_NOT_ZIP'));

    // An HTML export, or a file that is not a ZIP at all. Reported as
    // `cancelled`, the how-to screen simply did nothing.
    expect(await pickAndStartParse({ conversationId: ORBIT, chooseSource: jest.fn() })).toEqual({
      kind: 'failed',
      reason: 'archive',
    });
    expect(jobCount()).toBe(0);
    expect(importStore.getState().phase).toBe('idle');
  });

  it('names a group key that has not reached this device yet', async () => {
    mockKeyOpenError = new Error('pending wrap');
    mockClassifyCryptoError.mockReturnValue('retryable-pause');

    // It clears itself, so the copy says "try again in a minute" where the
    // archive copy would say "re-export".
    expect(await pickAndStartParse({ conversationId: ORBIT, chooseSource: jest.fn() })).toEqual({
      kind: 'failed',
      reason: 'key_pending',
    });
    expect(jobCount()).toBe(0);
  });

  it('names the allowance probe being unreachable', async () => {
    parseEmitting(1);
    mockGetGroupImports.mockRejectedValue(new NetworkError('offline'));

    expect(await pickAndStartParse({ conversationId: ORBIT, chooseSource: jest.fn() })).toEqual({
      kind: 'failed',
      reason: 'network',
    });
    expect(jobCount()).toBe(0);
    expect(mockStartImport).not.toHaveBeenCalled();
  });

  it('falls back to other for a failure with no class of its own', async () => {
    mockParseArchive.mockRejectedValue(new TypeError('boom'));

    expect(await pickAndStartParse({ conversationId: ORBIT, chooseSource: jest.fn() })).toEqual({
      kind: 'failed',
      reason: 'other',
    });
    expect(jobCount()).toBe(0);
  });

  it.each([
    [
      'the picker was already open',
      (): void => {
        mockPickArchiveParts.mockRejectedValue(new ArchiveReaderError('PICKER_BUSY'));
      },
    ],
    [
      'the read was cancelled',
      (): void => {
        mockOpenArchiveSession.mockRejectedValue(new ArchiveReaderError('ECANCELLED'));
      },
    ],
  ])('stays a plain cancel when %s', async (_label, arrange) => {
    arrange();

    // Neither is a failure: nothing was chosen, or the member stopped it, and
    // #928 shows no message for either.
    expect(await pickAndStartParse({ conversationId: ORBIT, chooseSource: jest.fn() })).toEqual({
      kind: 'cancelled',
    });
    expect(jobCount()).toBe(0);
  });

  it('keeps a too-large photo distinct from an unsupported one', async () => {
    seedJob({ items: 1, bookmark: ['part-a'], mediaEntryIds: ['entry-0-0'] });
    const tooLarge = Object.assign(new Error('over the pixel ceiling'), {
      name: 'ImageSanitizeError',
      reason: 'too-many-pixels',
    });
    mockUploadMedia.mockRejectedValue(tooLarge);

    await confirmAndRunLaunch();

    // #918's D12 asked for its own copy; folded into
    // `IMPORT_MEDIA_UNSUPPORTED` that copy could never be shown.
    expect(itemRows()[0]).toEqual({
      id: 'item-0',
      status: 'failed',
      error_code: 'IMPORT_MEDIA_TOO_LARGE',
    });
    expect(importStore.getState().summary?.failed).toBe(1);
    expect(importStore.getState().summary?.errorCode).toBeNull();
    expect(jobRow().status).toBe('completed');
  });
});

// ===========================================================================
// Group: what did not migrate (#928 gap 6 / B1)
// ===========================================================================

describe('the unmigrated list', () => {
  it('lists only skipped rows while the job is still at preflight', async () => {
    // 50 importable posts, all `pending` because nothing has been attempted.
    seedJob({ status: 'ready', items: 50, skips: ['held_video', 'empty_post'] });
    await resumeImportAtLaunch();
    expect(importStore.getState().phase).toBe('ready');

    const list = getImportUnmigratedItems();

    // B1: reading `pending` here would file all 50 importable posts under
    // "not sent before the import stopped" — on the screen that is offering
    // to import them, and contradicting the skip count beside it.
    expect(list.items).toHaveLength(2);
    expect(list.items.every((item) => item.kind === 'skipped')).toBe(true);
    expect(list.counts.notSent).toBe(0);
    expect(list.counts.failed).toEqual({});
    expect(list.counts.skipped).toEqual({ held_video: 1, empty_post: 1 });
    expect(list.truncated).toBe(0);
  });

  it('carries the row facts #928 renders, and no body', async () => {
    seedJob({ status: 'ready', items: 1, skips: ['image_too_large'] });
    await resumeImportAtLaunch();

    const [row] = getImportUnmigratedItems().items;

    expect(row).toEqual({
      id: 'skip-0',
      kind: 'skipped',
      reason: 'image_too_large',
      originalDate: POST_DATE,
      sourceFile: 'your_posts_1.json',
      sourceIndex: 1,
    });
    // `source_file` is local-UI class; the post body is not in the shape at all.
    expect(Object.keys(row)).not.toContain('body');
  });

  it('caps the list but not the counts', async () => {
    seedJob({
      status: 'ready',
      items: 0,
      skips: Array.from({ length: 1001 }, () => 'empty_post' as SkipReason),
    });
    await resumeImportAtLaunch();

    const list = getImportUnmigratedItems();

    // op-sqlite's `executeSync` blocks the JS thread, so the screen never
    // materializes more rows than it displays. The headers and the "…and N
    // more not listed" footer come from a COUNT, which is not capped.
    expect(list.items).toHaveLength(1000);
    expect(list.truncated).toBe(1);
    expect(list.counts.skipped).toEqual({ empty_post: 1001 });
  });

  it('adds failed rows once the run has settled', async () => {
    seedJob({ items: 2, skips: ['empty_post'] });
    mockSubmitImportBatch.mockImplementation(
      async (_id: string, body: { items: { importKey: string }[] }) => ({
        results: [
          { importKey: body.items[0].importKey, status: 'rejected', code: 'IMPORT_DATE_INVALID' },
          {
            importKey: body.items[1].importKey,
            status: 'created',
            threadId: threadUuid('1'),
            createdAt: '2012-08-26T00:00:00.000Z',
          },
        ],
        allowance: allowance(1),
      }),
    );

    await confirmAndRunLaunch();
    const list = getImportUnmigratedItems();

    expect(list.items).toEqual([
      expect.objectContaining({ id: 'item-0', kind: 'failed', code: 'IMPORT_DATE_INVALID' }),
      expect.objectContaining({ id: 'skip-0', kind: 'skipped', reason: 'empty_post' }),
    ]);
    expect(list.counts.failed).toEqual({ IMPORT_DATE_INVALID: 1 });
    expect(list.counts.notSent).toBe(0);
  });

  it('adds the rows that were never sent', async () => {
    const repository = require('../../../database/repositories/importRepository');
    const spy = jest
      .spyOn(repository, 'getPendingImportItems')
      .mockImplementationOnce((): never => {
        throw new TypeError('getPendingImportItems is not a function');
      });
    try {
      seedJob({ items: 2 });
      await confirmAndRunLaunch();
      expect(importStore.getState().summary?.errorCode).toBe('CLIENT_BUG');

      const list = getImportUnmigratedItems();

      // The third group #926's skip API could not express: still queued when
      // the run stopped, body already NULLed, so only a re-pick recovers them.
      expect(list.items.map((item) => item.kind)).toEqual(['not_sent', 'not_sent']);
      expect(list.counts.notSent).toBe(2);
    } finally {
      spy.mockRestore();
    }
  });

  it('reads an extract-time hold as a skip, not as unsent', async () => {
    seedJob({
      items: 1,
      bookmark: ['part-a'],
      mediaEntryIds: ['entry-0-0'],
      skips: ['held_video'],
    });
    mockOpenArchiveSession.mockImplementation(async () => videoArchiveSession());

    await confirmAndRunLaunch();
    const list = getImportUnmigratedItems();

    // The row is parked in `uploading`, which is also where an unsent batch
    // claim lives. `lastSettledHeld` is the only record that tells them apart
    // once the run is gone.
    expect(itemRows()[0].status).toBe('uploading');
    expect(list.items).toEqual([
      expect.objectContaining({ id: 'item-0', kind: 'skipped', reason: 'held_video' }),
      expect.objectContaining({ id: 'skip-0', kind: 'skipped', reason: 'held_video' }),
    ]);
    expect(list.counts.notSent).toBe(0);
    // Both halves — the parse-time skip and the extract-time hold — under one
    // reason, and the same number the summary line beside it shows.
    expect(list.counts.skipped).toEqual({ held_video: 2 });
    expect(list.counts.skipped.held_video).toBe(importStore.getState().summary?.heldVideo);
  });

  it('falls back to the sentinel for a failed row with no code at all', async () => {
    seedJob({ items: 1 });
    await confirmAndRunLaunch();
    // `error_code` is nullable, and a `failed` row that never carried one is
    // reachable from any writer that fails an item without a verdict.
    harness.sqlite
      .prepare("UPDATE import_items SET status = 'failed', error_code = NULL WHERE id = ?")
      .run('item-0');

    const list = getImportUnmigratedItems();

    expect(list.items).toEqual([
      expect.objectContaining({ kind: 'failed', code: 'IMPORT_RESULT_UNKNOWN' }),
    ]);
    expect(list.counts.failed).toEqual({ IMPORT_RESULT_UNKNOWN: 1 });
  });

  it('falls back to the sentinel for a code this build does not know', async () => {
    seedJob({ items: 1 });
    await confirmAndRunLaunch();
    // A code written by a newer build, or a server vocabulary that widened
    // under us: #928 has no copy for it, so it must not reach the copy table.
    harness.sqlite
      .prepare("UPDATE import_items SET status = 'failed', error_code = ? WHERE id = ?")
      .run('IMPORT_SOMETHING_NEW', 'item-0');

    const list = getImportUnmigratedItems();

    expect(list.items).toEqual([
      expect.objectContaining({ kind: 'failed', code: 'IMPORT_RESULT_UNKNOWN' }),
    ]);
    expect(list.counts.failed).toEqual({ IMPORT_RESULT_UNKNOWN: 1 });
  });

  it('answers nothing at all while the parse is still reading', async () => {
    mockParseArchive.mockImplementation(
      async (_session: unknown, opts: { signal: AbortSignal }): Promise<never> => {
        await new Promise<void>((resolve) => {
          opts.signal.addEventListener('abort', () => resolve(), { once: true });
        });
        throw new ArchiveReaderError('ECANCELLED');
      },
    );
    const picking = pickAndStartParse({ conversationId: ORBIT, chooseSource: jest.fn() });
    await drain();
    expect(importStore.getState().phase).toBe('parsing');

    // The answer is still being written: a prefix of the archive is not a
    // list of what did not migrate.
    expect(getImportUnmigratedItems()).toEqual({
      items: [],
      counts: { skipped: {}, failed: {}, notSent: 0 },
      truncated: 0,
    });

    cancelImport();
    await picking;
  });

  it('answers nothing at all while the run is still draining', async () => {
    seedJob({ items: 2, skips: ['empty_post'] });
    const held = deferred<unknown>();
    mockSubmitImportBatch.mockImplementation(() => held.promise);

    const running = resumeImportAtLaunch();
    await drain();
    expect(importStore.getState().phase).toBe('running');

    // Half the queue is claimed and in flight; the other half is `pending`
    // and may still become a post.
    expect(getImportUnmigratedItems().items).toEqual([]);

    cancelImport();
    held.resolve(createdFor([]));
    await running;
  });

  it('is empty again once the summary is dismissed', async () => {
    seedJob({ items: 1, bookmark: ['part-a'], mediaEntryIds: ['entry-0-0'] });
    mockOpenArchiveSession.mockImplementation(async () => videoArchiveSession());
    await confirmAndRunLaunch();
    expect(getImportUnmigratedItems().items).toHaveLength(1);

    dismissImportSummary();

    // The screen snapshots on mount and Share is how a member keeps the list;
    // the dismiss drops the job identity AND the held set behind it.
    expect(getImportUnmigratedItems()).toEqual({
      items: [],
      counts: { skipped: {}, failed: {}, notSent: 0 },
      truncated: 0,
    });
  });
});

// ===========================================================================
// Group: discarding a ready job (#928 gaps 2 and 2b)
// ===========================================================================

describe('discarding a preflight', () => {
  it('releases the parts and deletes a runnable job, with no network call', async () => {
    seedJob({ status: 'ready', items: 2, bookmark: ['part-a'] });
    await resumeImportAtLaunch();
    expect(importStore.getState().phase).toBe('ready');
    mockGetGroupImports.mockClear();

    await discardImportPreflight();

    // `pickAndStartParse`'s finally KEEPS a runnable job's parts for the run
    // that was about to use them; this is where that grant is handed back.
    expect(mockReleaseArchiveParts).toHaveBeenCalledWith(['part-a']);
    expect(getImportJob(JOB)).toBeNull();
    expect(importStore.getState().phase).toBe('idle');
    expect(importStore.getState().jobId).toBeNull();
    // No session was ever started, so there is nothing to complete and none
    // of the member's allowance was spent.
    expect(mockCompleteImport).not.toHaveBeenCalled();
    expect(mockStartImport).not.toHaveBeenCalled();
    expect(mockGetGroupImports).not.toHaveBeenCalled();
  });

  it('lets the next pick through', async () => {
    seedJob({ status: 'ready', items: 1, bookmark: ['part-a'] });
    await resumeImportAtLaunch();
    await discardImportPreflight();

    parseEmitting(2);
    const result = await pickAndStartParse({ conversationId: ORBIT, chooseSource: jest.fn() });

    // A `ready` job left behind answers every later pick `job-running`, with
    // no way for the member to start over.
    expect(result.kind).toBe('preflight');
  });

  it('returns a refused preflight to idle', async () => {
    // Over the remaining allowance: the job is already `cancelled`, but the
    // store still reads `ready` with the refusal on screen.
    mockGetGroupImports.mockResolvedValue(
      groupImports({ allowances: allowances({ facebook: allowance(999) }) }),
    );
    parseEmitting(2);
    const result = await pickAndStartParse({ conversationId: ORBIT, chooseSource: jest.fn() });
    expect(result.kind).toBe('preflight');
    expect(importStore.getState().preflight?.overAllowance).toBe('posts');
    expect(importStore.getState().phase).toBe('ready');

    await discardImportPreflight();

    expect(importStore.getState().phase).toBe('idle');
    expect(importStore.getState().preflight).toBeNull();
  });

  it('reaches a ready job whose preflight could not be rebuilt', async () => {
    seedJob({ status: 'ready', items: 1, bookmark: ['part-a'] });
    // The orbit the member has since left: `getGroupImports` fails every
    // time, and nothing else ever deletes this row (gap 2b).
    mockGetGroupImports.mockRejectedValue(new AuthError(403));

    await resumeImportAtLaunch();
    expect(importStore.getState().phase).toBe('idle');
    expect(importStore.getState().jobId).toBe(JOB);

    await discardImportPreflight();

    // A phase-only gate could never reach this job, and the member would be
    // refused `job-running` for ever.
    expect(getImportJob(JOB)).toBeNull();
    expect(mockReleaseArchiveParts).toHaveBeenCalledWith(['part-a']);
    expect(importStore.getState().jobId).toBeNull();
  });

  it('writes nothing when a wipe lands during the discard', async () => {
    seedJob({ status: 'ready', items: 1, bookmark: ['part-a'] });
    await resumeImportAtLaunch();
    mockReleaseArchiveParts.mockImplementation(async () => {
      resetImportRunnerState();
    });

    await discardImportPreflight();

    expect(getImportJob(JOB)).not.toBeNull();
    expect(importStore.getState()).toEqual(importStore.getInitialState());
  });
});

// ===========================================================================
// Group: the published progress fields (#928 gap 3)
// ===========================================================================

describe('media progress', () => {
  it('still publishes mediaDone, the only counter that moves in a batch', async () => {
    seedJob({ items: 1, bookmark: ['part-a'], mediaEntryIds: ['entry-0-0', 'entry-0-1'] });

    await confirmAndRunLaunch();

    // `mediaTotal` was removed because nothing ever wrote it; `mediaDone` has
    // a producer and is the only signal that moves while up to 50 photos
    // upload under one post.
    expect(importStore.getState().mediaDone).toBe(2);
    expect('mediaTotal' in importStore.getState()).toBe(false);
  });
});

// ===========================================================================
// Group: member actions queue, they do not join (PR #995)
// ===========================================================================

describe('a member action racing the pre-run gate', () => {
  /** The session payload the launch gate accepts. */
  function openSession(declaredPosts = 1) {
    return {
      importId: IMPORT_ID,
      groupId: ORBIT,
      status: 'open',
      declaredPosts,
      declaredBytes: 4096,
      createdPosts: 0,
      createdAt: '2012-08-26T00:00:00.000Z',
      lastActivityAt: '2012-08-26T00:00:00.000Z',
      completedAt: null,
      allowance: allowance(),
      limits: LIMITS,
    };
  }

  it('discards behind an in-flight resume instead of joining it', async () => {
    seedJob({ status: 'ready', items: 1, bookmark: ['part-a'] });
    const allowanceGet = deferred<unknown>();
    mockGetGroupImports.mockImplementation(() => allowanceGet.promise);

    // Retry on the blocked view: a launch resume parked on the allowance GET,
    // which offline takes the transport's full 15 s.
    const retrying = resumeImportAtLaunch();
    await drain();
    expect(getImportJob(JOB)).not.toBeNull();

    // Start over, while that entry is still in flight. `enterPreRun` would
    // answer this with the resume's promise and never run the discard: the
    // row and its grant survived, and the screen's spinner never cleared.
    const discarding = discardImportPreflight();
    await drain();

    allowanceGet.resolve(groupImports());
    await retrying;
    await discarding;
    await drain();

    expect(getImportJob(JOB)).toBeNull();
    expect(mockReleaseArchiveParts).toHaveBeenCalledWith(['part-a']);
    expect(importStore.getState().phase).toBe('idle');
    expect(importStore.getState().jobId).toBeNull();
  });

  it('still discards when the resume it waited for failed', async () => {
    seedJob({ status: 'ready', items: 1, bookmark: ['part-a'] });
    const allowanceGet = deferred<unknown>();
    mockGetGroupImports.mockImplementation(() => allowanceGet.promise);

    const retrying = resumeImportAtLaunch();
    await drain();
    const discarding = discardImportPreflight();
    await drain();

    // Offline for the whole 15 s, and then it fails. The member's Start over
    // is the only thing left that can clear this job.
    allowanceGet.reject(new NetworkError('offline'));
    await retrying;
    await discarding;
    await drain();

    expect(getImportJob(JOB)).toBeNull();
    expect(importStore.getState().jobId).toBeNull();
  });

  it('lands a pre-run Stop that another entry grabs the gate ahead of', async () => {
    seedJob({ items: 1 });
    const parked = deferred<unknown>();
    let gets = 0;
    mockGetImportSession.mockImplementation(() => {
      gets += 1;
      if (gets === 1) return Promise.reject(new NetworkError('offline'));
      if (gets === 2) return parked.promise;
      return Promise.reject(new NetworkError('offline'));
    });

    await resumeImportAtLaunch();
    expect(importStore.getState().phase).toBe('paused');

    // Entry A is parked on the session GET.
    const entryA = resumeImportAtLaunch();
    await drain();
    expect(gets).toBe(2);

    // The member taps Stop...
    cancelImport();
    // ...and a second entry claims the gate the instant A unwinds, which is
    // the window where the Stop used to be absorbed: its one `enterPreRun`
    // JOINED that entry, and `cancelBeforeRun` never ran.
    void entryA.then(() => resumeImportAtLaunch()).catch(() => {});
    parked.resolve(openSession());
    await entryA;
    await drain();

    expect(jobRow().status).toBe('cancelled');
    expect(importStore.getState().phase).toBe('done');
    expect(importStore.getState().summary?.cancelled).toBe(true);
    expect(mockSubmitImportBatch).not.toHaveBeenCalled();
    expect(itemRows()[0].status).toBe('pending');
  });

  it('writes nothing when a wipe lands while the group key is opening', async () => {
    parseEmitting(1);
    // The one await between the picker and the first write. A wipe landing
    // here used to get a job row, an archive bookmark and a `parsing` publish
    // written through it — rule 0's own docblock said otherwise.
    const keyOpen = deferred();
    mockKeyOpenGate = keyOpen.promise;

    const picking = pickAndStartParse({ conversationId: ORBIT, chooseSource: jest.fn() });
    await drain();
    resetImportRunnerState();
    mockKeyOpenGate = null;
    keyOpen.resolve();
    const result = await picking;

    expect(result).toEqual({ kind: 'cancelled' });
    expect(jobCount()).toBe(0);
    expect(mockParseArchive).not.toHaveBeenCalled();
    expect(importStore.getState()).toEqual(importStore.getInitialState());
    // Every session this pick opened is closed, on this path as on the others.
    expect(mockKeySessions.every((session) => session.closed === 1)).toBe(true);
  });
});

// ===========================================================================
// Group: a job the allowance could not be read for (PR #995)
// ===========================================================================

describe('a job whose preflight cannot be rebuilt', () => {
  /** An `in_progress` job that never got as far as a server session. */
  function seedUndeclaredJob(): void {
    seedJob({ status: 'ready', items: 1, bookmark: ['part-a'] });
    // `startImportJob` is the only writer of `session_id`, and it runs from
    // `runJob`: this is an import that stopped before it ever declared.
    harness.sqlite.prepare("UPDATE import_jobs SET status = 'in_progress' WHERE id = ?").run(JOB);
  }

  it('publishes the job identity, so the member sees a blocked import', async () => {
    seedUndeclaredJob();
    mockGetGroupImports.mockRejectedValue(new NetworkError('offline'));

    await resumeImportAtLaunch();

    // `idle` with NO jobId reads as "no import" while every pick is refused
    // `job-running` — a dead end the member cannot act on. With the identity,
    // `deriveImportView` answers `blocked`, which offers Retry and Start over.
    const state = importStore.getState();
    expect(state.phase).toBe('idle');
    expect(state.jobId).toBe(JOB);
    expect(state.conversationId).toBe(ORBIT);
    expect(state.source).toBe('facebook');
    expect(jobRow().status).toBe('in_progress');
  });

  it('publishes the job identity on the confirm path too', async () => {
    seedJob({ status: 'ready', items: 1 });
    mockGetGroupImports.mockRejectedValue(new NetworkError('offline'));

    // No launch rebuild ran, so there is no cached preflight to price the run
    // from and the confirm has to ask — the same dead end from the other side.
    await confirmAndRunImport();

    expect(importStore.getState().phase).toBe('idle');
    expect(importStore.getState().jobId).toBe(JOB);
    expect(mockStartImport).not.toHaveBeenCalled();
    expect(jobRow().status).toBe('ready');
  });

  it('starts over from a blocked job that declared nothing', async () => {
    seedUndeclaredJob();
    mockGetGroupImports.mockRejectedValue(new NetworkError('offline'));
    await resumeImportAtLaunch();
    expect(importStore.getState().jobId).toBe(JOB);

    await discardImportPreflight();

    // Nothing was declared server-side, so there is nothing to complete and
    // no allowance to refund: it settles as a cancel, with a summary, through
    // the one path that writes a terminal status.
    expect(jobRow().status).toBe('cancelled');
    expect(importStore.getState().phase).toBe('done');
    expect(importStore.getState().summary?.cancelled).toBe(true);
    expect(mockCompleteImport).not.toHaveBeenCalled();
    expect(mockReleaseArchiveParts).toHaveBeenCalledWith(['part-a']);
  });

  it('clears a stale job identity the row no longer backs', async () => {
    seedUndeclaredJob();
    mockGetGroupImports.mockRejectedValue(new NetworkError('offline'));
    await resumeImportAtLaunch();
    expect(importStore.getState().jobId).toBe(JOB);
    // The row went away underneath the blocked view — another device's wipe,
    // or a job this app already finished.
    harness.sqlite.prepare('DELETE FROM import_jobs').run();

    await discardImportPreflight();

    // Something must move: a no-op here leaves the screen latched on a
    // spinner with a jobId that explains nothing.
    expect(importStore.getState().phase).toBe('idle');
    expect(importStore.getState().jobId).toBeNull();
  });

  it('refuses to throw away declared work, and says so', async () => {
    seedJob({ items: 1 });
    mockGetImportSession.mockRejectedValue(new NetworkError('offline'));
    await resumeImportAtLaunch();
    expect(importStore.getState().phase).toBe('paused');

    await discardImportPreflight();

    // Defensive: this job HAS a server session, so its staged bytes are a
    // lien on the orbit and Stop — not Start over — is what closes it. The
    // row is untouched and the identity is republished rather than dropped.
    expect(jobRow().status).toBe('in_progress');
    expect(importStore.getState().jobId).toBe(JOB);
    expect(importStore.getState().phase).toBe('idle');
  });
});

// ===========================================================================
// Group: a queued action that waited too long (#995 fold round)
// ===========================================================================

describe('a queued pre-run action', () => {
  /** The session payload the launch gate accepts. */
  function openSession() {
    return {
      importId: IMPORT_ID,
      groupId: ORBIT,
      status: 'open',
      declaredPosts: 1,
      declaredBytes: 4096,
      createdPosts: 0,
      createdAt: '2012-08-26T00:00:00.000Z',
      lastActivityAt: '2012-08-26T00:00:00.000Z',
      completedAt: null,
      allowance: allowance(),
      limits: LIMITS,
    };
  }

  it('abandons a discard when a wipe lands while it waits', async () => {
    seedJob({ status: 'ready', items: 1, bookmark: ['part-a'] });
    // No `session_id`: the arm that settles the job through `cancelBeforeRun`,
    // which is the one that would write a terminal status and a summary.
    harness.sqlite.prepare("UPDATE import_jobs SET status = 'in_progress' WHERE id = ?").run(JOB);
    const allowanceGet = deferred<unknown>();
    mockGetGroupImports.mockImplementation(() => allowanceGet.promise);

    const retrying = resumeImportAtLaunch();
    await drain();
    const discarding = discardImportPreflight();
    await drain();

    // The member logs out while the discard is still queued. Stamping
    // `gen`/`token` AFTER the wait would read the post-wipe pair and match
    // itself, and the job would be finished through the wipe.
    resetImportRunnerState();
    allowanceGet.resolve(groupImports());
    await retrying;
    await discarding;
    await drain();

    expect(jobRow().status).toBe('in_progress');
    expect(mockCompleteImport).not.toHaveBeenCalled();
    expect(importStore.getState()).toEqual(importStore.getInitialState());
  });

  it('leaves a finished import alone when the discard finally lands', async () => {
    seedJob({ items: 2, bookmark: ['part-a'], mediaEntryIds: ['entry-0-0'] });
    mockOpenArchiveSession.mockImplementation(async () => videoArchiveSession());
    const batch = deferred();
    mockSubmitImportBatch.mockImplementation(
      async (_id: string, body: { items: { importKey: string }[] }) => {
        await batch.promise;
        return createdFor(body.items);
      },
    );

    const running = resumeImportAtLaunch();
    await drain();
    expect(importStore.getState().phase).toBe('running');

    // `enterJob` awaits `runJob`, so the latch is held for the WHOLE run: by
    // the time this gets the gate the member is reading a summary.
    const discarding = discardImportPreflight();
    await drain();

    batch.resolve();
    await running;
    await discarding;
    await drain();

    // Only `dismissImportSummary` may clear a `done` phase, and resetting the
    // store here would also drop `lastSettledHeld` — the one record that
    // tells the held video row from an unsent one.
    expect(importStore.getState().phase).toBe('done');
    expect(importStore.getState().summary?.created).toBe(1);
    expect(importStore.getState().summary?.heldVideo).toBe(1);
    expect(getImportUnmigratedItems().items).toEqual([
      expect.objectContaining({ id: 'item-0', kind: 'skipped', reason: 'held_video' }),
    ]);
  });

  it('does not stop a run that already finished', async () => {
    seedJob({ items: 1 });
    const parked = deferred<unknown>();
    let gets = 0;
    mockGetImportSession.mockImplementation(() => {
      gets += 1;
      if (gets === 1) return Promise.reject(new NetworkError('offline'));
      if (gets === 2) return parked.promise;
      return Promise.resolve(openSession());
    });

    await resumeImportAtLaunch();
    expect(importStore.getState().phase).toBe('paused');
    const entryA = resumeImportAtLaunch();
    await drain();

    // The member taps Stop while the store still reads `paused`...
    cancelImport();
    // ...and the entry that claims the gate next runs the job to completion
    // before the queued cancel ever gets there.
    void entryA.then(() => resumeImportAtLaunch()).catch(() => {});
    parked.resolve(openSession());
    await entryA;
    await drain();

    // `cancelled` over `completed`, a second `/complete` and a cancelled
    // summary over the real one: all three are what the re-read prevents.
    expect(jobRow().status).toBe('completed');
    expect(importStore.getState().phase).toBe('done');
    expect(importStore.getState().summary?.cancelled).toBe(false);
    expect(importStore.getState().summary?.created).toBe(1);
    expect(mockCompleteImport).toHaveBeenCalledTimes(1);
  });

  it('reports failure rather than a success it never achieved', async () => {
    seedJob({ status: 'ready', items: 1, bookmark: ['part-a'] });

    // Each entry is registered on the one before it DIRECTLY, never on a
    // derived promise: adoption costs two extra ticks, which would hand the
    // gate to the queued discard instead of to the next entry.
    const hogGate = (times: number): Promise<void> =>
      times === 0 ? Promise.resolve() : resumeImportAtLaunch().then(() => hogGate(times - 1));

    // An entry claims the gate the instant the one before it unwinds, over
    // and over. The queue's budget runs out with `fn` never having run.
    const hogging = hogGate(10);
    const discarding = discardImportPreflight();

    // Resolving here would unlatch the screen as though Start over had
    // happened — the silent drop this whole function exists to prevent.
    await expect(discarding).rejects.toThrow(/pre-run gate/);
    await hogging;

    expect(getImportJob(JOB)).not.toBeNull();
    expect(mockReleaseArchiveParts).not.toHaveBeenCalled();
  });

  it('writes nothing when a wipe lands while the archive is opening', async () => {
    const opening = deferred<ArchiveImportSession>();
    mockOpenArchiveSession.mockImplementation(() => opening.promise);

    const picking = pickAndStartParse({ conversationId: ORBIT, chooseSource: jest.fn() });
    await drain();
    resetImportRunnerState();
    opening.resolve(archiveSession());

    expect(await picking).toEqual({ kind: 'cancelled' });
    // The first of the two `stale()` checks: the key session is opened after
    // it, so a wipe here costs no key material and no row.
    expect(mockKeySessions).toHaveLength(0);
    expect(jobCount()).toBe(0);
    expect(importStore.getState()).toEqual(importStore.getInitialState());
  });
});

// ===========================================================================
// Group: which source this archive is (#996)
// ===========================================================================

describe('source detection at the pick', () => {
  it('uses the only source in the archive, without asking', async () => {
    mockOpenArchiveSession.mockImplementation(async () => instagramArchiveSession());
    parseEmitting(1);
    const chooseSource = jest.fn();

    const result = await pickAndStartParse({ conversationId: ORBIT, chooseSource });

    // One source is not a choice. Asking anyway is the dead end #996 removes:
    // a member who picks the row that is not in their export.
    expect(chooseSource).not.toHaveBeenCalled();
    expect(result.kind).toBe('preflight');
    expect(soleJob().status).toBe('ready');
    expect(importStore.getState().source).toBe('instagram');
    expect(importStore.getState().preflight?.source).toBe('instagram');
  });

  it('uses Facebook when that is all the archive holds', async () => {
    parseEmitting(1);
    const chooseSource = jest.fn();

    await pickAndStartParse({ conversationId: ORBIT, chooseSource });

    expect(chooseSource).not.toHaveBeenCalled();
    expect(importStore.getState().preflight?.source).toBe('facebook');
  });

  it('fails with no_posts when neither source is in the files', async () => {
    mockOpenArchiveSession.mockImplementation(async () => noPostsArchiveSession());
    const chooseSource = jest.fn();

    const result = await pickAndStartParse({ conversationId: ORBIT, chooseSource });

    // Readable files that simply hold no posts — a different ask from
    // `archive`, which is about files Orbital could not read at all.
    expect(result).toEqual({ kind: 'failed', reason: 'no_posts' });
    expect(chooseSource).not.toHaveBeenCalled();
    // Nothing was opened, written or kept: no key session, no row, no grant,
    // and the store never left idle.
    expect(mockKeySessions).toHaveLength(0);
    expect(jobCount()).toBe(0);
    expect(mockReleaseArchiveParts).toHaveBeenCalledWith(['part-a']);
    expect(mockParseArchive).not.toHaveBeenCalled();
    // Not one publish: the pick failed before the `parsing` state existed, so
    // whatever the screen was showing is still what it shows.
    expect(importStore.getState()).toEqual(importStore.getInitialState());
  });

  it('asks which source first when the archive holds both', async () => {
    mockOpenArchiveSession.mockImplementation(async () => bothSourcesArchiveSession());
    parseEmitting(1);
    const chooseSource = jest.fn().mockResolvedValue('instagram');

    const result = await pickAndStartParse({ conversationId: ORBIT, chooseSource });

    expect(chooseSource).toHaveBeenCalledTimes(1);
    expect(result.kind).toBe('preflight');
    // Each job is single-source; the summary offers the other afterwards.
    expect(soleJobSource()).toBe('instagram');
    expect(importStore.getState().preflight?.source).toBe('instagram');
  });

  it.each([
    ['the member backs out', async () => null],
    ['the chooser rejects', async () => Promise.reject(new Error('boom'))],
    ['the answer is not a source', async () => 'threads'],
    ['the answer is undefined', async () => undefined],
  ])('cancels when %s', async (_label, answer) => {
    mockOpenArchiveSession.mockImplementation(async () => bothSourcesArchiveSession());
    parseEmitting(1);

    const result = await pickAndStartParse({
      conversationId: ORBIT,
      chooseSource: answer as () => Promise<never>,
    });

    // A non-literal is the dangerous one: it would otherwise become a job
    // row, a key session and an allowance bucket that do not exist.
    expect(result).toEqual({ kind: 'cancelled' });
    expect(mockKeySessions).toHaveLength(0);
    expect(jobCount()).toBe(0);
    expect(importStore.getState()).toEqual(importStore.getInitialState());
  });

  it('settles the chooser when the member cancels the pick', async () => {
    mockOpenArchiveSession.mockImplementation(async () => bothSourcesArchiveSession());
    const pending = deferred<'facebook' | 'instagram' | null>();

    const picking = pickAndStartParse({
      conversationId: ORBIT,
      chooseSource: () => pending.promise,
    });
    await drain();

    // Without the abort race this waits for a member who may never answer,
    // holding the archive session and the picker's grant.
    cancelImport();

    expect(await picking).toEqual({ kind: 'cancelled' });
    expect(jobCount()).toBe(0);
    expect(mockParseArchive).not.toHaveBeenCalled();
  });

  it('settles the chooser on a wipe, and writes nothing', async () => {
    mockOpenArchiveSession.mockImplementation(async () => bothSourcesArchiveSession());
    const pending = deferred<'facebook' | 'instagram' | null>();

    const picking = pickAndStartParse({
      conversationId: ORBIT,
      chooseSource: () => pending.promise,
    });
    await drain();

    resetImportRunnerState();

    expect(await picking).toEqual({ kind: 'cancelled' });
    expect(jobCount()).toBe(0);
    expect(mockGetGroupImports).not.toHaveBeenCalled();
    expect(importStore.getState()).toEqual(importStore.getInitialState());
  });

  it('ignores a late answer from a chooser nobody is waiting for', async () => {
    mockOpenArchiveSession.mockImplementation(async () => bothSourcesArchiveSession());
    const pending = deferred<'facebook' | 'instagram' | null>();
    parseEmitting(1);

    const picking = pickAndStartParse({
      conversationId: ORBIT,
      chooseSource: () => pending.promise,
    });
    await drain();
    cancelImport();
    await picking;

    // The dialog was still up when the pick settled; answering it now must
    // not resurrect the parse.
    pending.resolve('facebook');
    await drain();

    expect(jobCount()).toBe(0);
    expect(mockParseArchive).not.toHaveBeenCalled();
    expect(importStore.getState()).toEqual(importStore.getInitialState());
  });
});

// ===========================================================================
// Group: pricing one source at a time (#996 / B#352)
// ===========================================================================

describe('the per-source allowance', () => {
  it('refuses a Facebook archive the Facebook bucket cannot take', async () => {
    mockGetGroupImports.mockResolvedValue(
      groupImports({ allowances: allowances({ facebook: allowance(999) }) }),
    );
    parseEmitting(5);

    const result = await pickAndStartParse({ conversationId: ORBIT, chooseSource: jest.fn() });

    const preflight = result.kind === 'preflight' ? result.preflight : null;
    expect(preflight?.overAllowance).toBe('posts');
    expect(preflight?.remainingPosts).toBe(1);
  });

  it('leaves the other bucket alone', async () => {
    // Facebook is spent; the same archive read as Instagram still fits.
    mockGetGroupImports.mockResolvedValue(
      groupImports({ allowances: allowances({ facebook: allowance(1000) }) }),
    );
    mockOpenArchiveSession.mockImplementation(async () => instagramArchiveSession());
    parseEmitting(5);

    const result = await pickAndStartParse({ conversationId: ORBIT, chooseSource: jest.fn() });

    const preflight = result.kind === 'preflight' ? result.preflight : null;
    expect(preflight?.source).toBe('instagram');
    expect(preflight?.overAllowance).toBeNull();
    expect(preflight?.remainingPosts).toBe(1000);
  });

  it('rebuilds a launched job against ITS source, not the default', async () => {
    seedJob({ status: 'ready', items: 1, source: 'instagram' });
    mockGetGroupImports.mockResolvedValue(
      groupImports({
        allowances: allowances({ facebook: allowance(1000), instagram: allowance(10) }),
      }),
    );

    await resumeImportAtLaunch();

    // Pricing an Instagram job against the Facebook bucket is how a member
    // gets refused at start by a number the preflight never showed them.
    expect(importStore.getState().preflight?.source).toBe('instagram');
    expect(importStore.getState().preflight?.remainingPosts).toBe(990);
  });

  it.each([
    ['there is no allowances map at all', {}],
    ['a bucket is missing', { allowances: { facebook: allowance() } }],
    [
      'a bucket is half-populated',
      { allowances: { facebook: { postsUsed: 1 }, instagram: allowance() } },
    ],
    [
      'a limit is not a finite number',
      {
        allowances: {
          facebook: { ...allowance(), postsLimit: Number.NaN },
          instagram: allowance(),
        },
      },
    ],
  ])('reads a response as unavailable when %s', async (_label, over) => {
    mockGetGroupImports.mockResolvedValue({ openImport: null, limits: LIMITS, ...over });

    const probe = await probeImportAvailability(ORBIT);

    // Fail closed: "remaining" is a used/limit PAIR, so a half-populated
    // bucket would read as zero room and refuse an archive that fits.
    expect(probe).toEqual({ available: false, allowances: null, limits: null });
    // NOT cached — only a 404 is sticky, so a server deploy mid-session fixes
    // itself without a relaunch.
    mockGetGroupImports.mockResolvedValue(groupImports());
    expect((await probeImportAvailability(ORBIT)).available).toBe(true);
  });

  it('caches a 404 but never a wipe', async () => {
    mockGetGroupImports.mockImplementation(async () => {
      // The account is torn down while the GET is in flight.
      resetImportRunnerState();
      return groupImports();
    });

    const probe = await probeImportAvailability(ORBIT);

    // No allowance residue for the next account on this device.
    expect(probe.available).toBe(false);
    mockGetGroupImports.mockResolvedValue(groupImports());
    expect((await probeImportAvailability(ORBIT)).available).toBe(true);
  });
});

// ===========================================================================
// Group: the other source's open session (#996)
// ===========================================================================

describe('an open import of the other source', () => {
  it('blocks the start without refusing the archive', async () => {
    mockGetGroupImports.mockResolvedValue(
      groupImports({ openImport: openImport({ source: 'instagram' }) }),
    );
    parseEmitting(2);

    const result = await pickAndStartParse({ conversationId: ORBIT, chooseSource: jest.fn() });
    const preflight = result.kind === 'preflight' ? result.preflight : null;

    // The archive is fine; the member's OTHER import is holding the one open
    // slot. Refusing here would release the grant and delete a job they can
    // run the moment that session closes.
    expect(preflight?.otherOpenImport).toEqual({ importId: IMPORT_ID });
    // Runnable as an ARCHIVE — the two refusals are both clear — but not
    // startable, which is the distinction `canStartFromPreflight` draws.
    expect(preflight?.overAllowance).toBeNull();
    expect(preflight?.nothingToImport).toBe(false);
    expect(canStartFromPreflight(preflight as ImportPreflight)).toBe(false);
    expect(soleJob().status).toBe('ready');

    await confirmAndRunImport();
    await drain();

    expect(mockStartImport).not.toHaveBeenCalled();
    expect(importStore.getState().phase).toBe('ready');
  });

  it('is null for an open session of our OWN source', async () => {
    mockGetGroupImports.mockResolvedValue(
      groupImports({ openImport: openImport({ source: 'facebook' }) }),
    );
    parseEmitting(1);

    const result = await pickAndStartParse({ conversationId: ORBIT, chooseSource: jest.fn() });
    const preflight = result.kind === 'preflight' ? result.preflight : null;

    // Ours is an ADOPTION, which the run handles; it is not a block.
    expect(preflight?.otherOpenImport).toBeNull();
    expect(canStartFromPreflight(preflight as ImportPreflight)).toBe(true);
  });

  it.each([
    ['the server states no source', { source: undefined }],
    ['the source is not one we know', { source: 'threads' }],
  ])('counts a session as foreign when %s', async (_label, over) => {
    mockGetGroupImports.mockResolvedValue(groupImports({ openImport: openImport(over) }));
    parseEmitting(1);

    const result = await pickAndStartParse({ conversationId: ORBIT, chooseSource: jest.fn() });
    const preflight = result.kind === 'preflight' ? result.preflight : null;

    // Fail closed: a session we cannot confirm is one we must not adopt —
    // adopting it spends the wrong bucket and closes it on our settle.
    expect(preflight?.otherOpenImport).toEqual({ importId: IMPORT_ID });
  });

  it('ignores a session that is not open', async () => {
    mockGetGroupImports.mockResolvedValue(
      groupImports({ openImport: openImport({ source: 'instagram', status: 'completed' }) }),
    );
    parseEmitting(1);

    const result = await pickAndStartParse({ conversationId: ORBIT, chooseSource: jest.fn() });
    const preflight = result.kind === 'preflight' ? result.preflight : null;

    expect(preflight?.otherOpenImport).toBeNull();
  });
});

// ===========================================================================
// Group: never adopt the other source's session (#996)
// ===========================================================================

describe('a session that is not ours to adopt', () => {
  /** A 409 `IMPORT_IN_PROGRESS`, with whatever details the server stated. */
  function inProgress(details: Record<string, unknown>): ConflictError {
    return new ConflictError(
      JSON.stringify({
        error: 'IMPORT_REFUSED',
        details: { code: 'IMPORT_IN_PROGRESS', ...details },
      }),
    );
  }

  const FOREIGN_ID = '99999999-8888-4777-8666-555555555555';

  /**
   * The first TWO GETs are clean and every later one answers `over`.
   *
   * Two, because the confirm re-prices unconditionally before starting
   * (§7.2): the launch rebuild is the first, the confirm's is the second, and
   * only then does the run make its own. That is what makes these true
   * races — a foreign session visible at either of the first two stops the
   * member at the Import button instead, which is the point of §7.2.
   */
  function foreignFromTheThirdGetOn(over: Record<string, unknown>): void {
    let gets = 0;
    mockGetGroupImports.mockImplementation(async () => {
      gets += 1;
      return gets <= 2 ? groupImports() : groupImports(over);
    });
  }

  /** Launch a `ready` job, confirm it, and let the run settle. */
  async function confirmReadyJob(): Promise<void> {
    await resumeImportAtLaunch();
    await confirmAndRunImport();
    await drain();
  }

  it("is terminal when the run's own GET finds the other source", async () => {
    seedJob({ status: 'ready', items: 1 });
    foreignFromTheThirdGetOn({
      openImport: openImport({ importId: FOREIGN_ID, source: 'instagram' }),
    });

    await confirmReadyJob();

    expect(importStore.getState().summary?.errorCode).toBe('OTHER_IMPORT_OPEN');
    expect(mockStartImport).not.toHaveBeenCalled();
    // THE rule: `settleRun` completes whatever `r.importId` holds, so a
    // foreign id must never be assigned — adopting it would close the
    // member's other import on our way out.
    expect(mockCompleteImport).not.toHaveBeenCalledWith(FOREIGN_ID);
    expect(jobRow().session_id).toBeNull();
  });

  it('is terminal when the START refusal names the other source', async () => {
    seedJob({ status: 'ready', items: 1 });
    mockStartImport.mockRejectedValue(inProgress({ import_id: FOREIGN_ID, source: 'instagram' }));

    await confirmReadyJob();

    expect(importStore.getState().summary?.errorCode).toBe('OTHER_IMPORT_OPEN');
    expect(mockCompleteImport).not.toHaveBeenCalledWith(FOREIGN_ID);
    expect(mockSubmitImportBatch).not.toHaveBeenCalled();
    expect(itemRows()[0].status).toBe('pending');
  });

  it('looks the session up when the refusal states nothing, and refuses a foreign one', async () => {
    seedJob({ status: 'ready', items: 1 });
    mockStartImport.mockRejectedValue(inProgress({}));
    // The run's own preflight GET sees nothing open; the lookup AFTER the
    // refusal is what finds the other source's session.
    let gets = 0;
    mockGetGroupImports.mockImplementation(async () => {
      gets += 1;
      return gets <= 3
        ? groupImports()
        : groupImports({ openImport: openImport({ importId: FOREIGN_ID, source: 'instagram' }) });
    });

    await confirmReadyJob();

    expect(importStore.getState().summary?.errorCode).toBe('OTHER_IMPORT_OPEN');
    expect(mockCompleteImport).not.toHaveBeenCalledWith(FOREIGN_ID);
  });

  it('adopts the looked-up session when it IS ours', async () => {
    seedJob({ status: 'ready', items: 1 });
    mockStartImport.mockRejectedValue(inProgress({}));
    let gets = 0;
    mockGetGroupImports.mockImplementation(async () => {
      gets += 1;
      return gets <= 3
        ? groupImports()
        : groupImports({ openImport: openImport({ importId: 'import-ours', source: 'facebook' }) });
    });

    await confirmReadyJob();

    // Same source: the ordinary adoption, unchanged by #996.
    expect(mockSubmitImportBatch).toHaveBeenCalledWith('import-ours', expect.anything());
    expect(jobRow().status).toBe('completed');
  });

  it('counts an unstated source as foreign', async () => {
    seedJob({ status: 'ready', items: 1 });
    // Only an id: a pre-B#352 server, or one whose winner vanished. We cannot
    // confirm it, so we must not take it.
    mockStartImport.mockRejectedValue(inProgress({ import_id: FOREIGN_ID }));
    foreignFromTheThirdGetOn({
      openImport: openImport({ importId: FOREIGN_ID, source: undefined }),
    });

    await confirmReadyJob();

    expect(importStore.getState().summary?.errorCode).toBe('OTHER_IMPORT_OPEN');
    expect(mockCompleteImport).not.toHaveBeenCalledWith(FOREIGN_ID);
  });

  it('is terminal on the RESTART path too', async () => {
    seedJob({ items: 1, sessionId: IMPORT_ID });
    // The session was abandoned, so the run restarts — and the restart is
    // refused because the member's other import took the slot meanwhile.
    mockSubmitImportBatch.mockRejectedValue(
      new ConflictError(
        JSON.stringify({
          error: 'IMPORT_REFUSED',
          details: { code: 'IMPORT_CLOSED', status: 'abandoned' },
        }),
      ),
    );
    mockStartImport.mockRejectedValue(inProgress({ import_id: FOREIGN_ID, source: 'instagram' }));

    await confirmAndRunLaunch();

    expect(importStore.getState().summary?.errorCode).toBe('OTHER_IMPORT_OPEN');
    expect(mockCompleteImport).not.toHaveBeenCalledWith(FOREIGN_ID);
    // Our OWN session is still completed on the way out — that one is ours.
    expect(mockCompleteImport).toHaveBeenCalledWith(IMPORT_ID);
  });
});

// ===========================================================================
// Group: a stale foreign session never destroys a parsed job (#996 §7.2)
// ===========================================================================

describe('confirming a ready job while the other source is open', () => {
  it('re-prices and stays ready, leaving the row and its grant alone', async () => {
    seedJob({ status: 'ready', items: 2, bookmark: ['part-a'] });
    let gets = 0;
    mockGetGroupImports.mockImplementation(async () => {
      gets += 1;
      // Clean at launch; the member's OTHER import takes the slot before they
      // tap Import.
      return gets === 1
        ? groupImports()
        : groupImports({ openImport: openImport({ importId: 'other-id', source: 'instagram' }) });
    });

    await resumeImportAtLaunch();
    expect(importStore.getState().preflight?.otherOpenImport).toBeNull();

    await confirmAndRunImport();
    await drain();

    // The job is PARSED work with a part grant behind it. Burning it on an
    // `OTHER_IMPORT_OPEN` terminal would make the member re-pick and re-parse
    // for a session that closes on its own.
    expect(jobRow().status).toBe('ready');
    expect(jobRow().archive_bookmark).toBe(JSON.stringify(['part-a']));
    expect(mockStartImport).not.toHaveBeenCalled();
    expect(mockReleaseArchiveParts).not.toHaveBeenCalled();
    expect(importStore.getState().summary).toBeNull();

    // And the published preflight is the FRESH one, so the view can offer to
    // close the other import.
    const state = importStore.getState();
    expect(state.phase).toBe('ready');
    expect(state.preflight?.otherOpenImport).toEqual({ importId: 'other-id' });
    expect(canStartFromPreflight(state.preflight as ImportPreflight)).toBe(false);
  });

  it('starts normally once that session is gone', async () => {
    seedJob({ status: 'ready', items: 1, bookmark: ['part-a'] });
    let gets = 0;
    mockGetGroupImports.mockImplementation(async () => {
      gets += 1;
      return gets === 1
        ? groupImports({ openImport: openImport({ importId: 'other-id', source: 'instagram' }) })
        : groupImports();
    });

    await resumeImportAtLaunch();
    expect(importStore.getState().preflight?.otherOpenImport).toEqual({ importId: 'other-id' });

    await confirmAndRunImport();
    await drain();

    // Nothing had to be re-picked: the same parsed job ran.
    expect(jobRow().status).toBe('completed');
    expect(itemRows()[0].status).toBe('created');
  });

  it('falls through to the run when the reprice GET fails', async () => {
    seedJob({ status: 'ready', items: 1 });
    let gets = 0;
    mockGetGroupImports.mockImplementation(async () => {
      gets += 1;
      if (gets === 1) return groupImports();
      throw rateLimited(60_000);
    });

    await resumeImportAtLaunch();
    // NOT awaited: the pause this reaches waits out the server's own
    // `Retry-After`, which is the behaviour under test.
    void confirmAndRunImport();
    await drain();

    // `rebuildPreflight` swallows every error into null, so treating that as
    // "blocked" would lose the countdown and the automatic retry #993's
    // dropped-verdict fix put on this path. The run's own GET classifies it.
    expect(importStore.getState().phase).toBe('paused');
    expect(importStore.getState().pauseCauses).toEqual(['rate_limited']);
    expect(jobRow().status).toBe('ready');
  });
});

// ===========================================================================
// Group: the session id on our own row (#996 belt check)
// ===========================================================================

describe('a session whose source does not match the job', () => {
  it('is a CLIENT_BUG, and still closes the session', async () => {
    seedJob({ items: 1, source: 'facebook' });
    mockGetImportSession.mockResolvedValue({
      importId: IMPORT_ID,
      groupId: ORBIT,
      status: 'open',
      source: 'instagram',
      declaredPosts: 1,
      declaredBytes: 4096,
      createdPosts: 0,
      createdAt: '2012-08-26T00:00:00.000Z',
      lastActivityAt: '2012-08-26T00:00:00.000Z',
      completedAt: null,
      allowance: allowance(),
      limits: LIMITS,
    });

    await confirmAndRunLaunch();

    // This id came off our OWN job row, so a mismatch is not "someone else's
    // session" — it is this client having written one of the wrong source,
    // which no path should be able to do.
    expect(importStore.getState().summary?.errorCode).toBe('CLIENT_BUG');
    expect(mockSubmitImportBatch).not.toHaveBeenCalled();
    expect(jobRow().status).toBe('failed');
    // It IS ours, so completing it on the way out is right.
    expect(mockCompleteImport).toHaveBeenCalledWith(IMPORT_ID);
  });

  it('runs normally when the server states no source', async () => {
    seedJob({ items: 1 });
    mockGetImportSession.mockResolvedValue({
      importId: IMPORT_ID,
      groupId: ORBIT,
      status: 'open',
      declaredPosts: 1,
      declaredBytes: 4096,
      createdPosts: 0,
      createdAt: '2012-08-26T00:00:00.000Z',
      lastActivityAt: '2012-08-26T00:00:00.000Z',
      completedAt: null,
      allowance: allowance(),
      limits: LIMITS,
    });

    await confirmAndRunLaunch();

    // A belt, not a gate: an older server that says nothing must not fail a
    // job whose id we wrote ourselves.
    expect(jobRow().status).toBe('completed');
  });
});

// ===========================================================================
// Group: closing the other source's import (#996 §2)
// ===========================================================================

describe('closeOtherImport', () => {
  const OTHER_ID = '99999999-8888-4777-8666-555555555555';

  /** A `ready` job whose preflight is blocked by the other source. */
  async function readyBlockedByOther(): Promise<void> {
    seedJob({ status: 'ready', items: 2, bookmark: ['part-a'] });
    mockGetGroupImports.mockResolvedValue(
      groupImports({ openImport: openImport({ importId: OTHER_ID, source: 'instagram' }) }),
    );
    await resumeImportAtLaunch();
    expect(importStore.getState().preflight?.otherOpenImport).toEqual({ importId: OTHER_ID });
  }

  it('closes it, re-prices, and lets the import start', async () => {
    await readyBlockedByOther();
    // Afterwards the slot is free and the allowance has moved.
    mockGetGroupImports.mockResolvedValue(
      groupImports({ allowances: allowances({ facebook: allowance(7) }) }),
    );

    await expect(closeOtherImport()).resolves.toBe('closed');

    expect(mockCompleteImport).toHaveBeenCalledWith(OTHER_ID);
    const state = importStore.getState();
    expect(state.phase).toBe('ready');
    expect(state.preflight?.otherOpenImport).toBeNull();
    expect(state.preflight?.remainingPosts).toBe(993);
    expect(canStartFromPreflight(state.preflight as ImportPreflight)).toBe(true);
    // Nothing local was written: this is a server-side close and a reprice.
    expect(jobRow().status).toBe('ready');
    expect(mockReleaseArchiveParts).not.toHaveBeenCalled();
  });

  it('keeps the parse summary through the reprice', async () => {
    // From a PARSE, not a launch rebuild: a rebuilt preflight has no summary
    // to lose (the `ParseSummary` is not persisted), so only this path can
    // show the reprice preserving one.
    mockGetGroupImports.mockResolvedValue(
      groupImports({ openImport: openImport({ importId: OTHER_ID, source: 'instagram' }) }),
    );
    parseEmitting(2, { skips: ['empty_post'] });
    await pickAndStartParse({ conversationId: ORBIT, chooseSource: jest.fn() });
    const before = importStore.getState().preflight?.summary;
    expect(before).not.toBeNull();
    expect(importStore.getState().preflight?.otherOpenImport).toEqual({ importId: OTHER_ID });
    mockGetGroupImports.mockResolvedValue(groupImports());

    await expect(closeOtherImport()).resolves.toBe('closed');

    // Re-pricing with `summary: null` would erase the parse's own answer —
    // the date range, the file issues, the other-source hint — from a screen
    // that is only being repriced.
    expect(importStore.getState().preflight?.summary).toEqual(before);
  });

  it('treats an already-closed session as closed', async () => {
    await readyBlockedByOther();
    mockCompleteImport.mockRejectedValue(
      new ConflictError(
        JSON.stringify({
          error: 'IMPORT_REFUSED',
          details: { code: 'IMPORT_CLOSED', status: 'completed' },
        }),
      ),
    );
    mockGetGroupImports.mockResolvedValue(groupImports());

    await expect(closeOtherImport()).resolves.toBe('closed');
    expect(importStore.getState().preflight?.otherOpenImport).toBeNull();
  });

  it('treats a session that is not there as closed', async () => {
    await readyBlockedByOther();
    mockCompleteImport.mockRejectedValue(new NotFoundError());
    mockGetGroupImports.mockResolvedValue(groupImports());

    await expect(closeOtherImport()).resolves.toBe('closed');
  });

  it('fails when the close itself fails, and changes nothing', async () => {
    await readyBlockedByOther();
    mockCompleteImport.mockRejectedValue(new NetworkError('offline'));

    await expect(closeOtherImport()).resolves.toBe('failed');

    // The other import is still open, so Import must stay disabled.
    expect(importStore.getState().preflight?.otherOpenImport).toEqual({ importId: OTHER_ID });
    expect(jobRow().status).toBe('ready');
  });

  it('reports closed-stale when the close works but the reprice does not', async () => {
    await readyBlockedByOther();
    mockGetGroupImports.mockRejectedValue(new NetworkError('offline'));

    await expect(closeOtherImport()).resolves.toBe('closed-stale');

    // The session IS closed, so this is not a failure — but the preflight on
    // screen is the old one, and re-tapping is safe because `/complete` is
    // idempotent.
    expect(mockCompleteImport).toHaveBeenCalledWith(OTHER_ID);
    expect(importStore.getState().preflight?.otherOpenImport).toEqual({ importId: OTHER_ID });
  });

  it('is cancelled by a wipe mid-close', async () => {
    await readyBlockedByOther();
    const completing = deferred<unknown>();
    mockCompleteImport.mockImplementation(() => completing.promise);

    const closing = closeOtherImport();
    await drain();
    resetImportRunnerState();
    completing.resolve({});

    await expect(closing).resolves.toBe('cancelled');
    // Not one publish after the wipe.
    expect(importStore.getState()).toEqual(importStore.getInitialState());
  });

  it('is cancelled when the job was discarded before it got the gate', async () => {
    await readyBlockedByOther();

    // Both are queued member actions, so they SERIALIZE: the close waits for
    // the discard, and by the time it runs there is no job to re-price.
    const discarding = discardImportPreflight();
    const closing = closeOtherImport();
    await discarding;

    await expect(closing).resolves.toBe('cancelled');
    expect(getImportJob(JOB)).toBeNull();
    // Nothing of the member's was closed on the way out.
    expect(mockCompleteImport).not.toHaveBeenCalled();
  });

  it('never closes the other session from a refused archive (PR #997 blocker)', async () => {
    // Over this source's allowance AND the other source has a session open:
    // the archive is refused on its own facts, so closing the other import
    // would stop it for nothing. The refused job sits at phase `ready` with
    // its row already `cancelled` — exactly the state the gate must reject.
    mockGetGroupImports.mockResolvedValue(
      groupImports({
        allowances: allowances({ facebook: allowance(999) }),
        openImport: openImport({ importId: OTHER_ID, source: 'instagram' }),
      }),
    );
    parseEmitting(2);
    await pickAndStartParse({ conversationId: ORBIT, chooseSource: jest.fn() });
    const preflight = importStore.getState().preflight;
    expect(importStore.getState().phase).toBe('ready');
    expect(preflight?.overAllowance).toBe('posts');
    expect(preflight?.otherOpenImport).toEqual({ importId: OTHER_ID });

    await expect(closeOtherImport()).resolves.toBe('cancelled');
    expect(mockCompleteImport).not.toHaveBeenCalled();
  });

  it('never reports a landed close as a no-op when the job vanished meanwhile', async () => {
    await readyBlockedByOther();
    const completing = deferred<unknown>();
    mockCompleteImport.mockImplementation(() => completing.promise);
    mockGetGroupImports.mockResolvedValue(groupImports());

    const closing = closeOtherImport();
    await drain();
    // Same account, but the job is gone by the time the close lands.
    finishImportJob(JOB, 'cancelled');
    completing.resolve({});

    await expect(closing).resolves.toBe('closed-stale');
    expect(mockCompleteImport).toHaveBeenCalledWith(OTHER_ID);
  });

  it('does nothing at all when the phase is not ready', async () => {
    seedJob({ items: 1 });
    await resumeImportAtLaunch();
    await drain();

    await expect(closeOtherImport()).resolves.toBe('cancelled');
    expect(mockCompleteImport).not.toHaveBeenCalledWith(OTHER_ID);
  });

  it('does nothing when there is no other import to close', async () => {
    seedJob({ status: 'ready', items: 1 });
    await resumeImportAtLaunch();
    expect(importStore.getState().preflight?.otherOpenImport).toBeNull();

    await expect(closeOtherImport()).resolves.toBe('cancelled');
    expect(mockCompleteImport).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// Group: the summary knows its source, and what else was in the files (#996)
// ===========================================================================

describe('the summary source and other-source hint', () => {
  it('carries the run source and the hint from the parse', async () => {
    mockOpenArchiveSession.mockImplementation(async () => bothSourcesArchiveSession());
    parseEmitting(1, { otherSourceDetected: true });
    await pickAndStartParse({
      conversationId: ORBIT,
      chooseSource: jest.fn().mockResolvedValue('instagram'),
    });
    await confirmAndRunImport();
    await drain();

    const summary = importStore.getState().summary;
    expect(summary?.source).toBe('instagram');
    // The summary is where #996 offers the second import, so it has to know
    // there IS one.
    expect(summary?.otherSourceDetected).toBe(true);
  });

  it('re-detects the hint from the archive on a resumed run', async () => {
    // Launch-resumed: no `ParseSummary` survives, so the open archive is the
    // only thing that still knows.
    seedJob({ items: 1, bookmark: ['part-a'], mediaEntryIds: ['entry-0-0'] });
    mockOpenArchiveSession.mockImplementation(async () => bothSourcesArchiveSession());

    await confirmAndRunLaunch();

    expect(importStore.getState().preflight?.summary ?? null).toBeNull();
    expect(importStore.getState().summary?.otherSourceDetected).toBe(true);
  });

  it('is false when the archive holds only our own source', async () => {
    parseEmitting(1);
    await pickAndStartParse({ conversationId: ORBIT, chooseSource: jest.fn() });
    await confirmAndRunImport();
    await drain();

    expect(importStore.getState().summary?.source).toBe('facebook');
    expect(importStore.getState().summary?.otherSourceDetected).toBe(false);
  });

  it('is false for a text-only resumed run, which has nothing left to ask', async () => {
    // The documented caveat: no archive was opened (every item is text) and
    // no `ParseSummary` survived the relaunch.
    seedJob({ items: 1 });

    await confirmAndRunLaunch();

    expect(importStore.getState().summary?.otherSourceDetected).toBe(false);
    expect(importStore.getState().summary?.source).toBe('facebook');
  });
});
