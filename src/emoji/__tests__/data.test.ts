/**
 * Tests for the emoji data module.
 */

import {
  unifiedToNative,
  getEmojiData,
  getEmojiDataByNative,
  getEmojiByCategory,
  getCategories,
  searchEmoji,
  findEmojiInText,
  emojiData,
  SHEET_COLUMNS,
  CELL_SIZE_32,
  CELL_SIZE_64,
} from '../data';

describe('emoji/data', () => {
  describe('constants', () => {
    it('has correct sprite sheet constants', () => {
      expect(SHEET_COLUMNS).toBe(62);
      expect(CELL_SIZE_32).toBe(34);
      expect(CELL_SIZE_64).toBe(66);
    });
  });

  describe('emojiData', () => {
    it('loads the full emoji dataset', () => {
      expect(emojiData.length).toBeGreaterThan(1000);
    });

    it('each entry has required fields', () => {
      const first = emojiData[0];
      expect(first).toHaveProperty('unified');
      expect(first).toHaveProperty('sheet_x');
      expect(first).toHaveProperty('sheet_y');
      expect(first).toHaveProperty('short_name');
      expect(first).toHaveProperty('category');
    });
  });

  describe('unifiedToNative', () => {
    it('converts single codepoint', () => {
      // 1F600 = grinning face
      const native = unifiedToNative('1F600');
      expect(native).toBe('\u{1F600}');
    });

    it('converts multi-codepoint sequence', () => {
      // 0023-FE0F-20E3 = #️⃣
      const native = unifiedToNative('0023-FE0F-20E3');
      expect(native).toBe('#️⃣');
    });
  });

  describe('getEmojiData', () => {
    it('finds emoji by unified code', () => {
      const data = getEmojiData('1F600');
      expect(data).toBeDefined();
      expect(data!.name).toBe('GRINNING FACE');
      expect(data!.short_name).toBe('grinning');
    });

    it('finds emoji by non_qualified code', () => {
      // 2699 is the non_qualified form of 2699-FE0F (gear)
      const data = getEmojiData('2699');
      expect(data).toBeDefined();
      expect(data!.name).toBe('GEAR');
    });

    it('returns undefined for unknown code', () => {
      expect(getEmojiData('ZZZZ')).toBeUndefined();
    });
  });

  describe('getEmojiDataByNative', () => {
    it('finds emoji by native unicode string', () => {
      const data = getEmojiDataByNative('\u{1F600}');
      expect(data).toBeDefined();
      expect(data!.unified).toBe('1F600');
    });

    it('returns undefined for non-emoji string', () => {
      expect(getEmojiDataByNative('hello')).toBeUndefined();
    });
  });

  describe('getEmojiByCategory', () => {
    it('returns emoji for a valid category', () => {
      const smileys = getEmojiByCategory('Smileys & Emotion');
      expect(smileys.length).toBeGreaterThan(0);
    });

    it('returns entries sorted by sort_order', () => {
      const smileys = getEmojiByCategory('Smileys & Emotion');
      for (let i = 1; i < smileys.length; i++) {
        expect(smileys[i].sort_order).toBeGreaterThanOrEqual(
          smileys[i - 1].sort_order,
        );
      }
    });

    it('returns empty array for unknown category', () => {
      expect(getEmojiByCategory('NonExistent')).toEqual([]);
    });
  });

  describe('getCategories', () => {
    it('returns all category names', () => {
      const cats = getCategories();
      expect(cats.length).toBeGreaterThan(0);
      expect(cats).toContain('Smileys & Emotion');
      expect(cats).toContain('People & Body');
      expect(cats).toContain('Animals & Nature');
    });
  });

  describe('searchEmoji', () => {
    it('finds emoji by short_name substring', () => {
      const results = searchEmoji('grin');
      expect(results.length).toBeGreaterThan(0);
      expect(results.some((e) => e.short_name === 'grinning')).toBe(true);
    });

    it('is case-insensitive', () => {
      const results = searchEmoji('GRIN');
      expect(results.length).toBeGreaterThan(0);
    });

    it('respects limit', () => {
      const results = searchEmoji('face', 5);
      expect(results.length).toBeLessThanOrEqual(5);
    });

    it('returns empty for empty query', () => {
      expect(searchEmoji('')).toEqual([]);
    });
  });

  describe('findEmojiInText', () => {
    it('returns empty array for empty string', () => {
      expect(findEmojiInText('')).toEqual([]);
    });

    it('returns single text segment for text without emoji', () => {
      const result = findEmojiInText('hello world');
      expect(result).toEqual([{ type: 'text', value: 'hello world' }]);
    });

    it('parses text with single emoji', () => {
      const text = 'hello \u{1F600} world';
      const result = findEmojiInText(text);

      expect(result.length).toBe(3);
      expect(result[0]).toEqual({ type: 'text', value: 'hello ' });
      expect(result[1]).toEqual({
        type: 'emoji',
        value: '\u{1F600}',
        unified: '1F600',
      });
      expect(result[2]).toEqual({ type: 'text', value: ' world' });
    });

    it('parses text with multiple emoji', () => {
      const text = '\u{1F600}\u{1F601}';
      const result = findEmojiInText(text);

      expect(result.length).toBe(2);
      expect(result[0].type).toBe('emoji');
      expect(result[1].type).toBe('emoji');
    });

    it('handles emoji at start and end of text', () => {
      const text = '\u{1F600}hello\u{1F601}';
      const result = findEmojiInText(text);

      expect(result.length).toBe(3);
      expect(result[0].type).toBe('emoji');
      expect(result[1]).toEqual({ type: 'text', value: 'hello' });
      expect(result[2].type).toBe('emoji');
    });

    it('handles text that is only emoji', () => {
      const text = '\u{1F600}';
      const result = findEmojiInText(text);
      expect(result.length).toBe(1);
      expect(result[0].type).toBe('emoji');
      expect(result[0].unified).toBe('1F600');
    });
  });
});
