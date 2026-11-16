/**
 * `importMedia.ts` — the per-item media pipeline (#926 §4.10).
 *
 * ## The database is REAL
 *
 * `importRepository` runs against `node:sqlite` with migration 009's actual
 * DDL, through the `executeSync` seam `openImportDb()` injects. So "the ordinal
 * was marked uploaded" and "the row now holds a different `media_id` and is
 * pending again" are read back out of SQL rather than asserted against a spy
 * that would pass just as happily on the wrong column. It is also what makes
 * the already-uploaded skip real: the pipeline reads the row the repository
 * wrote.
 *
 * ## The two seams that ARE mocked, and why
 *
 *  - `mediaUploadService` is factory-mocked: the real module drags the store,
 *    SQLCipher, the crypto layer and the API client in behind it, and the
 *    behaviour under test here is which ARGUMENTS reach `uploadMedia` and what
 *    this file does with the errors it throws. `ImportMediaStagedError` and
 *    friends are matched BY NAME in the subject, so the mock's local classes
 *    are faithful stand-ins — that is the repo's standing rule for errors
 *    whose module a suite replaces.
 *  - The archive session is a hand-built stub implementing
 *    `ArchiveImportSession`. `extractImageEntry`'s outcome union is the whole
 *    input surface, and `archiveAccess.test.ts` owns proving that the real
 *    session produces those outcomes.
 *
 * No fake timers anywhere (#834): nothing in this module waits.
 *
 * Run: npm test -- importMedia
 */

import { closeDatabase } from '../../../database/connection';
import { getPendingImportItems } from '../../../database/repositories/importRepository';
import {
  AuthError,
  ConflictError,
  NetworkError,
  RateLimitError,
  ValidationError,
} from '../../api/errors';
import {
  ARCHIVE_IMAGE_ENTRY_MAX_BYTES,
  IMPORT_CIPHERTEXT_OVERHEAD_BYTES,
  estimateImportBytes,
  importMediaFileName,
  importMediaStage,
  uploadImportItemMedia,
} from '../importMedia';
import { openImportDb } from '../testUtils/importDbHarness';

import type { PendingImportItem } from '../../../database/repositories/importRepository';
import type { ImportMediaRun } from '../importMedia';
import type { ArchiveExtractOutcome, ArchiveImportSession } from '../archiveAccess';
import type { ImportDbHarness } from '../testUtils/importDbHarness';
import type { DatabaseSync } from 'node:sqlite';

jest.mock('@op-engineering/op-sqlite', () => ({ open: jest.fn() }));

// ---------------------------------------------------------------------------
// mediaUploadService: the only mocked service seam
// ---------------------------------------------------------------------------

const mockUploadMedia = jest.fn<Promise<unknown>, [Record<string, unknown>]>();

/**
 * Stand-ins for the upload service's two import error shapes.
 *
 * Declared INSIDE the factory (jest hoists the factory above the imports) and
 * re-exported through the module object below, so a test can construct the
 * same shape the subject matches on.
 */
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
  class ImageSanitizeError extends Error {
    readonly reason: string;
    constructor(reason: string) {
      super('This image cannot be processed on this device.');
      this.name = 'ImageSanitizeError';
      this.reason = reason;
    }
  }
  return {
    uploadMedia: (options: Record<string, unknown>) => mockUploadMedia(options),
    // A COPY of the real one-liner, kept honest by the two abort tests below
    // which never rely on it: the subject treats `signal.aborted` as the
    // authoritative cancellation signal and this guard only catches the shape
    // that arrives without it.
    isUploadCancellation: (e: unknown) =>
      (e !== null && typeof e === 'object' && (e as { code?: unknown }).code === 'ECANCELLED') ||
      (e instanceof Error && e.message === 'Upload cancelled'),
    ImportMediaStagedError,
    ImportMediaUnsupportedError,
    ImageSanitizeError,
  };
});

/**
 * The mock's own classes. Reached through `require` rather than a static
 * import because they exist only on the MOCKED module object: a static import
 * would be type-checked against the real module, which exports neither
 * `ImageSanitizeError` nor a constructor-compatible shape for the other two.
 */
const uploadServiceMock = require('../../mediaUploadService');
const ImportMediaStagedError = uploadServiceMock.ImportMediaStagedError as new (
  cause: unknown,
) => Error;
const ImportMediaUnsupportedError = uploadServiceMock.ImportMediaUnsupportedError as new (
  reason: string,
) => Error;
const ImageSanitizeError = uploadServiceMock.ImageSanitizeError as new (reason: string) => Error;

// ---------------------------------------------------------------------------
// Real SQLite, migration 009's own DDL
// ---------------------------------------------------------------------------

const JOB = 'job-1';
const ITEM = 'item-1';
const IMPORT_ID = 'import-1';
const GROUP = 'orbit-1';
/** 2012-08-26T12:00:00Z — the POST's date. */
const POST_DATE = 1345982400000;
/** 2008-03-01T00:00:00Z — a photo that predates its post by years. */
const MEDIA_DATE = 1204329600000;

