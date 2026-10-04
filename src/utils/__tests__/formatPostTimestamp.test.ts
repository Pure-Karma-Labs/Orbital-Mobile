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
// host zone, and the suite stays deterministic either way. The everyday
// fixtures (Jan 5, Sep 12) sit well clear of any DST transition; the two
// DST-boundary cases in formatDayLabel deliberately straddle the US spring-
// forward and fall-back days, and read 20:00/08:00 — hours that exist exactly
// once on a 23- or 25-hour day, so those wall-clock readings are unambiguous
// too (and in a host zone that transitions elsewhere they are ordinary days,
// which the same expectation covers).
// ---------------------------------------------------------------------------

import {
  formatCompactTimestamp,
  formatDayLabel,
  formatPostTimestamp,
  formatPostTimestampA11y,
  formatShortTime,
  localDayKey,
} from '../formatPostTimestamp';

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

describe('formatShortTime', () => {
  it('renders the clock time only', () => {
    expect(formatShortTime(SEP_12_2026)).toBe('3:04 PM');
  });

  it('renders midnight as "12:00 AM" and noon as "12:00 PM"', () => {
    expect(formatShortTime(MIDNIGHT_2026)).toBe('12:00 AM');
    expect(formatShortTime(NOON_2026)).toBe('12:00 PM');
  });

  it('zero-pads a single-digit minute', () => {
    expect(formatShortTime(SINGLE_DIGIT_MINUTE_2026)).toBe('9:07 AM');
  });

  it('returns "" for unrenderable timestamps without throwing', () => {
    expect(formatShortTime(NaN)).toBe('');
    expect(formatShortTime(undefined as unknown as number)).toBe('');
    expect(formatShortTime(1e20)).toBe('');
    expect(() => formatShortTime(NaN)).not.toThrow();
  });
});

describe('formatDayLabel', () => {
  it('says "Today" for any time on the same local calendar day', () => {
    expect(formatDayLabel(localTime(2026, 8, 20, 0, 0), NOW_2026)).toBe('Today');
    expect(formatDayLabel(localTime(2026, 8, 20, 23, 59), NOW_2026)).toBe('Today');
  });

  it('says "Yesterday" for any time on the previous local calendar day', () => {
    expect(formatDayLabel(localTime(2026, 8, 19, 0, 0), NOW_2026)).toBe('Yesterday');
    expect(formatDayLabel(localTime(2026, 8, 19, 23, 59), NOW_2026)).toBe('Yesterday');
  });

  it('falls back to the short date two days back', () => {
    expect(formatDayLabel(localTime(2026, 8, 18, 12, 0), NOW_2026)).toBe('Sep 18');
  });

  it('crosses a month boundary by calendar day, not by elapsed hours', () => {
    const sep30 = localTime(2026, 8, 30, 20, 0);
    const oct1 = localTime(2026, 9, 1, 8, 0);
    expect(formatDayLabel(sep30, oct1)).toBe('Yesterday');
  });

  it('crosses a year boundary the same way', () => {
    const dec31 = localTime(2025, 11, 31, 22, 0);
    const jan1 = localTime(2026, 0, 1, 8, 0);
    expect(formatDayLabel(dec31, jan1)).toBe('Yesterday');
  });

  it('crosses a 25-hour day (US fall-back) by calendar day', () => {
    // 2026-11-01 is the US DST end date: the local day is 25 hours long.
    const nov1 = localTime(2026, 10, 1, 20, 0);
    const nov2 = localTime(2026, 10, 2, 8, 0);
    expect(formatDayLabel(nov1, nov2)).toBe('Yesterday');
  });

  it('crosses a 23-hour day (US spring-forward) by calendar day', () => {
    // 2026-03-08 is the US DST start date: the local day is 23 hours long.
    const mar7 = localTime(2026, 2, 7, 20, 0);
    const mar8 = localTime(2026, 2, 8, 8, 0);
    expect(formatDayLabel(mar7, mar8)).toBe('Yesterday');
  });

  it('never shows a year, even for another year', () => {
    expect(formatDayLabel(SEP_12_2025, NOW_2026)).toBe('Sep 12');
  });

  it('shows the short date for a future day rather than a relative word', () => {
    expect(formatDayLabel(localTime(2026, 8, 21, 9, 0), NOW_2026)).toBe('Sep 21');
  });

  it('returns "" for an unrenderable timestamp and tolerates a bad now', () => {
    expect(formatDayLabel(NaN, NOW_2026)).toBe('');
    expect(() => formatDayLabel(SEP_12_2026, NaN)).not.toThrow();
    // Finite but unrenderable: resolveNow passes it through, so no day matches
    // and the label falls through to the short date rather than claiming 'Today'.
    expect(() => formatDayLabel(SEP_12_2026, 1e20)).not.toThrow();
    expect(formatDayLabel(SEP_12_2026, 1e20)).toBe('Sep 12');
  });

  it('defaults now to the real clock when it is omitted', () => {
    expect(formatDayLabel(Date.now())).toBe('Today');
  });
});

describe('formatCompactTimestamp', () => {
  it('shows the clock time for today', () => {
    expect(formatCompactTimestamp(localTime(2026, 8, 20, 15, 4), NOW_2026)).toBe('3:04 PM');
  });

  it('shows "Yesterday" for the previous calendar day', () => {
    expect(formatCompactTimestamp(localTime(2026, 8, 19, 15, 4), NOW_2026)).toBe('Yesterday');
  });

  it('shows the short date for anything older', () => {
    expect(formatCompactTimestamp(SEP_12_2026, NOW_2026)).toBe('Sep 12');
  });

  it('returns "" for an unrenderable timestamp', () => {
    expect(formatCompactTimestamp(NaN, NOW_2026)).toBe('');
  });
});

describe('localDayKey', () => {
  it('zero-pads month and day', () => {
    expect(localDayKey(SINGLE_DIGIT_MINUTE_2026)).toBe('2026-01-05');
  });

  it('is stable across one local day and changes at the next midnight', () => {
    const start = localDayKey(localTime(2026, 8, 20, 0, 0));
    const end = localDayKey(localTime(2026, 8, 20, 23, 59));
    const next = localDayKey(localTime(2026, 8, 21, 0, 0));
    expect(start).toBe(end);
    expect(next).not.toBe(start);
  });

  it('returns "" for an unrenderable timestamp', () => {
    expect(localDayKey(NaN)).toBe('');
    expect(localDayKey(1e20)).toBe('');
  });
});

describe('the epoch is a real instant, not a missing value', () => {
  it('renders timestamp 0 rather than returning ""', () => {
    // Which side of the date line 0 falls on depends on the zone, so assert
    // the shape rather than the exact day.
    expect(localDayKey(0)).toMatch(/^(1969-12-31|1970-01-01)$/);
    expect(formatShortTime(0)).toMatch(/^\d{1,2}:\d{2} (AM|PM)$/);
  });
});
