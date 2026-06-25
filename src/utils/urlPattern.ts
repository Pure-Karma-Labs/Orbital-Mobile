/**
 * Shared URL pattern source string.
 *
 * Exported as a raw string so each consumer can build its own RegExp instance
 * (avoiding shared lastIndex state from a global RegExp).
 *
 * Used by:
 * - emoji/data.ts (URL detection in findEmojiInText)
 * - hooks/useLinkPreview.ts (extractFirstUrl)
 */
export const URL_PATTERN_SOURCE = 'https?:\\/\\/[^\\s<>"{}|\\\\^`\\[\\]]+';

/**
 * Strip Unicode format characters (category Cf) that can spoof URL display.
 * Covers bidi overrides (U+202E RTL Override), zero-width spaces (U+200B),
 * and other invisible format chars used in homograph/bidi attacks.
 */
const FORMAT_CHAR_RE = /\p{Cf}/gu;
export function stripFormatChars(url: string): string {
  return url.replace(FORMAT_CHAR_RE, '');
}
