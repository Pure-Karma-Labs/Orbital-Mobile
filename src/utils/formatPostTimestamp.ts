/**
 * Home for all user-facing date/time formatting of posts and replies.
 *
 * New date/time display code belongs here rather than in a screen or component.
 * Migrating the chats/threads list formatters (including the duplicated
 * getDayLabel/getDayKey pair in ChatDetailScreen and ThreadsScreen) is a
 * recorded deferral (#821).
 *
 * Strings are assembled by hand from the tables below rather than through
 * Date#toLocaleString. Hermes ships a trimmed ICU, so the same option bag can
 * render differently on device than it does under Node (where Jest runs), and
 * a device locale other than en-US would reorder or re-word the output. Manual
 * assembly removes that drift entirely: the output is byte-identical
 * everywhere, and the tests below pin the exact strings.
 *
 * Both exports are total — a non-finite, NaN, or missing timestamp yields ''
 * rather than "Invalid Date", and neither ever throws.
 *
 * @example
 *   formatPostTimestamp(t)     // "Sep 12, 3:04 PM" / "Sep 12, 2025, 3:04 PM"
 *   formatPostTimestampA11y(t) // "September 12 at 3:04 PM"
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
  const reference = Number.isFinite(now) ? new Date(now) : new Date();
  const referenceYear = reference.getFullYear();
  if (Number.isNaN(referenceYear)) return false;
  return year === referenceYear;
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

  const { monthIndex, day, year, hour12, minute, meridiem } = parts;
  const date = `${MONTHS_SHORT[monthIndex]} ${day}`;
  const time = `${hour12}:${minute} ${meridiem}`;

  if (isCurrentYear(year, now)) return `${date}, ${time}`;
  return `${date}, ${year}, ${time}`;
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

  const { monthIndex, day, year, hour12, minute, meridiem } = parts;
  const date = `${MONTHS_LONG[monthIndex]} ${day}`;
  const time = `${hour12}:${minute} ${meridiem}`;

  if (isCurrentYear(year, now)) return `${date} at ${time}`;
  return `${date}, ${year} at ${time}`;
}
