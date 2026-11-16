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

jest.mock('../../api/imports', () => ({
  startImport: (...a: unknown[]) => mockStartImport(...a),
  getGroupImports: (...a: unknown[]) => mockGetGroupImports(...a),
  getImportSession: (...a: unknown[]) => mockGetImportSession(...a),
  submitImportBatch: (...a: unknown[]) => mockSubmitImportBatch(...a),
  completeImport: (...a: unknown[]) => mockCompleteImport(...a),
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
  cancelImport,
  confirmAndRunImport,
  dismissImportSummary,
  getImportSkipDetails,
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

function groupImports(over: Record<string, unknown> = {}) {
  return { allowance: allowance(), openImport: null, limits: LIMITS, ...over };
}

let harness: ImportDbHarness;

/** An `ArchiveImportSession` double whose extract always succeeds. */
function archiveSession(parts: readonly string[] = ['part-a']): ArchiveImportSession {
  return {
    parts,
    entries: [],
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

/** A promise plus its resolver: a call held open across an await point. */
function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Let every queued microtask settle. The runner never waits on real I/O. */
async function drain(times = 80): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

/** A parse that emits `posts` importable items and the given skips. */
function parseEmitting(
  posts: number,
  options: { skips?: readonly SkipReason[]; mediaPerPost?: number } = {},
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
      return summaryWith(posts, options.skips ?? []);
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

function summaryWith(importable: number, skips: readonly SkipReason[]): ParseSummary {
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
    otherSourceDetected: false,
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
    declaredPosts: 2,
    declaredBytes: 4096,
    allowance: allowance(),
    limits: LIMITS,
  });
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
    const result = await pickAndStartParse({ conversationId: ORBIT, source: 'facebook' });

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

    const result = await pickAndStartParse({ conversationId: ORBIT, source: 'facebook' });

    expect(result).toEqual({
      kind: 'refused',
      reason: 'job-running',
      conversationId: 'orbit-2',
    });
    expect(mockPickArchiveParts).not.toHaveBeenCalled();
  });

  it('returns skip details per reason without the screen touching the repository', async () => {
    seedJob({ status: 'ready', items: 1, skips: ['held_video', 'empty_post', 'held_video'] });
    await resumeImportAtLaunch();

    const all = getImportSkipDetails();
    expect(all).toHaveLength(3);
    expect(all[0].source_file).toBe('your_posts_1.json');

    const held = getImportSkipDetails('held_video');
    expect(held).toHaveLength(2);
    expect(held.every((row) => row.skip_reason === 'held_video')).toBe(true);
  });

  it('probes availability once per orbit and reads a 404 as unavailable', async () => {
    const first = await probeImportAvailability(ORBIT);
    const second = await probeImportAvailability(ORBIT);

    expect(first.available).toBe(true);
    expect(first.limits).toEqual(LIMITS);
    expect(second).toBe(first);
    expect(mockGetGroupImports).toHaveBeenCalledTimes(1);

    mockGetGroupImports.mockRejectedValueOnce(new NotFoundError());
    const off = await probeImportAvailability('orbit-off');
    expect(off).toEqual({ available: false, allowance: null, limits: null });
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
    mockGetGroupImports.mockResolvedValue(groupImports({ allowance: allowance(200) }));
    parseEmitting(900);

    const result = await pickAndStartParse({ conversationId: ORBIT, source: 'facebook' });

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
      groupImports({ allowance: { ...allowance(), bytesUsed: 2 * 1024 * 1024 * 1024 - 10 } }),
    );
    mockOpenArchiveSession.mockImplementation(async () => {
      const session = archiveSession();
      return {
        ...session,
        entries: [
          { entryId: 'entry-0-0', path: 'a.jpg', kind: 'image', declaredSize: 4096, skip: null },
        ],
      } as unknown as ArchiveImportSession;
    });
    parseEmitting(1, { mediaPerPost: 1 });

    const result = await pickAndStartParse({ conversationId: ORBIT, source: 'facebook' });

    const preflight = result.kind === 'preflight' ? result.preflight : null;
    expect(preflight?.overAllowance).toBe('bytes');
    // ceil(4096 * 1.5) + 64 — the clamp, the re-encode headroom, the framing.
    expect(preflight?.estimatedBytes).toBe(6208);
    expect(mockStartImport).not.toHaveBeenCalled();
    expect(soleJob().status).toBe('cancelled');
  });

  it('accepts an archive that fits, and declares exactly what it parsed', async () => {
    mockGetGroupImports.mockResolvedValue(groupImports({ allowance: allowance(200) }));
    parseEmitting(800);

    const result = await pickAndStartParse({ conversationId: ORBIT, source: 'facebook' });

    const preflight = result.kind === 'preflight' ? result.preflight : null;
    expect(preflight?.overAllowance).toBeNull();
    expect(preflight?.importable).toBe(800);
    const row = soleJob();
    expect(row.status).toBe('ready');
    expect(row.declared_posts).toBe(800);
  });

  it('refuses a run the preflight already refused', async () => {
    mockGetGroupImports.mockResolvedValue(groupImports({ allowance: allowance(999) }));
    parseEmitting(50);
    await pickAndStartParse({ conversationId: ORBIT, source: 'facebook' });

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

    const result = await pickAndStartParse({ conversationId: ORBIT, source: 'facebook' });

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
    await pickAndStartParse({ conversationId: ORBIT, source: 'facebook' });
    await confirmAndRunImport();
    await drain();
    expect(importStore.getState().phase).toBe('done');
    dismissImportSummary();

    // The orbit's lifetime counters have advanced by what that run created.
    mockGetGroupImports.mockResolvedValue(groupImports({ allowance: allowance(1, 6208) }));
    parseEmitting(1);

    const second = await pickAndStartParse({ conversationId: ORBIT, source: 'facebook' });

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
    expect(importStore.getState().pauseCauses).toEqual(['needs_repick']);
    expect(importStore.getState().needsRepick).toBe(true);

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
    expect(importStore.getState().needsRepick).toBe(false);
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
          details: { code: 'IMPORT_IN_PROGRESS', import_id: IMPORT_ID },
        }),
      ),
    );
    mockGetGroupImports.mockResolvedValue(
      groupImports({
        openImport: {
          importId: IMPORT_ID,
          status: 'open',
          declaredPosts: 1,
          declaredBytes: 4096,
          createdPosts: 0,
          lastActivityAt: '2012-08-26T00:00:00.000Z',
        },
      }),
    );
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
      groupImports({
        openImport: {
          importId: 'import-open',
          status: 'open',
          declaredPosts: 1,
          declaredBytes: 4096,
          createdPosts: 0,
          lastActivityAt: '2012-08-26T00:00:00.000Z',
        },
      }),
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

    await pickAndStartParse({ conversationId: ORBIT, source: 'facebook' });

    expect(mockOpenArchiveSession).toHaveBeenCalledWith(['part-a'], {
      signal: expect.any(AbortSignal),
    });
    expect(mockParseArchive.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });

  it('cancels a live parse, deleting the job and landing on idle', async () => {
    parseUntilAborted();

    const picking = pickAndStartParse({ conversationId: ORBIT, source: 'facebook' });
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

    const picking = pickAndStartParse({ conversationId: ORBIT, source: 'facebook' });
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

    const result = await pickAndStartParse({ conversationId: ORBIT, source: 'facebook' });

    expect(result).toEqual({ kind: 'cancelled' });
    // The row used to survive as `parsing`, which refused every later pick.
    expect(jobCount()).toBe(0);
    expect(importStore.getState().phase).toBe('idle');
    expect(importStore.getState().jobId).toBeNull();
  });

  it('leaves a LIVE parse alone when the launch gate runs mid-parse', async () => {
    parseUntilAborted();
    const picking = pickAndStartParse({ conversationId: ORBIT, source: 'facebook' });
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
    expect(await pickAndStartParse({ conversationId: ORBIT, source: 'facebook' })).toEqual({
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
    expect(await pickAndStartParse({ conversationId: ORBIT, source: 'facebook' })).toEqual({
      kind: 'failed',
      reason: 'key_pending',
    });
    expect(jobCount()).toBe(0);
  });

  it('names the allowance probe being unreachable', async () => {
    parseEmitting(1);
    mockGetGroupImports.mockRejectedValue(new NetworkError('offline'));

    expect(await pickAndStartParse({ conversationId: ORBIT, source: 'facebook' })).toEqual({
      kind: 'failed',
      reason: 'network',
    });
    expect(jobCount()).toBe(0);
    expect(mockStartImport).not.toHaveBeenCalled();
  });

  it('falls back to other for a failure with no class of its own', async () => {
    mockParseArchive.mockRejectedValue(new TypeError('boom'));

    expect(await pickAndStartParse({ conversationId: ORBIT, source: 'facebook' })).toEqual({
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
    expect(await pickAndStartParse({ conversationId: ORBIT, source: 'facebook' })).toEqual({
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
