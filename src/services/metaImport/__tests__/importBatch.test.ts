/**
 * `importBatch.ts` — the #926 §4.6/§4.11 assembly layer.
 *
 * `importRepository` is REAL here, against migration 009's DDL executed on
 * `node:sqlite` (`testUtils/importDbHarness`): the contract this module is
 * written to is the repository's RETURN VALUES ("a short `markItemsUploading`
 * means your batch is stale", "`applyBatchResults` NULLs the body"), and a
 * mocked op-sqlite can only prove the SQL string.
 *
 * `importCrypto` is factory-mocked — it reaches `useAppStore` → MMKV/nitro —
 * with a real base64 `importKeyToWire` and a key session whose seals are
 * recorded, so "the title is sealed from the EMPTY string" is an assertion
 * rather than a comment.
 *
 * No fake timers (#834).
 */

import {
  countImportItemsByStatus,
  createImportJob,
  getPendingImportItems,
  insertImportItems,
  IMPORT_RESULT_UNKNOWN,
} from '../../../database/repositories/importRepository';
import { closeDatabase } from '../../../database/connection';
import {
  IMPORT_BATCH_HARD_MAX,
  IMPORT_BATCH_MAX_BYTES,
  IMPORT_ITEM_CODES,
  applyBatchOutcome,
  assembleBatch,
  batchRequestBytes,
  batchSizeLimit,
  buildImportItem,
  claimBatch,
  failImportItems,
  halveBatchSize,
  isBatchHalvingExhausted,
  isImportItemCode,
  isItemBatchEligible,
  mapBatchResults,
  preflightImportItem,
  releaseBatchClaim,
  wireItemBytes,
} from '../importBatch';
import { openImportDb } from '../testUtils/importDbHarness';

import type { ImportDbHarness } from '../testUtils/importDbHarness';
import type {
  ImportItemInsert,
  PendingImportItem,
} from '../../../database/repositories/importRepository';
import type { ImportBatchResultWire, ImportLimits } from '../../../types/api';
import type { ImportKeySession } from '../../crypto/importCrypto';
import type { BuiltImportItem, PreflightedItem } from '../importBatch';
import type { RunGuard } from '../importErrors';

jest.mock('@op-engineering/op-sqlite', () => ({ open: jest.fn() }));

