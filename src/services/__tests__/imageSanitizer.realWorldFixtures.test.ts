/**
 * Real-world JPEG fixture tests for imageSanitizer.
 *
 * Tests the exact pipeline that sanitizeStillImage + verifyNoImageMetadata
 * execute on-device:
 *   stripJpegMetadata(bytes) → hasExif(stripped)
 *
 * The existing imageSanitizer.test.ts covers only programmatically-clean
 * synthetic JPEGs (small, no post-EOI bytes, no real camera provenance).
 * This file adds fixtures that reflect real Android camera output.
 *
 * Coverage gap analysis (relative to existing tests):
 *   - No fixture >8KB (emulator test images are tiny)
 *   - No EXIF-bearing fixture from a real camera (gps-small.jpg is 598 bytes
 *     and lacks a post-EOI Samsung trailer)
 *   - No post-EOI trailer fixture (Samsung SEF / motion photo)
 *   - No entropy-coded scan data containing Exif\0\0 bytes by coincidence
 *   - Progressive JPEG not tested against hasExif after strip
 *   - picker re-encode behavior invisible (launchImageLibrary fully mocked)
 *
 * Hypothesis under test (in priority order):
 *   A. Samsung SEF motion-photo trailer survives stripJpegMetadata because the
 *      SOS branch copies every byte from the SOS marker to data.length verbatim
 *      (imageSanitizer.ts line 102-105), including post-EOI bytes. The trailer
 *      embeds JPEG thumbnails with their own Exif\0\0 signatures. hasExif()
 *      scans the entire output file for the Exif\0\0 byte pattern (line 251-260)
 *      and finds it in the trailer → verifyNoImageMetadata throws.
 *
 *   A-variant. Coincidental Exif\0\0 byte sequence in entropy-coded scan data
 *      triggers the same raw-byte scan false positive even without a trailer.
 *
 *   B. Progressive JPEG or multi-APP1 JPEG -- covered in the multi-segment
 *      section below; both strip correctly (hypothesis B eliminated for these
 *      formats).
 *
 * Run: npm test -- imageSanitizer.realWorldFixtures
 */

import {
  stripJpegMetadata,
  stripPngMetadata,
  hasExif,
} from '../media/imageSanitizer';

// ---------------------------------------------------------------------------
// Byte-level JPEG builder
//
// Produces a structurally complete JPEG with optional segments and optional
// post-EOI trailer bytes.  All segment lengths are computed from actual data
// so the stripper's segment-walking never throws on a malformed length.
// ---------------------------------------------------------------------------

function writeSegment(marker: [number, number], payload: number[]): number[] {
  // length field includes itself (2 bytes) but not the 2-byte marker
  const len = payload.length + 2;
  return [...marker, (len >> 8) & 0xFF, len & 0xFF, ...payload];
}

