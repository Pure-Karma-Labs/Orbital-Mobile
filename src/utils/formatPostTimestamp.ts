/**
 * App-wide home for user-facing date/time display.
 *
 * The file name is historical — it predates the day-separator, clock-time and
 * compact-row formatters below. Every user-facing date or time string in the
 * app is built here, and `localDayKey` lives here too because it defines the
 * same calendar day the labels use.
 *
 * Strings are assembled by hand from the tables below rather than through
 * Date#toLocaleString. Hermes ships a trimmed ICU, so the same option bag can
 * render differently on device than it does under Node (where Jest runs), and
 * a device locale other than en-US would reorder or re-word the output. Manual
 * assembly removes that drift entirely: the output is byte-identical
 * everywhere, and the tests below pin the exact strings.
 *
 * That rule is enforced, not just documented: `no-restricted-syntax` in
 * .eslintrc.js bans every `toLocale*` method (case methods included), `Intl.*`,
 * `toDateString` and `toTimeString` everywhere ESLint lints (`.js/.jsx/.ts/.tsx`
 * under the repo root — note `scripts/*.mjs` are outside the lint set
 * entirely). A new display format therefore has to be added here rather than
 * inlined in a screen.
 *
 * All exports are total — a non-finite, NaN, or missing timestamp yields ''
 * rather than "Invalid Date", and none of them ever throws.
 *
 * @example
 *   formatPostTimestamp(t)       // "Sep 12, 3:04 PM" / "Sep 12, 2025, 3:04 PM"
 *   formatPostTimestampA11y(t)   // "September 12 at 3:04 PM"
 *   formatShortTime(t)           // "3:04 PM"
 *   formatDayLabel(t)            // "Today" / "Yesterday" / "Sep 12" / "Jun 1, 2014"
 *   formatCompactTimestamp(t)    // "3:04 PM" (today) / "Yesterday" / "Sep 12"
 *   formatDateWithYear(t)        // "Mar 4, 2019"
 *   formatDateWithYearA11y(t)    // "March 4, 2019"
 *   formatImportDate(t)          // "Jun 1, 2014"
 *   formatImportDateA11y(t)      // "June 1, 2014"
 *   localDayKey(t)               // "2026-09-12"
 */

const MONTHS_SHORT = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

const MONTHS_LONG = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

/**
 * Which calendar a timestamp is split against.
 *
 * `'local'` is the device's zone and the default — every formatter that
 * predates #928 keeps it. `'utc'` exists for dates the SERVER defines as a UTC
 * calendar day: an imported post's original date is stored as `YYYY-MM-DD` and
 * rendered at noon UTC, so rendering it locally would show the wrong day to
 * anyone west of Greenwich.
 */
export type DateZone = 'local' | 'utc';

/** Calendar/clock parts of a timestamp, in the requested time zone. */
interface TimestampParts {
  monthIndex: number;
  day: number;
  year: number;
  /** 1-12, with midnight rendered as 12 rather than 0. */
  hour12: number;
  /** Zero-padded to two digits. */
  minute: string;
  meridiem: 'AM' | 'PM';
}

/**
 * Split a timestamp into display parts, or return null when it cannot be
 * rendered. Guards every caller against "Invalid Date" reaching the UI:
 * undefined/null arrive as non-finite, and a finite-but-out-of-range value
 * (e.g. 1e20) still produces a NaN Date, so both are checked.
 *
 * `zone` picks the getter family (`getMonth` vs `getUTCMonth`) rather than
 * shifting the instant: adding an offset to the timestamp and reading it back
 * locally is what breaks on a DST boundary, because the offset you added is
 * not the offset that applies to the shifted instant.
 */
function toParts(timestamp: number, zone: DateZone = 'local'): TimestampParts | null {
  if (!Number.isFinite(timestamp)) return null;

  const date = new Date(timestamp);
  const ms = date.getTime();
  if (Number.isNaN(ms)) return null;

  const utc = zone === 'utc';
  const rawHour = utc ? date.getUTCHours() : date.getHours();
  const hour12 = rawHour % 12 === 0 ? 12 : rawHour % 12;
  const minute = utc ? date.getUTCMinutes() : date.getMinutes();

  return {
    monthIndex: utc ? date.getUTCMonth() : date.getMonth(),
    day: utc ? date.getUTCDate() : date.getDate(),
    year: utc ? date.getUTCFullYear() : date.getFullYear(),
    hour12,
    minute: minute.toString().padStart(2, '0'),
    meridiem: rawHour < 12 ? 'AM' : 'PM',
  };
}

