/**
 * Tests for threadHeadline (#927 §7).
 *
 * The cut cases are the point of this suite: the headline is derived from
 * arbitrary imported text, so the only cuts that matter are the ones that
 * land inside something — a surrogate pair, a flag, a keycap, an accent.
 */

import { NO_TITLE_FALLBACK, threadHeadline } from '../threadHeadline';
import type { Thread } from '../../types/store';

type HeadlineInput = Pick<Thread, 'title' | 'body' | 'contentType' | 'mediaCount'>;

function input(overrides: Partial<HeadlineInput> = {}): HeadlineInput {
  return {
    title: null,
    body: null,
    contentType: 'text',
    mediaCount: 0,
    ...overrides,
  };
}

/** True when `value` holds a UTF-16 surrogate that is not part of a pair. */
function hasLoneSurrogate(value: string): boolean {
  return Array.from(value).some((codePoint) => /^[\uD800-\uDFFF]$/.test(codePoint));
}

/** Length in CODE POINTS, which is what the cut is measured in. */
function codePoints(value: string): number {
  return Array.from(value).length;
}

describe('threadHeadline — the title branch', () => {
  it('returns a non-empty title exactly as stored', () => {
    expect(threadHeadline(input({ title: 'Trip to the coast' }))).toBe('Trip to the coast');
    // Untouched means untouched: no trimming, no collapsing, no cut. A native
    // thread's row must read exactly as it did before this function existed,
    // including a title longer than the body branch's ceiling.
    expect(threadHeadline(input({ title: '  padded  ' }))).toBe('  padded  ');
    const long = 'T'.repeat(200);
    expect(threadHeadline(input({ title: long }))).toBe(long);
  });

  it('wins over a body and over photos', () => {
    expect(
      threadHeadline(
        input({ title: 'Title', body: 'Body text', contentType: 'media', mediaCount: 4 }),
      ),
    ).toBe('Title');
  });

  it('falls through when the title is empty or whitespace only', () => {
    expect(threadHeadline(input({ title: '', body: 'Body text' }))).toBe('Body text');
    expect(threadHeadline(input({ title: '   ', body: 'Body text' }))).toBe('Body text');
    expect(threadHeadline(input({ title: null, body: 'Body text' }))).toBe('Body text');
  });
});

describe('threadHeadline — the link branch', () => {
  it('reduces a body that is nothing but a URL to its host', () => {
    expect(threadHeadline(input({ body: 'https://www.example.com/article' }))).toBe('example.com');
    expect(threadHeadline(input({ body: 'http://example.com' }))).toBe('example.com');
    expect(threadHeadline(input({ body: '  https://example.com/x  ' }))).toBe('example.com');
    expect(threadHeadline(input({ body: 'https://news.example.co.uk/a?b=1#c' }))).toBe(
      'news.example.co.uk',
    );
  });

  it('shows the real host of a userinfo spoof', () => {
    expect(threadHeadline(input({ body: 'https://example.com@evil.test/x' }))).toBe('evil.test');
  });

  it('falls back to "Link" when the URL has no host to name', () => {
    expect(threadHeadline(input({ body: 'https://@' }))).toBe('Link');
  });

  it('takes the text branch when the body is a URL plus anything else', () => {
    expect(threadHeadline(input({ body: 'look: https://example.com/x' }))).toBe(
      'look: https://example.com/x',
    );
    expect(threadHeadline(input({ body: 'https://example.com/x https://b.test' }))).toBe(
      'https://example.com/x https://b.test',
    );
  });
});

