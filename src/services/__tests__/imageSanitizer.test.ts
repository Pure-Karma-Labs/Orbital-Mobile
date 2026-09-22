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
import { buildJpeg, buildPng } from '../testUtils/imageFixtures';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FIXTURE_DIR = path.join(__dirname, 'fixtures');

function loadFixture(name: string): Uint8Array {
  const buf = fs.readFileSync(path.join(FIXTURE_DIR, name));
  return new Uint8Array(buf);
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
