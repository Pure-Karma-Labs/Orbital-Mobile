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
  formatDateWithYear,
  formatDateWithYearA11y,
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

  // #919. The two branches of the year rule, pinned together: dropping the
  // year is correct only in the current year, and the same fixture read from
  // two different `now`s is what proves the branch is the year and not the
  // date.
  it('omits the year for an other-day date in the current year', () => {
    expect(formatDayLabel(SEP_12_2026, NOW_2026)).toBe('Sep 12');
  });

  it('shows the year for a date outside the current year', () => {
    expect(formatDayLabel(SEP_12_2025, NOW_2026)).toBe('Sep 12, 2025');
    // Far enough back that a bare "Jun 1" would be eleven years wrong — the
    // imported-post case #919 was filed for.
    expect(formatDayLabel(localTime(2014, 5, 1, 9, 0), NOW_2026)).toBe('Jun 1, 2014');
    // A FUTURE year takes the same branch.
    expect(formatDayLabel(SEP_12_2026, NOW_2025)).toBe('Sep 12, 2026');
    expect(formatDayLabel(SEP_12_2025, NOW_2025)).toBe('Sep 12');
  });

  // The boundary the DM-scrollback case lands on: the two relative words win
  // over the year branch even when they straddle New Year, and the first day
  // that is neither picks the year up.
  it('keeps Today/Yesterday across a year boundary and dates the day before', () => {
    const jan2 = localTime(2026, 0, 2, 8, 0);
    expect(formatDayLabel(localTime(2026, 0, 2, 1, 0), jan2)).toBe('Today');
    expect(formatDayLabel(localTime(2026, 0, 1, 23, 0), jan2)).toBe('Yesterday');
    expect(formatDayLabel(localTime(2025, 11, 31, 22, 0), jan2)).toBe('Dec 31, 2025');
  });

  it('shows the short date for a future day rather than a relative word', () => {
    expect(formatDayLabel(localTime(2026, 8, 21, 9, 0), NOW_2026)).toBe('Sep 21');
  });

  it('returns "" for an unrenderable timestamp and tolerates a bad now', () => {
    expect(formatDayLabel(NaN, NOW_2026)).toBe('');
    expect(() => formatDayLabel(SEP_12_2026, NaN)).not.toThrow();
    // Finite but unrenderable: resolveNow passes it through, so no day matches
    // and the label falls through to a date rather than claiming 'Today'. With
    // no readable current year it shows the year — the same tolerance
    // formatPostTimestamp has, through the same isCurrentYear.
    expect(() => formatDayLabel(SEP_12_2026, 1e20)).not.toThrow();
    expect(formatDayLabel(SEP_12_2026, 1e20)).toBe('Sep 12, 2026');
    expect(formatPostTimestamp(SEP_12_2026, 1e20)).toBe('Sep 12, 2026, 3:04 PM');
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

// ---------------------------------------------------------------------------
// #928: the always-dated formatters, and the `zone` parameter.
//
// ZONE CONTROL — read the suite header first. There is no working TZ pin in
// this Jest setup: `process.env.TZ` is assigned at the top of this file and
// does NOT reach V8's cached zone (re-verified here: with TZ pinned to
// America/New_York the process still reports its own host offset). So, exactly
// as the rest of this file does, the fixtures below are built from local
// wall-clock constructors where the expectation is a local one, and from
// Date.UTC where the expectation is a UTC one — which makes every pinned
// string hold in any host zone.
//
// The one assertion that genuinely NEEDS a non-UTC zone — a UTC-midnight
// instant landing on a different LOCAL day — is therefore written against the
// zone the process actually has: its expected string is chosen from the real
// UTC offset, and both directions (behind and ahead of UTC) are pinned
// explicitly. Under TZ=UTC there is no boundary to show and the test asserts
// that the two zones agree, which is the correct behaviour there.
// ---------------------------------------------------------------------------

/** 2019-03-04 12:00 local — noon, so no zone can move it off March 4. */
const MAR_4_2019_LOCAL = localTime(2019, 2, 4, 12, 0);
/** 2019-03-04T12:00:00Z — noon UTC, for the `'utc'` expectations. */
const MAR_4_2019_UTC = Date.UTC(2019, 2, 4, 12, 0);
/** 2019-03-04T00:30:00Z — 30 minutes past UTC midnight. */
const UTC_MIDNIGHT_EDGE = Date.UTC(2019, 2, 4, 0, 30);
/** 2019-03-04 00:30 local — 30 minutes past LOCAL midnight. */
const LOCAL_MIDNIGHT_EDGE = localTime(2019, 2, 4, 0, 30);

/** Minutes the host zone is BEHIND UTC at that instant (negative = ahead). */
const UTC_OFFSET_MIN = new Date(UTC_MIDNIGHT_EDGE).getTimezoneOffset();

describe('formatDateWithYear', () => {
  it('renders a known instant in local time', () => {
    expect(formatDateWithYear(MAR_4_2019_LOCAL)).toBe('Mar 4, 2019');
    expect(formatDateWithYear(MAR_4_2019_LOCAL, 'local')).toBe('Mar 4, 2019');
  });

  it('renders a known instant in UTC', () => {
    expect(formatDateWithYear(MAR_4_2019_UTC, 'utc')).toBe('Mar 4, 2019');
  });

  it('always shows the year, including for a current-year date', () => {
    const thisYear = new Date().getFullYear();
    expect(formatDateWithYear(localTime(thisYear, 8, 12, 15, 4))).toBe(`Sep 12, ${thisYear}`);
    // The contrast that motivates the function: formatPostTimestamp drops it.
    expect(formatPostTimestamp(localTime(thisYear, 8, 12, 15, 4))).toBe('Sep 12, 3:04 PM');
  });

  it('shows no clock time at all', () => {
    expect(formatDateWithYear(localTime(2019, 2, 4, 23, 59))).toBe('Mar 4, 2019');
    expect(formatDateWithYear(localTime(2019, 2, 4, 0, 0))).toBe('Mar 4, 2019');
  });

  it("splits a UTC-midnight instant by the UTC calendar under 'utc'", () => {
    expect(formatDateWithYear(UTC_MIDNIGHT_EDGE, 'utc')).toBe('Mar 4, 2019');
  });

  it("splits that same instant by the DEVICE calendar under 'local'", () => {
    // Behind UTC (e.g. America/*): 00:30Z is still March 3 locally.
    // Ahead of UTC (e.g. Europe/*): it is already March 4.
    // At UTC itself: the two agree, and there is no boundary to show.
    const expected = UTC_OFFSET_MIN > 30 ? 'Mar 3, 2019' : 'Mar 4, 2019';
    expect(formatDateWithYear(UTC_MIDNIGHT_EDGE, 'local')).toBe(expected);
  });

  it('shows the mirror boundary for a zone AHEAD of UTC', () => {
    // 00:30 LOCAL on March 4 is still March 3 in UTC whenever the zone is
    // ahead of UTC by more than 30 minutes.
    const expected = UTC_OFFSET_MIN < -30 ? 'Mar 3, 2019' : 'Mar 4, 2019';
    expect(formatDateWithYear(LOCAL_MIDNIGHT_EDGE, 'utc')).toBe(expected);
    expect(formatDateWithYear(LOCAL_MIDNIGHT_EDGE, 'local')).toBe('Mar 4, 2019');
  });

  it('makes the two zones disagree exactly when the device zone is not UTC', () => {
    const disagrees = (ts: number): boolean =>
      formatDateWithYear(ts, 'utc') !== formatDateWithYear(ts, 'local');
    const anyDisagreement = disagrees(UTC_MIDNIGHT_EDGE) || disagrees(LOCAL_MIDNIGHT_EDGE);
    expect(anyDisagreement).toBe(Math.abs(UTC_OFFSET_MIN) > 30);
  });

  it('returns "" for NaN, Infinity and an out-of-range finite value', () => {
    for (const zone of ['local', 'utc'] as const) {
      expect(formatDateWithYear(NaN, zone)).toBe('');
      expect(formatDateWithYear(Infinity, zone)).toBe('');
      expect(formatDateWithYear(-Infinity, zone)).toBe('');
      expect(formatDateWithYear(1e20, zone)).toBe('');
    }
    expect(formatDateWithYear(undefined as unknown as number)).toBe('');
    expect(() => formatDateWithYear(NaN)).not.toThrow();
  });
});

describe('formatDateWithYearA11y', () => {
  it('spells the month out, in local time and in UTC', () => {
    expect(formatDateWithYearA11y(MAR_4_2019_LOCAL)).toBe('March 4, 2019');
    expect(formatDateWithYearA11y(MAR_4_2019_LOCAL, 'local')).toBe('March 4, 2019');
    expect(formatDateWithYearA11y(MAR_4_2019_UTC, 'utc')).toBe('March 4, 2019');
  });

  it('always shows the year, including for a current-year date', () => {
    const thisYear = new Date().getFullYear();
    expect(formatDateWithYearA11y(localTime(thisYear, 8, 12, 15, 4))).toBe(
      `September 12, ${thisYear}`,
    );
    expect(formatPostTimestampA11y(localTime(thisYear, 8, 12, 15, 4))).toBe(
      'September 12 at 3:04 PM',
    );
  });

  it('honours the UTC-midnight boundary the same way', () => {
    expect(formatDateWithYearA11y(UTC_MIDNIGHT_EDGE, 'utc')).toBe('March 4, 2019');
    const expected = UTC_OFFSET_MIN > 30 ? 'March 3, 2019' : 'March 4, 2019';
    expect(formatDateWithYearA11y(UTC_MIDNIGHT_EDGE, 'local')).toBe(expected);
  });

  it('returns "" for NaN, Infinity and an out-of-range finite value', () => {
    for (const zone of ['local', 'utc'] as const) {
      expect(formatDateWithYearA11y(NaN, zone)).toBe('');
      expect(formatDateWithYearA11y(Infinity, zone)).toBe('');
      expect(formatDateWithYearA11y(-Infinity, zone)).toBe('');
      expect(formatDateWithYearA11y(1e20, zone)).toBe('');
    }
    expect(() => formatDateWithYearA11y(NaN)).not.toThrow();
  });
});

describe('the zone parameter is additive', () => {
  it('leaves every pre-#928 formatter on local time', () => {
    // toParts(ts, zone) gained a parameter that defaults to 'local'. The
    // formatters that predate #928 pass no zone, so they must still split a
    // UTC-midnight instant by the DEVICE calendar — and their pinned en-US
    // strings must be byte-identical to before. (formatDayLabel's other-year
    // string gained a year in #919; its zone did not change, which is what
    // this suite is about.)
    expect(formatPostTimestamp(SEP_12_2026, NOW_2026)).toBe('Sep 12, 3:04 PM');
    expect(formatPostTimestampA11y(SEP_12_2025, NOW_2026)).toBe('September 12, 2025 at 3:04 PM');
    expect(formatShortTime(MIDNIGHT_2026)).toBe('12:00 AM');
    expect(formatDayLabel(SEP_12_2025, NOW_2026)).toBe('Sep 12, 2025');
    expect(formatCompactTimestamp(SEP_12_2026, NOW_2026)).toBe('Sep 12');
    expect(localDayKey(SINGLE_DIGIT_MINUTE_2026)).toBe('2026-01-05');
    // The new formatters default to the same calendar as the old ones.
    const day = new Date(UTC_MIDNIGHT_EDGE).getDate();
    expect(formatDateWithYear(UTC_MIDNIGHT_EDGE)).toBe(`Mar ${day}, 2019`);
    expect(formatDateWithYear(UTC_MIDNIGHT_EDGE)).toBe(
      formatDateWithYear(UTC_MIDNIGHT_EDGE, 'local'),
    );
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
