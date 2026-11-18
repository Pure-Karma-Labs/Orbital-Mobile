/**
 * `importLookup.ts` — the two steps of the #930 pre-check.
 *
 * The repository is MOCKED here, unlike in `importRunner.test.ts`: this
 * module's whole subject is what it sends and what it believes, and the SQL
 * behind `markImportItemsPresent` has its own pins in
 * `importRepository.test.ts`. What the mock buys is the one thing a real DB
 * cannot show cheaply — a row the UPDATE did NOT move.
 *
 * `importKeyToWire` is mocked with the real base64 of the bytes, so the
 * canonical check is exercised rather than assumed.
 *
 * Run: npm test -- importLookup
 */

const mockGetPendingImportKeyPage = jest.fn();
const mockMarkImportItemsPresent = jest.fn();

jest.mock('../../../database/repositories/importRepository', () => ({
  getPendingImportKeyPage: (...a: unknown[]) => mockGetPendingImportKeyPage(...a),
  markImportItemsPresent: (...a: unknown[]) => mockMarkImportItemsPresent(...a),
}));

jest.mock('../../crypto/importCrypto', () => ({
  importKeyToWire: (bytes: Uint8Array) => {
    if (bytes.length !== 16) throw new Error('import_key must be exactly 16 bytes');
    // The sentinel below. The literal is inline because a `jest.mock` factory
    // is hoisted above every const in this file.
    if (bytes[0] === 0xee) return Buffer.from(bytes).toString('base64url');
    return Buffer.from(bytes).toString('base64');
  },
}));

import { applyLookupResponse, LOOKUP_PAGE_MAX, nextLookupPage } from '../importLookup';

import type { ImportLookupResponse } from '../../../types/api';

const JOB = 'job-1';

/** A 16-byte key whose base64 is canonical: 22 chars plus `==`. */
function key(fill: number): Uint8Array {
  return new Uint8Array(16).fill(fill);
}

function wire(fill: number): string {
  return Buffer.from(key(fill)).toString('base64');
}

/**
 * The fill byte the mocked encoder answers with a NON-CANONICAL string
 * (base64url, so 22 chars and no `==`).
 *
 * It is the only way to reach `CANONICAL_IMPORT_KEY_WIRE` at all. The real
 * `importKeyToWire` throws on anything that is not 16 bytes and otherwise
 * emits standard padded base64, so that regex is unreachable behind today's
 * encoder: it is defence-in-depth against a future one (a base64url switch,
 * say) sending the server a key it refuses the WHOLE request over. Pinning it
 * through a sentinel is what keeps the guard from rotting into dead code.
 */
const NON_CANONICAL_FILL = 0xee;

/** One row as `getPendingImportKeyPage` returns it. */
function row(ordinal: number, fill: number, bytes = 16) {
  return { id: `item-${ordinal}`, ordinal, import_key: new Uint8Array(bytes).fill(fill) };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetPendingImportKeyPage.mockReturnValue([]);
  // Default: every id asked for moved.
  mockMarkImportItemsPresent.mockImplementation((_job: string, ids: string[]) => [...ids]);
});

// ---------------------------------------------------------------------------
// nextLookupPage
// ---------------------------------------------------------------------------

