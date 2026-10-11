/**
 * Tests for content-type normalization and the byte-level sniff (#880).
 *
 * Every fixture is built BY HAND here rather than imported from
 * `testUtils/imageFixtures.ts`: this module takes raw bytes and nothing else,
 * so the headers — including the ones that are deliberately malformed or cut
 * short — are the subject of the test, not a detail of a shared builder.
 *
 * The sniff is ADVISORY: `null` means "nothing recognized" and every caller
 * falls back to the declared type. So each null row below is a statement that a
 * format is NOT claimed, never that a file is rejected.
 */

import {
  CONTENT_TYPE_ALIASES,
  SNIFF_HEAD_BYTES,
  normalizeContentType,
  sniffContentType,
} from '../contentType';
import { resolveExportRoute } from '../exportFileName';

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

function bytes(...values: number[]): Uint8Array {
  return new Uint8Array(values);
}

function asciiBytes(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) {
    out[i] = text.charCodeAt(i);
  }
  return out;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** Big-endian u32, the width of an ISO-BMFF box size. */
function u32be(value: number): Uint8Array {
  return bytes((value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff);
}

interface FtypOptions {
  major: string;
  compatible?: string[];
  /**
   * The size written into the box header. Defaults to the real byte length;
   * passing a LARGER value is how the truncation rows describe a box whose tail
   * was not in the bytes we read.
   */
  size?: number;
}

/**
 * An ISO-BMFF `ftyp` box: size u32 at 0, `'ftyp'` at 4, major brand at 8,
 * minor version at 12, compatible brands from 16 on.
 */
function ftyp({ major, compatible = [], size }: FtypOptions): Uint8Array {
  const brands = [major, ...compatible];
  for (const brand of brands) {
    if (brand.length !== 4) {
      throw new Error(`ftyp: brand ${JSON.stringify(brand)} is not 4 characters`);
    }
  }
  const body = concat(
    asciiBytes('ftyp'),
    asciiBytes(major),
    bytes(0, 0, 0, 0), // minor version
    asciiBytes(compatible.join('')),
  );
  return concat(u32be(size ?? body.length + 4), body);
}

/** Pad a header out to `length` with zeros, the way real file bytes would. */
function padTo(head: Uint8Array, length: number): Uint8Array {
  const out = new Uint8Array(length);
  out.set(head.subarray(0, length), 0);
  return out;
}

// ---------------------------------------------------------------------------
// sniffContentType
// ---------------------------------------------------------------------------

type PositiveCase = [label: string, head: Uint8Array, expected: string];

const POSITIVES: PositiveCase[] = [
  [
    'JPEG SOI plus the next segment marker',
    bytes(0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10),
    'image/jpeg',
  ],
  ['the 8-byte PNG signature', bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a), 'image/png'],
  ['GIF87a', asciiBytes('GIF87a'), 'image/gif'],
  ['GIF89a', asciiBytes('GIF89a'), 'image/gif'],
  ['RIFF + size + WEBP', concat(asciiBytes('RIFF'), u32be(1024), asciiBytes('WEBP')), 'image/webp'],
  ['ftyp major brand heic', ftyp({ major: 'heic' }), 'image/heic'],
  ['ftyp major brand heix', ftyp({ major: 'heix' }), 'image/heic'],
  ['ftyp major brand hevc', ftyp({ major: 'hevc' }), 'image/heic'],
  ['ftyp major brand avif', ftyp({ major: 'avif' }), 'image/avif'],
  ['ftyp major brand "qt  "', ftyp({ major: 'qt  ' }), 'video/quicktime'],
  ['ftyp major brand "M4V "', ftyp({ major: 'M4V ' }), 'video/x-m4v'],
  ['ftyp major brand isom', ftyp({ major: 'isom' }), 'video/mp4'],
  ['ftyp major brand mp42', ftyp({ major: 'mp42' }), 'video/mp4'],
  [
    'mif1 settled by a compatible heic brand',
    ftyp({ major: 'mif1', compatible: ['mp41', 'heic'] }),
    'image/heic',
  ],
  [
    'mif1 settled by a compatible avif brand',
    ftyp({ major: 'mif1', compatible: ['mp41', 'avif'] }),
    'image/avif',
  ],
  [
    'mif1 with no decisive brand but the whole box in the head',
    ftyp({ major: 'mif1', compatible: ['mp41'] }),
    'image/heif',
  ],
];

type NullCase = [label: string, head: Uint8Array];

const NULLS: NullCase[] = [
  ['an empty read', new Uint8Array(0)],
  ['a single byte', bytes(0xff)],
  // FF D8 alone is two bytes of anything; the third byte is load-bearing.
  ['FF D8 with no third byte', bytes(0xff, 0xd8)],
  ['a PNG signature with one byte altered', bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0b)],
  ['GIF88a', asciiBytes('GIF88a')],
  ['RIFF + size + WAVE', concat(asciiBytes('RIFF'), u32be(1024), asciiBytes('WAVE'))],
  // 3gp*/3g2* are deliberately unmapped: Android recorders write a 3gp4 major
  // brand into ordinary MP4s, so claiming video/3gpp would move a working video
  // to the document route.
  ['ftyp major brand 3gp4', ftyp({ major: '3gp4' })],
  ['ftyp major brand 3g2a', ftyp({ major: '3g2a' })],
  ['ftyp major brand "M4A "', ftyp({ major: 'M4A ' })],
  ['ftyp major brand "crx "', ftyp({ major: 'crx ' })],
  // A size under 16 leaves no room for size + 'ftyp' + major + minor version,
  // which also covers size 1 (the 64-bit largesize form) and size 0 ("to EOF").
  ['a declared box size of 0', ftyp({ major: 'heic', size: 0 })],
  ['a declared box size of 1', ftyp({ major: 'heic', size: 1 })],
  ['a declared box size of 8', ftyp({ major: 'heic', size: 8 })],
  ['ftyp at offset 0 instead of 4', padTo(asciiBytes('ftypheic'), 16)],
  ['a PDF', asciiBytes('%PDF-1.7')],
  ['an SVG', asciiBytes('<svg xmlns=')],
  ['an HTML page', asciiBytes('<html>')],
];

