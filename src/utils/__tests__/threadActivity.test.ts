/**
 * Tests for the thread-recency helpers (#883).
 *
 * The comparator is exercised as an ORDER, not as a list of expectations:
 * antisymmetry, transitivity and determinism are checked over every pair and
 * triple of a representative set, because `Array.prototype.sort` with an
 * inconsistent comparator produces implementation-defined garbage rather than
 * a visible failure.
 */

import {
  compareThreadsByActivityDesc,
  maxTimestamp,
  threadActivityAt,
  type ThreadActivityInput,
} from '../threadActivity';

// ---------------------------------------------------------------------------
// Representative set
// ---------------------------------------------------------------------------

/**
 * Every shape the comparator has to decide: valid/valid, reply-bumped, exact
 * activity ties resolved by createdAt and by id, and each flavour of invalid
 * (NaN, 0, negative, Infinity) on either field.
 */
const CASES: Record<string, ThreadActivityInput> = {
  // activity 1000 — createdAt only
  a: { id: 'a', createdAt: 1000, lastReplyAt: null },
  // activity 5000 — reply-bumped old thread
  b: { id: 'b', createdAt: 1000, lastReplyAt: 5000 },
  // activity 3000 — createdAt only
  c: { id: 'c', createdAt: 3000, lastReplyAt: null },
  // activity 3000, same createdAt as `c` -> decided by id
  d: { id: 'd', createdAt: 3000, lastReplyAt: 3000 },
  // no valid timestamp at all
  e: { id: 'e', createdAt: NaN, lastReplyAt: null },
  // no valid timestamp at all, ties with `e` -> decided by id
  f: { id: 'f', createdAt: NaN, lastReplyAt: NaN },
  // activity 5000, ties with `b`, but its createdAt is invalid -> after `b`
  g: { id: 'g', createdAt: NaN, lastReplyAt: 5000 },
  // Infinity createdAt is dropped -> activity 2000
  h: { id: 'h', createdAt: Infinity, lastReplyAt: 2000 },
  // 0 is the "no value" sentinel, not 1970 -> no valid timestamp
  i: { id: 'i', createdAt: 0, lastReplyAt: 0 },
  // negative createdAt dropped -> activity 7000, the newest in the set
  j: { id: 'j', createdAt: -5, lastReplyAt: 7000 },
};

const ALL = Object.values(CASES);

function sortIds(input: readonly ThreadActivityInput[]): string[] {
  return [...input].sort(compareThreadsByActivityDesc).map((t) => t.id);
}

// ---------------------------------------------------------------------------
// threadActivityAt
// ---------------------------------------------------------------------------

describe('threadActivityAt', () => {
  it('returns the newer of createdAt and lastReplyAt', () => {
    expect(threadActivityAt({ createdAt: 1000, lastReplyAt: 5000 })).toBe(5000);
    expect(threadActivityAt({ createdAt: 9000, lastReplyAt: 5000 })).toBe(9000);
    expect(threadActivityAt({ createdAt: 5000, lastReplyAt: 5000 })).toBe(5000);
  });

  it('falls back to whichever single timestamp is valid', () => {
    expect(threadActivityAt({ createdAt: 3000, lastReplyAt: null })).toBe(3000);
    expect(threadActivityAt({ createdAt: 3000, lastReplyAt: NaN })).toBe(3000);
    expect(threadActivityAt({ createdAt: 3000, lastReplyAt: Infinity })).toBe(3000);
    expect(threadActivityAt({ createdAt: NaN, lastReplyAt: 4000 })).toBe(4000);
    expect(threadActivityAt({ createdAt: 0, lastReplyAt: 4000 })).toBe(4000);
    expect(threadActivityAt({ createdAt: -1, lastReplyAt: 4000 })).toBe(4000);
  });

  // NaN is the contract: localDayKey(NaN) === '' is what keeps an unrenderable
  // row from opening a day group of its own and splitting a real one (#845).
  it('returns NaN when neither timestamp is valid', () => {
    expect(threadActivityAt({ createdAt: NaN, lastReplyAt: null })).toBeNaN();
    expect(threadActivityAt({ createdAt: NaN, lastReplyAt: NaN })).toBeNaN();
    expect(threadActivityAt({ createdAt: 0, lastReplyAt: 0 })).toBeNaN();
    expect(threadActivityAt({ createdAt: -10, lastReplyAt: null })).toBeNaN();
    expect(threadActivityAt({ createdAt: Infinity, lastReplyAt: -Infinity })).toBeNaN();
  });
});