let harness: ImportDbHarness;
/** The harness's own database, aliased for the direct-SQL helpers below. */
let sqlite: DatabaseSync;

interface MediaSpec {
  ordinal: number;
  mediaId: string;
  entryId: string;
  originalDate?: number | null;
  uploadState?: 'pending' | 'uploaded';
}

/** One job + one pending item + its media rows, inserted with real SQL. */
function seed(media: readonly MediaSpec[], itemDate: number | null = POST_DATE): void {
  sqlite
    .prepare(
      `INSERT INTO import_jobs (id, conversation_id, source, status, session_id,
                                key_fingerprint, created_at, updated_at)
       VALUES (?, ?, 'facebook', 'in_progress', ?, 'fp-1', 1700000000000, 1700000000000)`,
    )
    .run(JOB, GROUP, IMPORT_ID);
  sqlite
    .prepare(
      `INSERT INTO import_items (id, job_id, ordinal, import_key, status, original_date, body,
                                 source_file, source_index, id_kind)
       VALUES (?, ?, 0, ?, 'pending', ?, 'post body', 'your_posts_1.json', 3, 1)`,
    )
    .run(ITEM, JOB, new Uint8Array(16).fill(0x5a), itemDate);
  for (const m of media) {
    sqlite
      .prepare(
        `INSERT INTO import_item_media (item_id, ordinal, media_id, entry_id, original_date, upload_state)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        ITEM,
        m.ordinal,
        m.mediaId,
        m.entryId,
        m.originalDate ?? null,
        m.uploadState ?? 'pending',
      );
  }
}

/** The media rows as they stand in SQLite right now. */
function mediaRows(): { ordinal: number; media_id: string; upload_state: string }[] {
  return sqlite
    .prepare('SELECT ordinal, media_id, upload_state FROM import_item_media ORDER BY ordinal')
    .all() as { ordinal: number; media_id: string; upload_state: string }[];
}

/** The item, exactly as the runner would hand it over. */
function pendingItem(): PendingImportItem {
  const items = getPendingImportItems(JOB, 10);
  expect(items).toHaveLength(1);
  return items[0];
}

// ---------------------------------------------------------------------------
// The archive session stub
// ---------------------------------------------------------------------------

const extractImageEntry = jest.fn<Promise<ArchiveExtractOutcome>, [string, unknown?]>();
/** Every `release()` the stub has handed out, so double-release is visible. */
let releases: string[] = [];

/** A successful extraction of `entryId`, whose release is recorded by id. */
function extracted(entryId: string, contentType = 'image/jpeg'): ArchiveExtractOutcome {
  return {
    ok: true,
    path: `/tmp/staging/${entryId}-archive-staging.bin`,
    byteLength: 2048,
    contentType,
    release: () => {
      releases.push(entryId);
    },
  };
}

function archiveSession(): ArchiveImportSession {
  return {
    parts: [],
    entries: [],
    telemetry: { partCount: 0, entryCounts: {}, rejectedCounts: {} } as never,
    resolveMediaUris: jest.fn(() => []),
    readEntryJson: jest.fn(),
    peekEntryKind: jest.fn(),
    extractImageEntry: (entryId: string, options?: unknown) => extractImageEntry(entryId, options),
    close: jest.fn(),
  } as unknown as ArchiveImportSession;
}

let controller: AbortController;
let currentRun: boolean;
let mintedIds: string[];

function run(overrides: Partial<ImportMediaRun> = {}): ImportMediaRun {
  return {
    importId: IMPORT_ID,
    groupId: GROUP,
    session: archiveSession(),
    signal: controller.signal,
    isCurrentRun: () => currentRun,
    newMediaId: () => {
      const id = `minted-${mintedIds.length + 1}`;
      mintedIds.push(id);
      return id;
    },
    ...overrides,
  };
}

/** The options object of the nth `uploadMedia` call. */
function uploadCall(index = 0): Record<string, unknown> {
  expect(mockUploadMedia.mock.calls.length).toBeGreaterThan(index);
  return mockUploadMedia.mock.calls[index][0];
}

/** The `import` block of the nth call. */
function importBlock(index = 0): { importId: string; mediaId: string; contentClass: string } {
  return uploadCall(index).import as { importId: string; mediaId: string; contentClass: string };
}

beforeEach(() => {
  jest.clearAllMocks();
  releases = [];
  mintedIds = [];
  controller = new AbortController();
  currentRun = true;
  mockUploadMedia.mockResolvedValue({
    mediaId: 'ignored',
    attachmentKey: new Uint8Array(64),
    digest: new Uint8Array(32),
  });
  harness = openImportDb();
  sqlite = harness.sqlite;
});

afterEach(() => {
  // `closeDatabase()` reaches the harness's own `close`, which closes the
  // underlying `node:sqlite` handle; the second call is the idempotent
  // backstop for a test that closed the connection itself.
  closeDatabase();
  harness.close();
});

// ===========================================================================
// The happy path and the arguments uploadMedia is handed
// ===========================================================================

describe('uploadImportItemMedia — one ordinal, uploaded', () => {
  it('extracts, uploads through the import routes and marks the ordinal uploaded', async () => {
    seed([{ ordinal: 0, mediaId: 'media-a', entryId: 'entry-a' }]);
    extractImageEntry.mockResolvedValue(extracted('entry-a'));

    const outcome = await uploadImportItemMedia(pendingItem(), run());

    expect(outcome).toEqual({ kind: 'uploaded' });
    expect(importBlock()).toEqual({
      importId: IMPORT_ID,
      mediaId: 'media-a',
      contentClass: 'image',
    });
    expect(uploadCall().groupId).toBe(GROUP);
    // Read back from SQL, not from a spy: the cache flag is what stops a
    // resume from paying for this file twice.
    expect(mediaRows()).toEqual([{ ordinal: 0, media_id: 'media-a', upload_state: 'uploaded' }]);
  });

  it('passes the staging path and the POST-EXTRACT content type, nothing else', async () => {
    seed([{ ordinal: 0, mediaId: 'media-a', entryId: 'entry-a' }]);
    extractImageEntry.mockResolvedValue(extracted('entry-a', 'image/png'));

    await uploadImportItemMedia(pendingItem(), run());

    const call = uploadCall();
    expect(call.fileUri).toBe('file:///tmp/staging/entry-a-archive-staging.bin');
    // The sniffed type of the bytes on disk — never the parser's guess, which
    // does not exist, and never an extension's claim.
    expect(call.mimeType).toBe('image/png');
    // F18: the archive's own basename is LOCAL-UI-class and must not reach the
    // append-only envelope. The name is built from OUR media id.
    expect(call.fileName).toBe('media-a.png');
    expect(JSON.stringify(call)).not.toContain('your_posts_1.json');
    expect(call.fileName).not.toContain('entry-a');
  });

  it('forwards the run signal so an abort unwinds the whole upload', async () => {
    seed([{ ordinal: 0, mediaId: 'media-a', entryId: 'entry-a' }]);
    extractImageEntry.mockResolvedValue(extracted('entry-a'));

    await uploadImportItemMedia(pendingItem(), run());

    expect(uploadCall().signal).toBe(controller.signal);
    expect(extractImageEntry).toHaveBeenCalledWith('entry-a', { signal: controller.signal });
  });

  it('uploads every ordinal in order and skips the ones already uploaded', async () => {
    seed([
      { ordinal: 0, mediaId: 'media-a', entryId: 'entry-a', uploadState: 'uploaded' },
      { ordinal: 1, mediaId: 'media-b', entryId: 'entry-b' },
      { ordinal: 2, mediaId: 'media-c', entryId: 'entry-c' },
    ]);
    extractImageEntry.mockImplementation(async (entryId: string) => extracted(entryId));

    const outcome = await uploadImportItemMedia(pendingItem(), run());

    expect(outcome).toEqual({ kind: 'uploaded' });
    // Ordinal 0 is on the server already: not extracted, not re-charged.
    expect(extractImageEntry.mock.calls.map(([id]) => id)).toEqual(['entry-b', 'entry-c']);
    expect(mockUploadMedia).toHaveBeenCalledTimes(2);
    expect(importBlock(0).mediaId).toBe('media-b');
    expect(importBlock(1).mediaId).toBe('media-c');
    expect(mediaRows().every((r) => r.upload_state === 'uploaded')).toBe(true);
  });

  it('resolves a text-only item without touching the archive', async () => {
    seed([]);

    const outcome = await uploadImportItemMedia(pendingItem(), run());

    expect(outcome).toEqual({ kind: 'uploaded' });
    expect(extractImageEntry).not.toHaveBeenCalled();
    expect(mockUploadMedia).not.toHaveBeenCalled();
  });

  it('releases the staging file exactly once per extraction', async () => {
    seed([
      { ordinal: 0, mediaId: 'media-a', entryId: 'entry-a' },
      { ordinal: 1, mediaId: 'media-b', entryId: 'entry-b' },
    ]);
    extractImageEntry.mockImplementation(async (entryId: string) => extracted(entryId));

    await uploadImportItemMedia(pendingItem(), run());

    expect(releases).toEqual(['entry-a', 'entry-b']);
  });
});

// ===========================================================================
// The envelope date (§4.10.4)
// ===========================================================================

describe('importOriginalCreatedAt precedence', () => {
  it("prefers the MEDIA item's own date over the post's", async () => {
    seed([{ ordinal: 0, mediaId: 'media-a', entryId: 'entry-a', originalDate: MEDIA_DATE }]);
    extractImageEntry.mockResolvedValue(extracted('entry-a'));

    await uploadImportItemMedia(pendingItem(), run());

    // A post's photos can predate the post by years; #921 stored that fact
    // deliberately and feeding only the item date would discard it.
    expect(uploadCall().importOriginalCreatedAt).toBe(MEDIA_DATE);
  });

  it("falls back to the post's date when the media row has none", async () => {
    seed([{ ordinal: 0, mediaId: 'media-a', entryId: 'entry-a', originalDate: null }]);
    extractImageEntry.mockResolvedValue(extracted('entry-a'));

    await uploadImportItemMedia(pendingItem(), run());

    expect(uploadCall().importOriginalCreatedAt).toBe(POST_DATE);
  });

  it('passes null when neither has one, so the envelope key is omitted', async () => {
    seed([{ ordinal: 0, mediaId: 'media-a', entryId: 'entry-a', originalDate: null }], null);
    extractImageEntry.mockResolvedValue(extracted('entry-a'));

    await uploadImportItemMedia(pendingItem(), run());

    // Null, never a substituted "now": a fabricated date would be sealed into
    // an append-only envelope and rendered as the photo's real date.
    expect(uploadCall().importOriginalCreatedAt).toBeNull();
  });

  it('drops a stored date that is not a safe integer rather than throwing', async () => {
    seed([{ ordinal: 0, mediaId: 'media-a', entryId: 'entry-a' }]);
    // `importRepository` binds only safe integers, so this is defence in
    // depth — but `uploadMedia` answers a bad value with a plain Error that
    // the taxonomy cannot classify, which would kill the whole archive.
    //
    // A FRACTIONAL epoch is the poison this column can actually hold: INTEGER
    // affinity stores 1345982400000.5 as a REAL, and it reads straight back.
    // An out-of-safe-range integer is NOT reachable through this harness at
    // all — node:sqlite refuses to hand 2^53 back to JS — which is its own
    // evidence that a row can only reach the pipeline as a float.
    sqlite
      .prepare('UPDATE import_item_media SET original_date = ? WHERE item_id = ?')
      .run(POST_DATE + 0.5, ITEM);
    extractImageEntry.mockResolvedValue(extracted('entry-a'));

    const outcome = await uploadImportItemMedia(pendingItem(), run());

    expect(outcome).toEqual({ kind: 'uploaded' });
    expect(uploadCall().importOriginalCreatedAt).toBeNull();
  });
});

// ===========================================================================
// The extract skip table (§4.10.2)
// ===========================================================================

describe('the extract skip table', () => {
  beforeEach(() => {
    seed([{ ordinal: 0, mediaId: 'media-a', entryId: 'entry-a' }]);
  });

  it('re-extracts ONCE on ENTRY_CORRUPT and uploads when the retry succeeds', async () => {
    extractImageEntry
      .mockResolvedValueOnce({ ok: false, skip: 'ENTRY_CORRUPT' })
      .mockResolvedValueOnce(extracted('entry-a'));

    const outcome = await uploadImportItemMedia(pendingItem(), run());

    expect(outcome).toEqual({ kind: 'uploaded' });
    expect(extractImageEntry).toHaveBeenCalledTimes(2);
  });

  it('fails the item after the one bounded re-extract also reports ENTRY_CORRUPT', async () => {
    extractImageEntry.mockResolvedValue({ ok: false, skip: 'ENTRY_CORRUPT' });

    const outcome = await uploadImportItemMedia(pendingItem(), run());

    expect(outcome).toEqual({ kind: 'item-failed', code: 'IMPORT_MEDIA_UNAVAILABLE' });
    // Bounded at exactly two: the staged size changing twice is not a
    // transient worth a third read.
    expect(extractImageEntry).toHaveBeenCalledTimes(2);
    expect(mockUploadMedia).not.toHaveBeenCalled();
    expect(mediaRows()[0].upload_state).toBe('pending');
  });

  it('HOLDS the post on ENTRY_IS_VIDEO and never fails the item', async () => {
    extractImageEntry.mockResolvedValue({ ok: false, skip: 'ENTRY_IS_VIDEO' });

    const outcome = await uploadImportItemMedia(pendingItem(), run());

    // Reachable even for an entry #925's pre-pass called an image: the head
    // peek and the real inflation are two different reads. Held video is
    // reported separately from failures (issue AC).
    expect(outcome).toEqual({ kind: 'held-video' });
    expect(extractImageEntry).toHaveBeenCalledTimes(1);
    expect(mockUploadMedia).not.toHaveBeenCalled();
  });

  it.each([
    'ENTRY_OVER_CAP',
    'ENTRY_RATIO_EXCEEDED',
    'ENTRY_ENCRYPTED',
    'ENTRY_KIND_MISMATCH',
    'ENTRY_SNIFF_INDETERMINATE',
    'ENTRY_UNSUPPORTED_IMAGE_FORMAT',
  ] as const)('fails the item on %s with no retry', async (skip) => {
    extractImageEntry.mockResolvedValue({ ok: false, skip });

    const outcome = await uploadImportItemMedia(pendingItem(), run());

    expect(outcome).toEqual({ kind: 'item-failed', code: 'IMPORT_MEDIA_UNAVAILABLE' });
    // Only ENTRY_CORRUPT is a maybe. Every other skip is a settled fact about
    // the entry, and re-reading it would just spend the archive's job slots.
    expect(extractImageEntry).toHaveBeenCalledTimes(1);
  });

  it('propagates an archive-wide throw for the runner to pause on', async () => {
    const thrown = Object.assign(new Error('archive busy'), {
      name: 'ArchiveReaderError',
      code: 'ARCHIVE_BUSY',
    });
    extractImageEntry.mockRejectedValue(thrown);

    await expect(uploadImportItemMedia(pendingItem(), run())).rejects.toBe(thrown);
    // Never retried here: ARCHIVE_BUSY has its own in-place ladder in the
    // runner, and the other codes have pauses.
    expect(extractImageEntry).toHaveBeenCalledTimes(1);
  });
});

// ===========================================================================
// Item-level refusals (§4.7, #918's mapping)
// ===========================================================================

describe('refusals that are about THIS FILE', () => {
  beforeEach(() => {
    seed([{ ordinal: 0, mediaId: 'media-a', entryId: 'entry-a' }]);
    extractImageEntry.mockResolvedValue(extracted('entry-a'));
  });

  it.each([
    ['too-many-pixels', 'image_too_large'],
    ['unsupported-format', 'unsupported_image_format'],
  ] as const)('maps ImageSanitizeError %s to %s', async (reason, code) => {
    mockUploadMedia.mockRejectedValue(new ImageSanitizeError(reason));

    const outcome = await uploadImportItemMedia(pendingItem(), run());

    // The two SkipReason spellings #928 already has copy for, reached from the
    // upload side instead of the parse side.
    expect(outcome).toEqual({ kind: 'item-failed', code });
    // No fresh id: a refusal about the PIXELS says nothing about the id, and
    // re-uploading under a new one would fail identically.
    expect(mediaRows()[0].media_id).toBe('media-a');
    expect(mockUploadMedia).toHaveBeenCalledTimes(1);
  });

  it('fails the item on a sanitizer reason it does not recognise', async () => {
    mockUploadMedia.mockRejectedValue(new ImageSanitizeError('something-new'));

    const outcome = await uploadImportItemMedia(pendingItem(), run());

    // A widened native vocabulary must still land on the item, not escape as
    // an unclassifiable run failure.
    expect(outcome).toEqual({ kind: 'item-failed', code: 'IMPORT_MEDIA_UNSUPPORTED' });
  });

  it('fails the item when uploadMedia refuses the file outright', async () => {
    mockUploadMedia.mockRejectedValue(new ImportMediaUnsupportedError('video'));

    const outcome = await uploadImportItemMedia(pendingItem(), run());

    expect(outcome).toEqual({ kind: 'item-failed', code: 'IMPORT_MEDIA_UNSUPPORTED' });
  });

  it('fails the item on the server content-type refusal', async () => {
    mockUploadMedia.mockRejectedValue(
      new ValidationError(
        400,
        JSON.stringify({
          error: 'VALIDATION_ERROR',
          details: { code: 'IMPORT_MEDIA_TYPE_UNSUPPORTED' },
        }),
      ),
    );

    const outcome = await uploadImportItemMedia(pendingItem(), run());

    expect(outcome).toEqual({ kind: 'item-failed', code: 'IMPORT_MEDIA_UNSUPPORTED' });
  });

  it('propagates any OTHER ValidationError, which is a client bug', async () => {
    const thrown = new ValidationError(400);
    mockUploadMedia.mockRejectedValue(thrown);

    // The ≥3 → job-terminal('CLIENT_BUG') ladder lives in the runner, so a
    // shape refusal must not be absorbed here as a per-file skip.
    await expect(uploadImportItemMedia(pendingItem(), run())).rejects.toBe(thrown);
  });
});

// ===========================================================================
// Run-level failures propagate RAW (§4.7)
// ===========================================================================

describe('failures that belong to the runner', () => {
  beforeEach(() => {
    seed([{ ordinal: 0, mediaId: 'media-a', entryId: 'entry-a' }]);
    extractImageEntry.mockResolvedValue(extracted('entry-a'));
  });

  it.each([
    ['NetworkError', () => new NetworkError('Network error')],
    ['RateLimitError', () => new RateLimitError()],
    ['AuthError 401', () => new AuthError(401)],
    [
      'IMPORT_CLOSED',
      () =>
        new ConflictError(
          JSON.stringify({
            error: 'IMPORT_REFUSED',
            details: { code: 'IMPORT_CLOSED', status: 'abandoned' },
          }),
        ),
    ],
  ])('rethrows %s unchanged, without re-extracting', async (_label, make) => {
    const thrown = make();
    mockUploadMedia.mockRejectedValue(thrown);

    // Unchanged and unwrapped: the runner's taxonomy matches on the CLASS, and
    // a wrapper here would hide it. One extraction, because every outer retry
    // would re-extract, re-sanitize and re-encrypt the whole file.
    await expect(uploadImportItemMedia(pendingItem(), run())).rejects.toBe(thrown);
    expect(extractImageEntry).toHaveBeenCalledTimes(1);
    expect(releases).toEqual(['entry-a']);
    expect(mediaRows()).toEqual([{ ordinal: 0, media_id: 'media-a', upload_state: 'pending' }]);
  });

  it('releases the staging file even when the upload throws', async () => {
    mockUploadMedia.mockRejectedValue(new NetworkError('Network error'));

    await expect(uploadImportItemMedia(pendingItem(), run())).rejects.toThrow();

    // The `finally` is the only unlink of extracted plaintext on this path.
    expect(releases).toEqual(['entry-a']);
  });
});

// ===========================================================================
// The one fresh-id rebind (§4.10.5)
// ===========================================================================

describe('a burned media_id is never retried in place', () => {
  beforeEach(() => {
    seed([{ ordinal: 0, mediaId: 'media-a', entryId: 'entry-a' }]);
    extractImageEntry.mockImplementation(async () => extracted('entry-a'));
  });

  it('rebinds and retries ONCE after ImportMediaStagedError, under a NEW id', async () => {
    mockUploadMedia
      .mockRejectedValueOnce(new ImportMediaStagedError(new NetworkError('Network error')))
      .mockResolvedValueOnce({});

    const outcome = await uploadImportItemMedia(pendingItem(), run());

    expect(outcome).toEqual({ kind: 'uploaded' });
    // The server holds attempt 1's envelope and IV under media-a. Reusing it
    // would stitch two ciphertexts into one undecryptable, allowance-charged
    // blob — so the second attempt MUST carry a different id.
    expect(importBlock(0).mediaId).toBe('media-a');
    expect(importBlock(1).mediaId).toBe('minted-1');
    expect(importBlock(1).mediaId).not.toBe(importBlock(0).mediaId);
    // Persisted before the retry, so a crash in between leaves the row
    // re-uploadable under the new id.
    expect(mediaRows()).toEqual([{ ordinal: 0, media_id: 'minted-1', upload_state: 'uploaded' }]);
    // A fresh staging file per attempt, each released.
    expect(releases).toEqual(['entry-a', 'entry-a']);
  });

  it.each([
    ['a 403 binding', () => new AuthError(403)],
    ['a plain 409 CONFLICT', () => new ConflictError()],
  ])('rebinds and retries once after %s', async (_label, make) => {
    mockUploadMedia.mockRejectedValueOnce(make()).mockResolvedValueOnce({});

    const outcome = await uploadImportItemMedia(pendingItem(), run());

    expect(outcome).toEqual({ kind: 'uploaded' });
    expect(importBlock(1).mediaId).toBe('minted-1');
    expect(mintedIds).toHaveLength(1);
  });

  it('reports fresh-id-exhausted when the rebind fails the same way', async () => {
    const second = new AuthError(403);
    mockUploadMedia.mockRejectedValueOnce(new AuthError(403)).mockRejectedValueOnce(second);

    const outcome = await uploadImportItemMedia(pendingItem(), run());

    // Per C4 a 403 here has three indistinguishable causes and a fresh id is
    // the only text-free disambiguation; a second one is terminal, and the
    // runner must not be able to read it as "rebind again".
    expect(outcome).toEqual({
      kind: 'fresh-id-exhausted',
      stage: 'media-chunk',
      error: second,
    });
    expect(mockUploadMedia).toHaveBeenCalledTimes(2);
    expect(mintedIds).toHaveLength(1);
    expect(mediaRows()[0].media_id).toBe('minted-1');
  });

  it('does not rebind on a 409 that carries IMPORT_REFUSED details', async () => {
    const thrown = new ConflictError(
      JSON.stringify({
        error: 'IMPORT_REFUSED',
        details: { code: 'IMPORT_QUOTA_EXCEEDED', available_bytes: 10, size_bytes: 20 },
      }),
    );
    mockUploadMedia.mockRejectedValue(thrown);

    // A quota refusal is about the ORBIT, not the id: the runner parks the
    // file and retries `complete` later. Minting a new id would burn the
    // staged bytes for nothing.
    await expect(uploadImportItemMedia(pendingItem(), run())).rejects.toBe(thrown);
    expect(mediaRows()[0].media_id).toBe('media-a');
  });

  it('mints ids with generateUUID when the run provides no seam', async () => {
    mockUploadMedia.mockRejectedValueOnce(new AuthError(403)).mockResolvedValueOnce({});

    const outcome = await uploadImportItemMedia(pendingItem(), run({ newMediaId: undefined }));

    expect(outcome).toEqual({ kind: 'uploaded' });
    // #921: a media id is ever only minted by generateUUID. Shape-checked
    // rather than spied, so this holds whatever the uuid module is doing.
    expect(importBlock(1).mediaId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(importBlock(1).mediaId).not.toBe('media-a');
  });
});

// ===========================================================================
// Rule 0: a reset run writes nothing (§4.7)
// ===========================================================================

describe('rule 0 — the run token comes first', () => {
  beforeEach(() => {
    seed([{ ordinal: 0, mediaId: 'media-a', entryId: 'entry-a' }]);
  });

  it('does not mark the ordinal uploaded when the run went stale mid-upload', async () => {
    extractImageEntry.mockResolvedValue(extracted('entry-a'));
    mockUploadMedia.mockImplementation(async () => {
      currentRun = false;
      return {};
    });

    const outcome = await uploadImportItemMedia(pendingItem(), run());

    // The bytes are on the server, but `localWipe` awaits between its phase 1
    // and deleteAllImportJobs — writing here would resurrect a deleted job's
    // row. The staged bytes are the server's to GC.
    expect(outcome).toEqual({ kind: 'cancelled' });
    expect(mediaRows()).toEqual([{ ordinal: 0, media_id: 'media-a', upload_state: 'pending' }]);
  });

  it('stops before the first extraction when the run is already stale', async () => {
    currentRun = false;

    const outcome = await uploadImportItemMedia(pendingItem(), run());

    expect(outcome).toEqual({ kind: 'cancelled' });
    expect(extractImageEntry).not.toHaveBeenCalled();
    expect(mockUploadMedia).not.toHaveBeenCalled();
  });

  it('releases exactly once and writes nothing when aborted mid-upload', async () => {
    extractImageEntry.mockResolvedValue(extracted('entry-a'));
    mockUploadMedia.mockImplementation(async () => {
      controller.abort();
      throw new Error('Aborted');
    });

    const outcome = await uploadImportItemMedia(pendingItem(), run());

    // This is the wipe path: the abort is what runs the `finally`, and
    // `release()` is the ONLY unlink of the extracted plaintext there.
    expect(outcome).toEqual({ kind: 'cancelled' });
    expect(releases).toEqual(['entry-a']);
    expect(mediaRows()[0].upload_state).toBe('pending');
  });

  it('treats the upload layer cancellation shape as cancelled, not failed', async () => {
    extractImageEntry.mockResolvedValue(extracted('entry-a'));
    mockUploadMedia.mockRejectedValue(
      Object.assign(new Error('cancelled'), { code: 'ECANCELLED' }),
    );

    const outcome = await uploadImportItemMedia(pendingItem(), run());

    expect(outcome).toEqual({ kind: 'cancelled' });
    expect(mediaRows()[0].upload_state).toBe('pending');
  });

  it('does not rebind the id when the run goes stale after a burned attempt', async () => {
    extractImageEntry.mockResolvedValue(extracted('entry-a'));
    mockUploadMedia.mockImplementation(async () => {
      currentRun = false;
      throw new AuthError(403);
    });

    const outcome = await uploadImportItemMedia(pendingItem(), run());

    expect(outcome).toEqual({ kind: 'cancelled' });
    // replaceMediaId is an importRepository write like any other.
    expect(mediaRows()[0].media_id).toBe('media-a');
    expect(mintedIds).toHaveLength(0);
  });

  it('stops at the ordinal where the run went stale, leaving later rows alone', async () => {
    sqlite.prepare('DELETE FROM import_item_media').run();
    sqlite
      .prepare(
        `INSERT INTO import_item_media (item_id, ordinal, media_id, entry_id, upload_state)
         VALUES (?, 0, 'media-a', 'entry-a', 'pending'), (?, 1, 'media-b', 'entry-b', 'pending')`,
      )
      .run(ITEM, ITEM);
    extractImageEntry.mockImplementation(async (entryId: string) => extracted(entryId));
    mockUploadMedia.mockImplementationOnce(async () => {
      currentRun = false;
      return {};
    });

    const outcome = await uploadImportItemMedia(pendingItem(), run());

    expect(outcome).toEqual({ kind: 'cancelled' });
    expect(mockUploadMedia).toHaveBeenCalledTimes(1);
    expect(mediaRows().every((r) => r.upload_state === 'pending')).toBe(true);
  });
});

// ===========================================================================
// A non-uploaded ordinal stops the item
// ===========================================================================

describe('a stopped ordinal stops the item', () => {
  it('does not upload later ordinals once one is held', async () => {
    seed([
      { ordinal: 0, mediaId: 'media-a', entryId: 'entry-a' },
      { ordinal: 1, mediaId: 'media-b', entryId: 'entry-b' },
    ]);
    extractImageEntry.mockImplementation(async (entryId: string) =>
      entryId === 'entry-a'
        ? { ok: false as const, skip: 'ENTRY_IS_VIDEO' as const }
        : extracted(entryId),
    );

    const outcome = await uploadImportItemMedia(pendingItem(), run());

    // An item is submittable only when EVERY ordinal is uploaded, so bytes
    // spent on ordinal 1 would be charged to the lifetime allowance for a post
    // that is never submitted — and the allowance is never refunded.
    expect(outcome).toEqual({ kind: 'held-video' });
    expect(mockUploadMedia).not.toHaveBeenCalled();
  });

  it('sorts by ordinal rather than trusting the caller’s array order', async () => {
    seed([
      { ordinal: 0, mediaId: 'media-a', entryId: 'entry-a' },
      { ordinal: 1, mediaId: 'media-b', entryId: 'entry-b' },
    ]);
    extractImageEntry.mockImplementation(async (entryId: string) => extracted(entryId));
    const item = pendingItem();
    const reversed: PendingImportItem = { ...item, media: [...item.media].reverse() };

    await uploadImportItemMedia(reversed, run());

    // The envelope's media order is what #927 renders.
    expect(extractImageEntry.mock.calls.map(([id]) => id)).toEqual(['entry-a', 'entry-b']);
  });
});

// ===========================================================================
// importMediaStage
// ===========================================================================

describe('importMediaStage', () => {
  function refusal(details: Record<string, unknown>): ConflictError {
    return new ConflictError(JSON.stringify({ error: 'IMPORT_REFUSED', details }));
  }

  it('reads the CHUNK allowance ceiling from staged_bytes/projected_bytes', () => {
    // assertChunkAllowanceCeiling sends both; the refusal is soft and the
    // session stays open.
    expect(
      importMediaStage(
        refusal({
          code: 'IMPORT_ALLOWANCE_EXCEEDED',
          allowance: {
            posts_used: 1,
            bytes_used: 2,
            posts_limit: 1000,
            bytes_limit: 2147483648,
          },
          staged_bytes: 10,
          projected_bytes: 20,
        }),
      ),
    ).toBe('media-chunk');
  });

  it('reads the media-COMPLETE allowance overrun from the absence of both', () => {
    // lockAllowanceForMediaBytes sends `allowance` alone, and has already
    // closed the session — the terminal path the runner must keep first-class.
    expect(
      importMediaStage(
        refusal({
          code: 'IMPORT_ALLOWANCE_EXCEEDED',
          allowance: {
            posts_used: 1,
            bytes_used: 2,
            posts_limit: 1000,
            bytes_limit: 2147483648,
          },
        }),
      ),
    ).toBe('media-complete');
  });

  it('reads the orbit quota refusal as media-complete', () => {
    // assertImportQuotaForMediaBytes runs after the media INSERT; the chunk
    // route takes no quota lock at all.
    expect(
      importMediaStage(
        refusal({ code: 'IMPORT_QUOTA_EXCEEDED', available_bytes: 1, size_bytes: 2 }),
      ),
    ).toBe('media-complete');
  });

  it('unwraps ImportMediaStagedError before reading the details', () => {
    const inner = refusal({
      code: 'IMPORT_QUOTA_EXCEEDED',
      available_bytes: 1,
      size_bytes: 2,
    });

    expect(importMediaStage(new ImportMediaStagedError(inner))).toBe('media-complete');
  });

  it.each([
    ['a NetworkError', new NetworkError('Network error')],
    ['a 403', new AuthError(403)],
    ['an IMPORT_CLOSED refusal', undefined],
    ['a non-error', 'nonsense'],
  ])('defaults %s to media-chunk', (_label, value) => {
    const e = value === undefined ? refusal({ code: 'IMPORT_CLOSED', status: 'abandoned' }) : value;

    // The conservative default: media-chunk has no outer retry ladder, so it
    // can never ADD a retry that re-extracts and re-encrypts a whole file.
    expect(importMediaStage(e)).toBe('media-chunk');
  });
});

// ===========================================================================
// estimateImportBytes (§4.5) and the file name
// ===========================================================================

describe('estimateImportBytes', () => {
  it('adds re-encode headroom and the ciphertext framing', () => {
    // 1 MiB declared -> 1.5 MiB of forced-q0.9 headroom + 64 bytes of framing.
    expect(estimateImportBytes(1024 * 1024)).toBe(1024 * 1024 * 1.5 + 64);
  });

  it('clamps an overstated declaredSize to the archive image cap', () => {
    const atCap = estimateImportBytes(ARCHIVE_IMAGE_ENTRY_MAX_BYTES);

    // declaredSize is the ZIP central directory's own claim: unvalidated and
    // export-controlled, so a crafted archive must not be able to inflate the
    // estimate without bound.
    expect(estimateImportBytes(ARCHIVE_IMAGE_ENTRY_MAX_BYTES * 100)).toBe(atCap);
    expect(estimateImportBytes(Number.MAX_SAFE_INTEGER)).toBe(atCap);
  });

  it('never over-estimates a real file: the estimate exceeds the declared size', () => {
    for (const size of [1, 1024, 400_000, 12 * 1024 * 1024]) {
      expect(estimateImportBytes(size)).toBeGreaterThan(size);
    }
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    'contributes the framing alone for %p',
    (bad) => {
      // A garbled record must neither inflate the sum nor make it negative.
      expect(estimateImportBytes(bad)).toBe(IMPORT_CIPHERTEXT_OVERHEAD_BYTES);
    },
  );

  it('is an integer, because declared_bytes is an INTEGER column', () => {
    expect(Number.isInteger(estimateImportBytes(12345))).toBe(true);
    expect(Number.isInteger(estimateImportBytes(1))).toBe(true);
  });
});

describe('importMediaFileName', () => {
  it('names the file after OUR media id, with the sniffed extension', () => {
    expect(importMediaFileName('media-a', 'image/png')).toBe('media-a.png');
    expect(importMediaFileName('media-a', 'image/jpeg')).toBe('media-a.jpg');
  });

  it('falls back to jpg for anything else, which uploadMedia then relabels', () => {
    // The sanitizer re-encodes a non-JPEG/PNG source to JPEG and the upload
    // service relabels the name from the bytes it actually wrote, so this is a
    // canonical starting point rather than a claim about the source.
    expect(importMediaFileName('media-a', 'image/heic')).toBe('media-a.jpg');
  });
});
