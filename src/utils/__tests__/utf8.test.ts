/**
 * Strict UTF-8 codec (#925).
 *
 * Two things are being proved here, and the second matters more than the
 * first:
 *
 *  1. The hand-written decoder accepts and rejects the right byte sequences.
 *  2. It agrees with an INDEPENDENT implementation — Node's
 *     `TextDecoder('utf-8', { fatal: true })` — over the whole table and over
 *     10,000 seeded pseudo-random buffers. "Hand-written" is otherwise just
 *     another way of saying "hand-specified", and the failure mode of a
 *     slightly-too-lenient decoder is that `repairMojibake` corrupts a post.
 *
 * `ignoreBOM: true` on the reference decoder is not a detail: WHATWG's decoder
 * STRIPS a leading U+FEFF by default, and a `source_item_id` that silently
 * loses its first character would be a real defect. Our decoder keeps it, so
 * the reference is configured to keep it too.
 *
 * The Hermes guard at the bottom is the reason this module exists at all:
 * Jest's node environment has `TextDecoder`, the Pods Hermes 0.82.1 the app
 * ships does NOT, and a test suite that never notices the difference is how a
 * `TextDecoder` reaches a device. Security invariant 29.8 clause 8 bans the
 * identifier repo-wide; this proves the module works without it.
 */

import { decodeUtf8Strict, encodeUtf8Strict } from '../utf8';

/** `TextDecoder` is the ORACLE here, never the implementation (see header). */
function nodeDecode(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return null;
  }
}

const bytes = (...values: number[]): Uint8Array => new Uint8Array(values);

const VALID: [label: string, input: Uint8Array, expected: string][] = [
  ['empty', bytes(), ''],
  ['NUL', bytes(0x00), '\u0000'],
  ['ASCII', bytes(0x41, 0x42), 'AB'],
  ['two-byte minimum (U+0080)', bytes(0xc2, 0x80), '\u0080'],
  ['two-byte e-acute', bytes(0xc3, 0xa9), 'é'],
  ['two-byte maximum (U+07FF)', bytes(0xdf, 0xbf), '߿'],
  ['three-byte minimum (U+0800)', bytes(0xe0, 0xa0, 0x80), 'ࠀ'],
  ['three-byte hot beverage', bytes(0xe2, 0x98, 0x95), '☕'],
  ['last code point below the surrogates', bytes(0xed, 0x9f, 0xbf), '퟿'],
  ['first code point above the surrogates', bytes(0xee, 0x80, 0x80), ''],
  ['three-byte maximum (U+FFFF)', bytes(0xef, 0xbf, 0xbf), '￿'],
  ['BOM is CONTENT, not stripped', bytes(0xef, 0xbb, 0xbf, 0x41), '﻿A'],
  ['replacement character as real input', bytes(0xef, 0xbf, 0xbd), '�'],
  ['four-byte minimum (U+10000)', bytes(0xf0, 0x90, 0x80, 0x80), '\u{10000}'],
  ['four-byte emoji', bytes(0xf0, 0x9f, 0x8f, 0x96), '\u{1f3d6}'],
  ['four-byte maximum (U+10FFFF)', bytes(0xf4, 0x8f, 0xbf, 0xbf), '\u{10ffff}'],
  [
    'mixed widths in one buffer',
    bytes(0x41, 0xc3, 0xa9, 0xe2, 0x98, 0x95, 0xf0, 0x9f, 0x8f, 0x96),
    'Aé☕\u{1f3d6}',
  ],
];