/** True when `timestamp` falls in the same calendar year as `now`. */
function isCurrentYear(year: number, now: number): boolean {
  const reference = new Date(resolveNow(now));
  // resolveNow only rules out non-finite values; a finite-but-unrenderable one
  // (1e20) still yields a NaN year, which matches no year at all.
  const referenceYear = reference.getFullYear();
  if (Number.isNaN(referenceYear)) return false;
  return year === referenceYear;
}

/**
 * Epoch ms of local midnight on the calendar day BEFORE the one containing
 * `ms` (calendar construction, so it is DST-safe on 23- and 25-hour days).
 */
function startOfPreviousLocalDay(ms: number): number {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1).getTime();
}

/**
 * `now` resolved to a usable instant; a non-finite value falls back to the
 * real clock. The single definition of that tolerance — every consumer of
 * `now` goes through it.
 */
function resolveNow(now: number): number {
  return Number.isFinite(now) ? now : Date.now();
}

/** "Sep 12" — short month plus day, no year. */
function shortDate(parts: TimestampParts): string {
  return `${MONTHS_SHORT[parts.monthIndex]} ${parts.day}`;
}

/** "3:04 PM" — 12-hour clock with a zero-padded minute. */
function shortTime(parts: TimestampParts): string {
  return `${parts.hour12}:${parts.minute} ${parts.meridiem}`;
}

/**
 * Which display bucket a timestamp falls in relative to `now`, by LOCAL
 * calendar day. Compares localDayKey(timestamp) against localDayKey(now) and
 * localDayKey(startOfPreviousLocalDay(now)), so "a day" is defined once, by
 * construction, for keys and labels alike. null when `timestamp` cannot be
 * rendered at all.
 *
 * Public formatters branch on this, never on each other's output: a display
 * string must not double as control flow.
 */
function dayBucket(timestamp: number, now: number): 'today' | 'yesterday' | 'other' | null {
  const key = localDayKey(timestamp);
  if (key === '') return null;

  const reference = resolveNow(now);
  if (key === localDayKey(reference)) return 'today';
  if (key === localDayKey(startOfPreviousLocalDay(reference))) return 'yesterday';
  return 'other';
}

/**
 * Absolute date and time for a post or reply. Never relative — no "2h ago".
 *
 * The year is shown only when it differs from the current year, so the common
 * case stays short.
 *
 * @param timestamp Epoch milliseconds.
 * @param now Epoch milliseconds used to decide the year branch. Defaults to
 *   Date.now(); exists so tests can pin it.
 *
 * @example
 *   formatPostTimestamp(t) // "Sep 12, 3:04 PM"      (current year)
 *   formatPostTimestamp(t) // "Sep 12, 2025, 3:04 PM" (any other year)
 *   formatPostTimestamp(NaN) // ""
 */
export function formatPostTimestamp(timestamp: number, now: number = Date.now()): string {
  const parts = toParts(timestamp);
  if (parts === null) return '';

  const date = shortDate(parts);
  const time = shortTime(parts);

  if (isCurrentYear(parts.year, now)) return `${date}, ${time}`;
  return `${date}, ${parts.year}, ${time}`;
}

/**
 * Screen-reader form of {@link formatPostTimestamp}: the month is spelled out
 * and "at" separates date from time, so VoiceOver/TalkBack read it as a
 * sentence rather than as an abbreviation plus a bare number.
 *
 * @param timestamp Epoch milliseconds.
 * @param now Epoch milliseconds used to decide the year branch. Defaults to
 *   Date.now(); exists so tests can pin it.
 *
 * @example
 *   formatPostTimestampA11y(t) // "September 12 at 3:04 PM"       (current year)
 *   formatPostTimestampA11y(t) // "September 12, 2025 at 3:04 PM" (any other year)
 *   formatPostTimestampA11y(NaN) // ""
 */
export function formatPostTimestampA11y(timestamp: number, now: number = Date.now()): string {
  const parts = toParts(timestamp);
  if (parts === null) return '';

  const date = `${MONTHS_LONG[parts.monthIndex]} ${parts.day}`;
  const time = shortTime(parts);

  if (isCurrentYear(parts.year, now)) return `${date} at ${time}`;
  return `${date}, ${parts.year} at ${time}`;
}

