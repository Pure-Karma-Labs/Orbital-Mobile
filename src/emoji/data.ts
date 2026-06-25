/**
 * Emoji Data Module
 *
 * Loads emoji-datasource/emoji.json and builds lookup maps for efficient
 * emoji rendering and text parsing. Used by the Emoji and EmojiText components
 * to resolve Unicode emoji to OpenMoji sprite sheet positions.
 */

import { URL_PATTERN_SOURCE, stripFormatChars } from '../utils/urlPattern';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const emojiData: EmojiDataEntry[] = require('emoji-datasource/emoji.json');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EmojiDataEntry {
  name: string;
  unified: string;
  non_qualified: string | null;
  image: string;
  sheet_x: number;
  sheet_y: number;
  short_name: string;
  short_names: string[];
  text: string | null;
  texts: string[] | null;
  category: string;
  subcategory: string;
  sort_order: number;
  added_in: string;
  has_img_apple: boolean;
  has_img_google: boolean;
  has_img_twitter: boolean;
  has_img_facebook: boolean;
}

export type TextSegment = { type: 'text'; value: string };
export type EmojiSegment = { type: 'emoji'; value: string; unified: string };
export type LinkSegment = { type: 'link'; value: string; url: string };
export type RichTextSegment = TextSegment | EmojiSegment | LinkSegment;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Number of columns in the sprite sheet grid */
export const SHEET_COLUMNS = 62;

/** Cell size for the 32px sprite sheet (32px emoji + 2px margin = 34px) */
export const CELL_SIZE_32 = 34;

/** Cell size for the 64px sprite sheet (64px emoji + 2px margin = 66px) */
export const CELL_SIZE_64 = 66;

// ---------------------------------------------------------------------------
// Lookup Maps (built once at module load)
// ---------------------------------------------------------------------------

/** Map from unified hex code (e.g. "1F600") to emoji data */
const emojiByUnified = new Map<string, EmojiDataEntry>();

/** Map from native unicode string (e.g. the actual emoji character) to emoji data */
const emojiByNative = new Map<string, EmojiDataEntry>();

/** Map from category name to array of emoji data entries */
const emojiByCategory = new Map<string, EmojiDataEntry[]>();

/** Map from short_name to emoji data */
const emojiByShortName = new Map<string, EmojiDataEntry>();

// Build all lookup maps
for (const entry of emojiData) {
  // By unified code
  emojiByUnified.set(entry.unified, entry);

  // Also index non_qualified form (e.g. "0023-20E3" without FE0F)
  if (entry.non_qualified) {
    emojiByUnified.set(entry.non_qualified, entry);
  }

  // By native unicode character
  const native = unifiedToNative(entry.unified);
  emojiByNative.set(native, entry);

  // By category
  const catList = emojiByCategory.get(entry.category);
  if (catList) {
    catList.push(entry);
  } else {
    emojiByCategory.set(entry.category, [entry]);
  }

  // By short_name (all aliases)
  for (const shortName of entry.short_names) {
    emojiByShortName.set(shortName, entry);
  }
}

// Sort each category by sort_order
for (const [, entries] of emojiByCategory) {
  entries.sort((a, b) => a.sort_order - b.sort_order);
}

// ---------------------------------------------------------------------------
// Build regex for finding emoji in text
// ---------------------------------------------------------------------------

/**
 * Build a regex that matches any emoji in our dataset. We sort native strings
 * longest-first so multi-codepoint sequences (ZWJ, skin tones, flags) match
 * before their single-codepoint prefixes.
 */
function buildEmojiRegex(): RegExp {
  const nativeStrings: string[] = [];
  for (const [native] of emojiByNative) {
    nativeStrings.push(native);
  }
  // Sort longest first so ZWJ sequences, skin tones etc. match before shorter prefixes
  nativeStrings.sort((a, b) => b.length - a.length);

  // Escape special regex characters in the native strings
  const escaped = nativeStrings.map((s) =>
    s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
  );

  return new RegExp(`(${escaped.join('|')})`, 'g');
}

const emojiRegex = buildEmojiRegex();

// ---------------------------------------------------------------------------
// URL detection helpers
// ---------------------------------------------------------------------------