const INVALID: [label: string, input: Uint8Array][] = [
  ['bare continuation byte', bytes(0x80)],
  ['bare continuation byte (high)', bytes(0xbf)],
  ['overlong NUL (C0 80)', bytes(0xc0, 0x80)],
  ['overlong two-byte (C1 BF)', bytes(0xc1, 0xbf)],
  ['overlong three-byte NUL', bytes(0xe0, 0x80, 0x80)],
  ['overlong three-byte (U+07FF re-encoded)', bytes(0xe0, 0x9f, 0xbf)],
  ['overlong four-byte NUL', bytes(0xf0, 0x80, 0x80, 0x80)],
  ['overlong four-byte (U+FFFF re-encoded)', bytes(0xf0, 0x8f, 0xbf, 0xbf)],
  ['high surrogate U+D800', bytes(0xed, 0xa0, 0x80)],
  ['low surrogate U+DFFF', bytes(0xed, 0xbf, 0xbf)],
  ['CESU-8 surrogate pair', bytes(0xed, 0xa0, 0xbd, 0xed, 0xb8, 0x80)],
  ['above U+10FFFF (F4 90 ...)', bytes(0xf4, 0x90, 0x80, 0x80)],
  ['five-byte lead (F5)', bytes(0xf5, 0x80, 0x80, 0x80)],
  ['FE', bytes(0xfe)],
  ['FF', bytes(0xff)],
  ['truncated two-byte', bytes(0xc3)],
  ['truncated three-byte', bytes(0xe2, 0x98)],
  ['truncated four-byte', bytes(0xf0, 0x9f, 0x8f)],
  ['non-continuation inside two-byte', bytes(0xc3, 0x28)],
  ['non-continuation inside three-byte', bytes(0xe2, 0x28, 0xa1)],
  ['non-continuation inside four-byte', bytes(0xf0, 0x28, 0x8c, 0xbc)],
  ['valid prefix then truncated', bytes(0x41, 0xc3)],
  ['latin1 e-acute on its own (the mojibake false-positive guard)', bytes(0xe9)],
];

describe('decodeUtf8Strict', () => {
  it.each(VALID)('decodes %s', (_label, input, expected) => {
    expect(decodeUtf8Strict(input)).toBe(expected);
  });

  it.each(INVALID)('rejects %s', (_label, input) => {
    expect(decodeUtf8Strict(input)).toBeNull();
  });

  it('never substitutes U+FFFD for invalid input', () => {
    // A lenient decoder answers every one of the INVALID rows with
    // replacement characters, which is exactly the behaviour that would make
    // repairMojibake destructive.
    for (const [, input] of INVALID) {
      expect(decodeUtf8Strict(input)).toBeNull();
    }
  });

  it('decodes a buffer longer than the internal flush block', () => {
    // The decoder flushes code units in blocks of 1024; a buffer that crosses
    // several block boundaries must come back whole and in order.
    const source = 'é☕\u{1f3d6}A'.repeat(1500);
    const encoded = encodeUtf8Strict(source);
    expect(encoded).not.toBeNull();
    expect(decodeUtf8Strict(encoded as Uint8Array)).toBe(source);
  });

  it('round-trips every encodable table row', () => {
    for (const [, , expected] of VALID) {
      const encoded = encodeUtf8Strict(expected);
      expect(encoded).not.toBeNull();
      expect(decodeUtf8Strict(encoded as Uint8Array)).toBe(expected);
    }
  });
});

