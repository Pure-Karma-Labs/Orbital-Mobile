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

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FIXTURE_DIR = path.join(__dirname, 'fixtures');

function loadFixture(name: string): Uint8Array {
  const buf = fs.readFileSync(path.join(FIXTURE_DIR, name));
  return new Uint8Array(buf);
}

/**
 * Build a minimal valid JPEG with optional APP1 (Exif) and APP13 (IPTC) segments.
 */
function buildJpeg(opts?: {
  exif?: boolean;
  xmp?: boolean;
  iptc?: boolean;
  multiApp1?: boolean;
}): Uint8Array {
  const parts: number[] = [];

  // SOI
  parts.push(0xFF, 0xD8);

  // APP0 (JFIF) -- should be kept
  const jfifData = [0x4A, 0x46, 0x49, 0x46, 0x00]; // "JFIF\0"
  const jfifLen = jfifData.length + 2;
  parts.push(0xFF, 0xE0, (jfifLen >> 8) & 0xFF, jfifLen & 0xFF, ...jfifData);

  // APP1 with XMP (if requested) -- should be dropped
  if (opts?.xmp || opts?.multiApp1) {
    const xmpSig = Array.from(new TextEncoder().encode('http://ns.adobe.com/xap/1.0/\0<x:xmpmeta/>'));
    const xmpLen = xmpSig.length + 2;
    parts.push(0xFF, 0xE1, (xmpLen >> 8) & 0xFF, xmpLen & 0xFF, ...xmpSig);
  }

  // APP1 with Exif (if requested) -- should be dropped
  if (opts?.exif || opts?.multiApp1) {
    const exifSig = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00]; // "Exif\0\0"
    // Add some GPS IFD data
    const gpsData = [0x00, 0x08, 0x00, 0x04, 0x88, 0x25, 0x00, 0x00];
    const exifPayload = [...exifSig, ...gpsData];
    const exifLen = exifPayload.length + 2;
    parts.push(0xFF, 0xE1, (exifLen >> 8) & 0xFF, exifLen & 0xFF, ...exifPayload);
  }

  // APP13 (IPTC) -- should be dropped
  if (opts?.iptc) {
    const iptcData = [0x50, 0x68, 0x6F, 0x74, 0x6F]; // "Photo"
    const iptcLen = iptcData.length + 2;
    parts.push(0xFF, 0xED, (iptcLen >> 8) & 0xFF, iptcLen & 0xFF, ...iptcData);
  }

  // SOF0 (Start of Frame) -- should be kept
  const sofData = [0x08, 0x00, 0x10, 0x00, 0x10, 0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01];
  const sofLen = sofData.length + 2;
  parts.push(0xFF, 0xC0, (sofLen >> 8) & 0xFF, sofLen & 0xFF, ...sofData);

  // SOS (Start of Scan) -- should be kept with all following data
  const sosData = [0x03, 0x01, 0x00, 0x02, 0x11, 0x03, 0x11, 0x00, 0x3F, 0x00];
  const sosLen = sosData.length + 2;
  parts.push(0xFF, 0xDA, (sosLen >> 8) & 0xFF, sosLen & 0xFF, ...sosData);

  // Scan data (entropy coded)
  const scanData = [0xAA, 0xBB, 0xCC, 0xDD, 0xEE];
  parts.push(...scanData);

  // EOI
  parts.push(0xFF, 0xD9);

  return new Uint8Array(parts);
}

/**
 * Build a minimal valid PNG with optional metadata chunks.
 */
function buildPng(opts?: {
  exif?: boolean;
  text?: boolean;
  time?: boolean;
}): Uint8Array {
  const parts: number[] = [];

  // PNG signature
  parts.push(137, 80, 78, 71, 13, 10, 26, 10);

  function writeChunk(type: string, data: number[]) {
    const len = data.length;
    parts.push((len >> 24) & 0xFF, (len >> 16) & 0xFF, (len >> 8) & 0xFF, len & 0xFF);
    const typeBytes = Array.from(new TextEncoder().encode(type));
    parts.push(...typeBytes);
    parts.push(...data);
    // CRC (placeholder -- not validated by our stripper)
    parts.push(0, 0, 0, 0);
  }

  // IHDR (required)
  writeChunk('IHDR', [
    0, 0, 0, 16, // width
    0, 0, 0, 16, // height
    8, // bit depth
    2, // color type (RGB)
    0, // compression
    0, // filter
    0, // interlace
  ]);

  // eXIf chunk (if requested) -- should be stripped
  if (opts?.exif) {
    const exifData = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00, 0x4D, 0x4D]; // "Exif\0\0MM"
    writeChunk('eXIf', exifData);
  }

  // tEXt chunk (if requested) -- should be stripped
  if (opts?.text) {
    const textData = Array.from(new TextEncoder().encode('Comment\0Test text'));
    writeChunk('tEXt', textData);
  }

  // tIME chunk (if requested) -- should be stripped
  if (opts?.time) {
    writeChunk('tIME', [0x07, 0xEA, 0x07, 0x11, 0x0A, 0x1E, 0x00]);
  }

  // IDAT (required, minimal)
  writeChunk('IDAT', [0x08, 0x99, 0x01, 0x00]);

  // IEND (required)
  writeChunk('IEND', []);

  return new Uint8Array(parts);
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
      const input = buildJpeg({ exif: true });
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

    it('handles multi-APP1 JPEG (XMP first, then Exif)', () => {
      const input = buildJpeg({ multiApp1: true });
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