describe('sniffContentType — recognized formats', () => {
  it.each(POSITIVES)('identifies %s as %s', (_label, head, expected) => {
    expect(sniffContentType(head)).toBe(expected);
  });
});

describe('sniffContentType — nothing claimed', () => {
  it.each(NULLS)('returns null for %s', (_label, head) => {
    expect(sniffContentType(head)).toBeNull();
  });
});

describe('sniffContentType — short and truncated heads', () => {
  it('still identifies a JPEG from 12 bytes', () => {
    expect(sniffContentType(padTo(bytes(0xff, 0xd8, 0xff, 0xe0), 12))).toBe('image/jpeg');
  });

  it('returns null for a 4-byte head', () => {
    // The first half of the PNG signature: every signature checks its own
    // length first, so a short read is simply unrecognized.
    expect(sniffContentType(bytes(0x89, 0x50, 0x4e, 0x47))).toBeNull();
  });

  it('refuses to guess image/heif when the box ran past the head', () => {
    // The declared size (200) exceeds the bytes supplied and none of the
    // compatible brands we DID read is decisive — so the brand that would have
    // settled it may simply be past the end of the head. Claiming HEIF here
    // would be a guess; null leaves the declared type in place.
    const head = ftyp({ major: 'mif1', compatible: ['mp41', 'iso2'], size: 200 });
    expect(head.length).toBeLessThan(200);
    expect(sniffContentType(head)).toBeNull();
  });

  it('finds a decisive compatible brand past byte 64', () => {
    // Real encoders push the brand that decides AVIF vs HEIC well past the 16
    // bytes the signature itself needs — which is why SNIFF_HEAD_BYTES is 128
    // and not 16. This fixture puts `heic` at offset 80.
    const filler = new Array<string>(16).fill('mp41');
    const head = ftyp({ major: 'mif1', compatible: [...filler, 'heic'] });
    expect(head.length).toBe(84);
    expect(head.subarray(80, 84)).toEqual(asciiBytes('heic'));
    expect(sniffContentType(head)).toBe('image/heic');
  });
});

describe('sniffContentType — only ever names a saveable type', () => {
  const SNIFFED_TYPES = Array.from(new Set(POSITIVES.map(([, , expected]) => expected)));

  it('covers every positive expectation', () => {
    expect(SNIFFED_TYPES.length).toBeGreaterThan(0);
  });

  it.each(SNIFFED_TYPES)('%s is accepted by the export allowlist', (contentType) => {
    // The sniff corrects a LABEL; it must never produce a type that
    // `reconcileExportLabel` would then have to refuse.
    expect(resolveExportRoute(contentType).kind).not.toBe('refused');
  });
});

describe('SNIFF_HEAD_BYTES', () => {
  it('is 128', () => {
    expect(SNIFF_HEAD_BYTES).toBe(128);
  });

  it('is enough for every fixture in this suite', () => {
    for (const [, head] of [...POSITIVES, ...NULLS]) {
      expect(head.length).toBeLessThanOrEqual(SNIFF_HEAD_BYTES);
    }
  });
});

// ---------------------------------------------------------------------------
// normalizeContentType
// ---------------------------------------------------------------------------

describe('normalizeContentType', () => {
  it.each([
    ['lower-cases', 'IMAGE/PNG', 'image/png'],
    ['drops parameters', 'image/png; q=1', 'image/png'],
    ['drops a charset parameter', 'text/plain;charset=utf-8', 'text/plain'],
    ['trims surrounding space', '  image/png  ', 'image/png'],
    ['aliases image/jpg to image/jpeg', 'image/jpg', 'image/jpeg'],
    ['aliases through case and parameters', 'IMAGE/JPG; q=1', 'image/jpeg'],
    ['leaves the canonical spelling alone', 'image/jpeg', 'image/jpeg'],
  ])('%s', (_label, input, expected) => {
    expect(normalizeContentType(input)).toBe(expected);
  });

  it('returns the empty string for null, undefined and a non-string', () => {
    expect(normalizeContentType(null)).toBe('');
    expect(normalizeContentType(undefined)).toBe('');
    // A wire value is whatever the server sent; the runtime guard is the point,
    // so call past the declared signature rather than trusting it.
    const unchecked = normalizeContentType as (value: unknown) => string;
    expect(unchecked(42)).toBe('');
    expect(unchecked({})).toBe('');
  });

  it('does not resolve prototype-chain property names', () => {
    // `in` would have resolved these against Object.prototype; the alias map is
    // read with hasOwnProperty for exactly this reason.
    expect(normalizeContentType('constructor')).toBe('constructor');
    // Lower-cased like any other type, but still just the string back.
    expect(normalizeContentType('toString')).toBe('tostring');
    expect(normalizeContentType('__proto__')).toBe('__proto__');
    expect(typeof normalizeContentType('constructor')).toBe('string');
  });

  it.each(Object.entries(CONTENT_TYPE_ALIASES))('maps the %s alias onto %s', (alias, canonical) => {
    expect(normalizeContentType(alias)).toBe(canonical);
    // An alias that is not itself on an allowlist would admit a spelling the
    // export then refuses.
    expect(resolveExportRoute(canonical).kind).not.toBe('refused');
  });
});