describe('threadHeadline — the text branch', () => {
  it('uses a short body as it stands', () => {
    expect(threadHeadline(input({ body: 'Back from the lake.' }))).toBe('Back from the lake.');
  });

  it('uses the first NON-EMPTY line', () => {
    expect(threadHeadline(input({ body: '\n\n   \nFirst real line\nsecond line' }))).toBe(
      'First real line',
    );
    expect(threadHeadline(input({ body: 'first\nsecond' }))).toBe('first');
    // \r\n and the Unicode line separators count as line breaks too.
    expect(threadHeadline(input({ body: 'first\r\nsecond' }))).toBe('first');
    expect(threadHeadline(input({ body: 'first\u2028second' }))).toBe('first');
  });

  it('collapses runs of whitespace inside the line', () => {
    expect(threadHeadline(input({ body: '  a   b\t\tc  ' }))).toBe('a b c');
  });

  it('leaves a line of exactly 60 code points uncut', () => {
    const exact = 'a'.repeat(60);
    expect(threadHeadline(input({ body: exact }))).toBe(exact);
    expect(threadHeadline(input({ body: `${exact}b` }))).toBe(`${exact}…`);
  });

  it('cuts at the last word boundary at or after index 30', () => {
    //                     1234567890123456789012345678901234567890
    const body = 'The quick brown fox jumps over the lazy dog and keeps on running for miles';
    const headline = threadHeadline(input({ body }));
    expect(headline).toBe('The quick brown fox jumps over the lazy dog and keeps on…');
    expect(headline!.endsWith(' …')).toBe(false);
    expect(codePoints(headline!)).toBeLessThanOrEqual(61);
  });

  it('hard-cuts a long word rather than leaving a stub', () => {
    const body = 'ab ' + 'c'.repeat(100);
    const headline = threadHeadline(input({ body }))!;
    // The only space sits at index 2, well below the 30-code-point floor, so
    // the word-boundary rule is declined and the cut is hard.
    expect(headline).toBe(`${body.slice(0, 60)}…`);
    expect(codePoints(headline)).toBe(61);
  });

  it('cuts a single unbroken word at exactly 60 code points', () => {
    const headline = threadHeadline(input({ body: 'z'.repeat(200) }))!;
    expect(headline).toBe(`${'z'.repeat(60)}…`);
  });
});

describe('threadHeadline — cutting near emoji and marks', () => {
  // Every case here is 61+ code points, so the cut always fires, and the
  // cluster always straddles index 60.
  const PAD = (n: number) => 'a'.repeat(n);

  it('never splits a surrogate pair', () => {
    const headline = threadHeadline(input({ body: PAD(59) + '\u{1F600}\u{1F600}' }))!;
    expect(hasLoneSurrogate(headline)).toBe(false);
    expect(headline).toBe(`${PAD(59)}\u{1F600}…`);
  });

  it('does not orphan a skin-tone modifier', () => {
    const headline = threadHeadline(input({ body: PAD(59) + '\u{1F44D}\u{1F3FD}x' }))!;
    expect(headline).toBe(`${PAD(59)}…`);
    expect(headline).not.toContain('\u{1F3FD}');
    expect(hasLoneSurrogate(headline)).toBe(false);
  });

  it('does not split a regional-indicator flag pair', () => {
    const headline = threadHeadline(input({ body: PAD(59) + '\u{1F1EB}\u{1F1F7}x' }))!;
    expect(headline).toBe(`${PAD(59)}…`);
    expect(headline).not.toContain('\u{1F1EB}');
  });

  it('keeps a whole flag when both halves fit', () => {
    const headline = threadHeadline(input({ body: PAD(58) + '\u{1F1EB}\u{1F1F7}x' }))!;
    expect(headline).toBe(`${PAD(58)}\u{1F1EB}\u{1F1F7}…`);
  });

  it('does not split a keycap sequence', () => {
    // '1' + VS16 + U+20E3 occupies indices 58, 59 and 60.
    const headline = threadHeadline(input({ body: PAD(58) + '1\uFE0F\u20E3xx' }))!;
    expect(headline).toBe(`${PAD(58)}…`);
    expect(headline).not.toContain('\u20E3');
    expect(headline).not.toContain('\uFE0F');
  });

  it('does not orphan a combining accent', () => {
    const headline = threadHeadline(input({ body: PAD(59) + 'e\u0301xx' }))!;
    expect(headline).toBe(`${PAD(59)}…`);
    expect(headline).not.toContain('\u0301');
  });

  // A ZWJ sequence cannot reach the cut: `stripFormatChars` removes every Cf
  // character — ZWJ and tag characters included — before anything is measured.
  // The sequence therefore degrades to its component emoji, each of which is
  // still cut whole. (safeCutIndex keeps its ZWJ and tag arms so that
  // narrowing the strip later cannot start splitting them.)
  it('cuts a ZWJ family sequence without producing a lone surrogate', () => {
    const family = '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}';
    const headline = threadHeadline(input({ body: PAD(59) + family + 'x' }))!;
    expect(headline).toBe(`${PAD(59)}\u{1F468}…`);
    expect(headline).not.toContain('\u200D');
    expect(hasLoneSurrogate(headline)).toBe(false);
  });

  it('cuts everything rather than mangling a line of bare combining marks', () => {
    expect(threadHeadline(input({ body: '\u0301'.repeat(70) }))).toBe('…');
  });
});

