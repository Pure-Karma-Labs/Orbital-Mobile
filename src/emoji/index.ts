/**
 * Emoji module barrel export.
 *
 * Provides the emoji data layer (lookup maps, parsing, search) and
 * sprite sheet constants for the OpenMoji rendering system.
 */

export {
  // Types
  type EmojiDataEntry,
  type EmojiSegment,
  // Constants
  SHEET_COLUMNS,
  CELL_SIZE_32,
  CELL_SIZE_64,
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