function buildTestJpeg(opts: {
  /** Include a real EXIF APP1 segment (will be dropped by stripJpegMetadata). */
  includeExifApp1?: boolean;
  /** Include an XMP APP1 segment (will be dropped by stripJpegMetadata). */
  includeXmpApp1?: boolean;
  /** Include an ICC profile APP2 segment (must be KEPT by stripJpegMetadata). */
  includeIccApp2?: boolean;
  /**
   * Use SOF2 (progressive) instead of SOF0 (baseline).
   * The stripper must still remove APP1 and leave scan data intact.
   */
  progressive?: boolean;
  /**
   * Raw bytes for the entropy-coded scan data section.
   * Defaults to a harmless three-byte sequence.
   */
  scanData?: number[];
  /**
   * Bytes appended verbatim AFTER the JPEG EOI marker.
   * Simulates Samsung SEF motion-photo trailers.
   */
  postEoiTrailer?: number[];
}): Uint8Array {
  const {
    includeExifApp1 = false,
    includeXmpApp1 = false,
    includeIccApp2 = false,
    progressive = false,
    scanData = [0xAA, 0xBB, 0xCC],
    postEoiTrailer = [],
  } = opts;

  const parts: number[] = [];

  // SOI
  parts.push(0xFF, 0xD8);

  // APP0 JFIF -- kept by stripper
  parts.push(...writeSegment([0xFF, 0xE0], [
    0x4A, 0x46, 0x49, 0x46, 0x00, // "JFIF\0"
    0x01, 0x01,                     // version 1.1
    0x00,                           // aspect ratio units = 0
    0x00, 0x01, 0x00, 0x01,         // 1 dpi
    0x00, 0x00,                     // no thumbnail
  ]));

  // APP1 Exif -- DROPPED by stripJpegMetadata
  if (includeExifApp1) {
    // Minimal but structurally correct TIFF IFD inside APP1.
    // "MM" = big-endian, magic = 42, IFD0 at offset 8.
    // IFD0 has one entry: Make tag (0x010F), ASCII, 4 chars ("Cam\0").
    const exifPayload = [
      0x45, 0x78, 0x69, 0x66, 0x00, 0x00, // "Exif\0\0" -- the byte pattern hasExif scans for
      0x4D, 0x4D,                           // "MM" big-endian
      0x00, 0x2A,                           // TIFF magic 42
      0x00, 0x00, 0x00, 0x08,               // IFD0 offset = 8 (relative to "MM")
      // IFD0: 1 entry
      0x00, 0x01,
      // Entry: Make (0x010F) | ASCII (0x0002) | count 4 | offset 0x1A
      0x01, 0x0F, 0x00, 0x02, 0x00, 0x00, 0x00, 0x04, 0x00, 0x00, 0x00, 0x1A,
      0x00, 0x00, 0x00, 0x00,               // next IFD = 0
      // "Cam\0" at offset 0x1A (26 dec) from start of TIFF header
      0x43, 0x61, 0x6D, 0x00,
    ];
    parts.push(...writeSegment([0xFF, 0xE1], exifPayload));
  }

  // APP1 XMP -- DROPPED by stripJpegMetadata (same APP1 marker 0xFFE1)
  if (includeXmpApp1) {
    const xmpSig = Array.from(new TextEncoder().encode('http://ns.adobe.com/xap/1.0/\0'));
    const xmpPayload = [...xmpSig, ...Array.from(new TextEncoder().encode('<x:xmpmeta/>'))];
    parts.push(...writeSegment([0xFF, 0xE1], xmpPayload));
  }

  // APP2 ICC profile -- KEPT by stripJpegMetadata (only APP1 and APP13 are dropped)
  if (includeIccApp2) {
    const iccSig = Array.from(new TextEncoder().encode('ICC_PROFILE\0'));
    parts.push(...writeSegment([0xFF, 0xE2], [...iccSig, 0x01, 0x01, 0xDE, 0xAD]));
  }

  // SOF0 or SOF2 (progressive) -- kept
  const sofMarker: [number, number] = progressive ? [0xFF, 0xC2] : [0xFF, 0xC0];
  parts.push(...writeSegment(sofMarker, [
    0x08,       // precision: 8 bits
    0x00, 0x01, // height: 1 px
    0x00, 0x01, // width: 1 px
    0x01,       // components: 1 (grayscale)
    0x01, 0x11, 0x00, // Y: sampling 1x1, quantization table 0
  ]));

  // DHT -- kept (minimal table, not a real Huffman table but structurally valid)
  parts.push(...writeSegment([0xFF, 0xC4], [
    0x00,                                               // TC=0 TH=0 (DC luma)
    0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,    // 1 code of length 2
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,           // 0 codes for lengths 3-16
    0x00,                                               // symbol: 0
  ]));

  // SOS -- everything after this marker is copied verbatim by stripJpegMetadata
  parts.push(...writeSegment([0xFF, 0xDA], [
    0x01,       // Ns=1 component
    0x01, 0x00, // C1, Td=0/Ta=0
    0x00, 0x3F, 0x00, // Ss=0, Se=63, Ah=0/Al=0
  ]));

  // Entropy-coded scan data (not parsed by stripper -- copied verbatim)
  parts.push(...scanData);

  // EOI
  parts.push(0xFF, 0xD9);

  // Post-EOI trailer (e.g. Samsung SEF) -- appended after EOI
  parts.push(...postEoiTrailer);

  return new Uint8Array(parts);
}

// ---------------------------------------------------------------------------
// Samsung SEF motion-photo trailer builder
//
// Samsung phones store a motion video (a short MP4) AFTER the JPEG EOI on
// every Motion Photo.  The SEF block structure wraps an MP4 container that
// in turn contains JPEG frames with their own EXIF APP1 segments.  The
// minimal reproduction below captures the key byte pattern: an Exif\0\0
// signature inside the embedded thumbnail frame that the MP4/SEF carries.
//
// Real trailers are several MB; this is a structurally representative
// minimum that exercises the exact code path that fails on-device.
// ---------------------------------------------------------------------------

