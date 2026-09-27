// ---------------------------------------------------------------------------
// TIME ZONE PIN — explicit, and deliberately belt-and-braces.
//
// The formatters render in local time, so an unpinned zone would make every
// expectation below depend on the machine/CI region. The pin is stated here:
process.env.TZ = 'America/New_York';
//
// That assignment alone is NOT sufficient in this Jest setup, and the fixtures
// below do not rely on it. Jest's environment hands each test file a COPY of
// process.env, so assigning TZ never reaches the native setter that
// invalidates V8's cached zone — verified on this repo: with the line above in
// place, Date.UTC(2026, 8, 12, 19, 4) still reads back as 12:00, i.e. the
// host's zone, not 15:04 EDT. Setting it via require('process') or
// module.createRequire behaves identically.
//
// So every fixture is built from a LOCAL wall-clock constructor
// (new Date(year, monthIndex, day, hour, minute)), which yields exactly that
// wall-clock reading in whatever zone the process is actually running in.
// The expected strings therefore hold under the pinned zone and under any
// host zone, and the suite stays deterministic either way. The dates chosen
// (Jan 5, Sep 12) sit well clear of any DST transition, so the wall-clock
// readings are unambiguous.
// ---------------------------------------------------------------------------

import { formatPostTimestamp, formatPostTimestampA11y } from '../formatPostTimestamp';

/** Epoch millis for a local wall-clock reading — the basis of every fixture. */
function localTime(
  year: number,
  monthIndex: number,
  day: number,
  hour: number,
  minute: number,
): number {
  return new Date(year, monthIndex, day, hour, minute, 0, 0).getTime();
}

/** 2026-09-20 08:00 local — the pinned "current time" for the year branch. */
const NOW_2026 = localTime(2026, 8, 20, 8, 0);
/** 2025-09-20 08:00 local — same, one year earlier. */
const NOW_2025 = localTime(2025, 8, 20, 8, 0);

/** 2026-09-12 15:04 local. */
const SEP_12_2026 = localTime(2026, 8, 12, 15, 4);
/** 2025-09-12 15:04 local. */
const SEP_12_2025 = localTime(2025, 8, 12, 15, 4);
/** 2026-01-05 00:00 local. */
const MIDNIGHT_2026 = localTime(2026, 0, 5, 0, 0);
/** 2026-01-05 12:00 local. */
const NOON_2026 = localTime(2026, 0, 5, 12, 0);
/** 2026-01-05 09:07 local — single-digit minute, to prove zero padding. */
const SINGLE_DIGIT_MINUTE_2026 = localTime(2026, 0, 5, 9, 7);

// Guards the assumption the fixtures rest on: a local wall-clock constructor
// round-trips to the same wall clock. If a fixture date ever landed on a DST
// transition, this fails first and names the reason instead of leaving a dozen
// opaque string mismatches.
describe('fixture basis', () => {
  it('round-trips local wall-clock readings', () => {
    const sep = new Date(SEP_12_2026);
    expect([sep.getFullYear(), sep.getMonth(), sep.getDate()]).toEqual([2026, 8, 12]);
    expect([sep.getHours(), sep.getMinutes()]).toEqual([15, 4]);

    const midnight = new Date(MIDNIGHT_2026);
    expect([midnight.getHours(), midnight.getMinutes()]).toEqual([0, 0]);
  });
});

