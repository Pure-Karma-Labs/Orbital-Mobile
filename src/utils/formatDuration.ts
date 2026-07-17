/**
 * Duration formatting utilities for media display.
 *
 * @example
 *   formatDurationMs(61000)   // "1:01"
 *   formatDurationMs(3661000) // "1:01:01"
 *   formatDurationSeconds(90) // "1:30"
 */

/**
 * Format a duration in milliseconds to a human-readable string.
 *
 * - Under 1 hour: "M:SS"
 * - 1 hour or more: "H:MM:SS"
 * - Negative or NaN: "0:00"
 *
 * @example
 *   formatDurationMs(61000)   // "1:01"
 *   formatDurationMs(3661000) // "1:01:01"
 *   formatDurationMs(-1)      // "0:00"
 */
export function formatDurationMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0:00';

  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
  }

  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

/**
 * Format a duration in seconds to a human-readable string.
 * Delegates to {@link formatDurationMs} after converting to milliseconds.
 *
 * @example
 *   formatDurationSeconds(90)   // "1:30"
 *   formatDurationSeconds(3700) // "1:01:40"
 */
export function formatDurationSeconds(seconds: number): string {
  return formatDurationMs(seconds * 1000);
}