function buildSefTrailer(): number[] {
  // The Exif\0\0 bytes that appear inside the embedded JPEG thumbnail
  // that Samsung's SEF MP4 container holds.
  const embeddedJpegApp1Payload = [
    0x45, 0x78, 0x69, 0x66, 0x00, 0x00, // "Exif\0\0" ← byte pattern hasExif finds
    0x4D, 0x4D, 0x00, 0x2A,             // TIFF: MM + magic
    0x00, 0x00, 0x00, 0x08,             // IFD0 at offset 8
    0x00, 0x00,                          // 0 IFD entries (minimal)
    0x00, 0x00, 0x00, 0x00,             // next IFD = 0
  ];

  // Minimal embedded JPEG thumbnail (SOI + APP1 + EOI) as would appear
  // inside the SEF's MP4 'mdat' box.
  const embeddedJpeg = [
    0xFF, 0xD8,                          // SOI of embedded thumbnail
    ...writeSegment([0xFF, 0xE1], embeddedJpegApp1Payload),
    0xFF, 0xD9,                          // EOI of embedded thumbnail
  ];

  // SEF block count and offset table (simplified from the Samsung SEF v2 spec)
  const blockName = Array.from(new TextEncoder().encode('moti')); // "moti" block type
  const blockDataOffset = 0x18;           // offset from end of SEFH to block data
  const blockDataSize = embeddedJpeg.length;

  const sefhBody = [
    0x00, 0x00, 0x00, 0x02,             // SEF version 2
    0x00, 0x00, 0x00, 0x01,             // num blocks = 1
    ...blockName,                        // block name: "moti"
    (blockDataOffset >> 24) & 0xFF, (blockDataOffset >> 16) & 0xFF,
    (blockDataOffset >> 8) & 0xFF, blockDataOffset & 0xFF,
    (blockDataSize >> 24) & 0xFF, (blockDataSize >> 16) & 0xFF,
    (blockDataSize >> 8) & 0xFF, blockDataSize & 0xFF,
  ];

  const sefhSize = sefhBody.length + 8; // 4 "SEFH" + 4 size field + body

  return [
    // SEFH marker
    0x53, 0x45, 0x46, 0x48,             // "SEFH"
    (sefhSize >> 24) & 0xFF, (sefhSize >> 16) & 0xFF,
    (sefhSize >> 8) & 0xFF, sefhSize & 0xFF,
    ...sefhBody,

    // Padding between SEFH and block data (blockDataOffset bytes)
    ...new Array(blockDataOffset).fill(0x00),

    // Embedded JPEG thumbnail with its own Exif\0\0 in APP1
    ...embeddedJpeg,

    // SEFT footer (trailer end marker + total SEF size)
    0x53, 0x45, 0x46, 0x54,             // "SEFT"
    0x00, 0x00, 0x00, 0x00,             // size placeholder (not needed for this test)
  ];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('imageSanitizer – real-world JPEG fixtures', () => {

  // =========================================================================
  // CONTROL: standard JPEG with EXIF APP1 (no post-EOI bytes)
  // =========================================================================
  describe('control: baseline JPEG with EXIF APP1', () => {
    it('detects EXIF in original JPEG', () => {
      const jpeg = buildTestJpeg({ includeExifApp1: true });
      expect(hasExif(jpeg)).toBe(true);
    });

    it('stripJpegMetadata removes EXIF → hasExif returns false (clean path)', () => {
      const jpeg = buildTestJpeg({ includeExifApp1: true });
      const stripped = stripJpegMetadata(jpeg);
      // The existing suite already exercises this; this is the control that
      // must pass so we know the failure below is specifically about the trailer.
      expect(hasExif(stripped)).toBe(false);
    });
  });

  // =========================================================================
  // HYPOTHESIS A: Samsung SEF motion-photo trailer survival
  //
  // Root cause (two cooperating defects):
  //
  //   1. stripJpegMetadata (imageSanitizer.ts line 100-107):
  //      When the SOS marker is found, the function copies EVERYTHING from
  //      the current position to data.length — including any bytes that
  //      appear after the EOI marker.  The Samsung SEF trailer is entirely
  //      within that range and is copied verbatim into the stripped output.
  //
  //   2. hasExif (imageSanitizer.ts line 251-260):
  //      The first check is a raw full-file byte scan for the 6-byte sequence
  //      [0x45 0x78 0x69 0x66 0x00 0x00] ("Exif\0\0") at any offset.
  //      It does not stop at the EOI marker.  When the SEF trailer contains
  //      an embedded JPEG thumbnail (which it does on Samsung motion photos),
  //      that thumbnail's own APP1 Exif header supplies the "Exif\0\0" bytes
  //      anywhere in the file — well past the original EOI.
  //
  // Consequence:
  //   sanitizeStillImage → stripJpegMetadata (drops APP1 ✓)
  //                      → writeFile (writes stripped bytes including trailer)
  //                      → verifyNoImageMetadata → readFile → hasExif → true
  //                      → throws "Could not remove metadata from this image."
  //   Error is swallowed by uploadMedia's catch (only console.warn under __DEV__,
  //   silent in release builds) → generic banner, zero network requests.
  // =========================================================================
  describe('Hypothesis A – Samsung SEF motion-photo trailer (THE BUG)', () => {
    it('original JPEG+SEF trailer is detected as containing EXIF', () => {
      const jpeg = buildTestJpeg({
        includeExifApp1: true,
        postEoiTrailer: buildSefTrailer(),
      });
      expect(hasExif(jpeg)).toBe(true);
    });

    it('stripJpegMetadata removes the JPEG APP1 segment', () => {
      const jpeg = buildTestJpeg({
        includeExifApp1: true,
        postEoiTrailer: buildSefTrailer(),
      });
      const stripped = stripJpegMetadata(jpeg);

      // Walk the header segments of the stripped output and confirm no APP1 remains.
      let app1Found = false;
      let pos = 2; // skip SOI
      while (pos < stripped.length - 1) {
        if (stripped[pos] !== 0xFF) { pos++; continue; }
        const marker = (stripped[pos] << 8) | stripped[pos + 1];
        if (marker === 0xFFDA || marker === 0xFFD9) break; // SOS or EOI
        if (marker === 0xFFE1) { app1Found = true; break; }
        if (pos + 3 >= stripped.length) break;
        const segLen = (stripped[pos + 2] << 8) | stripped[pos + 3];
        if (segLen < 2) break;
        pos += 2 + segLen;
      }
      expect(app1Found).toBe(false); // APP1 (Exif) correctly stripped
    });

    it('stripJpegMetadata drops the SEF trailer (output truncated at EOI)', () => {
      const trailer = buildSefTrailer();
      const jpeg = buildTestJpeg({
        includeExifApp1: true,
        postEoiTrailer: trailer,
      });
      const stripped = stripJpegMetadata(jpeg);

      // The stripped output must be byte-for-byte the same length as a clean
      // JPEG (no trailer) of the same structural shape: the whole trailer is
      // gone, not merely the APP1 segment.
      const cleanJpeg = buildTestJpeg({ includeExifApp1: false });
      const cleanStripped = stripJpegMetadata(cleanJpeg);
      expect(stripped.length).toBe(cleanStripped.length);

      // ...and it must still end with the EOI marker.
      expect(stripped[stripped.length - 2]).toBe(0xFF);
      expect(stripped[stripped.length - 1]).toBe(0xD9);
    });

    /**
     * THE FAILING TEST — this reproduces the production bug.
     *
     * verifyNoImageMetadata reads the file and calls hasExif.
     * hasExif scans the ENTIRE output (including the SEF trailer that
     * survived the strip) for the Exif\0\0 byte pattern.
     * It finds the pattern in the trailer's embedded thumbnail APP1 header
     * and returns true → verifyNoImageMetadata throws:
     *
     *   "Could not remove metadata from this image. The image cannot be sent."
     *
     * Expected (what SHOULD happen): hasExif(stripped) === false
     * Actual (what DOES happen):     hasExif(stripped) === true  ← BUG
     *
     * Offending lines:
     *   stripJpegMetadata copies post-EOI bytes: imageSanitizer.ts lines 100-107
     *   hasExif raw full-file scan:              imageSanitizer.ts lines 251-260
     */
    it('hasExif returns false after strip: the SEF trailer no longer survives', () => {
      const jpeg = buildTestJpeg({
        includeExifApp1: true,
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
      // was preserved byte-for-byte.  stripJpegMetadata still copies the
      // trailer verbatim, so hasExif still fires.
      const jpeg = buildTestJpeg({
        includeExifApp1: false,      // no APP1 — picker already dropped it
        postEoiTrailer: buildSefTrailer(), // but trailer is still there
      });

      // The original has no APP1 but hasExif finds the trailer pattern
      expect(hasExif(jpeg)).toBe(true); // raw byte scan hits the trailer

      const stripped = stripJpegMetadata(jpeg);

      // Nothing to strip (no APP1), but the trailer is truncated at the EOI.
      expect(hasExif(stripped)).toBe(false);
    });
  });

  // =========================================================================
  // HYPOTHESIS A-VARIANT: Exif\0\0 pattern in entropy-coded scan data
  //
  // The raw full-file scan in hasExif (line 251-260) runs over scan data
  // as well as header segments.  If the entropy-coded scan data contains
  // the bytes [0x45 0x78 0x69 0x66 0x00 0x00] by coincidence (statistically
  // unlikely in any given 2MB photo but non-zero), verifyNoImageMetadata
  // throws even for a structurally clean JPEG that never had an APP1.
  //
  // This is a secondary defect in hasExif (scan should stop at SOS) that
  // the production failure confirms exists in the codebase, but which is
  // not the primary cause because the SEF trailer (Hypothesis A) is a
  // far more deterministic trigger for Samsung devices.
  // =========================================================================
  describe('Hypothesis A-variant – Exif\\0\\0 coincidence in entropy-coded scan data', () => {
    const EXIF_BYTES_IN_SCAN: number[] = [
      0xAA, 0xBB,
      0x45, 0x78, 0x69, 0x66, 0x00, 0x00, // "Exif\0\0" embedded inside scan data
      0xCC, 0xDD,
    ];

    it('no false positive: clean JPEG with Exif bytes in entropy-coded scan data', () => {
      const jpeg = buildTestJpeg({
        includeExifApp1: false,
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

  // =========================================================================
  // HYPOTHESIS B: progressive JPEG or multi-segment JPEG
  //
  // Hypothesis B posited that the strip might CORRUPT some real-world variant.
  // Tests below confirm that progressive JPEG and multi-APP1/APP2 JPEGs
  // strip correctly → Hypothesis B is ELIMINATED for these variants.
  // =========================================================================
  describe('Hypothesis B – progressive JPEG (SOF2)', () => {
    it('strips EXIF APP1 from progressive JPEG → hasExif false (B eliminated)', () => {
      const jpeg = buildTestJpeg({
        includeExifApp1: true,
        progressive: true,
      });
      expect(hasExif(jpeg)).toBe(true);

      const stripped = stripJpegMetadata(jpeg);
      expect(hasExif(stripped)).toBe(false); // passes: B is not the cause
    });

    /**
     * Guards the EOI-truncation logic against the multi-scan case: a real
     * progressive JPEG has several SOS sections, with tables between them, and
     * all of them precede the single closing EOI.  Truncating at the *first*
     * FFD9-looking byte pair, or at the first scan, would corrupt the image.
     */
    it('keeps every scan of a multi-scan progressive JPEG up to the closing EOI', () => {
      const parts: number[] = [];
      parts.push(0xFF, 0xD8); // SOI
      parts.push(...writeSegment([0xFF, 0xE1], [
        0x45, 0x78, 0x69, 0x66, 0x00, 0x00, // "Exif\0\0" -- dropped
      ]));
      parts.push(...writeSegment([0xFF, 0xC2], [
        0x08, 0x00, 0x01, 0x00, 0x01, 0x01, 0x01, 0x11, 0x00,
      ]));

      // Scan 1: SOS + entropy data containing stuffed 0xFF (FF00) and a restart
      // marker (FFD0) -- both legal inside an entropy-coded stream.
      parts.push(...writeSegment([0xFF, 0xDA], [0x01, 0x01, 0x00, 0x00, 0x05, 0x00]));
      const scan1 = [0x11, 0xFF, 0x00, 0x22, 0xFF, 0xD0, 0x33];
      parts.push(...scan1);

      // Tables between scans, then scan 2.
      const dht = writeSegment([0xFF, 0xC4], [
        0x00,
        0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00,
      ]);
      parts.push(...dht);
      parts.push(...writeSegment([0xFF, 0xDA], [0x01, 0x01, 0x00, 0x06, 0x3F, 0x02]));
      const scan2 = [0x44, 0x55, 0x66];
      parts.push(...scan2);

      parts.push(0xFF, 0xD9); // EOI
      parts.push(...buildSefTrailer()); // Samsung-style trailer past the EOI

      const jpeg = new Uint8Array(parts);
      expect(hasExif(jpeg)).toBe(true);

      const stripped = stripJpegMetadata(jpeg);
      expect(hasExif(stripped)).toBe(false);

      // Both scans and the inter-scan DHT survive; only APP1 and the trailer go.
      const bytes = Array.from(stripped);
      function indexOfSeq(hay: number[], needle: number[]): number {
        for (let i = 0; i + needle.length <= hay.length; i++) {
          let match = true;
          for (let j = 0; j < needle.length; j++) {
            if (hay[i + j] !== needle[j]) { match = false; break; }
          }
          if (match) return i;
        }
        return -1;
      }
      expect(indexOfSeq(bytes, scan1)).toBeGreaterThan(-1);
      expect(indexOfSeq(bytes, scan2)).toBeGreaterThan(-1);
      expect(indexOfSeq(bytes, dht)).toBeGreaterThan(-1);

      // Ends exactly at the EOI, trailer removed.
      expect(stripped[stripped.length - 2]).toBe(0xFF);
      expect(stripped[stripped.length - 1]).toBe(0xD9);
    });
  });

  describe('Hypothesis B – multi-segment JPEG (APP1 Exif + XMP + APP2 ICC)', () => {
    it('strips both APP1 segments (Exif+XMP), keeps APP2 (ICC) → hasExif false', () => {
      const jpeg = buildTestJpeg({
        includeExifApp1: true,
        includeXmpApp1: true,
        includeIccApp2: true,
      });
      expect(hasExif(jpeg)).toBe(true);

      const stripped = stripJpegMetadata(jpeg);
      expect(hasExif(stripped)).toBe(false); // passes: B is not the cause

      // Confirm APP2 (ICC profile) was preserved — it is not metadata
      let app2Found = false;
      let pos = 2;
      while (pos < stripped.length - 1) {
        if (stripped[pos] !== 0xFF) { pos++; continue; }
        const marker = (stripped[pos] << 8) | stripped[pos + 1];
        if (marker === 0xFFDA || marker === 0xFFD9) break;
        if (marker === 0xFFE2) { app2Found = true; break; }
        if (pos + 3 >= stripped.length) break;
        const segLen = (stripped[pos + 2] << 8) | stripped[pos + 3];
        if (segLen < 2) break;
        pos += 2 + segLen;
      }
      expect(app2Found).toBe(true);
    });
  });

  // =========================================================================
  // HYPOTHESIS C: resolveUri / file:// path handling
  //
  // The brief flagged path/URI mishandling as hypothesis C.  resolveUri is
  // not exported and cannot be tested at the pure-bytes level.  The test
  // below confirms that the pure-core path (no RNFS) is not at fault — the
  // strip functions receive a Uint8Array, not a URI, so path handling is
  // orthogonal to what these tests exercise.  C is untestable in Jest and
  // remains a candidate only for on-device logcat investigation.
  // =========================================================================
  describe('Hypothesis C note (not a Jest-testable code path)', () => {
    it('placeholder: pure-core functions accept Uint8Array, not URIs — C is out of scope here', () => {
      // resolveUri is private to mediaUploadService and not exported.
      // Its behavior with file:// URIs returned by the picker is invisible
      // to Jest without an RNFS mock replicating real-device filesystem paths.
      // Flag C as "untestable in Jest — requires on-device logcat" in the report.
      expect(true).toBe(true);
    });
  });

  // =========================================================================
  // PNG: post-IEND trailing bytes (parallel to the JPEG SEF case)
  //
  // stripPngMetadata copies any bytes that appear after the IEND chunk
  // (the "Copy any trailing bytes" guard at the end of the function).
  // If those trailing bytes contain Exif\0\0, hasExif fires on the
  // stripped output.  PNG is not the failing format on the reported device,
  // but the same structural bug exists for PNG too.
  // =========================================================================
  describe('PNG with eXIf chunk + post-IEND Exif bytes', () => {
    function buildPngWithTrailer(postIendBytes: number[]): Uint8Array {
      const sig = [137, 80, 78, 71, 13, 10, 26, 10];
      const parts: number[] = [...sig];

      function writeChunk(type: string, data: number[]) {
        const len = data.length;
        parts.push((len >> 24) & 0xFF, (len >> 16) & 0xFF, (len >> 8) & 0xFF, len & 0xFF);
        parts.push(...Array.from(new TextEncoder().encode(type)));
        parts.push(...data);
        parts.push(0, 0, 0, 0); // CRC placeholder
      }

      writeChunk('IHDR', [0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0]);
      writeChunk('eXIf', [0x45, 0x78, 0x69, 0x66, 0x00, 0x00, 0x4D, 0x4D]);
      writeChunk('IDAT', [0x08, 0x1D, 0x00]);
      writeChunk('IEND', []);

      // Post-IEND bytes (e.g. some proprietary trailer with Exif\0\0)
      parts.push(...postIendBytes);

      return new Uint8Array(parts);
    }

    it('strips eXIf chunk from clean PNG correctly (no trailer)', () => {
      const png = buildPngWithTrailer([]);
      expect(hasExif(png)).toBe(true);
      const stripped = stripPngMetadata(png);
      expect(hasExif(stripped)).toBe(false);
    });

    it('post-IEND Exif\\0\\0 bytes are dropped by stripPngMetadata', () => {
      const postIendTrailer = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00, 0xDE, 0xAD];
      const png = buildPngWithTrailer(postIendTrailer);
      expect(hasExif(png)).toBe(true);

      const stripped = stripPngMetadata(png);
      // The eXIf chunk is stripped AND the post-IEND trailer is truncated
      // (same EOI/IEND boundary rule as the JPEG stripper), so nothing is left
      // for hasExif to find.
      expect(hasExif(stripped)).toBe(false);
    });
  });

  // =========================================================================
  // DEGRADED AND PADDED STREAMS
  //
  // The strippers truncate at a boundary (JPEG EOI / PNG IEND).  When that
  // boundary cannot be located the strippers fall back to copying to the end,
  // so a trailer survives — and hasExif MUST still report it, or a
  // metadata-bearing image would sail past the fail-closed verify.  These
  // tests pin the strip and the detect halves together: whenever the strip
  // degrades, the detect degrades conservatively in the same direction.
  // =========================================================================
  describe('degraded and padded streams (fail-closed boundaries)', () => {
    it('JPEG with no findable EOI: trailer survives the strip and hasExif still reports it', () => {
      // Structurally valid header and SOS, entropy data that never reaches an
      // EOI, then a metadata-bearing trailer.
      const parts: number[] = [];
      parts.push(0xFF, 0xD8); // SOI
      parts.push(...writeSegment([0xFF, 0xE0], [0x4A, 0x46, 0x49, 0x46, 0x00]));
      parts.push(...writeSegment([0xFF, 0xC0], [
        0x08, 0x00, 0x01, 0x00, 0x01, 0x01, 0x01, 0x11, 0x00,
      ]));
      parts.push(...writeSegment([0xFF, 0xDA], [0x01, 0x01, 0x00, 0x00, 0x3F, 0x00]));
      parts.push(0x11, 0x22, 0x33); // entropy data -- no EOI anywhere in the file
      parts.push(
        0x53, 0x45, 0x46, 0x48,             // "SEFH"
        0x45, 0x78, 0x69, 0x66, 0x00, 0x00, // "Exif\0\0" in the trailer
        0xDE, 0xAD,
      );
      const jpeg = new Uint8Array(parts);

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
      const jpeg = buildTestJpeg({
        includeExifApp1: true,
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
      const parts: number[] = [137, 80, 78, 71, 13, 10, 26, 10];

      function writeChunk(type: string, data: number[]) {
        const len = data.length;
        parts.push((len >> 24) & 0xFF, (len >> 16) & 0xFF, (len >> 8) & 0xFF, len & 0xFF);
        parts.push(...Array.from(new TextEncoder().encode(type)));
        parts.push(...data);
        parts.push(0, 0, 0, 0); // CRC placeholder
      }

      writeChunk('IHDR', [0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0]);
      writeChunk('IDAT', [0x08, 0x1D, 0x00]);
      // Truncated tail: shorter than a chunk header, so the walk stops here
      // without ever seeing IEND. Six of these eight bytes are an Exif\0\0.
      parts.push(0x45, 0x78, 0x69, 0x66, 0x00, 0x00, 0xDE, 0xAD);

      const png = new Uint8Array(parts);
      expect(hasExif(png)).toBe(true);

      const stripped = stripPngMetadata(png);
      expect(stripped.length).toBe(png.length); // tail copied through
      expect(hasExif(stripped)).toBe(true);     // so it must still be detected
    });
  });
});
