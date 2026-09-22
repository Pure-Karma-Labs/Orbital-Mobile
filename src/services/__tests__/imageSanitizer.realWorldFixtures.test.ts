/**
 * Real-world-shaped image fixtures for imageSanitizer.
 *
 * Exercises the exact pipeline sanitizeStillImage + verifyNoImageMetadata run
 * on-device — stripJpegMetadata(bytes) → hasExif(stripped) — against the file
 * shapes real cameras and pickers actually emit. imageSanitizer.test.ts covers
 * small, programmatically clean synthetic images; this file covers the messy
 * ones, and pins these contracts:
 *
 *   1. Post-EOI trailer truncation (Samsung SEF). Samsung Motion Photos append
 *      a SEF trailer after the JPEG EOI: an embedded MP4 whose thumbnail frames
 *      carry their own Exif APP1 headers, often location-bearing. Copying those
 *      bytes through would preserve exactly the metadata the strip exists to
 *      remove, and would also make the fail-closed verify reject the image. The
 *      output must end at the EOI.
 *
 *   2. No false positive from Exif bytes in entropy-coded scan data. Compressed
 *      scan data is arbitrary bytes, so the "Exif\0\0" pattern can occur there
 *      by coincidence. Detection must be structural (header segments, chunk
 *      payloads, trailers) and must never pattern-scan the compressed stream —
 *      a match there would make verifyNoImageMetadata reject an image that
 *      carries no metadata at all.
 *
 *   3. Progressive multi-scan preservation. A progressive JPEG has several SOS
 *      sections with tables between them, all preceding one closing EOI.
 *      Truncating at the first FFD9-looking byte pair, or at the first scan,
 *      would corrupt the image.
 *
 *   4. Multi-segment headers. Exif APP1 and XMP APP1 are both dropped; an ICC
 *      APP2 color profile is not metadata and is kept.
 *
 *   5. Degraded-boundary fail-closed. When the truncation boundary (JPEG EOI /
 *      PNG IEND) cannot be located, the strip falls back to copying to the end,
 *      so a trailer survives — and detection must still report it. The strip
 *      half and the detect half have to degrade together, or a metadata-bearing
 *      image sails past the verify.
 *
 *   6. PNG chunk-length hardening. A chunk length is a 32-bit big-endian field
 *      read with <<, so a length with the high bit set reads as NEGATIVE and
 *      would walk `pos` backwards — an unbounded loop on a user-picked file.
 *      A positive but over-long length previously made the truncated-chunk
 *      branch copy the remainder twice. Contract: never throw, never loop, emit
 *      the input verbatim, and keep reporting the metadata in that tail.
 *
 * Run: npm test -- imageSanitizer.realWorldFixtures
 */

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
} from '../testUtils/imageFixtures';