describe('nextLookupPage', () => {
  it('encodes a page and reads it strictly after the cursor', () => {
    mockGetPendingImportKeyPage.mockReturnValue([row(3, 1), row(4, 2)]);

    const page = nextLookupPage(JOB, 2, 50);

    expect(mockGetPendingImportKeyPage).toHaveBeenCalledWith(JOB, 2, 50);
    expect(page.rows).toEqual([
      { itemId: 'item-3', ordinal: 3, importKeyWire: wire(1) },
      { itemId: 'item-4', ordinal: 4, importKeyWire: wire(2) },
    ]);
    expect(page.lastOrdinal).toBe(4);
    expect(page.scanned).toBe(2);
  });

  it('pages by ordinal: the next call starts after the last row READ', () => {
    mockGetPendingImportKeyPage
      .mockReturnValueOnce([row(0, 1), row(1, 2)])
      .mockReturnValueOnce([row(7, 3)]);

    const first = nextLookupPage(JOB, -1, 2);
    const second = nextLookupPage(JOB, first.lastOrdinal, 2);

    expect(mockGetPendingImportKeyPage.mock.calls[0]).toEqual([JOB, -1, 2]);
    expect(mockGetPendingImportKeyPage.mock.calls[1]).toEqual([JOB, 1, 2]);
    expect(second.rows.map((r) => r.ordinal)).toEqual([7]);
    expect(second.lastOrdinal).toBe(7);
  });

  it('drops a key the encoder REFUSES and still advances the cursor past it', () => {
    // 15 bytes: `importKeyToWire` throws, and the server would answer 400 for
    // the WHOLE request on it — one bad row must not void a whole page.
    mockGetPendingImportKeyPage.mockReturnValue([row(5, 1, 15), row(6, 2)]);

    const page = nextLookupPage(JOB, 4, 50);

    expect(page.rows.map((r) => r.itemId)).toEqual(['item-6']);
    // `scanned` counts rows READ, which is what the runner terminates on: a
    // page whose every key was dropped still has pages behind it.
    expect(page.scanned).toBe(2);
    // From the rows READ, not the rows kept. Otherwise a trailing bad row
    // would be re-read forever.
    expect(page.lastOrdinal).toBe(6);
  });

  it('keeps the cursor when the dropped row is the LAST of the page', () => {
    mockGetPendingImportKeyPage.mockReturnValue([row(8, 1), row(9, 2, 17)]);

    const page = nextLookupPage(JOB, 7, 50);

    expect(page.rows.map((r) => r.itemId)).toEqual(['item-8']);
    expect(page.lastOrdinal).toBe(9);
  });

  it('drops a key that ENCODES but not to the canonical 22+== shape', () => {
    // 16 bytes, so the encoder does not throw — it answers base64url, which
    // the backend's `IMPORT_KEY_B64_RE` refuses. The regex is re-checked
    // rather than trusted from the encoder, and this is the arm that proves
    // it: see the note on NON_CANONICAL_FILL.
    mockGetPendingImportKeyPage.mockReturnValue([row(1, NON_CANONICAL_FILL), row(2, 3)]);

    const page = nextLookupPage(JOB, 0, 50);

    // The encoded form is well-formed base64url and 22 chars with no padding.
    const encoded = Buffer.from(key(NON_CANONICAL_FILL)).toString('base64url');
    expect(encoded).toHaveLength(22);
    expect(encoded.endsWith('=')).toBe(false);
    // Dropped locally; the good row beside it still goes out, and the cursor
    // moves past both.
    expect(page.rows.map((r) => r.itemId)).toEqual(['item-2']);
    expect(page.scanned).toBe(2);
    expect(page.lastOrdinal).toBe(2);
  });

  it('clamps the page size to LOOKUP_PAGE_MAX whatever the server advertised', () => {
    nextLookupPage(JOB, -1, 100_000);

    expect(mockGetPendingImportKeyPage).toHaveBeenCalledWith(JOB, -1, LOOKUP_PAGE_MAX);
    expect(LOOKUP_PAGE_MAX).toBe(1000);
  });

  it('reports a drained queue as scanned 0 with the cursor unmoved', () => {
    const page = nextLookupPage(JOB, 12, 50);

    expect(page.scanned).toBe(0);
    expect(page.rows).toEqual([]);
    expect(page.lastOrdinal).toBe(12);
  });
});

// ---------------------------------------------------------------------------
// applyLookupResponse
// ---------------------------------------------------------------------------