jest.mock('../../crypto/importCrypto', () => ({
  // Standard padded base64 of the 16 bytes, exactly as the shipped helper does
  // it — the wire join in `mapBatchResults` is keyed on this string.
  importKeyToWire: (bytes: Uint8Array) => Buffer.from(bytes).toString('base64'),
  classifyImportCryptoError: () => null,
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** The server's advertised limits (`routes/imports.js`), verbatim. */
const LIMITS: ImportLimits = {
  batchMax: 50,
  mediaPerItemMax: 100,
  metaMaxBytes: 1024,
  ivMax: 64,
  titleMax: 10000,
  bodyMax: 100000,
  minDate: '2004-01-01',
  mediaContentClasses: ['image'],
};

const JOB = 'job-1';
const LIVE: RunGuard = { run: 3, currentRun: () => 3 };
const STALE: RunGuard = { run: 3, currentRun: () => 4 };

/** 2010-05-04T23:30:00Z — late enough in UTC that a local-time slice would slip. */
const DATE_MS = Date.UTC(2010, 4, 4, 23, 30, 0);

function key(byte: number): Uint8Array {
  return new Uint8Array(16).fill(byte);
}

function makeSession(
  overrides: Partial<Record<'sealContent' | 'sealImportMeta', unknown>> = {},
): ImportKeySession & {
  sealContent: jest.Mock;
  sealImportMeta: jest.Mock;
} {
  const session = {
    keyFingerprint: 'fp-1',
    deriveImportKey: jest.fn(),
    sealContent: jest.fn(async (plaintext: string) => ({
      ciphertext: `ct:${plaintext}`,
      iv: 'IV0',
    })),
    sealImportMeta: jest.fn(async (ms: number) => ({
      encryptedImportMeta: `meta:${ms}`,
      importMetaIv: 'IV1',
    })),
    verifyGroupKeyPin: jest.fn(async () => undefined),
    close: jest.fn(),
    ...overrides,
  };
  return session as unknown as ImportKeySession & {
    sealContent: jest.Mock;
    sealImportMeta: jest.Mock;
  };
}

/** A pending row as `getPendingImportItems` hands it over. */
function row(overrides: Partial<PendingImportItem> = {}): PendingImportItem {
  return {
    id: 'item-1',
    job_id: JOB,
    ordinal: 0,
    import_key: key(0xa1),
    status: 'pending',
    skip_reason: null,
    original_date: DATE_MS,
    body: 'hello world',
    source_file: 'your_posts_1.json',
    source_index: 3,
    id_kind: 1,
    thread_id: null,
    error_code: null,
    media: [],
    ...overrides,
  };
}

function mediaRow(ordinal: number, mediaId: string, uploaded = true) {
  return {
    item_id: 'item-1',
    ordinal,
    media_id: mediaId,
    entry_id: `entry-${ordinal}`,
    original_date: null,
    upload_state: uploaded ? ('uploaded' as const) : ('pending' as const),
  };
}

function preflighted(overrides: Partial<PreflightedItem> = {}): PreflightedItem {
  return {
    itemId: 'item-1',
    importKeyWire: Buffer.from(key(0xa1)).toString('base64'),
    originalDateMs: DATE_MS,
    originalCreatedAt: '2010-05-04',
    body: 'hello world',
    mediaIds: [],
    ...overrides,
  };
}

function built(itemId: string, importKey: string, bytes: number): BuiltImportItem {
  return {
    itemId,
    bytes,
    wire: {
      importKey,
      originalCreatedAt: '2010-05-04',
      encryptedTitle: 'ct:',
      encryptedBody: 'ct:body',
      titleIv: 'IV0',
      bodyIv: 'IV0',
    },
  };
}

/** The parser's hand-over shape, for seeding the real repository. */
function insert(overrides: Partial<ImportItemInsert> = {}): ImportItemInsert {
  return {
    id: 'item-1',
    ordinal: 0,
    importKey: key(0xa1),
    status: 'pending',
    skipReason: null,
    originalDate: DATE_MS,
    body: 'hello world',
    sourceFile: 'your_posts_1.json',
    sourceIndex: 3,
    idKind: 1,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Local preflight (§4.6 null narrowing)
// ---------------------------------------------------------------------------

describe('preflightImportItem', () => {
  it('narrows a good row and derives the UTC date', () => {
    const result = preflightImportItem(row(), LIMITS);
    expect(result).toEqual({
      ok: true,
      item: {
        itemId: 'item-1',
        importKeyWire: Buffer.from(key(0xa1)).toString('base64'),
        originalDateMs: DATE_MS,
        originalCreatedAt: '2010-05-04',
        body: 'hello world',
        mediaIds: [],
      },
    });
  });

  it('keeps the padded base64 shape the server validates', () => {
    const result = preflightImportItem(row(), LIMITS);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.item.importKeyWire).toMatch(/^[A-Za-z0-9+/]{22}==$/);
  });

  it('fails the item on a NULL import_key instead of throwing a TypeError', () => {
    expect(preflightImportItem(row({ import_key: null }), LIMITS)).toEqual({
      ok: false,
      code: 'IMPORT_ITEM_INVALID',
    });
  });

  it('fails the item on a wrong-width import_key instead of a run-terminal crypto invariant', () => {
    expect(preflightImportItem(row({ import_key: new Uint8Array(8) }), LIMITS)).toEqual({
      ok: false,
      code: 'IMPORT_ITEM_INVALID',
    });
  });

  it('fails the item on a NULL body', () => {
    expect(preflightImportItem(row({ body: null }), LIMITS)).toEqual({
      ok: false,
      code: 'IMPORT_ITEM_INVALID',
    });
  });

  it('accepts an EMPTY body — the server allows it and the title is empty too', () => {
    const result = preflightImportItem(row({ body: '' }), LIMITS);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.item.body).toBe('');
  });

  it('fails the item on a NULL date and SUBSTITUTES NOTHING', () => {
    const result = preflightImportItem(row({ original_date: null }), LIMITS);
    expect(result).toEqual({ ok: false, code: 'IMPORT_ITEM_INVALID' });
    expect(result).not.toHaveProperty('item');
  });

  it.each([[Number.NaN], [1.5], [Number.MAX_VALUE]])(
    'fails the item on an unusable date %p',
    (date) => {
      expect(preflightImportItem(row({ original_date: date }), LIMITS)).toEqual({
        ok: false,
        code: 'IMPORT_ITEM_INVALID',
      });
    },
  );

  it('orders media ids by ordinal', () => {
    const result = preflightImportItem(
      row({ media: [mediaRow(2, 'id-c'), mediaRow(0, 'id-a'), mediaRow(1, 'id-b')] }),
      LIMITS,
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.item.mediaIds).toEqual(['id-a', 'id-b', 'id-c']);
  });

  it('fails the item when media ids collide within it', () => {
    expect(
      preflightImportItem(row({ media: [mediaRow(0, 'same'), mediaRow(1, 'same')] }), LIMITS),
    ).toEqual({ ok: false, code: 'IMPORT_ITEM_INVALID' });
  });

  it('fails the item above the advertised media-per-item cap', () => {
    const media = Array.from({ length: 4 }, (_, i) => mediaRow(i, `id-${i}`));
    expect(preflightImportItem(row({ media }), { ...LIMITS, mediaPerItemMax: 3 })).toEqual({
      ok: false,
      code: 'IMPORT_ITEM_INVALID',
    });
  });
});

describe('isItemBatchEligible', () => {
  it('is true only when every ordinal is uploaded', () => {
    expect(isItemBatchEligible(row())).toBe(true);
    expect(isItemBatchEligible(row({ media: [mediaRow(0, 'a'), mediaRow(1, 'b')] }))).toBe(true);
    expect(isItemBatchEligible(row({ media: [mediaRow(0, 'a'), mediaRow(1, 'b', false)] }))).toBe(
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// Payload (§4.11)
// ---------------------------------------------------------------------------

describe('buildImportItem', () => {
  it('seals the title from the EMPTY string, the body from the row, and meta from the epoch date', async () => {
    const session = makeSession();
    const result = await buildImportItem(preflighted(), session, LIMITS);

    expect(session.sealContent).toHaveBeenNthCalledWith(1, '');
    expect(session.sealContent).toHaveBeenNthCalledWith(2, 'hello world');
    expect(session.sealImportMeta).toHaveBeenCalledWith(DATE_MS);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.built.wire).toEqual({
      importKey: preflighted().importKeyWire,
      originalCreatedAt: '2010-05-04',
      encryptedTitle: 'ct:',
      encryptedBody: 'ct:hello world',
      titleIv: 'IV0',
      bodyIv: 'IV0',
      encryptedImportMeta: `meta:${DATE_MS}`,
      importMetaIv: 'IV1',
    });
  });

  it('omits mediaIds entirely for a text-only post and sends them in order otherwise', async () => {
    const textOnly = await buildImportItem(preflighted(), makeSession(), LIMITS);
    expect(textOnly.ok).toBe(true);
    if (textOnly.ok) expect(textOnly.built.wire.mediaIds).toBeUndefined();

    const withMedia = await buildImportItem(
      preflighted({ mediaIds: ['id-a', 'id-b'] }),
      makeSession(),
      LIMITS,
    );
    expect(withMedia.ok).toBe(true);
    if (withMedia.ok) expect(withMedia.built.wire.mediaIds).toEqual(['id-a', 'id-b']);
  });

  it('never calls encryptContent or any group-key path itself', async () => {
    // The only crypto surface is the session: if a future edit reached for the
    // raw key, these two would stop being the whole encryption story.
    const session = makeSession();
    await buildImportItem(preflighted(), session, LIMITS);
    expect(session.sealContent).toHaveBeenCalledTimes(2);
    expect(session.sealImportMeta).toHaveBeenCalledTimes(1);
  });

  it('fails the item when a sealed body exceeds body_max', async () => {
    const session = makeSession({
      sealContent: jest.fn(async (p: string) => ({
        ciphertext: 'x'.repeat(p === '' ? 24 : 120),
        iv: 'IV0',
      })),
    });
    expect(await buildImportItem(preflighted(), session, { ...LIMITS, bodyMax: 100 })).toEqual({
      ok: false,
      code: 'IMPORT_ITEM_INVALID',
    });
  });

  it('fails the item when a sealed title exceeds title_max', async () => {
    const session = makeSession({
      sealContent: jest.fn(async () => ({ ciphertext: 'x'.repeat(40), iv: 'IV0' })),
    });
    expect(await buildImportItem(preflighted(), session, { ...LIMITS, titleMax: 24 })).toEqual({
      ok: false,
      code: 'IMPORT_ITEM_INVALID',
    });
  });

  it('fails the item when the meta envelope exceeds meta_max_bytes (base64 octets)', async () => {
    const session = makeSession({
      sealImportMeta: jest.fn(async () => ({
        encryptedImportMeta: 'x'.repeat(1025),
        importMetaIv: 'IV1',
      })),
    });
    expect(await buildImportItem(preflighted(), session, LIMITS)).toEqual({
      ok: false,
      code: 'IMPORT_ITEM_INVALID',
    });
  });

  it('fails the item on an IV outside 1..iv_max', async () => {
    const empty = makeSession({
      sealContent: jest.fn(async () => ({ ciphertext: 'ct', iv: '' })),
    });
    expect(await buildImportItem(preflighted(), empty, LIMITS)).toEqual({
      ok: false,
      code: 'IMPORT_ITEM_INVALID',
    });

    const long = makeSession({
      sealContent: jest.fn(async () => ({ ciphertext: 'ct', iv: 'x'.repeat(65) })),
    });
    expect(await buildImportItem(preflighted(), long, LIMITS)).toEqual({
      ok: false,
      code: 'IMPORT_ITEM_INVALID',
    });
  });

  it('lets a crypto error PROPAGATE, so the taxonomy can pause or stop the run', async () => {
    const changed = new Error('Group key changed during import');
    changed.name = 'ImportKeyChangedError';
    const session = makeSession({ sealContent: jest.fn(async () => Promise.reject(changed)) });

    await expect(buildImportItem(preflighted(), session, LIMITS)).rejects.toBe(changed);
  });
});

describe('byte accounting', () => {
  it('counts an item as its ASCII JSON plus the snake_case key expansion', async () => {
    const result = await buildImportItem(preflighted(), makeSession(), LIMITS);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.built.bytes).toBe(wireItemBytes(result.built.wire));
    expect(result.built.bytes).toBe(JSON.stringify(result.built.wire).length + 12);
  });

  it('counts a request body as the envelope, the items and their commas', () => {
    expect(batchRequestBytes([])).toBe('{"items":[]}'.length);
    expect(batchRequestBytes([built('a', 'KEYA', 100)])).toBe(112);
    expect(batchRequestBytes([built('a', 'KEYA', 100), built('b', 'KEYB', 50)])).toBe(163);
  });
});

// ---------------------------------------------------------------------------
// Assembly, halving
// ---------------------------------------------------------------------------

describe('batchSizeLimit', () => {
  it('reads the advertised cap but never exceeds the hard max', () => {
    expect(batchSizeLimit(LIMITS)).toBe(50);
    expect(batchSizeLimit({ ...LIMITS, batchMax: 10 })).toBe(10);
    expect(batchSizeLimit({ ...LIMITS, batchMax: 5000 })).toBe(IMPORT_BATCH_HARD_MAX);
  });

  it('honours the runner s current (halved) size and never returns 0', () => {
    expect(batchSizeLimit(LIMITS, 7)).toBe(7);
    expect(batchSizeLimit(LIMITS, 0)).toBe(1);
    expect(batchSizeLimit(LIMITS, -3)).toBe(1);
  });

  it('falls back to the hard max when the server advertises nonsense', () => {
    expect(batchSizeLimit({ ...LIMITS, batchMax: Number.NaN })).toBe(IMPORT_BATCH_HARD_MAX);
  });
});

describe('assembleBatch', () => {
  const items = Array.from({ length: 6 }, (_, i) => built(`item-${i}`, `KEY${i}`, 1000));

  it('stops at the item cap and defers the rest', () => {
    const { batch, deferred } = assembleBatch(items, { maxItems: 2 });
    expect(batch.map((b) => b.itemId)).toEqual(['item-0', 'item-1']);
    expect(deferred.map((b) => b.itemId)).toEqual(['item-2', 'item-3', 'item-4', 'item-5']);
  });

  it('stops at the byte cap even when the item cap allows more', () => {
    const { batch, deferred } = assembleBatch(items, { maxItems: 50, maxBytes: 2_500 });
    expect(batch).toHaveLength(2);
    expect(batchRequestBytes(batch)).toBeLessThanOrEqual(2_500);
    expect(deferred).toHaveLength(4);
  });

  it('always takes the first item, even when it alone exceeds the byte cap', () => {
    const huge = built('huge', 'KEYH', IMPORT_BATCH_MAX_BYTES * 2);
    const { batch, deferred } = assembleBatch([huge, items[0]], { maxItems: 50 });
    expect(batch.map((b) => b.itemId)).toEqual(['huge']);
    expect(deferred.map((b) => b.itemId)).toEqual(['item-0']);
  });

  it('defaults to the 4 MiB cap', () => {
    const { batch } = assembleBatch(
      Array.from({ length: 50 }, (_, i) => built(`i-${i}`, `K${i}`, 200_000)),
      { maxItems: 50 },
    );
    expect(batchRequestBytes(batch)).toBeLessThanOrEqual(IMPORT_BATCH_MAX_BYTES);
    expect(batch).toHaveLength(20);
  });

  it('returns an empty batch for an empty queue', () => {
    expect(assembleBatch([], { maxItems: 50 })).toEqual({ batch: [], deferred: [] });
  });
});

describe('halveBatchSize', () => {
  it('halves down to one and stops there', () => {
    expect([50, 25, 12, 6, 3, 1].map(halveBatchSize)).toEqual([25, 12, 6, 3, 1, 1]);
  });

  it('names the floor rather than leaving an inline === 1', () => {
    expect(isBatchHalvingExhausted(2)).toBe(false);
    expect(isBatchHalvingExhausted(1)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Result mapping (§4.6)
// ---------------------------------------------------------------------------

describe('mapBatchResults', () => {
  const batch = [
    built('item-0', 'KEY0', 100),
    built('item-1', 'KEY1', 100),
    built('item-2', 'KEY2', 100),
  ];

  it('joins on the echoed import_key, not on position', () => {
    const results: ImportBatchResultWire[] = [
      { importKey: 'KEY2', status: 'created', threadId: 't-2', createdAt: 'now' },
      { importKey: 'KEY0', status: 'duplicate', threadId: 't-0', createdAt: 'now' },
      { importKey: 'KEY1', status: 'rejected', code: 'IMPORT_DATE_INVALID' },
    ];

    const mapped = mapBatchResults(batch, results);
    expect(mapped.applied).toEqual([
      { itemId: 'item-2', status: 'created', threadId: 't-2' },
      { itemId: 'item-0', status: 'duplicate', threadId: 't-0' },
      { itemId: 'item-1', status: 'rejected', code: 'IMPORT_DATE_INVALID' },
    ]);
    expect(mapped).toMatchObject({
      created: 1,
      duplicate: 1,
      failed: 1,
      unmatched: 0,
      unanswered: [],
    });
  });

  it('falls back to the index when the echo is null', () => {
    const mapped = mapBatchResults(batch, [
      { importKey: null, status: 'created', threadId: 't-0' },
      { importKey: null, status: 'rejected', code: 'IMPORT_ITEM_INVALID' },
      { importKey: null, status: 'duplicate' },
    ]);
    expect(mapped.applied.map((a) => a.itemId)).toEqual(['item-0', 'item-1', 'item-2']);
    expect(mapped.applied[2]).toEqual({ itemId: 'item-2', status: 'duplicate', threadId: null });
  });

  it('allowlists the rejected code and sentinels anything else', () => {
    const mapped = mapBatchResults(batch, [
      { importKey: 'KEY0', status: 'rejected', code: 'IMPORT_MEDIA_NOT_OWNED' },
      { importKey: 'KEY1', status: 'rejected', code: 'IMPORT_SOMETHING_NEW' },
      { importKey: 'KEY2', status: 'rejected' },
    ]);
    expect(mapped.applied).toEqual([
      { itemId: 'item-0', status: 'rejected', code: 'IMPORT_MEDIA_NOT_OWNED' },
      { itemId: 'item-1', status: 'rejected', code: IMPORT_RESULT_UNKNOWN },
      { itemId: 'item-2', status: 'rejected', code: IMPORT_RESULT_UNKNOWN },
    ]);
    expect(mapped.failed).toBe(3);
  });

  it('refuses a prototype key as a rejected code', () => {
    expect(isImportItemCode('constructor')).toBe(false);
    expect(isImportItemCode('toString')).toBe(false);
    expect(isImportItemCode('IMPORT_ITEM_INVALID')).toBe(true);
    expect(Object.keys(IMPORT_ITEM_CODES)).toEqual([
      'IMPORT_ITEM_INVALID',
      'IMPORT_DATE_INVALID',
      'IMPORT_MEDIA_NOT_OWNED',
    ]);

    const mapped = mapBatchResults(batch, [
      { importKey: 'KEY0', status: 'rejected', code: 'constructor' },
    ]);
    expect(mapped.applied[0]).toEqual({
      itemId: 'item-0',
      status: 'rejected',
      code: IMPORT_RESULT_UNKNOWN,
    });
  });

  it('parks a status this build does not know instead of trusting it', () => {
    const mapped = mapBatchResults(batch, [
      { importKey: 'KEY0', status: 'accepted' as unknown as 'created', threadId: 't-0' },
    ]);
    expect(mapped.applied[0]).toEqual({
      itemId: 'item-0',
      status: 'rejected',
      code: IMPORT_RESULT_UNKNOWN,
    });
    expect(mapped.created).toBe(0);
    expect(mapped.failed).toBe(1);
  });

  it('never lets one echoed key claim two items', () => {
    const mapped = mapBatchResults(batch, [
      { importKey: 'KEY0', status: 'created', threadId: 't-a' },
      { importKey: 'KEY0', status: 'created', threadId: 't-b' },
    ]);
    expect(mapped.applied).toEqual([
      { itemId: 'item-0', status: 'created', threadId: 't-a' },
      { itemId: 'item-1', status: 'created', threadId: 't-b' },
    ]);
  });

  it('counts a result that matches nothing, and reports items the server ignored', () => {
    const mapped = mapBatchResults(
      [batch[0]],
      [
        { importKey: 'KEY0', status: 'created', threadId: 't-0' },
        { importKey: 'KEY9', status: 'created', threadId: 't-9' },
      ],
    );
    expect(mapped.unmatched).toBe(1);
    expect(mapped.applied).toHaveLength(1);

    const short = mapBatchResults(batch, [
      { importKey: 'KEY0', status: 'created', threadId: 't-0' },
    ]);
    expect(short.unanswered).toEqual(['item-1', 'item-2']);
  });
});

// ---------------------------------------------------------------------------
// Repository writes, against the real database
// ---------------------------------------------------------------------------

describe('repository writes (real importRepository on node:sqlite)', () => {
  let harness: ImportDbHarness;

  function statuses(): Record<
    string,
    { status: string; error_code: string | null; body: string | null; thread_id: string | null }
  > {
    const rows = harness.sqlite
      .prepare('SELECT id, status, error_code, body, thread_id FROM import_items ORDER BY ordinal')
      .all() as unknown as {
      id: string;
      status: string;
      error_code: string | null;
      body: string | null;
      thread_id: string | null;
    }[];
    return Object.fromEntries(
      rows.map((r) => [
        r.id,
        { status: r.status, error_code: r.error_code, body: r.body, thread_id: r.thread_id },
      ]),
    );
  }

  beforeEach(() => {
    harness = openImportDb();
    createImportJob({
      id: JOB,
      conversationId: 'orbit-1',
      source: 'facebook',
      keyFingerprint: 'fp-1',
      createdAt: DATE_MS,
    });
    insertImportItems(JOB, [
      insert({ id: 'item-0', ordinal: 0, importKey: key(0xa0) }),
      insert({ id: 'item-1', ordinal: 1, importKey: key(0xa1) }),
      insert({ id: 'item-2', ordinal: 2, importKey: key(0xa2) }),
    ]);
  });

  afterEach(() => {
    closeDatabase();
    jest.clearAllMocks();
  });

  it('round-trips a pending row through preflight — the key survives as 16 bytes', () => {
    const pending = getPendingImportItems(JOB, 10);
    expect(pending).toHaveLength(3);
    expect(pending[0].import_key).toBeInstanceOf(Uint8Array);

    const result = preflightImportItem(pending[0], LIMITS);
    expect(result.ok).toBe(true);
    if (result.ok)
      expect(result.item.importKeyWire).toBe(Buffer.from(key(0xa0)).toString('base64'));
  });

  it('claims a batch by moving its rows to uploading', () => {
    const batch = [built('item-0', 'KEY0', 10), built('item-1', 'KEY1', 10)];
    expect(claimBatch(JOB, batch, LIVE)).toEqual({ kind: 'ok', value: 2 });
    expect(statuses()['item-0'].status).toBe('uploading');
    expect(statuses()['item-1'].status).toBe('uploading');
    expect(statuses()['item-2'].status).toBe('pending');
  });

  it('reports a stale batch when a row is no longer pending', () => {
    // item-0 is already taken server-side.
    applyBatchOutcome(JOB, [{ itemId: 'item-0', status: 'created', threadId: 't-0' }], LIVE);

    expect(
      claimBatch(JOB, [built('item-0', 'KEY0', 10), built('item-1', 'KEY1', 10)], LIVE),
    ).toEqual({
      kind: 'stale',
    });
    // The guard means the already-created row was NOT demoted.
    expect(statuses()['item-0'].status).toBe('created');
  });

  it('writes nothing at all once the run has moved on (rule 0)', () => {
    const before = statuses();
    expect(claimBatch(JOB, [built('item-0', 'KEY0', 10)], STALE)).toEqual({ kind: 'cancelled' });
    expect(
      applyBatchOutcome(JOB, [{ itemId: 'item-0', status: 'created', threadId: 't' }], STALE),
    ).toEqual({
      kind: 'cancelled',
    });
    expect(
      failImportItems(JOB, [{ itemId: 'item-0', code: 'IMPORT_ITEM_INVALID' }], STALE),
    ).toEqual({
      kind: 'cancelled',
    });
    expect(releaseBatchClaim(JOB, ['item-0'], STALE)).toEqual({ kind: 'cancelled' });
    expect(statuses()).toEqual(before);
  });

  it('requeues the halving remainder back to pending', () => {
    claimBatch(JOB, [built('item-0', 'KEY0', 10), built('item-1', 'KEY1', 10)], LIVE);
    expect(releaseBatchClaim(JOB, ['item-1'], LIVE)).toEqual({ kind: 'ok', value: 1 });
    expect(statuses()['item-0'].status).toBe('uploading');
    expect(statuses()['item-1'].status).toBe('pending');
  });

  it('applies a mapped response: thread id in, plaintext body out', () => {
    const batch = [built('item-0', 'KEY0', 10), built('item-1', 'KEY1', 10)];
    claimBatch(JOB, batch, LIVE);

    const mapped = mapBatchResults(batch, [
      { importKey: 'KEY0', status: 'created', threadId: 't-0', createdAt: 'now' },
      { importKey: 'KEY1', status: 'rejected', code: 'IMPORT_DATE_INVALID' },
    ]);
    expect(applyBatchOutcome(JOB, mapped.applied, LIVE)).toEqual({ kind: 'ok', value: 2 });

    expect(statuses()['item-0']).toEqual({
      status: 'created',
      error_code: null,
      body: null,
      thread_id: 't-0',
    });
    expect(statuses()['item-1']).toEqual({
      status: 'failed',
      error_code: 'IMPORT_DATE_INVALID',
      // A rejected item keeps its body: the retry needs the payload.
      body: 'hello world',
      thread_id: null,
    });
  });

  it('fails an item locally with our own code, through the same writer', () => {
    expect(
      failImportItems(JOB, [{ itemId: 'item-2', code: 'IMPORT_ITEM_TOO_LARGE' }], LIVE),
    ).toEqual({
      kind: 'ok',
      value: 1,
    });
    expect(statuses()['item-2']).toMatchObject({
      status: 'failed',
      error_code: 'IMPORT_ITEM_TOO_LARGE',
    });
  });

  it('is a no-op for an empty write', () => {
    expect(claimBatch(JOB, [], LIVE)).toEqual({ kind: 'ok', value: 0 });
    expect(applyBatchOutcome(JOB, [], LIVE)).toEqual({ kind: 'ok', value: 0 });
    expect(failImportItems(JOB, [], LIVE)).toEqual({ kind: 'ok', value: 0 });
    expect(releaseBatchClaim(JOB, [], LIVE)).toEqual({ kind: 'ok', value: 0 });
    expect(countImportItemsByStatus(JOB)).toMatchObject({ pending: 3 });
  });

  it('drives one whole batch: preflight → seal → assemble → claim → map → apply', async () => {
    const session = makeSession();
    const pending = getPendingImportItems(JOB, 50);

    const builtItems: BuiltImportItem[] = [];
    for (const item of pending) {
      const pre = preflightImportItem(item, LIMITS);
      expect(pre.ok).toBe(true);
      if (!pre.ok) continue;
      const build = await buildImportItem(pre.item, session, LIMITS);
      expect(build.ok).toBe(true);
      if (build.ok) builtItems.push(build.built);
    }

    const { batch, deferred } = assembleBatch(builtItems, { maxItems: batchSizeLimit(LIMITS) });
    expect(batch).toHaveLength(3);
    expect(deferred).toHaveLength(0);
    expect(claimBatch(JOB, batch, LIVE)).toEqual({ kind: 'ok', value: 3 });

    const mapped = mapBatchResults(
      batch,
      batch.map((b, i) => ({
        importKey: b.wire.importKey,
        status: i === 2 ? ('rejected' as const) : ('created' as const),
        ...(i === 2 ? { code: 'IMPORT_ITEM_INVALID' } : { threadId: `t-${i}`, createdAt: 'now' }),
      })),
    );
    expect(applyBatchOutcome(JOB, mapped.applied, LIVE)).toEqual({ kind: 'ok', value: 3 });

    expect(countImportItemsByStatus(JOB)).toMatchObject({
      pending: 0,
      uploading: 0,
      created: 2,
      failed: 1,
    });
  });
});
