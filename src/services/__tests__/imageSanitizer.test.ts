/**
 * Tests for imageSanitizer -- EXIF/GPS metadata stripping for still images.
 *
 * Uses the pure byte-level cores (stripJpegMetadata, stripPngMetadata, hasExif)
 * directly for fixture-based testing without RNFS dependencies.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  stripJpegMetadata,
  stripPngMetadata,
  hasExif,
} from '../media/imageSanitizer';
import {
  buildJpeg,
  buildPng,
  buildSefTrailer,
  writeChunk,
  writeSegment,
  indexOfSeq,
  hasHeaderMarker,
  EXIF_SIGNATURE,
  EXIF_TRAILER_BARE,
  MPF_SIGNATURE,
  MPF_HEADER,
} from '../testUtils/imageFixtures';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FIXTURE_DIR = path.join(__dirname, 'fixtures');

function loadFixture(name: string): Uint8Array {
  const buf = fs.readFileSync(path.join(FIXTURE_DIR, name));
  return new Uint8Array(buf);
}

/**
 * Splice a hand-built segment into the header of a fixture, immediately after
 * the SOI -- for header shapes the builder has no option for (an APP2 whose
 * payload is neither a plain ICC profile nor a plain MPF index).
 */
function withHeaderSegment(jpeg: Uint8Array, segment: number[]): Uint8Array {
  return new Uint8Array([...jpeg.slice(0, 2), ...segment, ...jpeg.slice(2)]);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('imageSanitizer', () => {
  describe('stripJpegMetadata', () => {
    it('strips APP1 (Exif) from JPEG', () => {
      const input = buildJpeg({ exif: true });
      expect(hasExif(input)).toBe(true);

      const output = stripJpegMetadata(input);
      expect(hasExif(output)).toBe(false);
      // Output should be smaller (Exif segment removed)
      expect(output.length).toBeLessThan(input.length);
    });

    it('strips a COM comment segment from the header', () => {
      const input = buildJpeg({ com: true });
      const output = stripJpegMetadata(input);

      // COM is textual metadata by definition, so it joins APP1/APP13 in the
      // drop set. Keeping it would also make a COM-borne signature permanently
      // unpostable: the detect half would flag it and the strip could not
      // remove it.
      let hasCom = false;
      for (let i = 0; i < output.length - 1; i++) {
        if (output[i] === 0xFF && output[i + 1] === 0xFE) {
          hasCom = true;
          break;
        }
      }
      expect(hasCom).toBe(false);
      expect(output.length).toBeLessThan(input.length);
    });

    it('strips APP13 (IPTC) from JPEG', () => {
      const input = buildJpeg({ iptc: true });
      const output = stripJpegMetadata(input);
      // Should not contain APP13 marker
      let hasApp13 = false;
      for (let i = 0; i < output.length - 1; i++) {
        if (output[i] === 0xFF && output[i + 1] === 0xED) {
          hasApp13 = true;
          break;
        }
      }
      expect(hasApp13).toBe(false);
    });

    it('preserves APP0 (JFIF) and SOF/SOS data', () => {
      // scanData is pinned explicitly: the tail assertion below compares the
      // last seven output bytes, so the entropy bytes must be exactly these.
      const input = buildJpeg({ exif: true, scanData: [0xAA, 0xBB, 0xCC, 0xDD, 0xEE] });
      const output = stripJpegMetadata(input);

      // Should still start with SOI
      expect(output[0]).toBe(0xFF);
      expect(output[1]).toBe(0xD8);

      // Should contain APP0 (JFIF)
      let hasApp0 = false;
      for (let i = 0; i < output.length - 1; i++) {
        if (output[i] === 0xFF && output[i + 1] === 0xE0) {
          hasApp0 = true;
          break;
        }
      }
      expect(hasApp0).toBe(true);

      // Scan data should be preserved byte-identical
      const scanData = [0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0xFF, 0xD9];
      const outputEnd = Array.from(output.slice(-7));
      expect(outputEnd).toEqual(scanData);
    });

    it('handles multi-APP1 JPEG (Exif and XMP)', () => {
      const input = buildJpeg({ exif: true, xmp: true });
      expect(hasExif(input)).toBe(true);

      const output = stripJpegMetadata(input);
      expect(hasExif(output)).toBe(false);
    });

    it.each([
      ['before the ICC APP2', 'before-icc' as const],
      ['after the ICC APP2', 'after-icc' as const],
    ])('drops the APP2 MPF index and keeps the ICC APP2: MPF %s', (_label, order) => {
      const input = buildJpeg({ icc: true, mpf: order });
      expect(indexOfSeq(Array.from(input), MPF_SIGNATURE)).toBeGreaterThan(-1);

      const output = stripJpegMetadata(input);

      // The MPF index only ever describes images at or past the primary EOI,
      // which the strip truncates -- leaving it behind would point a decoder
      // past the end of the file and keep the device-written bytes of the MP
      // Index IFD along with it.
      expect(indexOfSeq(Array.from(output), MPF_SIGNATURE)).toBe(-1);
      // Exactly that segment is gone: marker + length field + payload.
      expect(output.length).toBe(
        input.length - (4 + MPF_SIGNATURE.length + MPF_HEADER.length),
      );
      // ...and the ICC APP2 it shares a marker with survives, either order.
      expect(hasHeaderMarker(output, 0xFFE2)).toBe(true);
    });

    it.each([
      ['a payload too short to hold the signature', [0x4D, 0x50]],
      ['a four-byte signature that merely starts "MP"', [0x4D, 0x50, 0x00, 0x01, 0xDE, 0xAD]],
    ])('keeps an APP2 that is not an MPF index: %s', (_label, payload) => {
      const segment = writeSegment([0xFF, 0xE2], payload);
      const input = withHeaderSegment(buildJpeg(), segment);

      const output = stripJpegMetadata(input);

      // Only the exact "MPF\0" signature, bounded by the declared segment end,
      // selects the drop -- an unknown APP2 is left alone.
      expect(Array.from(output)).toEqual(Array.from(input));
      expect(indexOfSeq(Array.from(output), segment)).toBeGreaterThan(-1);
    });

    it('leaves the detect half silent about MPF (strip-only, by design)', () => {
      // The direction rule: the strip may remove more than the detect flags,
      // never the reverse. Every MPF image carries an APP2 MPF, so flagging it
      // would be an unclearable rejection on the copy-through path.
      const input = buildJpeg({ mpf: 'before-icc' });
      expect(hasExif(input)).toBe(false);
      expect(hasExif(stripJpegMetadata(input))).toBe(false);
    });

    it('is idempotent on clean input', () => {
      const clean = buildJpeg(); // No exif, no iptc
      expect(hasExif(clean)).toBe(false);

      const output = stripJpegMetadata(clean);
      // Should be identical
      expect(output.length).toBe(clean.length);
      expect(hasExif(output)).toBe(false);
    });

    it('throws on truncated input', () => {
      expect(() => stripJpegMetadata(new Uint8Array([0xFF]))).toThrow();
    });

    it('throws on non-JPEG input', () => {
      expect(() => stripJpegMetadata(new Uint8Array([0x89, 0x50, 0x4E, 0x47]))).toThrow('Not a valid JPEG');
    });
  });

  describe('stripPngMetadata', () => {
    it('strips eXIf chunk from PNG', () => {
      const input = buildPng({ exif: true });
      expect(hasExif(input)).toBe(true);

      const output = stripPngMetadata(input);
      expect(hasExif(output)).toBe(false);
      expect(output.length).toBeLessThan(input.length);
    });

    it('strips tEXt and tIME chunks from PNG', () => {
      const input = buildPng({ text: true, time: true });
      const output = stripPngMetadata(input);
      expect(output.length).toBeLessThan(input.length);

      // Verify no tEXt or tIME chunks remain
      const outputStr = String.fromCharCode(...Array.from(output));
      expect(outputStr.includes('tEXt')).toBe(false);
      expect(outputStr.includes('tIME')).toBe(false);
    });

    it('preserves IHDR and IDAT chunks', () => {
      const input = buildPng({ exif: true, text: true });
      const output = stripPngMetadata(input);

      const outputStr = String.fromCharCode(...Array.from(output));
      expect(outputStr.includes('IHDR')).toBe(true);
      expect(outputStr.includes('IDAT')).toBe(true);
      expect(outputStr.includes('IEND')).toBe(true);
    });

    it('is idempotent on clean input', () => {
      const clean = buildPng();
      const output = stripPngMetadata(clean);
      expect(output.length).toBe(clean.length);
    });

    it('throws on non-PNG input', () => {
      expect(() => stripPngMetadata(new Uint8Array([0xFF, 0xD8]))).toThrow('valid PNG');
    });
  });

  describe('hasExif', () => {
    it('detects Exif in JPEG', () => {
      const jpeg = buildJpeg({ exif: true });
      expect(hasExif(jpeg)).toBe(true);
    });

    it('detects XMP in JPEG', () => {
      const jpeg = buildJpeg({ xmp: true });
      expect(hasExif(jpeg)).toBe(true);
    });

    it('detects eXIf in PNG', () => {
      const png = buildPng({ exif: true });
      expect(hasExif(png)).toBe(true);
    });

    it('returns false for clean JPEG', () => {
      const jpeg = buildJpeg();
      expect(hasExif(jpeg)).toBe(false);
    });

    it('returns false for clean PNG', () => {
      const png = buildPng();
      expect(hasExif(png)).toBe(false);
    });

    it('returns false for tiny input', () => {
      expect(hasExif(new Uint8Array([]))).toBe(false);
      expect(hasExif(new Uint8Array([0]))).toBe(false);
    });

    it('detects a header APP13 (IPTC) segment', () => {
      // The payload carries no Exif or XMP signature, so only the marker walk
      // can see it -- a raw pattern scan of the header region cannot.
      expect(hasExif(buildJpeg({ iptc: true }))).toBe(true);
    });

    it('detects a header COM segment', () => {
      expect(hasExif(buildJpeg({ com: true }))).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // The strip and the detect walk the header region with two separate loops.
  // This block pins them together: for every fixture the builders can produce,
  // stripping then detecting must agree. The degraded fixtures are listed with
  // an explicit `true` -- when the strip cannot find its boundary the trailer
  // survives, and the detect has to keep reporting it.
  // -------------------------------------------------------------------------
  describe('strip and detect agreement', () => {
    it.each([
      ['clean baseline', () => buildJpeg(), false],
      ['Exif APP1', () => buildJpeg({ exif: true }), false],
      ['XMP APP1', () => buildJpeg({ xmp: true }), false],
      ['APP13 IPTC', () => buildJpeg({ iptc: true }), false],
      ['COM comment', () => buildJpeg({ com: true }), false],
      ['every droppable segment at once', () => buildJpeg({ exif: true, xmp: true, iptc: true, com: true }), false],
      ['ICC APP2 (kept, not metadata)', () => buildJpeg({ icc: true }), false],
      ['MPF APP2 (dropped by the strip, never flagged)', () => buildJpeg({ icc: true, mpf: 'after-icc' }), false],
      [
        // A header APP2 carrying an Exif signature is today an unclearable
        // rejection when its payload is an ICC profile: the strip keeps the
        // segment and the detect's header scan sees the signature. An MPF one
        // clears, because the strip removes the whole segment. The ICC twin
        // stays accepted residue -- narrowing it is not this change.
        'MPF APP2 carrying an Exif signature',
        () => withHeaderSegment(
          buildJpeg(),
          writeSegment([0xFF, 0xE2], [...MPF_SIGNATURE, ...MPF_HEADER, ...EXIF_SIGNATURE]),
        ),
        false,
      ],
      ['progressive with Exif', () => buildJpeg({ exif: true, progressive: true }), false],
      ['post-EOI SEF trailer', () => buildJpeg({ exif: true, postEoiTrailer: buildSefTrailer() }), false],
      [
        // An APP2 between scans is already non-conforming, and the strip can
        // only agree with the detect by removing it -- keeping it while
        // flagging its payload would make this photo permanently unpostable.
        'inter-scan APP2 carrying an Exif signature',
        () => buildJpeg({
          betweenScans: writeSegment([0xFF, 0xE2], [...EXIF_SIGNATURE, 0x4D, 0x4D]),
          scan2Data: [0x44, 0x55],
        }),
        false,
      ],
      [
        'inter-scan APP14 (kept) with a clean payload',
        () => buildJpeg({
          betweenScans: writeSegment([0xFF, 0xEE], [
            0x41, 0x64, 0x6F, 0x62, 0x65, 0x00, 0x64, 0x00, 0x00, 0x00, 0x00, 0x01, // "Adobe"
          ]),
          scan2Data: [0x44, 0x55],
        }),
        false,
      ],
      ['degraded: no findable EOI', () => buildJpeg({ omitEoi: true, postEoiTrailer: EXIF_TRAILER_BARE }), true],
    ])('JPEG %s', (_label, build, expected) => {
      expect(hasExif(stripJpegMetadata(build()))).toBe(expected);
    });

    it.each([
      ['clean baseline', () => buildPng(), false],
      ['eXIf chunk', () => buildPng({ exif: true }), false],
      ['tEXt chunk', () => buildPng({ text: true }), false],
      ['tIME chunk', () => buildPng({ time: true }), false],
      ['every droppable chunk at once', () => buildPng({ exif: true, text: true, time: true }), false],
      ['post-IEND trailer', () => buildPng({ tail: EXIF_TRAILER_BARE }), false],
      ['degraded: no IEND', () => buildPng({ omitIend: true, tail: EXIF_TRAILER_BARE }), true],
      [
        'degraded: nonsense chunk length',
        () => buildPng({
          omitIend: true,
          afterIdat: writeChunk('bOgU', [], 0x80000000),
          tail: EXIF_TRAILER_BARE,
        }),
        true,
      ],
    ])('PNG %s', (_label, build, expected) => {
      expect(hasExif(stripPngMetadata(build()))).toBe(expected);
    });
  });

  describe('real fixture: gps-small.jpg', () => {
    it('has Exif metadata in original', () => {
      const data = loadFixture('gps-small.jpg');
      expect(hasExif(data)).toBe(true);
    });

    it('strips Exif from fixture', () => {
      const data = loadFixture('gps-small.jpg');
      const stripped = stripJpegMetadata(data);
      expect(hasExif(stripped)).toBe(false);
      // Output should differ from input (not byte-identical)
      expect(stripped.length).not.toBe(data.length);
    });

    it('preserves SOF dimensions and SOS scan data', () => {
      const data = loadFixture('gps-small.jpg');
      const stripped = stripJpegMetadata(data);

      // Both should start with SOI and end with EOI
      expect(stripped[0]).toBe(0xFF);
      expect(stripped[1]).toBe(0xD8);
      expect(stripped[stripped.length - 2]).toBe(0xFF);
      expect(stripped[stripped.length - 1]).toBe(0xD9);

      // Find SOF0 in both and compare dimensions
      function findSOF(buf: Uint8Array): { w: number; h: number } | null {
        for (let i = 0; i < buf.length - 8; i++) {
          if (buf[i] === 0xFF && (buf[i + 1] === 0xC0 || buf[i + 1] === 0xC2)) {
            const h = (buf[i + 5] << 8) | buf[i + 6];
            const w = (buf[i + 7] << 8) | buf[i + 8];
            return { w, h };
          }
        }
        return null;
      }

      const origDims = findSOF(data);
      const strippedDims = findSOF(stripped);
      expect(origDims).not.toBeNull();
      expect(strippedDims).toEqual(origDims);
    });
  });
});