// ---------------------------------------------------------------------------
// compareThreadsByActivityDesc — order properties
// ---------------------------------------------------------------------------

describe('compareThreadsByActivityDesc — total order', () => {
  it('never returns NaN, and only ever -1, 0 or 1', () => {
    for (const x of ALL) {
      for (const y of ALL) {
        const result = compareThreadsByActivityDesc(x, y);
        expect(Number.isNaN(result)).toBe(false);
        expect([-1, 0, 1]).toContain(result);
      }
    }
  });

  it('is antisymmetric over every pair', () => {
    for (const x of ALL) {
      for (const y of ALL) {
        // Summed rather than negated-and-compared: Object.is(-0, 0) is false,
        // so `toBe(-Math.sign(0))` would fail on a legitimate tie.
        const forward = Math.sign(compareThreadsByActivityDesc(x, y));
        const reverse = Math.sign(compareThreadsByActivityDesc(y, x));
        expect(forward + reverse).toBe(0);
        expect(Math.abs(forward)).toBe(Math.abs(reverse));
      }
    }
  });

  it('is reflexive: a row compares equal to itself and to its own copy', () => {
    for (const x of ALL) {
      expect(compareThreadsByActivityDesc(x, x)).toBe(0);
      expect(compareThreadsByActivityDesc({ ...x }, { ...x })).toBe(0);
    }
  });

  it('is transitive over every triple', () => {
    for (const x of ALL) {
      for (const y of ALL) {
        if (compareThreadsByActivityDesc(x, y) > 0) continue;
        for (const z of ALL) {
          if (compareThreadsByActivityDesc(y, z) > 0) continue;
          expect(compareThreadsByActivityDesc(x, z)).toBeLessThanOrEqual(0);
        }
      }
    }
  });

  // Distinct ids never compare equal, so the sorted order is a single total
  // order rather than a set of interchangeable buckets.
  it('only ever reports equality for the same id', () => {
    for (const x of ALL) {
      for (const y of ALL) {
        if (compareThreadsByActivityDesc(x, y) === 0) {
          expect(x.id).toBe(y.id);
        }
      }
    }
  });
});

describe('compareThreadsByActivityDesc — ordering rules', () => {
  it('puts the most recent activity first, with invalid activity last', () => {
    expect(sortIds(ALL)).toEqual(['j', 'b', 'g', 'c', 'd', 'h', 'a', 'e', 'f', 'i']);
  });

  it('lifts an old thread with a recent reply above a newer quiet thread', () => {
    const oldWithReply: ThreadActivityInput = { id: 'old', createdAt: 1_000, lastReplyAt: 9_000 };
    const newerQuiet: ThreadActivityInput = { id: 'new', createdAt: 5_000, lastReplyAt: null };
    expect(sortIds([newerQuiet, oldWithReply])).toEqual(['old', 'new']);
  });

  it('breaks an activity tie on createdAt descending', () => {
    const older: ThreadActivityInput = { id: 'aaa', createdAt: 1_000, lastReplyAt: 9_000 };
    const newer: ThreadActivityInput = { id: 'zzz', createdAt: 2_000, lastReplyAt: 9_000 };
    // `aaa` would win an id-only tiebreak; createdAt is consulted first.
    expect(sortIds([older, newer])).toEqual(['zzz', 'aaa']);
  });

  it('breaks a full tie on id, so the order is stable across re-sorts', () => {
    const rows: ThreadActivityInput[] = [
      { id: 'z', createdAt: 4_000, lastReplyAt: null },
      { id: 'm', createdAt: 4_000, lastReplyAt: null },
      { id: 'a', createdAt: 4_000, lastReplyAt: null },
    ];
    expect(sortIds(rows)).toEqual(['a', 'm', 'z']);
    expect(sortIds([...rows].reverse())).toEqual(['a', 'm', 'z']);
  });

  it('gives the same order regardless of input order', () => {
    const expected = sortIds(ALL);
    expect(sortIds([...ALL].reverse())).toEqual(expected);
    // A deterministic shuffle: every rotation of the input.
    for (let offset = 1; offset < ALL.length; offset++) {
      const rotated = [...ALL.slice(offset), ...ALL.slice(0, offset)];
      expect(sortIds(rotated)).toEqual(expected);
    }
  });

  it('sorts every flavour of invalid timestamp last', () => {
    const valid: ThreadActivityInput = { id: 'valid', createdAt: 1, lastReplyAt: null };
    for (const bad of [CASES.e, CASES.f, CASES.i]) {
      expect(compareThreadsByActivityDesc(valid, bad)).toBe(-1);
      expect(compareThreadsByActivityDesc(bad, valid)).toBe(1);
    }
  });
});

