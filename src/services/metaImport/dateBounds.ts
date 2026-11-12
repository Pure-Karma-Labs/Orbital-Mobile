/**
 * The importable date window, shared by both parsers (#925).
 *
 * The backend refuses an import item whose `original_created_at` falls outside
 * `[2004-01-01, DB UTC today]` (`importService.js:834`), so a post outside that
 * window is not a post we can offer to import — it is an `invalid_timestamp`
 * skip the member sees in #928's list, rather than a row the server rejects
 * halfway through a run.
 *
 * ## Why the upper bound is a UTC CALENDAR DAY and not `Date.now()`
 *
 * The server compares against its own `dbUtcToday`. A member in UTC+13 posting
 * at 09:00 local on the 2nd is at 20:00 UTC on the 1st — but their phone's
 * local calendar says the 2nd, and a device-local "today" would admit a whole
 * day the server will refuse (or refuse a day it would admit). So the bound is
 * computed from the UTC calendar date, inclusive of its last millisecond, and
 * `parseArchive` injects it as a `YYYY-MM-DD` string so every test can pin a
 * day without touching the clock.
 *
 * This module is deliberately tiny and dependency-free: both parsers apply the
 * identical rule, and two copies of a boundary rule is how a boundary rule
 * drifts.
 */

/** `2004-01-01T00:00:00.000Z` — Facebook's own epoch, and the server's floor. */
export const MIN_IMPORT_DATE_MS = Date.UTC(2004, 0, 1);

/** Milliseconds in one day; the upper bound is "start of the next UTC day". */
const MS_PER_DAY = 86_400_000;

const UTC_DAY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Today's UTC calendar date as `YYYY-MM-DD`. `parseArchive`'s default. */
export function todayUtcDay(now: number = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

/**
 * Exclusive upper bound in epoch ms for a `YYYY-MM-DD` UTC day, or `null` if
 * the string is not one.
 *
 * Exclusive-next-midnight rather than inclusive-last-millisecond: the same
 * number, one fewer place to write 999 wrongly.
 */
export function endOfUtcDayExclusive(utcDay: string): number | null {
  const match = UTC_DAY_PATTERN.exec(utcDay);
  if (match === null) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const start = Date.UTC(year, month - 1, day);
  if (!Number.isFinite(start)) return null;
  // `Date.UTC` rolls over (2026-02-31 → 2026-03-03). Reject rather than roll:
  // a bound that silently moved is worse than a bound that refuses.
  const iso = new Date(start).toISOString().slice(0, 10);
  if (iso !== utcDay) return null;
  return start + MS_PER_DAY;
}

/**
 * Whether an epoch-ms instant is inside the importable window.
 *
 * An unparseable `nowUtcDay` admits NOTHING. The alternative — falling back to
 * the device clock — would hide a caller bug behind posts that import on one
 * machine and not another.
 */
export function isImportableDate(epochMs: number, nowUtcDay: string): boolean {
  if (!Number.isFinite(epochMs)) return false;
  const upper = endOfUtcDayExclusive(nowUtcDay);
  if (upper === null) return false;
  return epochMs >= MIN_IMPORT_DATE_MS && epochMs < upper;
}
