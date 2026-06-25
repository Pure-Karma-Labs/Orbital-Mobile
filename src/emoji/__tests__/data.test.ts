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
      expect(result[0].type === 'emoji' && result[0].unified).toBe('1F600');
    });
  });

  describe('URL detection in findEmojiInText', () => {
    it('text with HTTPS URL', () => {
      const result = findEmojiInText('visit https://example.com for details');
      expect(result).toEqual([
        { type: 'text', value: 'visit ' },
        { type: 'link', value: 'https://example.com', url: 'https://example.com' },
        { type: 'text', value: ' for details' },
      ]);
    });

    it('text with HTTP URL', () => {
      const result = findEmojiInText('see http://example.com');
      const linkSegment = result.find((s) => s.type === 'link');
      expect(linkSegment).toBeDefined();
      expect(linkSegment!.type === 'link' && linkSegment!.url).toBe('http://example.com');
    });

    it('multiple URLs', () => {
      const result = findEmojiInText('see https://a.com and https://b.com');
      const links = result.filter((s) => s.type === 'link');
      expect(links.length).toBe(2);
      expect(links[0].type === 'link' && links[0].url).toBe('https://a.com');
      expect(links[1].type === 'link' && links[1].url).toBe('https://b.com');
    });

    it('URL only', () => {
      const result = findEmojiInText('https://example.com');
      expect(result).toEqual([
        { type: 'link', value: 'https://example.com', url: 'https://example.com' },
      ]);
    });

    it('URL with query string', () => {
      const result = findEmojiInText('https://example.com/path?a=1&b=2#frag');
      expect(result.length).toBe(1);
      expect(result[0]).toEqual({
        type: 'link',
        value: 'https://example.com/path?a=1&b=2#frag',
        url: 'https://example.com/path?a=1&b=2#frag',
      });
    });

    it('URL followed by period', () => {
      const result = findEmojiInText('visit https://example.com.');
      const linkSegment = result.find((s) => s.type === 'link');
      expect(linkSegment).toBeDefined();
      expect(linkSegment!.type === 'link' && linkSegment!.value).toBe('https://example.com');
    });

    it('URL followed by comma', () => {
      const result = findEmojiInText('see https://example.com, then');
      const linkSegment = result.find((s) => s.type === 'link');
      expect(linkSegment).toBeDefined();
      expect(linkSegment!.type === 'link' && linkSegment!.value).toBe('https://example.com');
    });

    it('Wikipedia URL with balanced parens', () => {
      const result = findEmojiInText('https://en.wikipedia.org/wiki/Foo_(bar)');
      const linkSegment = result.find((s) => s.type === 'link');
      expect(linkSegment).toBeDefined();
      expect(linkSegment!.type === 'link' && linkSegment!.value).toBe(
        'https://en.wikipedia.org/wiki/Foo_(bar)',
      );
    });

    it('URL with unbalanced trailing paren', () => {
      const result = findEmojiInText('(see https://example.com)');
      const linkSegment = result.find((s) => s.type === 'link');
      expect(linkSegment).toBeDefined();
      expect(linkSegment!.type === 'link' && linkSegment!.value).toBe('https://example.com');
    });

    it('URL and emoji in same text', () => {
      const result = findEmojiInText('check https://example.com \u{1F600}');
      const linkSegment = result.find((s) => s.type === 'link');
      const emojiSegment = result.find((s) => s.type === 'emoji');
      expect(linkSegment).toBeDefined();
      expect(emojiSegment).toBeDefined();
      expect(linkSegment!.type === 'link' && linkSegment!.url).toBe('https://example.com');
    });

    it('emoji before URL', () => {
      const result = findEmojiInText('\u{1F600} https://example.com');
      const emojiSegment = result.find((s) => s.type === 'emoji');
      const linkSegment = result.find((s) => s.type === 'link');
      expect(emojiSegment).toBeDefined();
      expect(linkSegment).toBeDefined();
      expect(linkSegment!.type === 'link' && linkSegment!.url).toBe('https://example.com');
    });

    it('bare www without scheme stays as text', () => {
      const result = findEmojiInText('visit www.example.com');
      const linkSegments = result.filter((s) => s.type === 'link');
      expect(linkSegments.length).toBe(0);
      expect(result).toEqual([{ type: 'text', value: 'visit www.example.com' }]);
    });

    it('javascript: scheme stays as text', () => {
      const result = findEmojiInText('javascript:alert(1)');
      const linkSegments = result.filter((s) => s.type === 'link');
      expect(linkSegments.length).toBe(0);
    });
  });

  describe('URL format-char stripping', () => {
    it('strips RTL Override from URL segment', () => {
      const text = 'visit https://evil.com‮moc.elgoog';
      const result = findEmojiInText(text);
      const link = result.find(s => s.type === 'link');
      expect(link).toBeDefined();
      expect(link!.url).not.toContain('‮');
      expect(link!.value).not.toContain('‮');
    });

    it('strips zero-width space from URL', () => {
      const text = 'https://example​.com/path';
      const result = findEmojiInText(text);
      const link = result.find(s => s.type === 'link');
      expect(link).toBeDefined();
      expect(link!.url).toBe('https://example.com/path');
    });

    it('strips multiple format chars from URL', () => {
      const text = 'https://‏example‪.com⁦';
      const result = findEmojiInText(text);
      const link = result.find(s => s.type === 'link');
      expect(link).toBeDefined();
      expect(link!.url).toBe('https://example.com');
    });

    it('leaves clean URLs unchanged', () => {
      const result = findEmojiInText('https://example.com/path?q=1');
      const link = result.find(s => s.type === 'link');
      expect(link!.url).toBe('https://example.com/path?q=1');
    });
  });

  describe('trimTrailingPunctuation loop cap', () => {
    it('caps trimming at 10 iterations on adversarial trailing dots', () => {
      const adversarial = 'https://example.com' + '.'.repeat(1000);
      const result = findEmojiInText(adversarial);
      const link = result.find(s => s.type === 'link');
      expect(link).toBeDefined();
      expect(link!.url).toBe('https://example.com' + '.'.repeat(990));
    });

    it('caps trimming on adversarial trailing parens (O(n^2) branch)', () => {
      const adversarial = 'https://example.com/path' + ')'.repeat(500);
      const result = findEmojiInText(adversarial);
      const link = result.find(s => s.type === 'link');
      expect(link).toBeDefined();
      expect(link!.url).toBe('https://example.com/path' + ')'.repeat(490));
    });

    it('fully trims normal trailing punctuation within cap', () => {
      const result = findEmojiInText('https://example.com/path.)');
      const link = result.find(s => s.type === 'link');
      expect(link).toBeDefined();
      expect(link!.url).toBe('https://example.com/path');
    });
  });
});