const TRAILING_PUNCT = /[.,;:!?'")\]}>]+$/;

function trimTrailingPunctuation(rawUrl: string): string {
  let url = rawUrl;
  let iterations = 0;
  while (iterations++ < 10 && TRAILING_PUNCT.test(url)) {
    const lastChar = url[url.length - 1];
    if (lastChar === ')') {
      const openCount = (url.match(/\(/g) || []).length;
      const closeCount = (url.match(/\)/g) || []).length;
      if (openCount >= closeCount) break;
    }
    url = url.slice(0, -1);
  }
  return url;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Convert a unified hex code (e.g. "1F600" or "1F468-200D-1F469-200D-1F467")
 * to a native unicode string.
 */
export function unifiedToNative(unified: string): string {
  return unified
    .split('-')
    .map((hex) => String.fromCodePoint(parseInt(hex, 16)))
    .join('');
}

/**
 * Look up emoji data by unified hex code.
 */
export function getEmojiData(unified: string): EmojiDataEntry | undefined {
  return emojiByUnified.get(unified);
}

/**
 * Look up emoji data by native unicode character.
 */
export function getEmojiDataByNative(
  native: string,
): EmojiDataEntry | undefined {
  return emojiByNative.get(native);
}

/**
 * Get all emoji for a given category, sorted by sort_order.
 */
export function getEmojiByCategory(category: string): EmojiDataEntry[] {
  return emojiByCategory.get(category) ?? [];
}

/**
 * Get all category names in display order.
 */
export function getCategories(): string[] {
  return Array.from(emojiByCategory.keys());
}

/**
 * Search emoji by short_name prefix or substring.
 * Returns up to `limit` results (default 50).
 */
export function searchEmoji(
  query: string,
  limit: number = 50,
): EmojiDataEntry[] {
  if (!query) return [];
  const q = query.toLowerCase();
  const results: EmojiDataEntry[] = [];

  for (const entry of emojiData) {
    if (results.length >= limit) break;

    // Check all short_names for a match
    const matches = entry.short_names.some(
      (name) => name.includes(q),
    );
    if (matches) {
      results.push(entry);
    }
  }

  return results;
}

/**
 * Parse a text span for emoji only (no URL detection).
 * This is the inner loop extracted from the original findEmojiInText.
 */
function findEmojiInTextSpan(text: string): RichTextSegment[] {
  if (!text) return [];

  const segments: RichTextSegment[] = [];
  let lastIndex = 0;

  // Reset regex state
  emojiRegex.lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = emojiRegex.exec(text)) !== null) {
    const matchStart = match.index;
    const matchedEmoji = match[0];

    // Add preceding text if any
    if (matchStart > lastIndex) {
      segments.push({
        type: 'text',
        value: text.slice(lastIndex, matchStart),
      });
    }

    // Look up the emoji data by native character
    const data = emojiByNative.get(matchedEmoji);
    if (data) {
      segments.push({
        type: 'emoji',
        value: matchedEmoji,
        unified: data.unified,
      });
    } else {
      // Fallback: treat as text if not found in our data
      segments.push({
        type: 'text',
        value: matchedEmoji,
      });
    }

    lastIndex = matchStart + matchedEmoji.length;
  }

  // Add trailing text if any
  if (lastIndex < text.length) {
    segments.push({
      type: 'text',
      value: text.slice(lastIndex),
    });
  }

  return segments;
}

/**
 * Parse a text string and split it into segments of plain text, emoji, and URLs.
 *
 * Two-pass approach:
 * 1. URL-first pass: split text into link and text segments
 * 2. Emoji pass: scan text segments for emoji
 *
 * Multi-codepoint sequences (ZWJ, skin tones, flags) are handled correctly
 * because the emoji regex is sorted longest-first.
 */
export function findEmojiInText(text: string): RichTextSegment[] {
  if (!text) return [];

  // Pass 1: split by URLs
  const urlRegex = new RegExp(URL_PATTERN_SOURCE, 'gi');
  const pass1Segments: RichTextSegment[] = [];
  let lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = urlRegex.exec(text)) !== null) {
    const matchStart = match.index;
    const rawUrl = match[0];

    // Add preceding text if any
    if (matchStart > lastIndex) {
      pass1Segments.push({
        type: 'text',
        value: text.slice(lastIndex, matchStart),
      });
    }

    // Trim trailing punctuation, then strip Unicode format chars (bidi spoofing)
    const trimmedUrl = trimTrailingPunctuation(rawUrl);
    const cleanUrl = stripFormatChars(trimmedUrl);
    pass1Segments.push({
      type: 'link',
      value: cleanUrl,
      url: cleanUrl,
    });

    // If characters were trimmed, add them as a text segment
    const trimmedChars = rawUrl.slice(trimmedUrl.length);
    if (trimmedChars) {
      pass1Segments.push({
        type: 'text',
        value: trimmedChars,
      });
    }

    lastIndex = matchStart + rawUrl.length;
  }

  // Add trailing text if any
  if (lastIndex < text.length) {
    pass1Segments.push({
      type: 'text',
      value: text.slice(lastIndex),
    });
  }

  // If no URLs found, fall through to pure emoji parsing
  if (pass1Segments.length === 0) {
    return findEmojiInTextSpan(text);
  }

  // Pass 2: scan text segments for emoji, leave link segments untouched
  const result: RichTextSegment[] = [];
  for (const segment of pass1Segments) {
    if (segment.type === 'text') {
      result.push(...findEmojiInTextSpan(segment.value));
    } else {
      result.push(segment);
    }
  }

  return result;
}

// Re-export the raw data for potential use by emoji picker (future)
export { emojiData };