/**
 * Clock time only — "3:04 PM". For the per-row time in a day-grouped list:
 * the clock time of this row's own timestamp.
 *
 * Callers are ThreadsScreen (orbit thread list) and ChatDetailScreen (DM
 * message list). Both pass the row's `createdAt` while grouping their day
 * separators on last activity (#883), so a message whose latest reply landed
 * today sits under "Today" showing the time it was originally posted. This
 * formatter therefore does NOT promise agreement with the enclosing day
 * separator — that mismatch is a known product call, not a bug here.
 *
 * @param timestamp Epoch milliseconds.
 *
 * @example
 *   formatShortTime(t)   // "3:04 PM"
 *   formatShortTime(NaN) // ""
 */
export function formatShortTime(timestamp: number): string {
  const parts = toParts(timestamp);
  if (parts === null) return '';
  return shortTime(parts);
}

/**
 * Day-separator label: "Today", "Yesterday", "Sep 12" in the current year, and
 * "Jun 1, 2014" in any other year. Local calendar-day comparison via dayBucket.
 *
 * The year branch is #919: a list can hold content from any year — an imported
 * post from 2014, or a DM scrolled back past a year boundary — and a bare
 * "Jun 1" over those rows claims a date that is eleven years off. The year is
 * still dropped in the current year, where it would be noise, so the everyday
 * separator is unchanged.
 *
 * The year uses the SHORT month, like every other header. It is chosen on the
 * same `isCurrentYear` test {@link formatPostTimestamp} uses, so the separator
 * and the timestamps under it agree on when a year is worth showing — including
 * for an unrenderable `now`, where neither can name the current year and both
 * show it.
 *
 * @param timestamp Epoch milliseconds.
 * @param now Epoch milliseconds that define "today". Defaults to Date.now();
 *   exists so tests can pin it.
 *
 * @example
 *   formatDayLabel(t)   // "Today" / "Yesterday" / "Sep 12" / "Jun 1, 2014"
 *   formatDayLabel(NaN) // ""
 */
export function formatDayLabel(timestamp: number, now: number = Date.now()): string {
  const parts = toParts(timestamp);
  if (parts === null) return '';

  const bucket = dayBucket(timestamp, now);
  if (bucket === 'today') return 'Today';
  if (bucket === 'yesterday') return 'Yesterday';
  if (isCurrentYear(parts.year, now)) return shortDate(parts);
  return `${shortDate(parts)}, ${parts.year}`;
}

/**
 * Chats-list row timestamp: clock time if the message landed today
 * ("3:04 PM"), "Yesterday" for the previous calendar day, otherwise the short
 * date ("Sep 12"). Switches on dayBucket.
 *
 * @param timestamp Epoch milliseconds.
 * @param now Epoch milliseconds that define "today". Defaults to Date.now();
 *   exists so tests can pin it.
 *
 * @example
 *   formatCompactTimestamp(t)   // "3:04 PM" (today) / "Yesterday" / "Sep 12"
 *   formatCompactTimestamp(NaN) // ""
 */
export function formatCompactTimestamp(timestamp: number, now: number = Date.now()): string {
  const parts = toParts(timestamp);
  if (parts === null) return '';

  const bucket = dayBucket(timestamp, now);
  if (bucket === 'today') return shortTime(parts);
  if (bucket === 'yesterday') return 'Yesterday';
  return shortDate(parts);
}

/**
 * Always-dated short form — "Mar 4, 2019". No clock time, and the year is
 * never dropped.
 *
 * Unlike {@link formatPostTimestamp}, this one is for dates that are YEARS
 * old by nature (#928: the original date of an imported post, and the day an
 * orbit's retention sweep will reach it). Hiding the year on the few that
 * happen to fall in the current year would make a list of them unreadable.
 *
 * @param timestamp Epoch milliseconds.
 * @param zone `'utc'` for a date the server defines as a UTC calendar day;
 *   `'local'` (the default) for one defined by the member's own clock.
 *
 * @example
 *   formatDateWithYear(t)          // "Mar 4, 2019"
 *   formatDateWithYear(t, 'utc')   // "Mar 4, 2019" on any device clock
 *   formatDateWithYear(NaN)        // ""
 */
export function formatDateWithYear(timestamp: number, zone: DateZone = 'local'): string {
  const parts = toParts(timestamp, zone);
  if (parts === null) return '';
  return `${MONTHS_SHORT[parts.monthIndex]} ${parts.day}, ${parts.year}`;
}

/**
 * Screen-reader form of {@link formatDateWithYear}: the month is spelled out,
 * so VoiceOver/TalkBack read a sentence rather than an abbreviation.
 *
 * @param timestamp Epoch milliseconds.
 * @param zone As {@link formatDateWithYear}.
 *
 * @example
 *   formatDateWithYearA11y(t)        // "March 4, 2019"
 *   formatDateWithYearA11y(NaN)      // ""
 */
