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
 * Not covered here: resolveUri / file:// path handling. These suites drive the
 * pure byte-level cores, which take a Uint8Array and never see a URI -- how the
 * picker's file:// URIs resolve on a real filesystem is an on-device path only.
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
  buildGainMapJpeg,
  s24SefTail,
  writeChunk,
  writeSegment,
  indexOfSeq,
  hasHeaderMarker,
  S24_SEF_CAPTURE_TIMESTAMP,
  S24_SEF_MCC,
  EXIF_SIGNATURE,
  EXIF_TRAILER_BARE,
  SEFH_EXIF_TRAILER,
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
      const png = buildPng({ exif: true, tail: EXIF_TRAILER_BARE });
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
      const png = buildPng({ omitIend: true, tail: EXIF_TRAILER_BARE });
      expect(hasExif(png)).toBe(true);

      const stripped = stripPngMetadata(png);
      expect(stripped.length).toBe(png.length); // tail copied through
      expect(hasExif(stripped)).toBe(true);     // so it must still be detected
    });
  });

  // =========================================================================
  // INTER-SCAN SEGMENTS
  //
  // A progressive JPEG may carry header segments between its scans, and
  // nothing stops an encoder from putting an APP1, APP13 or COM there. Those
  // sit PAST the SOS, so a header walk that stops at the first SOS never sees
  // them: they survived the strip and the detect reported the file clean --
  // metadata passing the fail-closed verify.
  // =========================================================================
  describe('inter-scan metadata segments', () => {
    const SCAN1 = [0x11, 0x22, 0x33, 0x44];
    const SCAN2 = [0x55, 0x66, 0x77, 0x88];

    const INTER_SCAN_SEGMENTS: [string, number[]][] = [
      ['Exif APP1', writeSegment([0xFF, 0xE1], [...EXIF_SIGNATURE, 0x4D, 0x4D, 0x00, 0x2A])],
      ['APP13 IPTC', writeSegment([0xFF, 0xED], [0x50, 0x68, 0x6F, 0x74, 0x6F])],
      ['COM comment', writeSegment([0xFF, 0xFE], [0x48, 0x65, 0x6C, 0x6C, 0x6F])],
    ];

    it.each(INTER_SCAN_SEGMENTS)('detects and drops a %s between two scans', (_label, segment) => {
      const jpeg = buildJpeg({
        scanData: SCAN1,
        betweenScans: segment,
        scan2Data: SCAN2,
      });

      // Seen at all only because the detect walks the scan stream too.
      expect(hasExif(jpeg)).toBe(true);

      const stripped = stripJpegMetadata(jpeg);
      const bytes = Array.from(stripped);

      // Exactly the one segment is gone -- both scans and the tables stay.
      expect(indexOfSeq(bytes, segment)).toBe(-1);
      expect(indexOfSeq(bytes, SCAN1)).toBeGreaterThan(-1);
      expect(indexOfSeq(bytes, SCAN2)).toBeGreaterThan(-1);
      expect(stripped.length).toBe(jpeg.length - segment.length);
      expect(stripped[stripped.length - 2]).toBe(0xFF);
      expect(stripped[stripped.length - 1]).toBe(0xD9);

      expect(hasExif(stripped)).toBe(false);
    });

    it('keeps inter-scan tables and raises no false positive', () => {
      // DQT/DRI between scans are ordinary coding data: dropping them would
      // corrupt the image, and flagging them would make a clean photo
      // permanently unpostable.
      const dqt = writeSegment([0xFF, 0xDB], [0x00, ...new Array(64).fill(0x10)]);
      const dri = writeSegment([0xFF, 0xDD], [0x00, 0x04]);
      const jpeg = buildJpeg({
        scanData: SCAN1,
        betweenScans: [...dqt, ...dri],
        scan2Data: SCAN2,
      });

      expect(hasExif(jpeg)).toBe(false);

      const stripped = stripJpegMetadata(jpeg);
      expect(Array.from(stripped)).toEqual(Array.from(jpeg));
      expect(hasExif(stripped)).toBe(false);
    });

    it('drops an inter-scan APP2 rather than flagging what it cannot remove', () => {
      // An APP2 between scans is already non-conforming (a color profile is
      // read from the header), and if its payload happens to carry an Exif
      // signature, keeping it while the detect flags it would reject this
      // photo forever. The halves agree by removing it.
      const app2 = writeSegment([0xFF, 0xE2], [
        ...Array.from(new TextEncoder().encode('ICC_PROFILE\0')), ...EXIF_SIGNATURE,
      ]);
      const jpeg = buildJpeg({ scanData: SCAN1, betweenScans: app2, scan2Data: SCAN2 });

      expect(hasExif(jpeg)).toBe(true);

      const stripped = stripJpegMetadata(jpeg);
      expect(indexOfSeq(Array.from(stripped), app2)).toBe(-1);
      expect(stripped.length).toBe(jpeg.length - app2.length);
      expect(hasExif(stripped)).toBe(false);
    });

    it('keeps an inter-scan APP14 and scans its payload instead', () => {
      // APP14's Adobe transform flag can change how the color components are
      // interpreted, so this one is kept -- and therefore raw-scanned. A clean
      // one must not be flagged.
      const adobe = [0x41, 0x64, 0x6F, 0x62, 0x65, 0x00, 0x64, 0x00, 0x00, 0x00, 0x00, 0x01];
      const app14 = writeSegment([0xFF, 0xEE], adobe);
      const jpeg = buildJpeg({ scanData: SCAN1, betweenScans: app14, scan2Data: SCAN2 });

      expect(hasExif(jpeg)).toBe(false);
      const stripped = stripJpegMetadata(jpeg);
      expect(Array.from(stripped)).toEqual(Array.from(jpeg));
      expect(hasExif(stripped)).toBe(false);

      // The one remaining unclearable rejection, kept deliberately narrow.
      const dirty = buildJpeg({
        scanData: SCAN1,
        betweenScans: writeSegment([0xFF, 0xEE], [...adobe, ...EXIF_SIGNATURE]),
        scan2Data: SCAN2,
      });
      expect(hasExif(stripJpegMetadata(dirty))).toBe(true);
    });

    it('does not fabricate a marker when the dropped segment follows 0xFF fill', () => {
      // Fill bytes may pad the run-up to a marker. Removing the segment but
      // leaving the padding would splice that 0xFF onto the next entropy byte
      // and invent an FF40 marker out of thin air.
      const app1 = writeSegment([0xFF, 0xE1], [...EXIF_SIGNATURE, 0x4D, 0x4D]);
      const jpeg = buildJpeg({
        scanData: [0x11, 0x22, 0xFF, ...app1, 0x40, 0x41],
      });
      expect(hasExif(jpeg)).toBe(true);

      const stripped = stripJpegMetadata(jpeg);
      const bytes = Array.from(stripped);

      expect(indexOfSeq(bytes, [0x11, 0x22, 0x40, 0x41])).toBeGreaterThan(-1);
      expect(indexOfSeq(bytes, [0xFF, 0x40])).toBe(-1);
      expect(stripped[stripped.length - 2]).toBe(0xFF);
      expect(stripped[stripped.length - 1]).toBe(0xD9);
      expect(hasExif(stripped)).toBe(false);
    });

    it('drops an inter-scan APP1 even when the walk later fails', () => {
      // The walk gives up at the unrecognized marker in scan 2 and reports no
      // EOI, but the APP1 it already recognized is still removed: segments
      // found before a failure are not forgotten.
      const app1 = writeSegment([0xFF, 0xE1], [...EXIF_SIGNATURE, 0x4D, 0x4D]);
      const jpeg = buildJpeg({
        scanData: SCAN1,
        betweenScans: app1,
        scan2Data: [0xFF, 0x02, 0x00, 0x08, 0x99],
      });

      const stripped = stripJpegMetadata(jpeg);
      expect(indexOfSeq(Array.from(stripped), app1)).toBe(-1);
      expect(stripped.length).toBe(jpeg.length - app1.length);
    });
  });

  // =========================================================================
  // SCAN-STREAM WALKER ALLOWLIST
  //
  // Between scans, only markers T.81 actually allows there may be skipped by
  // a declared length. Trusting the length of anything else lets a crafted or
  // corrupt byte pair step OVER the real EOI and land on a later FFD9 inside
  // the trailer -- the strip then truncates at the wrong place, keeping part
  // of the trailer while the detect, scanning only past that fake boundary,
  // reports the file clean. An unrecognized marker must degrade to "no EOI
  // found": copy through, and let the detect stay hot over the whole stream.
  // =========================================================================
  describe('scan-stream walker allowlist', () => {
    it.each([
      // A length that would carry the walk past the true EOI and onto a
      // FFD9 byte pair inside the trailer.
      ['FF02 with a length that steps over the EOI', [0xAA, 0xFF, 0x02, 0x00, 0x0F, 0xBB], [
        ...EXIF_SIGNATURE, 0xDE, 0xAD, 0xBE, 0xEF, 0xFF, 0xD9, 0x11, 0x22,
      ]],
      ['a stray SOI inside the scan', [0xAA, 0xFF, 0xD8, 0xBB, 0xCC], SEFH_EXIF_TRAILER],
      ['a DHT declaring a length below the minimum', [0xAA, 0xFF, 0xC4, 0x00, 0x00, 0xBB], SEFH_EXIF_TRAILER],
    ])('copies through and stays detectable: %s', (_label, scanData, trailer) => {
      const jpeg = buildJpeg({ scanData, postEoiTrailer: trailer });

      let stripped!: Uint8Array;
      expect(() => { stripped = stripJpegMetadata(jpeg); }).not.toThrow();

      // No trustworthy boundary, so nothing is truncated...
      expect(Array.from(stripped)).toEqual(Array.from(jpeg));
      // ...and the trailer is still reported.
      expect(hasExif(stripped)).toBe(true);
    });

    it('copies through when an inter-scan segment runs past the end of the file', () => {
      const jpeg = buildJpeg({
        betweenScans: [0xFF, 0xC4, 0xFF, 0xFF], // DHT declaring 65535 bytes
        scan2Data: [0x44, 0x55],
        postEoiTrailer: SEFH_EXIF_TRAILER,
      });

      const stripped = stripJpegMetadata(jpeg);
      expect(Array.from(stripped)).toEqual(Array.from(jpeg));
      expect(hasExif(stripped)).toBe(true);
    });

    // The recorded-segment array is sized by untrusted bytes, so it is capped.
    // A dense run of 4-byte segments in an 8MB file would otherwise allocate
    // millions of objects, twice per sanitize.
    it.each([
      ['APP0', [0xFF, 0xE0, 0x00, 0x02]],
      ['COM', [0xFF, 0xFE, 0x00, 0x02]],
    ])('fails closed past the recorded-segment ceiling: a dense %s run', (_label, segment) => {
      const dense: number[] = [];
      for (let i = 0; i < 4100; i++) dense.push(...segment); // > MAX_SCAN_STREAM_SEGMENTS

      const jpeg = buildJpeg({
        scanData: [0xAA, ...dense, 0xBB],
        postEoiTrailer: SEFH_EXIF_TRAILER,
      });

      let stripped!: Uint8Array;
      expect(() => { stripped = stripJpegMetadata(jpeg); }).not.toThrow();

      // The ceiling means "stop trusting this structure": no boundary was
      // found, so the trailer rides through rather than being truncated at
      // something the walk never actually reached...
      expect(indexOfSeq(Array.from(stripped), EXIF_SIGNATURE)).toBeGreaterThan(-1);
      // ...and the detect stays hot over it.
      expect(hasExif(stripped)).toBe(true);
    });

    it('is not slowed or capped by segments nobody consults', () => {
      // The same count of DHT segments: walked to find the EOI, never
      // recorded, so the ceiling is never reached and the real boundary is
      // still found. This is the difference the narrowed recording makes.
      const dense: number[] = [];
      for (let i = 0; i < 4100; i++) dense.push(0xFF, 0xC4, 0x00, 0x02);

      const jpeg = buildJpeg({
        scanData: [0xAA, ...dense, 0xBB],
        postEoiTrailer: SEFH_EXIF_TRAILER,
      });

      const stripped = stripJpegMetadata(jpeg);
      expect(indexOfSeq(Array.from(stripped), EXIF_SIGNATURE)).toBe(-1); // trailer truncated
      expect(stripped[stripped.length - 2]).toBe(0xFF);
      expect(stripped[stripped.length - 1]).toBe(0xD9);
      expect(hasExif(stripped)).toBe(false);
    });

    it('still finds the real EOI across DNL, DAC, DHP and EXP segments', () => {
      // All four are legal between scans, so the allowlist must admit them --
      // otherwise a legitimate progressive JPEG would take the copy-through
      // path and its trailer would survive.
      const dnl = writeSegment([0xFF, 0xDC], [0x00, 0x01]);
      const dac = writeSegment([0xFF, 0xCC], [0x00, 0x00]);
      const dhp = writeSegment([0xFF, 0xDE], [0x08, 0x00, 0x01, 0x00, 0x01, 0x01, 0x01, 0x11, 0x00]);
      const exp = writeSegment([0xFF, 0xDF], [0x11]);
      const jpeg = buildJpeg({
        exif: true,
        progressive: true,
        scanData: [0x11, 0x22],
        betweenScans: [...dnl, ...dac, ...dhp, ...exp],
        scan2Data: [0x33, 0x44],
        postEoiTrailer: SEFH_EXIF_TRAILER,
      });

      const stripped = stripJpegMetadata(jpeg);
      const bytes = Array.from(stripped);

      // Boundary found: the trailer is gone and the output closes at the EOI.
      expect(indexOfSeq(bytes, EXIF_SIGNATURE)).toBe(-1);
      expect(stripped[stripped.length - 2]).toBe(0xFF);
      expect(stripped[stripped.length - 1]).toBe(0xD9);
      // All four segments survive.
      for (const seg of [dnl, dac, dhp, exp]) {
        expect(indexOfSeq(bytes, seg)).toBeGreaterThan(-1);
      }
      expect(hasExif(stripped)).toBe(false);
    });
  });

  // =========================================================================
  // REAL SAMSUNG GALAXY S24 CAPTURE TAIL
  //
  // The post-EOI layout of the capture that validated #732: an embedded Ultra
  // HDR gain-map JPEG followed by a 217-byte Samsung SEF tail. The gain map
  // carries an XMP packet a raw scan can see; the SEF tail carries no
  // signature at all, only plain-text capture metadata.
  // =========================================================================
  describe('real Samsung S24 SEF tail', () => {
    const tailText = (bytes: number[]): string => String.fromCharCode(...bytes);

    it('is the scrubbed 217-byte tail and nothing else', () => {
      const tail = s24SefTail();
      const text = tailText(tail);

      expect(tail.length).toBe(217);
      expect(text.endsWith('SEFT')).toBe(true);
      expect(text).toContain('SEFH');
      expect(text).toContain(`Image_UTC_Data${S24_SEF_CAPTURE_TIMESTAMP}`);
      expect(text).toContain(`MCC_Data${S24_SEF_MCC}`);

      // The complete inventory of printable runs: every human-readable thing
      // in the committed bytes is listed here, so nothing from the capture can
      // ride along unreviewed. The capture date and time do not appear.
      expect(text.match(/[ -~]{4,}/g)).toEqual([
        `Image_UTC_Data${S24_SEF_CAPTURE_TIMESTAMP}`,
        `MCC_Data${S24_SEF_MCC}`,
        'Color_Display_P3',
        'Photo_HDR_Info',
        'Camera_Capture_Mode_Info1SEFHk',
        'SEFT',
      ]);
      expect(text).not.toContain('20260711');
      expect(text).not.toContain('193739');
    });

    it('strips the full S24 post-EOI layout back to the primary image', () => {
      const captured = buildJpeg({
        exif: true,
        postEoiTrailer: [...buildGainMapJpeg(), ...s24SefTail()],
      });
      expect(hasExif(captured)).toBe(true);

      const stripped = stripJpegMetadata(captured);
      const bytes = Array.from(stripped);

      // Byte-identical to stripping the primary image on its own.
      expect(bytes).toEqual(Array.from(stripJpegMetadata(buildJpeg({ exif: true }))));

      const text = tailText(bytes);
      expect(text).not.toContain('SEFT');
      expect(text).not.toContain('Image_UTC_Data');
      // The gain map's own SOI is gone: only the primary image's remains.
      expect(indexOfSeq(bytes.slice(2), [0xFF, 0xD8])).toBe(-1);

      expect(hasExif(stripped)).toBe(false);
    });

    it('strips the same layout when the picker already dropped the APP1', () => {
      const captured = buildJpeg({
        postEoiTrailer: [...buildGainMapJpeg(), ...s24SefTail()],
      });
      expect(hasExif(captured)).toBe(true); // the gain map's XMP packet

      const stripped = stripJpegMetadata(captured);
      expect(Array.from(stripped)).toEqual(Array.from(stripJpegMetadata(buildJpeg())));
      expect(hasExif(stripped)).toBe(false);
    });

    it('flags a signature-less SEF tail that survived the copy-through', () => {
      // The unparseable-stream path: the strip cannot find an EOI, so the tail
      // is copied into the output. It holds no Exif and no XMP, so no pattern
      // scan can see it -- the terminal SEFT check is the only thing standing
      // between this file and a verify that passes capture metadata through.
      const jpeg = buildJpeg({
        scanData: [0xAA, 0xFF, 0x02, 0x00, 0x08, 0xBB], // unrecognized marker
        postEoiTrailer: s24SefTail(),
      });
      expect(hasExif(jpeg)).toBe(true);

      const stripped = stripJpegMetadata(jpeg);
      expect(Array.from(stripped)).toEqual(Array.from(jpeg)); // tail survives
      // Nothing a raw pattern scan could latch onto:
      expect(indexOfSeq(Array.from(stripped), EXIF_SIGNATURE)).toBe(-1);
      expect(tailText(Array.from(stripped))).not.toContain('http://ns.adobe.com/xap');

      expect(hasExif(stripped)).toBe(true);
    });
  });
});