describe('imageSanitizer – real-world JPEG fixtures', () => {

  describe('control: baseline JPEG with EXIF APP1', () => {
    it('detects EXIF in original JPEG', () => {
      const jpeg = buildJpeg({ exif: true });
      expect(hasExif(jpeg)).toBe(true);
    });

    it('stripJpegMetadata removes EXIF → hasExif returns false (clean path)', () => {
      const jpeg = buildJpeg({ exif: true });
      const stripped = stripJpegMetadata(jpeg);
      // The existing suite already exercises this; this is the control that
      // must pass so we know the trailer cases below are specifically about
      // the trailer.
      expect(hasExif(stripped)).toBe(false);
    });
  });

  describe('post-EOI trailer truncation (Samsung SEF)', () => {
    it('original JPEG+SEF trailer is detected as containing EXIF', () => {
      const jpeg = buildJpeg({
        exif: true,
        postEoiTrailer: buildSefTrailer(),
      });
      expect(hasExif(jpeg)).toBe(true);
    });

    it('stripJpegMetadata removes the JPEG APP1 segment', () => {
      const jpeg = buildJpeg({
        exif: true,
        postEoiTrailer: buildSefTrailer(),
      });
      const stripped = stripJpegMetadata(jpeg);

      // Structural walk of the stripped header: no APP1 may remain.
      expect(hasHeaderMarker(stripped, 0xFFE1)).toBe(false);
    });

    it('stripJpegMetadata drops the SEF trailer (output truncated at EOI)', () => {
      const trailer = buildSefTrailer();
      const jpeg = buildJpeg({
        exif: true,
        postEoiTrailer: trailer,
      });
      const stripped = stripJpegMetadata(jpeg);

      // The stripped output must be byte-for-byte the same length as a clean
      // JPEG (no trailer) of the same structural shape: the whole trailer is
      // gone, not merely the APP1 segment.
      const cleanJpeg = buildJpeg({ exif: false });
      const cleanStripped = stripJpegMetadata(cleanJpeg);
      expect(stripped.length).toBe(cleanStripped.length);

      // ...and it must still end with the EOI marker.
      expect(stripped[stripped.length - 2]).toBe(0xFF);
      expect(stripped[stripped.length - 1]).toBe(0xD9);
    });

    it('hasExif returns false after strip: the SEF trailer no longer survives', () => {
      const jpeg = buildJpeg({
        exif: true,
        postEoiTrailer: buildSefTrailer(),
      });

      const stripped = stripJpegMetadata(jpeg);

      // This call mirrors what verifyNoImageMetadata does (reads file → hasExif).
      // APP1 dropped and the post-EOI trailer truncated, so the verify passes.
      expect(hasExif(stripped)).toBe(false);
    });

    it('JPEG with no original APP1 but a SEF trailer also verifies clean after strip', () => {
      // A JPEG where the picker's re-encode already dropped the APP1 header
      // (picker re-encoded the file for >2048px resize) but the SEF trailer
      // was preserved byte-for-byte.
      const jpeg = buildJpeg({
        exif: false,                       // no APP1 — picker already dropped it
        postEoiTrailer: buildSefTrailer(), // but trailer is still there
      });

      // The original has no APP1; the trailer supplies the Exif signature.
      expect(hasExif(jpeg)).toBe(true);

      const stripped = stripJpegMetadata(jpeg);

      // Nothing to strip (no APP1), but the trailer is truncated at the EOI.
      expect(hasExif(stripped)).toBe(false);
    });
  });

  describe('no false positive from Exif bytes in entropy-coded scan data', () => {
    const EXIF_BYTES_IN_SCAN: number[] = [
      0xAA, 0xBB,
      0x45, 0x78, 0x69, 0x66, 0x00, 0x00, // "Exif\0\0" embedded inside scan data
      0xCC, 0xDD,
    ];

    it('no false positive: clean JPEG with Exif bytes in entropy-coded scan data', () => {
      const jpeg = buildJpeg({
        exif: false,
        scanData: EXIF_BYTES_IN_SCAN,
      });

      // Structurally this JPEG is clean — it has no APP1 segment. The Exif\0\0
      // bytes sit inside the entropy-coded scan data, which hasExif must not
      // pattern-scan: a match there is a coincidence, not metadata.
      expect(hasExif(jpeg)).toBe(false);

      const stripped = stripJpegMetadata(jpeg);

      // Nothing is stripped (no APP1) and the scan data is copied verbatim, so
      // the stripped bytes are identical to the input — hasExif must agree with
      // itself, and verifyNoImageMetadata must not throw for this image.
      expect(hasExif(stripped)).toBe(false);
    });
  });

  describe('progressive multi-scan preservation', () => {
    it('strips EXIF APP1 from progressive JPEG → hasExif false', () => {
      const jpeg = buildJpeg({
        exif: true,
        progressive: true,
      });
      expect(hasExif(jpeg)).toBe(true);

      const stripped = stripJpegMetadata(jpeg);
      expect(hasExif(stripped)).toBe(false);
    });

    it('keeps every scan of a multi-scan progressive JPEG up to the closing EOI', () => {
      const scan1 = [0x11, 0xFF, 0x00, 0x22, 0xFF, 0xD0, 0x33];
      const scan2 = [0x44, 0x55, 0x66];
      // An AC-luma Huffman table between the two scans. TC=1 distinguishes it
      // from the DC-luma table the builder emits before the first scan, so the
      // search below can only be satisfied by the inter-scan segment.
      const interScanDht = writeSegment([0xFF, 0xC4], [
        0x10,
        0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00,
      ]);

      // scan1 carries a stuffed 0xFF (FF00) and a restart marker (FFD0) --
      // both legal inside an entropy-coded stream and neither an EOI.
      const jpeg = buildJpeg({
        exif: true,
        progressive: true,
        scanData: scan1,
        betweenScans: interScanDht,
        scan2Data: scan2,
        postEoiTrailer: buildSefTrailer(), // Samsung-style trailer past the EOI
      });
      expect(hasExif(jpeg)).toBe(true);

      const stripped = stripJpegMetadata(jpeg);
      expect(hasExif(stripped)).toBe(false);

      // Both scans and the inter-scan DHT survive; only APP1 and the trailer go.
      const bytes = Array.from(stripped);
      expect(indexOfSeq(bytes, scan1)).toBeGreaterThan(-1);
      expect(indexOfSeq(bytes, scan2)).toBeGreaterThan(-1);
      expect(indexOfSeq(bytes, interScanDht)).toBeGreaterThan(-1);

      // Ends exactly at the EOI, trailer removed.
      expect(stripped[stripped.length - 2]).toBe(0xFF);
      expect(stripped[stripped.length - 1]).toBe(0xD9);
    });
  });

  describe('multi-segment header (Exif + XMP + ICC)', () => {
    it('strips both APP1 segments (Exif+XMP), keeps APP2 (ICC) → hasExif false', () => {
      const jpeg = buildJpeg({
        exif: true,
        xmp: true,
        icc: true,
      });
      expect(hasExif(jpeg)).toBe(true);

      const stripped = stripJpegMetadata(jpeg);
      expect(hasExif(stripped)).toBe(false);

      // The ICC profile is a rendering instruction, not metadata: it stays.
      expect(hasHeaderMarker(stripped, 0xFFE2)).toBe(true);
    });
  });

  describe('PNG with eXIf chunk + post-IEND Exif bytes', () => {
    it('strips eXIf chunk from clean PNG correctly (no trailer)', () => {
      const png = buildPng({ exif: true });
      expect(hasExif(png)).toBe(true);
      const stripped = stripPngMetadata(png);
      expect(hasExif(stripped)).toBe(false);
    });

    it('post-IEND Exif\\0\\0 bytes are dropped by stripPngMetadata', () => {
      const postIendTrailer = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00, 0xDE, 0xAD];
      const png = buildPng({ exif: true, tail: postIendTrailer });
      expect(hasExif(png)).toBe(true);

      const stripped = stripPngMetadata(png);
      // The eXIf chunk is stripped AND the post-IEND trailer is truncated
      // (same EOI/IEND boundary rule as the JPEG stripper), so nothing is left
      // for hasExif to find.
      expect(hasExif(stripped)).toBe(false);
    });
  });

  describe('PNG with a nonsense chunk length', () => {
    /** PNG whose third chunk declares `declaredLength` but carries no data. */
    function buildPngWithBogusChunkLength(declaredLength: number): Uint8Array {
      return buildPng({
        omitIend: true,
        afterIdat: writeChunk('bOgU', [], declaredLength),
        // A tail long enough (>= 12 bytes) that the chunk loop would keep going.
        tail: [0x45, 0x78, 0x69, 0x66, 0x00, 0x00, 0xDE, 0xAD, 0xBE, 0xEF, 0x00, 0x01],
      });
    }

    it.each([
      ['high bit set (negative when read with <<)', 0x80000000],
      ['all bits set', 0xFFFFFFFF],
      ['positive but past the end of the buffer', 0x1000],
    ])('copies through and terminates: %s', (_label, declaredLength) => {
      const png = buildPngWithBogusChunkLength(declaredLength);
      expect(hasExif(png)).toBe(true);

      const stripped = stripPngMetadata(png);

      // Byte-identical copy-through: nothing dropped, nothing duplicated.
      expect(Array.from(stripped)).toEqual(Array.from(png));
      // The structure was never trustworthy, so the detect half stays hot.
      expect(hasExif(stripped)).toBe(true);
    });
  });

  describe('degraded-boundary fail-closed', () => {
    it('JPEG with no findable EOI: trailer survives the strip and hasExif still reports it', () => {
      // Structurally valid header and SOS, entropy data that never reaches an
      // EOI, then a metadata-bearing trailer.
      const jpeg = buildJpeg({
        scanData: [0x11, 0x22, 0x33],
        omitEoi: true,
        postEoiTrailer: [
          0x53, 0x45, 0x46, 0x48,             // "SEFH"
          0x45, 0x78, 0x69, 0x66, 0x00, 0x00, // "Exif\0\0" in the trailer
          0xDE, 0xAD,
        ],
      });

      expect(hasExif(jpeg)).toBe(true);

      const stripped = stripJpegMetadata(jpeg);
      // No EOI to truncate at, so the copy-to-end fallback keeps the trailer
      // (there is no APP1 here, so nothing else changes the length)...
      expect(stripped.length).toBe(jpeg.length);
      // ...and hasExif must still see it. Returning false here would let
      // verifyNoImageMetadata pass an image that still carries metadata.
      expect(hasExif(stripped)).toBe(true);
    });

    it('JPEG padded with 0xFF fill before the EOI still truncates at the real EOI', () => {
      // An odd number of 0xFF bytes runs up to the marker: ... AA BB FF | FF D9.
      // Treating the fill byte as a two-byte token would step over the D9 and
      // lose the EOI entirely.
      const jpeg = buildJpeg({
        exif: true,
        scanData: [0xAA, 0xBB, 0xFF],
        postEoiTrailer: buildSefTrailer(),
      });
      expect(hasExif(jpeg)).toBe(true);

      const stripped = stripJpegMetadata(jpeg);
      expect(hasExif(stripped)).toBe(false);

      // Fill byte preserved, trailer gone, output ends at the real EOI.
      expect(Array.from(stripped.slice(-5))).toEqual([0xAA, 0xBB, 0xFF, 0xFF, 0xD9]);
    });

    it('PNG that never reaches IEND: tail survives the strip and hasExif still reports it', () => {
      // Truncated tail: shorter than a chunk header, so the walk stops there
      // without ever seeing IEND. Six of these eight bytes are an Exif\0\0.
      const png = buildPng({
        omitIend: true,
        tail: [0x45, 0x78, 0x69, 0x66, 0x00, 0x00, 0xDE, 0xAD],
      });
      expect(hasExif(png)).toBe(true);

      const stripped = stripPngMetadata(png);
      expect(stripped.length).toBe(png.length); // tail copied through
      expect(hasExif(stripped)).toBe(true);     // so it must still be detected
    });
  });
});