describe('applyLookupResponse', () => {
  function pageOf(...fills: number[]) {
    mockGetPendingImportKeyPage.mockReturnValue(fills.map((fill, i) => row(i, fill)));
    return nextLookupPage(JOB, -1, 50);
  }

  it('marks the matching rows present and returns them with their ordinals', () => {
    const page = pageOf(1, 2, 3);

    const moved = applyLookupResponse(JOB, page, { existing: [wire(3), wire(1)] });

    expect(mockMarkImportItemsPresent).toHaveBeenCalledWith(JOB, ['item-0', 'item-2']);
    // The ordinal is the point: the runner keys its per-item byte map on it.
    expect(moved).toEqual([
      { itemId: 'item-0', ordinal: 0, importKeyWire: wire(1) },
      { itemId: 'item-2', ordinal: 2, importKeyWire: wire(3) },
    ]);
  });

  it('ignores a non-array `existing` without touching the database', () => {
    const page = pageOf(1);

    // The TypeScript type is erased at runtime; `.filter` on a string would
    // throw a TypeError into the parse.
    const moved = applyLookupResponse(JOB, page, {
      existing: 'AAAA',
    } as unknown as ImportLookupResponse);

    expect(moved).toEqual([]);
    expect(mockMarkImportItemsPresent).not.toHaveBeenCalled();
  });

  it('ignores a missing `existing`', () => {
    const page = pageOf(1);

    expect(applyLookupResponse(JOB, page, {} as ImportLookupResponse)).toEqual([]);
    expect(mockMarkImportItemsPresent).not.toHaveBeenCalled();
  });

  it('ignores non-string entries', () => {
    const page = pageOf(1, 2);

    const moved = applyLookupResponse(JOB, page, {
      existing: [null, 42, { importKey: wire(1) }, [wire(2)], wire(2)],
    } as unknown as ImportLookupResponse);

    expect(moved.map((r) => r.itemId)).toEqual(['item-1']);
  });

  it('ignores an entry that was not in THIS page', () => {
    const page = pageOf(1, 2);

    const moved = applyLookupResponse(JOB, page, {
      // A key from another page, one from another job, and one invented.
      existing: [wire(9), 'not-base64-at-all', wire(1)],
    });

    // The server never names which local rows to mutate: only keys this page
    // sent can move a row.
    expect(mockMarkImportItemsPresent).toHaveBeenCalledWith(JOB, ['item-0']);
    expect(moved.map((r) => r.itemId)).toEqual(['item-0']);
  });

  it('de-duplicates a key the server echoed twice', () => {
    const page = pageOf(1);

    applyLookupResponse(JOB, page, { existing: [wire(1), wire(1), wire(1)] });

    expect(mockMarkImportItemsPresent).toHaveBeenCalledWith(JOB, ['item-0']);
  });

  it('returns only the rows SQL actually moved', () => {
    const page = pageOf(1, 2);
    // `item-1` was requeued or wiped between the page read and the apply.
    mockMarkImportItemsPresent.mockReturnValue(['item-0']);

    const moved = applyLookupResponse(JOB, page, { existing: [wire(1), wire(2)] });

    // Crediting a row that did not move would under-declare `declared_bytes`
    // against a `CHECK (>= 0)` column.
    expect(moved.map((r) => r.itemId)).toEqual(['item-0']);
  });

  it('writes nothing when the page matched nothing', () => {
    const page = pageOf(1, 2);

    expect(applyLookupResponse(JOB, page, { existing: [] })).toEqual([]);
    expect(mockMarkImportItemsPresent).not.toHaveBeenCalled();
  });

  it('writes nothing for a page whose every key was dropped locally', () => {
    mockGetPendingImportKeyPage.mockReturnValue([row(0, 1, 15)]);
    const page = nextLookupPage(JOB, -1, 50);

    expect(applyLookupResponse(JOB, page, { existing: [wire(1)] })).toEqual([]);
    expect(mockMarkImportItemsPresent).not.toHaveBeenCalled();
  });
});