describe('formatPostTimestamp', () => {
  it('omits the year for a timestamp in the current year', () => {
    expect(formatPostTimestamp(SEP_12_2026, NOW_2026)).toBe('Sep 12, 3:04 PM');
  });

  it('includes the year for a timestamp in a past year', () => {
    expect(formatPostTimestamp(SEP_12_2025, NOW_2026)).toBe('Sep 12, 2025, 3:04 PM');
  });

  it('includes the year for a timestamp in a future year', () => {
    expect(formatPostTimestamp(SEP_12_2026, NOW_2025)).toBe('Sep 12, 2026, 3:04 PM');
  });

  it('renders midnight as "12:00 AM", not "0:00"', () => {
    expect(formatPostTimestamp(MIDNIGHT_2026, NOW_2026)).toBe('Jan 5, 12:00 AM');
  });

  it('renders noon as "12:00 PM"', () => {
    expect(formatPostTimestamp(NOON_2026, NOW_2026)).toBe('Jan 5, 12:00 PM');
  });

  it('zero-pads a single-digit minute', () => {
    expect(formatPostTimestamp(SINGLE_DIGIT_MINUTE_2026, NOW_2026)).toBe('Jan 5, 9:07 AM');
  });

  it('lets the injected now control the year branch for one fixed timestamp', () => {
    expect(formatPostTimestamp(SEP_12_2025, NOW_2025)).toBe('Sep 12, 3:04 PM');
    expect(formatPostTimestamp(SEP_12_2025, NOW_2026)).toBe('Sep 12, 2025, 3:04 PM');
  });

  it('defaults now to the real clock when it is omitted', () => {
    const thisYear = new Date().getFullYear();
    expect(formatPostTimestamp(localTime(thisYear, 8, 12, 15, 4))).toBe('Sep 12, 3:04 PM');
    expect(formatPostTimestamp(localTime(thisYear - 1, 8, 12, 15, 4))).toBe(
      `Sep 12, ${thisYear - 1}, 3:04 PM`,
    );
  });

  it('returns "" for NaN, Infinity, and missing timestamps without throwing', () => {
    expect(formatPostTimestamp(NaN, NOW_2026)).toBe('');
    expect(formatPostTimestamp(Infinity, NOW_2026)).toBe('');
    expect(formatPostTimestamp(-Infinity, NOW_2026)).toBe('');
    expect(formatPostTimestamp(undefined as unknown as number, NOW_2026)).toBe('');
    expect(formatPostTimestamp(null as unknown as number, NOW_2026)).toBe('');
  });

  it('returns "" for a finite timestamp outside the representable Date range', () => {
    // Finite, so the Number.isFinite guard passes — the Date is still Invalid.
    expect(formatPostTimestamp(1e20, NOW_2026)).toBe('');
  });

  it('never throws on hostile input', () => {
    expect(() => formatPostTimestamp(NaN)).not.toThrow();
    expect(() => formatPostTimestamp(0, NaN)).not.toThrow();
    expect(() => formatPostTimestamp(SEP_12_2026, NaN)).not.toThrow();
  });

  it('formats the epoch itself rather than treating 0 as missing', () => {
    // 0 is a real instant, not an absent value. Which side of the date line it
    // falls on depends on the zone, so assert the shape, not the exact day.
    expect(formatPostTimestamp(0, NOW_2026)).toMatch(
      /^(Dec 31, 1969|Jan 1, 1970), \d{1,2}:\d{2} (AM|PM)$/,
    );
  });
});

describe('formatPostTimestampA11y', () => {
  it('spells the month and omits the year in the current year', () => {
    expect(formatPostTimestampA11y(SEP_12_2026, NOW_2026)).toBe('September 12 at 3:04 PM');
  });

  it('spells the month and includes the year in a past year', () => {
    expect(formatPostTimestampA11y(SEP_12_2025, NOW_2026)).toBe('September 12, 2025 at 3:04 PM');
  });

  it('renders midnight and noon unambiguously', () => {
    expect(formatPostTimestampA11y(MIDNIGHT_2026, NOW_2026)).toBe('January 5 at 12:00 AM');
    expect(formatPostTimestampA11y(NOON_2026, NOW_2026)).toBe('January 5 at 12:00 PM');
  });

  it('zero-pads a single-digit minute', () => {
    expect(formatPostTimestampA11y(SINGLE_DIGIT_MINUTE_2026, NOW_2026)).toBe(
      'January 5 at 9:07 AM',
    );
  });

  it('lets the injected now control the year branch', () => {
    expect(formatPostTimestampA11y(SEP_12_2025, NOW_2025)).toBe('September 12 at 3:04 PM');
    expect(formatPostTimestampA11y(SEP_12_2025, NOW_2026)).toBe('September 12, 2025 at 3:04 PM');
  });

  it('returns "" for NaN, Infinity, and missing timestamps without throwing', () => {
    expect(formatPostTimestampA11y(NaN, NOW_2026)).toBe('');
    expect(formatPostTimestampA11y(Infinity, NOW_2026)).toBe('');
    expect(formatPostTimestampA11y(-Infinity, NOW_2026)).toBe('');
    expect(formatPostTimestampA11y(undefined as unknown as number, NOW_2026)).toBe('');
    expect(formatPostTimestampA11y(null as unknown as number, NOW_2026)).toBe('');
    expect(() => formatPostTimestampA11y(NaN)).not.toThrow();
  });
});