describe('decodeUtf8Strict parity with TextDecoder({ fatal: true })', () => {
  it.each([...VALID.map((row) => row[1]), ...INVALID.map((row) => row[1])])(
    'agrees on %p',
    (input) => {
      expect(decodeUtf8Strict(input)).toStrictEqual(nodeDecode(input));
    },
  );

  it('agrees over 10,000 seeded buffers', () => {
    // Deterministic: a parity failure is reproducible from the seed, and CI
    // cannot go red on a Tuesday for a buffer nobody can reconstruct.
    let state = 0x9e3779b9;
    const next = (): number => {
      state = (state + 0x6d2b79f5) | 0;
      let t = Math.imul(state ^ (state >>> 15), 1 | state);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const pick = (bound: number): number => Math.floor(next() * bound);

    let accepted = 0;
    let rejected = 0;

    for (let i = 0; i < 10_000; i++) {
      const length = pick(17);
      const buffer = new Uint8Array(length);
      const strategy = pick(4);
      for (let k = 0; k < length; k++) {
        if (strategy === 0) {
          buffer[k] = pick(256); // uniform noise: almost always invalid
        } else if (strategy === 1) {
          buffer[k] = pick(128); // ASCII: almost always valid
        } else if (strategy === 2) {
          // Lead and continuation bytes only, which is where the interesting
          // disagreements (overlong, truncated, surrogate) live.
          buffer[k] = pick(2) === 0 ? 0xc0 + pick(64) : 0x80 + pick(64);
        } else {
          // A valid encoding of a random code point, then one corrupted byte.
          buffer[k] = pick(256);
        }
      }
      if (strategy === 3 && length > 0) {
        const source = String.fromCodePoint(pick(0x110000 - 0x800) + 0x800);
        const valid = encodeUtf8Strict(source);
        if (valid !== null && valid.length <= length) {
          buffer.set(valid, 0);
          if (pick(2) === 0) buffer[pick(valid.length)] ^= 0x40;
        }
      }

      const mine = decodeUtf8Strict(buffer);
      expect(mine).toStrictEqual(nodeDecode(buffer));
      if (mine === null) rejected++;
      else accepted++;
    }

    // Non-vacuity: a decoder that returned null for everything would agree
    // with nothing, but a fuzz corpus that was ALL invalid would still pass
    // the loop above while proving far less than it looks.
    expect(accepted).toBeGreaterThan(100);
    expect(rejected).toBeGreaterThan(100);
  });
});

describe('encodeUtf8Strict', () => {
  it('encodes a string to UTF-8', () => {
    expect(encodeUtf8Strict('Aé\u{1f3d6}')).toEqual(
      bytes(0x41, 0xc3, 0xa9, 0xf0, 0x9f, 0x8f, 0x96),
    );
  });

  it('encodes the empty string to zero bytes, not null', () => {
    const encoded = encodeUtf8Strict('');
    expect(encoded).not.toBeNull();
    expect(encoded).toHaveLength(0);
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['a number', 42],
    ['an object', {}],
    ['an array', []],
    ['a boolean', true],
  ])('refuses %s', (_label, value) => {
    // `new TextEncoder().encode(undefined)` returns the nine bytes of the
    // string "undefined". Every value here arrives from JSON.parse on an
    // attacker-supplied file, so "it is a string" is a runtime fact.
    expect(encodeUtf8Strict(value)).toBeNull();
  });

  it.each([
    ['a lone high surrogate', 'bad \ud800 end'],
    ['a lone low surrogate', 'bad \udc00 end'],
    ['a reversed pair', '\udc00\ud800'],
    ['a trailing high surrogate', 'end \ud83d'],
  ])('refuses %s', (_label, value) => {
    // TextEncoder would substitute U+FFFD, which is lossy, which would make
    // the source_item_id framing non-injective.
    expect(encodeUtf8Strict(value)).toBeNull();
  });

  it('accepts a well-formed surrogate pair', () => {
    expect(encodeUtf8Strict('🏖')).toEqual(bytes(0xf0, 0x9f, 0x8f, 0x96));
  });
});

describe('Hermes has no TextDecoder', () => {
  it('works with globalThis.TextDecoder removed', () => {
    const original = globalThis.TextDecoder;
    Reflect.deleteProperty(globalThis, 'TextDecoder');
    try {
      jest.isolateModules(() => {
        expect(globalThis.TextDecoder).toBeUndefined();
        // `require`, not a static import: an import would be hoisted above
        // the deletion and defeat the guard. Re-required INSIDE the isolated
        // registry, so a module-scope `new TextDecoder()` would throw here
        // rather than having been captured when the suite's static import ran.
        const fresh = require('../utf8') as typeof import('../utf8');
        expect(fresh.decodeUtf8Strict(bytes(0xc3, 0xa9))).toBe('é');
        expect(fresh.decodeUtf8Strict(bytes(0xed, 0xa0, 0x80))).toBeNull();
        expect(fresh.encodeUtf8Strict('é')).toEqual(bytes(0xc3, 0xa9));
      });
    } finally {
      globalThis.TextDecoder = original;
    }
  });
});