export function formatDateWithYearA11y(timestamp: number, zone: DateZone = 'local'): string {
  const parts = toParts(timestamp, zone);
  if (parts === null) return '';
  return `${MONTHS_LONG[parts.monthIndex]} ${parts.day}, ${parts.year}`;
}

const MS_PER_DAY = 86_400_000;
/** Milliseconds from UTC midnight to the synthetic noon the server serves. */
const NOON_UTC_MS = MS_PER_DAY / 2;

/**
 * Which calendar an IMPORTED thread's served `createdAt` belongs to (#927 §8).
 *
 * The backend stores an imported post's original date as a calendar DAY and
 * serves it as that day at exactly 12:00:00.000 UTC — a synthetic sort key,
 * not an instant anything happened at. Read locally, it would show the wrong
 * day to anyone far enough east or west, so it is read in UTC.
 *
 * The served value is `LEAST(noon-UTC sort key, insert instant)`
 * (`Orbital-Backend/src/utils/threadSortKey.js`), which makes the exact
 * 12:00:00.000 UTC test decisive rather than probabilistic:
 *
 *  - EXACTLY noon UTC means the noon key won the LEAST — the post is dated on
 *    an earlier day than the import, or it is a same-day import run after
 *    12:00 UTC. Either way the value is the synthetic key, so it is read in
 *    UTC. This is every realistic archive row.
 *  - ANYTHING ELSE is the clamp: a same-day import run BEFORE 12:00 UTC, whose
 *    value is the real insert instant on the member's own clock. Read locally,
 *    so the row agrees with the day header above it.
 *
 * Known effect of the first case, accepted: in UTC+12…+14 a SAME-DAY import
 * run after 12:00 UTC is read in UTC and can print one day earlier than the
 * "Today" header it sits under — the same off-by-a-day the past-dated rows
 * have there, and for the same reason.
 */
function importDateZone(timestamp: number): DateZone {
  if (!Number.isFinite(timestamp)) return 'local';
  // Floored modulo: a pre-1970 timestamp is negative, and `%` keeps the sign.
  const msIntoUtcDay = ((timestamp % MS_PER_DAY) + MS_PER_DAY) % MS_PER_DAY;
  return msIntoUtcDay === NOON_UTC_MS ? 'utc' : 'local';
}

/**
 * The date shown on an IMPORTED thread — "Jun 1, 2014". Always dated, never a
 * clock time: the import carries a day, and the hour the server serves with it
 * is a sort key rather than a time anything happened at. Showing "12:00 PM"
 * beside an eleven-year-old post would be inventing a fact.
 *
 * The zone is picked per timestamp by {@link importDateZone}.
 *
 * Known and accepted (plan §8): in UTC+12…+14 a past-dated import's row reads
 * one day EARLIER than the day header above it, because the header groups
 * every row by the device-local day of `createdAt` while this one row is read
 * in UTC. Pinned by a test. The alternative — grouping imports by a different
 * calendar from their neighbours — would put two rows with the same visible
 * date under two different headers.
 *
 * @param timestamp Epoch milliseconds, as served.
 *
 * @example
 *   formatImportDate(Date.UTC(2014, 5, 1, 12, 0)) // "Jun 1, 2014" in any zone
 *   formatImportDate(NaN)                         // ""
 */
export function formatImportDate(timestamp: number): string {
  return formatDateWithYear(timestamp, importDateZone(timestamp));
}

/**
 * Screen-reader form of {@link formatImportDate}: the month is spelled out.
 *
 * @param timestamp Epoch milliseconds, as served.
 *
 * @example
 *   formatImportDateA11y(Date.UTC(2014, 5, 1, 12, 0)) // "June 1, 2014"
 */
export function formatImportDateA11y(timestamp: number): string {
  return formatDateWithYearA11y(timestamp, importDateZone(timestamp));
}

/**
 * Local "YYYY-MM-DD" grouping key, zero-padded. Not user-facing: it exists for
 * day-group change detection and FlatList keys, and it is what dayBucket
 * compares, so keys and labels agree on where a day starts.
 *
 * @param timestamp Epoch milliseconds.
 *
 * @example
 *   localDayKey(t)   // "2026-09-12"
 *   localDayKey(NaN) // ""
 */
export function localDayKey(timestamp: number): string {
  const parts = toParts(timestamp);
  if (parts === null) return '';

  const month = String(parts.monthIndex + 1).padStart(2, '0');
  const day = String(parts.day).padStart(2, '0');
  return `${parts.year}-${month}-${day}`;
}
