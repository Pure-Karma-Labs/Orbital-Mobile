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
 *   formatDayLabel(t)            // "Today" / "Yesterday" / "Sep 12"
 *   formatCompactTimestamp(t)    // "3:04 PM" (today) / "Yesterday" / "Sep 12"
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

/** Calendar/clock parts of a timestamp, in the device's local time zone. */
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
 */
function toParts(timestamp: number): TimestampParts | null {
  if (!Number.isFinite(timestamp)) return null;

  const date = new Date(timestamp);
  const ms = date.getTime();
  if (Number.isNaN(ms)) return null;

  const rawHour = date.getHours();
  const hour12 = rawHour % 12 === 0 ? 12 : rawHour % 12;

  return {
    monthIndex: date.getMonth(),
    day: date.getDate(),
    year: date.getFullYear(),
    hour12,
    minute: date.getMinutes().toString().padStart(2, '0'),
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
 * the clock time of this row's own timestamp. The enclosing day separator may
 * be grouped on a different field (ThreadsScreen groups by last activity
 * while rows show creation time), so this does not promise agreement with it.
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
 * Day-separator label: "Today", "Yesterday", otherwise "Sep 12". Local
 * calendar-day comparison via dayBucket.
 *
 * Never shows a year — en-US output is pinned to the pre-#845 strings, so an
 * other-year date still reads "Jan 5". A year branch is a possible later
 * refinement, not a bug.
 *
 * @param timestamp Epoch milliseconds.
 * @param now Epoch milliseconds that define "today". Defaults to Date.now();
 *   exists so tests can pin it.
 *
 * @example
 *   formatDayLabel(t)   // "Today" / "Yesterday" / "Sep 12"
 *   formatDayLabel(NaN) // ""
 */
export function formatDayLabel(timestamp: number, now: number = Date.now()): string {
  const parts = toParts(timestamp);
  if (parts === null) return '';

  const bucket = dayBucket(timestamp, now);
  if (bucket === 'today') return 'Today';
  if (bucket === 'yesterday') return 'Yesterday';
  return shortDate(parts);
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