describe('threadHeadline — format characters', () => {
  it('strips a bidi override and zero-width characters', () => {
    expect(threadHeadline(input({ body: 'hello\u202Eworld' }))).toBe('helloworld');
    expect(threadHeadline(input({ body: 'exa\u200Bmple' }))).toBe('example');
    expect(threadHeadline(input({ body: '\u202Egnp.exe' }))).toBe('gnp.exe');
  });

  it('strips them before the URL test, so a spoofed link still reduces to a host', () => {
    expect(threadHeadline(input({ body: 'https://exa\u202Emple.com/x' }))).toBe('example.com');
  });

  it('treats a body of nothing but format characters as empty', () => {
    expect(threadHeadline(input({ body: '\u202E\u200B', mediaCount: 2 }))).toBe('2 photos');
    expect(threadHeadline(input({ body: '\u202E\u200B', mediaCount: 0 }))).toBeNull();
  });
});

describe('threadHeadline — the photo branch', () => {
  it('counts photos when the body is empty', () => {
    expect(threadHeadline(input({ body: null, mediaCount: 1 }))).toBe('Photo');
    expect(threadHeadline(input({ body: '', mediaCount: 3 }))).toBe('3 photos');
    expect(threadHeadline(input({ body: '   ', mediaCount: 12 }))).toBe('12 photos');
  });

  it('says "Photos" for a media thread whose count is unknown', () => {
    expect(threadHeadline(input({ body: null, contentType: 'media', mediaCount: null }))).toBe(
      'Photos',
    );
  });

  it('says nothing for an unknown count on a non-media thread', () => {
    expect(threadHeadline(input({ body: null, contentType: 'text', mediaCount: null }))).toBeNull();
    expect(threadHeadline(input({ body: null, contentType: 'link', mediaCount: null }))).toBeNull();
  });

  it('declines a count that is zero or not a whole number', () => {
    expect(threadHeadline(input({ body: null, contentType: 'media', mediaCount: 0 }))).toBeNull();
    expect(threadHeadline(input({ body: null, mediaCount: -2 }))).toBeNull();
    expect(threadHeadline(input({ body: null, mediaCount: 1.5 }))).toBeNull();
    expect(threadHeadline(input({ body: null, mediaCount: NaN }))).toBeNull();
  });

  it('loses to a body, which is the more specific thing to say', () => {
    expect(threadHeadline(input({ body: 'At the beach', mediaCount: 4 }))).toBe('At the beach');
  });
});

describe('threadHeadline — the fallback', () => {
  it('returns null when there is nothing to derive a headline from', () => {
    expect(threadHeadline(input())).toBeNull();
    expect(threadHeadline(input({ title: '', body: '' }))).toBeNull();
  });

  it('publishes the caller-side fallback string', () => {
    expect(NO_TITLE_FALLBACK).toBe('(no title)');
  });

  it('never throws, for any shape a decrypt could hand it', () => {
    expect(() => threadHeadline(input({ title: undefined as unknown as null }))).not.toThrow();
    expect(() => threadHeadline(input({ body: undefined as unknown as null }))).not.toThrow();
    expect(() => threadHeadline(input({ mediaCount: undefined as unknown as null }))).not.toThrow();
  });
});
