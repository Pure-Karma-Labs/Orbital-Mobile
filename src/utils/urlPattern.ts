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
