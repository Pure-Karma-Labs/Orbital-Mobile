/**
 * Emoji module barrel export.
 *
 * Provides the emoji data layer (lookup maps, parsing, search) for the
 * OpenMoji per-emoji-asset rendering system.
 */

export {
  // Types
  type EmojiDataEntry,
  type EmojiSegment,
  type TextSegment,
  type LinkSegment,
  type RichTextSegment,
  // Utilities
  unifiedToNative,
  getEmojiData,
  getEmojiDataByNative,
  getEmojiByCategory,
  getCategories,
  searchEmoji,
  findEmojiInText,
  // Raw data
  emojiData,
} from './data';
