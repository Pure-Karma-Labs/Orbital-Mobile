/**
 * Meta's UTF-8-as-latin1 mojibake repair (#925).
 *
 * The repair is only safe because the decode is STRICT: every assertion below
 * that a string is left ALONE is really an assertion about `decodeUtf8Strict`
 * refusing something a lenient decoder would have mangled into U+FFFD.
 */

import { repairMojibake } from '../mojibake';
import { mojibakeEscape } from '../testUtils/builders';

describe('repairMojibake — strings it must not touch', () => {
  it.each([
    ['the empty string', ''],
    ['plain ASCII', 'Hello, world!'],
    ['ASCII punctuation and digits', 'a1! "#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~'],
    ['a newline-heavy post', 'line one\nline two\r\nline three'],
  ])('leaves %s unchanged (no byte in 0x80-0xFF)', (_label, input) => {
    expect(repairMojibake(input)).toBe(input);
  });

  it.each([
    ['an emoji', 'Beach day \u{1f3d6}'],
    ['a CJK string', '日本語'],
    ['a code point just above 0xFF', 'Ā'],
    ['correctly-typed text with an accent AND an emoji', 'Café ☕'],
    ['a surrogate pair', '🏖'],
  ])(
    'leaves %s unchanged (a code point above 0xFF proves it is not a byte image)',
    (_label, input) => {
      expect(repairMojibake(input)).toBe(input);
    },
  );

  it.each([
    ['a lone e-acute', 'café'],
    ['a lone diaeresis', 'naïve'],
    ['a lone n-tilde', 'mañana'],
    ['a non-breaking space', 'a b'],
    ['a pound sign', '£100'],
  ])('leaves %s unchanged (its latin1 byte image is not valid UTF-8)', (_label, input) => {
    // This is the whole false-positive defence. `café` has the byte image
    // `63 61 66 E9`, and `E9` is a three-byte lead with no continuation —
    // strict decode refuses, so the original survives.
    expect(repairMojibake(input)).toBe(input);
  });
});

describe('repairMojibake — strings it must repair', () => {
  it.each([
    ['an accent', 'Café'],
    ['an accent and an emoji', 'Café ☕'],
    ['an astral emoji', 'Beach day \u{1f3d6}️'],
    ['CJK', '日本語'],
    ['a mixed post', 'Dinner at Café Müller ☕ \u{1f374} — lovely'],
    ['a string that is mostly ASCII', 'ok é ok'],
  ])('repairs mojibake of %s', (_label, original) => {
    expect(repairMojibake(mojibakeEscape(original))).toBe(original);
  });

  it('accepts the documented false positive', () => {
    // Someone who literally typed `Ã©` gets `é`. Two Latin-1
    // Supplement code points that happen to form valid UTF-8 are far more
    // likely to be the exporter's defect than the member's intent, and the
    // alternative (never repairing a two-character sequence) would leave most
    // real accented posts broken.
    expect(repairMojibake('Ã©')).toBe('é');
  });
});

describe('repairMojibake — determinism', () => {
  const CASES = [
    '',
    'ASCII only',
    'café',
    'Café ☕',
    mojibakeEscape('Café ☕'),
    mojibakeEscape('Beach \u{1f3d6}'),
    mojibakeEscape('naïve'),
    'Ã©',
    'ÿþ',
  ];

  it.each(CASES)('is idempotent for %p', (input) => {
    const once = repairMojibake(input);
    expect(repairMojibake(once)).toBe(once);
  });

  it('repairs exactly ONE level of double encoding', () => {
    // Looping to a fixed point would be a guess about how many times Meta's
    // pipeline mangled the string, and a guess that sometimes eats real
    // content. One call, one layer.
    const doubled = mojibakeEscape(mojibakeEscape('é'));
    expect(repairMojibake(doubled)).toBe(mojibakeEscape('é'));
  });

  it('is NOT idempotent on double-encoded input, and that is the rule working', () => {
    // The one documented exception to idempotence: the first call's output is
    // itself well-formed mojibake, so a second call peels the second layer.
    // Refusing to repair in that case would make doubly-mangled text
    // permanently unreadable. The parser calls this exactly once per string.
    const doubled = mojibakeEscape(mojibakeEscape('é'));
    expect(repairMojibake(repairMojibake(doubled))).toBe('é');
    expect(repairMojibake(doubled)).not.toBe('é');
  });

  it('is a pure function of its input', () => {
    const input = mojibakeEscape('Café');
    expect(repairMojibake(input)).toBe(repairMojibake(input));
    expect(input).toBe(mojibakeEscape('Café'));
  });
});