// ---------------------------------------------------------------------------
// maxTimestamp — the only input to a STORED timestamp
// ---------------------------------------------------------------------------

describe('maxTimestamp', () => {
  it('returns the newer of two valid timestamps', () => {
    expect(maxTimestamp(5, 9)).toBe(9);
    expect(maxTimestamp(9, 5)).toBe(9);
    expect(maxTimestamp(7, 7)).toBe(7);
  });

  it('drops a non-finite operand on either side', () => {
    expect(maxTimestamp(NaN, 123)).toBe(123);
    expect(maxTimestamp(123, NaN)).toBe(123);
    expect(maxTimestamp(Infinity, 5)).toBe(5);
    expect(maxTimestamp(5, Infinity)).toBe(5);
    expect(maxTimestamp(-Infinity, 5)).toBe(5);
    expect(maxTimestamp(5, -Infinity)).toBe(5);
  });

  it('drops a non-positive operand on either side', () => {
    expect(maxTimestamp(0, 5)).toBe(5);
    expect(maxTimestamp(5, 0)).toBe(5);
    expect(maxTimestamp(-10, 5)).toBe(5);
    expect(maxTimestamp(5, -10)).toBe(5);
  });

  it('returns null when both operands are dropped', () => {
    expect(maxTimestamp(NaN, null)).toBeNull();
    expect(maxTimestamp(null, NaN)).toBeNull();
    expect(maxTimestamp(NaN, NaN)).toBeNull();
    expect(maxTimestamp(null, null)).toBeNull();
    expect(maxTimestamp(undefined, undefined)).toBeNull();
    expect(maxTimestamp(null, undefined)).toBeNull();
    expect(maxTimestamp(0, null)).toBeNull();
    expect(maxTimestamp(0, 0)).toBeNull();
    expect(maxTimestamp(-10, undefined)).toBeNull();
    expect(maxTimestamp(Infinity, Infinity)).toBeNull();
    expect(maxTimestamp(Infinity, -Infinity)).toBeNull();
  });

  it('passes a lone valid operand through, whichever side it is on', () => {
    expect(maxTimestamp(null, 123)).toBe(123);
    expect(maxTimestamp(123, null)).toBe(123);
    expect(maxTimestamp(undefined, 123)).toBe(123);
    expect(maxTimestamp(123, undefined)).toBe(123);
  });

  // The whole reason this function exists: a stored NaN/Infinity would pin a
  // conversation to the top of the Chats list permanently.
  it('never returns NaN for any combination in the hostile set', () => {
    const hostile = [NaN, Infinity, -Infinity, 0, -1, null, undefined, 1, 1_000_000];
    for (const a of hostile) {
      for (const b of hostile) {
        const result = maxTimestamp(a, b);
        expect(Number.isNaN(result)).toBe(false);
        if (result !== null) {
          expect(Number.isFinite(result)).toBe(true);
          expect(result).toBeGreaterThan(0);
        }
      }
    }
  });
});
