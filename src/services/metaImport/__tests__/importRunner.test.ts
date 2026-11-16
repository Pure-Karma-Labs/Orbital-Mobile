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
/** Set to throw from `verifyGroupKeyPin`. */
let mockPinError: unknown = null;
const mockClassifyCryptoError = jest.fn<string | null, [unknown]>(() => null);

jest.mock('../../crypto/importCrypto', () => ({
  importKeyToWire: (bytes: Uint8Array) => Buffer.from(bytes).toString('base64'),
  classifyImportCryptoError: (e: unknown) => mockClassifyCryptoError(e),
  openImportKeySession: async () => {
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

  it('parks a QUOTA refusal, retries it once at end of run, and keeps the run going', async () => {
    // item-0 carries the media; item-1 is text-only.
    seedJob({ items: 2, bookmark: ['part-a'], mediaEntryIds: ['entry-0-0'] });
    mockUploadMedia.mockRejectedValue(
      stagedRefusal({ code: 'IMPORT_QUOTA_EXCEEDED', available_bytes: 10, size_bytes: 20 }),
    );

    await confirmAndRunLaunch();

    // The park → end-of-run pass → `item-failed('QUOTA')` route, which the
    // unconditional rebind made unreachable: the file was re-uploaded under a
    // fresh id instead, and a second refusal ended the whole run `FORBIDDEN`.
    expect(mockUploadMedia).toHaveBeenCalledTimes(2);
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
