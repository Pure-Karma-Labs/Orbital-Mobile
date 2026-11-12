import { BODY_MAX_CHARS, RAW_TEXT_MAX_UNITS, assembleBody, countCodePoints } from '../text';
import { mojibakeEscape } from '../testUtils/builders';

/** A body of astral characters: one code point, two UTF-16 units each. */
const ASTRAL = '\u{1F642}';

describe('assembleBody text pipeline', () => {
  it('passes plain text through, trims the body, and keeps the id input untrimmed', () => {
    // `idText` is the repaired RAW text — trimming is a body cosmetic, and
    // folding it into the id would make the identity depend on whitespace the
    // member cannot see.
    const result = assembleBody({ rawText: '  hello  \n\n' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.body).toBe('hello');
    expect(result.idText).toBe('  hello  \n\n');
  });

  it('normalises CRLF and lone CR to LF, because Meta exports contain both', () => {
    const result = assembleBody({ rawText: 'a\r\nb\rc' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.body).toBe('a\nb\nc');
  });

  it('NFC-normalises the body while the id input stays PRE-NFC', () => {
    // The single most important assertion in this file. Hermes's
    // `normalize('NFC')` is platform-backed, so a normalised id could frame the
    // same post differently on two OS versions and duplicate a member's
    // history. The archive's bytes are the stable thing, so the id takes those.
    const result = assembleBody({ rawText: 'Café' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.body).toBe('Café');
    expect(result.idText).toBe('Café');
  });

  it('repairs Meta byte-escaped mojibake before anything else looks at the text', () => {
    // An export that byte-escaped `é` and one that did not must produce the
    // same body AND the same id input, or the two dedup as different posts.
    const result = assembleBody({ rawText: mojibakeEscape('Café ☕') });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.body).toBe('Café ☕');
    expect(result.idText).toBe('Café ☕');
  });
});

describe('assembleBody link handling', () => {
  it('puts the link on its own line below the member’s words', () => {
    const result = assembleBody({ rawText: 'Read this', linkUrl: 'https://example.org/a' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.body).toBe('Read this\nhttps://example.org/a');
  });

  it('makes a link-only post a body that is just the url', () => {
    const result = assembleBody({ rawText: '', linkUrl: 'https://example.org/a' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.body).toBe('https://example.org/a');
  });

  it('appends nothing for a null or empty link', () => {
    // An empty string is what a stripped/rejected link leaves behind; it must
    // not produce a trailing newline in the body.
    for (const linkUrl of [null, '']) {
      const result = assembleBody({ rawText: 'hi', linkUrl });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.body).toBe('hi');
    }
  });

  it('appends the link verbatim: not NFC-normalised and not mojibake-repaired', () => {
    // The body's url and the url inside `source_item_id` must be byte-for-byte
    // the same string, so the link skips both passes the text goes through.
    const decomposed = 'https://example.org/café';
    const decomposedResult = assembleBody({ rawText: '', linkUrl: decomposed });
    expect(decomposedResult.ok).toBe(true);
    if (!decomposedResult.ok) return;
    expect(decomposedResult.body).toBe(decomposed);
    expect(decomposedResult.body).not.toBe('https://example.org/café');

    const mojibakeLooking = mojibakeEscape('https://example.org/café');
    const mojibakeResult = assembleBody({ rawText: '', linkUrl: mojibakeLooking });
    expect(mojibakeResult.ok).toBe(true);
    if (!mojibakeResult.ok) return;
    expect(mojibakeResult.body).toBe(mojibakeLooking);
    expect(mojibakeResult.body).not.toBe('https://example.org/café');
  });
});

describe('assembleBody empty input', () => {
  it('returns ok with an empty body when there is neither text nor link', () => {
    // Only the caller knows whether the post has media, so only the caller can
    // decide this is `empty_post`.
    const result = assembleBody({ rawText: '' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.body).toBe('');
  });
});

describe('assembleBody length cap', () => {
  it('accepts a body of exactly maxChars', () => {
    const result = assembleBody({ rawText: 'a'.repeat(10), maxChars: 10 });
    expect(result.ok).toBe(true);
  });

  it('skips a body one character over maxChars without truncating it', () => {
    // Half of a member's post, silently, is worse than an honest "this one did
    // not migrate" row — and the id must still be the one this post would
    // always have had, so #921 can persist the skipped item's key.
    const result = assembleBody({ rawText: 'a'.repeat(11), maxChars: 10 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('text_too_long');
    expect(result.idText).toBe('a'.repeat(11));
  });

  it('counts CODE POINTS, so maxChars astral characters fit where a UTF-16 count would not', () => {
    // 10 astral characters are 20 UTF-16 units. Counting units would refuse a
    // post the member would call ten characters long.
    const rawText = ASTRAL.repeat(10);
    expect(rawText.length).toBe(20);
    const result = assembleBody({ rawText, maxChars: 10 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.body).toBe(rawText);
    expect(assembleBody({ rawText: ASTRAL.repeat(11), maxChars: 10 }).ok).toBe(false);
  });

  it('defaults maxChars to BODY_MAX_CHARS', () => {
    expect(assembleBody({ rawText: 'a'.repeat(BODY_MAX_CHARS) }).ok).toBe(true);
    expect(assembleBody({ rawText: 'a'.repeat(BODY_MAX_CHARS + 1) }).ok).toBe(false);
  });

  it('counts the appended link line toward the cap', () => {
    // The cap is on what gets stored, and the link is part of that.
    const rawText = 'abc';
    expect(assembleBody({ rawText, maxChars: 10 }).ok).toBe(true);
    const withLink = assembleBody({ rawText, linkUrl: 'https://e.co', maxChars: 10 });
    expect(withLink.ok).toBe(false);
    if (withLink.ok) return;
    expect(withLink.reason).toBe('text_too_long');
  });
});

describe('assembleBody raw length floor', () => {
  it('accepts raw text of exactly RAW_TEXT_MAX_UNITS UTF-16 units', () => {
    const result = assembleBody({
      rawText: 'a'.repeat(RAW_TEXT_MAX_UNITS),
      maxChars: RAW_TEXT_MAX_UNITS,
    });
    expect(result.ok).toBe(true);
  });

  it('refuses one unit more as malformed_post, before any repair or normalisation', () => {
    // Above this floor the string is not a Meta post but an attack on the
    // repair and NFC passes, both superlinear in allocation — so nothing is
    // repaired, normalised or framed, and there is no id to report.
    const result = assembleBody({
      rawText: 'a'.repeat(RAW_TEXT_MAX_UNITS + 1),
      maxChars: RAW_TEXT_MAX_UNITS + 1,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('malformed_post');
    expect(result.idText).toBeNull();
  });
});

describe('countCodePoints', () => {
  it('counts ASCII, astral characters and a lone surrogate the way a member would', () => {
    // A lone surrogate is one code point here — it is refused later by
    // `encodeUtf8Strict`, not miscounted into the cap.
    expect(countCodePoints('abc')).toBe(3);
    expect(countCodePoints(ASTRAL.repeat(3))).toBe(3);
    expect(countCodePoints('\uD800')).toBe(1);
  });
});
