/**
 * Image metadata sanitizer -- strips EXIF/GPS/XMP metadata from images.
 *
 * SECURITY: This is the ONE authoritative strip utility for still images.
 * The picker's resize re-encode is NOT a reliable strip -- Android's
 * react-native-image-picker skips re-encode for images <= 2048px (proven
 * byte-identical pass-through in 2026-07-16 smoke test).
 *
 * Supported formats:
 * - JPEG: drops APP1 (Exif/XMP), APP13 (IPTC) and COM segments -- wherever they
 *   sit, header or between scans; keeps JFIF/ICC/Adobe + scan data
 * - PNG: drops eXIf/tEXt/zTXt/iTXt/tIME chunks
 * Both strippers also truncate the output at the end of the image stream (JPEG
 * EOI / PNG IEND). Anything a camera appended past that point -- notably the
 * Samsung Motion Photo SEF trailer, which embeds an MP4 whose frames carry
 * their own Exif/GPS headers -- is metadata by another name and is dropped.
 * - WebP/HEIC/unknown: re-encodes to JPEG via reencodeImage first, then strips
 *
 * Always ends with verifyNoImageMetadata re-scan; THROWS if metadata persists (fail-closed).
 *
 * The strip half and the detect half are one contract, and they degrade
 * TOGETHER. When the structure cannot be parsed -- no findable EOI, no IEND, a
 * nonsense chunk length -- the strippers copy through unchanged rather than
 * guessing at a boundary, and hasExif widens its scan over exactly the region
 * that survived. Tightening one half alone would either pass metadata through
 * the verify or reject an image the strip has no way to clean.
 *
 * What that widening actually covers, precisely: a raw scan for an Exif or XMP
 * *signature*, plus the terminal SEFT anchor. It is NOT a structural check. A
 * signature-less APP13 or COM sitting past the point where the walk gave up
 * survives the copy-through and passes the verify -- there is nothing in those
 * bytes to match. Narrowing that residue (by treating an unwalkable stream as
 * unverifiable, or by a structural marker check over the surviving region) is
 * tracked as a follow-up, not solved here.
 *
 * Every unmodified user-picked JPEG of 8MB or less whose orientation tag is 1
 * or absent reaches these walkers directly, with no native re-encode in front
 * of them: gallery files of unknown provenance, not just this app's own camera
 * output. Unparseable input is contained by the copy-through, never trusted.
 *
 * Stripping the APP1 also removes the EXIF orientation tag, so a JPEG that carries
 * its rotation only in that tag is pre-encoded first (readJpegOrientation) -- the
 * native re-encode bakes the rotation into the pixels.
 *
 * Pure byte-level cores (stripJpegMetadata, stripPngMetadata, hasExif,
 * readJpegOrientation) are exported separately for fixture-based Jest tests.
 */

import { reencodeImage } from 'orbital-media-transcoder';
import {
  read,
  readFile,
  writeFile,
  stat,
  unlink,
  CachesDirectoryPath,
} from '@dr.pogodin/react-native-fs';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Files larger than 8MB are pre-compressed before stripping (memory bound). */
const MAX_STRIP_SIZE_BYTES = 8 * 1024 * 1024;

/**
 * Head slice read for the EXIF orientation probe. An Exif APP1 is capped at
 * 65535 bytes and sits in the first segments, so this covers it with room to
 * spare while never pulling a whole photo into JS.
 */
const ORIENTATION_HEAD_BYTES = 128 * 1024;

// JPEG markers
const JPEG_SOS = 0xFFDA;
const JPEG_EOI = 0xFFD9;

// APP segment markers
const APP1 = 0xFFE1;  // Exif / XMP
const APP13 = 0xFFED; // Photoshop / IPTC
const APP14 = 0xFFEE; // Adobe (color transform)
const COM = 0xFFFE;   // Comment

/**
 * Defensive ceiling on inter-scan segments recorded from one scan stream --
 * same idiom as MAX_IFD_ENTRIES. A conforming JPEG has a handful; the array is
 * sized by untrusted bytes, and a dense run of 4-byte segments in an 8MB file
 * would otherwise allocate millions of objects. Past the ceiling the walk
 * reports no EOI, which is the fail-closed copy-through path.
 */
const MAX_SCAN_STREAM_SEGMENTS = 4096;

/**
 * The JPEG segments this module removes, shared by the strip and the detect so
 * the two halves can never disagree about what counts as metadata.
 *
 * COM is in the set because a comment is textual metadata by definition -- and
 * because keeping it while the detect flags it would make a COM-borne signature
 * a permanent dead end: the verify would reject an image the strip cannot fix.
 * APP2 (ICC) and APP14 (Adobe) are deliberately absent -- a color profile is a
 * rendering instruction, not a description of the subject.
 */
const JPEG_DROP_MARKERS: ReadonlySet<number> = new Set([APP1, APP13, COM]);

/**
 * Markers whose declared length may be trusted between scans.
 *
 * T.81 allows frame/scan headers (SOFn, DHT, DAC), tables and restart
 * definitions (DQT, DNL, DRI), hierarchical-mode segments (DHP, EXP),
 * application segments (APPn) and comments (COM) to appear between scans.
 * Anything else there -- a stray SOI, a reserved FF02..FFBF byte pair, an
 * FFF0..FFFD -- is not something whose "length" means anything, and skipping by
 * it can step OVER the real EOI and land on a coincidental FFD9 inside a
 * trailer. FFC8 (JPG) is reserved and excluded with the rest.
 */
function isScanStreamSegmentMarker(marker: number): boolean {
  return (
    (marker >= 0xFFC0 && marker <= 0xFFCF && marker !== 0xFFC8) || // SOFn, DHT, DAC
    (marker >= 0xFFDA && marker <= 0xFFDF) ||                      // SOS, DQT, DNL, DRI, DHP, EXP
    (marker >= 0xFFE0 && marker <= 0xFFEF) ||                      // APPn
    marker === COM
  );
}

/**
 * Inter-scan segments the strip removes -- the shared drop set, plus every
 * APPn except APP14.
 *
 * Why every APPn and not just the drop set: between scans is not where an
 * application segment belongs, and the strip and the detect have to agree on
 * each one. Keeping (say) an inter-scan APP2 while the detect flagged its
 * payload would make that photo permanently unpostable -- the verify rejects
 * what the strip cannot remove. Dropping them costs nothing a decoder needs;
 * an ICC profile is read from the header.
 *
 * APP14 is the exception: its Adobe transform flag can change how the color
 * components are interpreted, so it is kept, and its payload is raw-scanned
 * instead. An Adobe APP14 carrying an Exif or XMP signature is the one
 * remaining unclearable rejection here, and it is a shape nothing emits.
 */
function isDroppedInterScanSegment(marker: number): boolean {
  return (
    JPEG_DROP_MARKERS.has(marker) ||
    (marker >= 0xFFE0 && marker <= 0xFFEF && marker !== APP14)
  );
}

/**
 * Markers whose spans the strip and the detect actually consult: APPn and COM.
 *
 * Tables and frame/scan headers are still walked -- they have to be, to find
 * the EOI -- but recording them serves nobody and let untrusted bytes size an
 * unbounded array.
 */
function isConsultedScanStreamSegment(marker: number): boolean {
  return (marker >= 0xFFE0 && marker <= 0xFFEF) || marker === COM;
}

/** Append `data[start, end)` to `output`. */
function pushRange(output: number[], data: Uint8Array, start: number, end: number): void {
  for (let i = start; i < end; i++) {
    output.push(data[i]);
  }
}

// PNG constants
const PNG_SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

// Chunks to strip from PNG
const PNG_STRIP_CHUNKS = new Set(['eXIf', 'tEXt', 'zTXt', 'iTXt', 'tIME']);

// ---------------------------------------------------------------------------
// JPEG pure byte-level core
// ---------------------------------------------------------------------------

/**
 * Strip EXIF/XMP/IPTC metadata from a JPEG byte array.
 *
 * Drops every JPEG_DROP_MARKERS segment (APP1 Exif/XMP, APP13 IPTC, COM),
 * whether it sits in the header or between scans, plus anything past the EOI
 * that closes the compressed stream (Samsung Motion Photo SEF trailers and the
 * like -- see the SOS branch below).
 * Keeps APP0 (JFIF), APP2 (ICC), APP14 (Adobe), and all other markers + scan data.
 * No recompression -- scan data is byte-identical.
 *
 * When the scan stream cannot be walked (an unrecognized marker, a segment past
 * EOF) the output is copied through to the end rather than truncated at a
 * boundary that was never found -- drop-set segments recognized before that
 * point are still removed, and hasExif scans the whole surviving remainder.
 *
 * @param data JPEG file bytes
 * @returns Sanitized JPEG bytes
 * @throws If the input is not a valid JPEG
 */
export function stripJpegMetadata(data: Uint8Array): Uint8Array {
  if (data.length < 4) {
    throw new Error('Input too small to be a valid JPEG');
  }

  // Verify SOI marker
  if (data[0] !== 0xFF || data[1] !== 0xD8) {
    throw new Error('Not a valid JPEG (missing SOI marker)');
  }

  const output: number[] = [];
  // Write SOI
  output.push(0xFF, 0xD8);

  let pos = 2;
  // Set once the output has been closed with an EOI; anything left in the
  // input past that point is a trailer and must not be emitted.
  let truncatedAtEoi = false;

  while (pos < data.length - 1) {
    // Find next marker
    if (data[pos] !== 0xFF) {
      output.push(data[pos]);
      pos++;
      continue;
    }

    const marker = (data[pos] << 8) | data[pos + 1];

    // EOI marker
    if (marker === JPEG_EOI) {
      output.push(0xFF, 0xD9);
      pos += 2;
      truncatedAtEoi = true;
      break;
    }

    // SOS marker -- copy it and the entropy-coded stream verbatim, stopping
    // after the EOI that closes the stream.
    //
    // SECURITY: bytes AFTER the EOI are deliberately dropped. Samsung Motion
    // Photos append a SEF trailer (an embedded MP4 whose thumbnail frames
    // carry their own Exif headers, often location-bearing) past the EOI.
    // Copying it through would preserve exactly the metadata this module
    // exists to remove -- truncating is the privacy-correct behavior.
    if (marker === JPEG_SOS) {
      const { eoiPos, segments } = walkJpegScanStream(data, pos);
      // Malformed input with no EOI at all: keep the pre-existing behavior and
      // copy to the end. verifyNoImageMetadata remains the fail-closed backstop.
      const streamEnd = eoiPos === -1 ? data.length : eoiPos + 2;

      // Copy [pos, streamEnd) while skipping the segments isDroppedInterScanSegment
      // names -- an encoder is free to put an APP1, APP13 or COM between scans,
      // and a header-only walk would never see it. Segments the walk recognized
      // before giving up are dropped too, so the copy-through path is not a
      // free pass for inter-scan metadata.
      //
      // This is the one place the strip deletes bytes from inside the
      // entropy-coded region, and it is reachable only on input that is already
      // non-compliant: T.81 puts application segments and comments in the
      // header, not between scans. A decoder that was relying on them was
      // reading a file no encoder should have produced -- and the alternative,
      // shipping the metadata, is the thing this module exists to prevent.
      let cursor = pos;
      for (const segment of segments) {
        if (!isDroppedInterScanSegment(segment.marker)) continue;
        // 0xFF fill may pad the run-up to a marker. Removing the segment while
        // leaving that padding behind would splice the stray 0xFF onto the next
        // entropy byte and FABRICATE a marker (FF 40 and so on), so the removed
        // range extends back over the whole fill run.
        let dropStart = segment.start;
        while (dropStart > cursor && data[dropStart - 1] === 0xFF) {
          dropStart--;
        }
        // Every recognized segment ends at or before streamEnd by construction:
        // the walk returns as soon as it reaches the EOI or gives up.
        pushRange(output, data, cursor, dropStart);
        cursor = segment.end;
      }
      pushRange(output, data, cursor, streamEnd);

      pos = streamEnd;
      truncatedAtEoi = eoiPos !== -1;
      break;
    }

    // Markers without length (standalone markers like RST0-RST7, TEM)
    if (
      marker === 0xFF00 ||
      (marker >= 0xFFD0 && marker <= 0xFFD7) ||
      marker === 0xFF01
    ) {
      output.push(data[pos], data[pos + 1]);
      pos += 2;
      continue;
    }

    // Marker with length field
    if (pos + 3 >= data.length) {
      // Truncated -- copy remaining and bail
      while (pos < data.length) {
        output.push(data[pos]);
        pos++;
      }
      break;
    }

    const segLength = (data[pos + 2] << 8) | data[pos + 3];
    if (segLength < 2) {
      throw new Error('Invalid JPEG segment length');
    }

    const segEnd = pos + 2 + segLength;
    if (segEnd > data.length) {
      throw new Error('JPEG segment extends beyond file');
    }

    // Keep or drop, by the one shared drop set.
    if (!JPEG_DROP_MARKERS.has(marker)) {
      pushRange(output, data, pos, segEnd);
    }
    pos = segEnd;
  }

  // Trailing bytes are copied ONLY when the output was never closed with an
  // EOI (malformed input). Once an EOI has been emitted, whatever follows is a
  // trailer -- Samsung SEF, MPF, or similar -- and is dropped on purpose.
  if (!truncatedAtEoi) {
    while (pos < data.length) {
      output.push(data[pos]);
      pos++;
    }
  }

  return new Uint8Array(output);
}

/** A length-bearing segment found between scans. `end` is exclusive. */
interface ScanStreamSegment {
  marker: number;
  start: number;
  end: number;
}

/**
 * Walk the compressed stream from a SOS marker, reporting where it ends and
 * which length-bearing segments sit inside it.
 *
 * Not a plain search for the FFD9 byte pair: entropy-coded data legitimately
 * contains 0xFF bytes (stuffed as FF00, or RSTn restart markers), and
 * progressive JPEGs interleave further header segments (DHT/DQT/SOS, and
 * sometimes an APPn or COM) between scans, so segments are skipped by their
 * declared length.
 *
 * A declared length is only trusted for markers T.81 actually allows here
 * (isScanStreamSegmentMarker). That restriction is the point: skipping by the
 * "length" of an arbitrary byte pair can carry the walk PAST the real EOI and
 * onto a coincidental FFD9 inside a trailer, which would truncate the output at
 * a fake boundary -- keeping part of the trailer while the detect, scanning
 * only past that boundary, reports the file clean.
 *
 * Anything the walk cannot make sense of degrades to `eoiPos: -1` rather than
 * throwing; the caller then keeps the pre-existing copy-to-end behavior and the
 * detect stays hot over the whole stream. Segments recognized before the
 * failure are still returned, so inter-scan metadata found before the walk gave
 * up can still be dropped.
 *
 * Only the segments a caller consults are recorded, and never more than
 * MAX_SCAN_STREAM_SEGMENTS of them: the array is sized by untrusted bytes.
 *
 * @param data JPEG file bytes
 * @param sosPos Offset of the SOS marker to start walking from
 * @returns Offset of the closing EOI (or -1), plus the segments recorded
 */
function walkJpegScanStream(
  data: Uint8Array,
  sosPos: number,
): { eoiPos: number; segments: ScanStreamSegment[] } {
  const segments: ScanStreamSegment[] = [];
  let pos = sosPos;

  while (pos < data.length - 1) {
    if (data[pos] !== 0xFF) {
      pos++;
      continue;
    }

    const marker = (data[pos] << 8) | data[pos + 1];

    if (marker === JPEG_EOI) {
      return { eoiPos: pos, segments };
    }

    // 0xFF fill bytes may pad the run-up to a marker, and the marker begins at
    // the LAST of them -- in FF FF D9 the EOI starts at the second FF. Consume
    // one byte only, or the real marker is stepped over.
    if (marker === 0xFFFF) {
      pos++;
      continue;
    }

    // Payload-free bytes inside the entropy-coded stream:
    // FF00 (stuffed 0xFF), TEM, and RST0-RST7.
    if (
      marker === 0xFF00 ||
      marker === 0xFF01 ||
      (marker >= 0xFFD0 && marker <= 0xFFD7)
    ) {
      pos += 2;
      continue;
    }

    // A marker that cannot legally carry a length here: stop trusting the
    // structure entirely rather than stepping by a number that means nothing.
    if (!isScanStreamSegmentMarker(marker)) {
      return { eoiPos: -1, segments };
    }

    if (pos + 3 >= data.length) {
      return { eoiPos: -1, segments };
    }
    const segLength = (data[pos + 2] << 8) | data[pos + 3];
    // A length field below 2 cannot even cover itself, and a segment running
    // past the buffer is truncated input -- neither is walkable.
    if (segLength < 2) {
      return { eoiPos: -1, segments };
    }
    const segEnd = pos + 2 + segLength;
    if (segEnd > data.length) {
      return { eoiPos: -1, segments };
    }

    if (isConsultedScanStreamSegment(marker)) {
      if (segments.length >= MAX_SCAN_STREAM_SEGMENTS) {
        // Too many to be a real image. Stop trusting the structure rather than
        // letting the input decide how much memory this walk costs; what was
        // recorded so far is still returned, so the detect keeps what it saw.
        return { eoiPos: -1, segments };
      }
      segments.push({ marker, start: pos, end: segEnd });
    }
    pos = segEnd;
  }

  return { eoiPos: -1, segments };
}

/**
 * EXIF Orientation tag (0x0112) in IFD0 of the TIFF structure inside APP1.
 * Values 1..8; 1 means "no rotation".
 */
const EXIF_TAG_ORIENTATION = 0x0112;

/** Defensive ceiling on IFD0 entries -- real cameras write tens, not thousands. */
const MAX_IFD_ENTRIES = 512;

/**
 * Read the EXIF orientation tag out of a JPEG's APP1 Exif segment.
 *
 * Why this exists: react-native-image-picker's Android resize decodes to raw
 * pixels (dropping the sensor rotation) and then writes ONLY the orientation
 * tag back into its output (Utils.java setOrientation). Stripping the APP1
 * therefore removes the sole rotation hint, and a portrait photo uploads as
 * sensor-native landscape. sanitizeStillImage uses this to detect that case and
 * route the file through the native re-encode first, which bakes the rotation
 * into the pixels before the strip.
 *
 * Every bound is checked against the APP1 segment's DECLARED length, not the
 * buffer, so a tag whose offset points past the segment reads as absent. The
 * walk never throws: anything malformed, truncated, or unrecognized returns
 * null, which the caller treats as "no rotation needed" -- the pre-existing,
 * strip-only behavior.
 *
 * Only the file head is needed; an Exif APP1 is at most 65535 bytes and sits
 * within the first few segments.
 *
 * @param data JPEG file bytes (the head is sufficient)
 * @returns Orientation value 1-8, or null if absent/unreadable/not a JPEG
 */
export function readJpegOrientation(data: Uint8Array): number | null {
  if (data.length < 4) return null;
  if (data[0] !== 0xFF || data[1] !== 0xD8) return null;

  let pos = 2;

  while (pos < data.length - 1) {
    // Segment walk only -- unlike the strippers there is no need to tolerate
    // stray bytes between markers, and refusing to resync keeps the walk from
    // wandering into payload data.
    if (data[pos] !== 0xFF) return null;

    const marker = (data[pos] << 8) | data[pos + 1];

    // Orientation lives in a header segment; past SOS (or at EOI) there is none.
    if (marker === JPEG_SOS || marker === JPEG_EOI) return null;

    // Payload-free markers.
    if (marker === 0xFF00 || marker === 0xFF01 || (marker >= 0xFFD0 && marker <= 0xFFD7)) {
      pos += 2;
      continue;
    }

    if (pos + 3 >= data.length) return null;

    const segLength = (data[pos + 2] << 8) | data[pos + 3];
    if (segLength < 2) return null;

    const segEnd = pos + 2 + segLength;
    // A segment running past the buffer means the head read cut it (or the file
    // is malformed); either way there is nothing trustworthy left to parse.
    if (segEnd > data.length) return null;

    // APP1 may be XMP rather than Exif, and a file can carry both -- keep
    // walking until the "Exif\0\0" one is found.
    if (marker === APP1 && isExifApp1(data, pos + 4, segEnd)) {
      return readOrientationFromTiff(data, pos + 10, segEnd);
    }

    pos = segEnd;
  }

  return null;
}

/** True if the APP1 payload starting at `start` carries the "Exif\0\0" signature. */
function isExifApp1(data: Uint8Array, start: number, segEnd: number): boolean {
  if (start + 6 > segEnd) return false;
  return (
    data[start] === 0x45 &&     // E
    data[start + 1] === 0x78 && // x
    data[start + 2] === 0x69 && // i
    data[start + 3] === 0x66 && // f
    data[start + 4] === 0x00 && // NUL
    data[start + 5] === 0x00    // NUL
  );
}

/**
 * Parse the TIFF structure of an Exif APP1 and return its IFD0 orientation.
 *
 * `tiffStart` is the offset of the TIFF header (the "II"/"MM" byte-order mark),
 * which is also the base every TIFF offset in the segment is relative to.
 * `segEnd` is the exclusive end of the enclosing APP1 segment -- the hard bound
 * for every read below.
 */
function readOrientationFromTiff(
  data: Uint8Array,
  tiffStart: number,
  segEnd: number,
): number | null {
  // TIFF header: 2 bytes byte order + 2 bytes magic (42) + 4 bytes IFD0 offset.
  if (tiffStart + 8 > segEnd) return null;

  let littleEndian: boolean;
  if (data[tiffStart] === 0x49 && data[tiffStart + 1] === 0x49) {
    littleEndian = true;  // "II"
  } else if (data[tiffStart] === 0x4D && data[tiffStart + 1] === 0x4D) {
    littleEndian = false; // "MM"
  } else {
    return null;
  }

  const u16 = (at: number): number =>
    littleEndian
      ? data[at] | (data[at + 1] << 8)
      : (data[at] << 8) | data[at + 1];

  // Unsigned 32-bit: >>> 0 keeps a high bit set from reading as negative.
  const u32 = (at: number): number =>
    (littleEndian
      ? data[at] | (data[at + 1] << 8) | (data[at + 2] << 16) | (data[at + 3] << 24)
      : (data[at] << 24) | (data[at + 1] << 16) | (data[at + 2] << 8) | data[at + 3]) >>> 0;

  if (u16(tiffStart + 2) !== 42) return null;

  const ifd0Offset = u32(tiffStart + 4);
  // IFD0 cannot overlap the 8-byte header, and its entry count must be readable.
  if (ifd0Offset < 8) return null;
  const ifd0Pos = tiffStart + ifd0Offset;
  if (ifd0Pos + 2 > segEnd) return null;

  const entryCount = u16(ifd0Pos);
  if (entryCount === 0 || entryCount > MAX_IFD_ENTRIES) return null;
  // Every entry is 12 bytes and must lie inside the declared segment.
  if (ifd0Pos + 2 + entryCount * 12 > segEnd) return null;

  for (let i = 0; i < entryCount; i++) {
    const entry = ifd0Pos + 2 + i * 12;
    if (u16(entry) !== EXIF_TAG_ORIENTATION) continue;

    const type = u16(entry + 2);
    const count = u32(entry + 4);
    if (count !== 1) return null;

    // A single SHORT/LONG fits in the 4-byte value field, so it is stored
    // inline -- no offset dereference. SHORT occupies the field's first
    // 2 bytes in both byte orders.
    let value: number;
    if (type === 3) {
      value = u16(entry + 8);
    } else if (type === 4) {
      value = u32(entry + 8);
    } else {
      return null;
    }

    return value >= 1 && value <= 8 ? value : null;
  }

  return null;
}

/**
 * Strip metadata chunks from a PNG byte array.
 *
 * Removes eXIf, tEXt, zTXt, iTXt, and tIME chunks, plus anything appended
 * after the IEND chunk that ends the stream.
 * Keeps IHDR, PLTE, IDAT, IEND, and all other chunks.
 *
 * @param data PNG file bytes
 * @returns Sanitized PNG bytes
 * @throws If the input is not a valid PNG
 */
export function stripPngMetadata(data: Uint8Array): Uint8Array {
  if (data.length < 8) {
    throw new Error('Input too small to be a valid PNG');
  }

  // Verify PNG signature
  for (let i = 0; i < 8; i++) {
    if (data[i] !== PNG_SIGNATURE[i]) {
      throw new Error('Not a valid PNG (bad signature)');
    }
  }

  const output: number[] = [];
  // Copy signature
  for (let i = 0; i < 8; i++) {
    output.push(data[i]);
  }

  let pos = 8;
  // Set once IEND has been emitted; the PNG stream ends there.
  let truncatedAtIend = false;

  while (pos + 12 <= data.length) {
    // Read chunk: 4 bytes length, 4 bytes type, <length> bytes data, 4 bytes CRC
    const chunkDataLength =
      (data[pos] << 24) | (data[pos + 1] << 16) | (data[pos + 2] << 8) | data[pos + 3];
    const chunkType = String.fromCharCode(
      data[pos + 4], data[pos + 5], data[pos + 6], data[pos + 7],
    );

    const totalChunkSize = 4 + 4 + chunkDataLength + 4; // length + type + data + CRC

    // AVAILABILITY: the length field is a 32-bit big-endian unsigned value, but
    // `<<` yields a SIGNED result -- a chunk declaring >= 2GB reads as negative,
    // which makes `totalChunkSize` negative and walks `pos` BACKWARDS forever
    // (hang, then OOM). Mirrors the guard hasExif already applies. The
    // remainder is copied exactly once and `pos` is parked at the end so the
    // !truncatedAtIend fallback below cannot emit it a second time.
    if (chunkDataLength < 0 || pos + totalChunkSize > data.length) {
      for (let i = pos; i < data.length; i++) {
        output.push(data[i]);
      }
      pos = data.length;
      break;
    }

    if (PNG_STRIP_CHUNKS.has(chunkType)) {
      // Skip this chunk
      pos += totalChunkSize;
    } else {
      // Keep this chunk
      for (let i = pos; i < pos + totalChunkSize; i++) {
        output.push(data[i]);
      }
      pos += totalChunkSize;

      // SECURITY: IEND terminates the PNG stream. Bytes appended after it are
      // a proprietary trailer (the PNG analogue of a Samsung SEF block) and can
      // carry metadata, so the output stops here -- same rule as the JPEG EOI.
      if (chunkType === 'IEND') {
        truncatedAtIend = true;
        break;
      }
    }
  }

  // Trailing bytes are copied ONLY when IEND was never reached (malformed
  // input); verifyNoImageMetadata remains the fail-closed backstop.
  if (!truncatedAtIend) {
    while (pos < data.length) {
      output.push(data[pos]);
      pos++;
    }
  }

  return new Uint8Array(output);
}

/** XMP packet signature, as embedded in a JPEG APP1 or a PNG iTXt chunk. */
const XMP_SIGNATURE = new TextEncoder().encode('http://ns.adobe.com/xap');

/**
 * Raw scan of [start, end) for the "Exif\0\0" byte pattern or an XMP packet
 * signature.
 *
 * Callers pass only structural regions (header segments, chunk payloads,
 * trailers). It must NOT be pointed at compressed payloads -- entropy-coded
 * JPEG scan data and PNG IDAT are arbitrary bytes, so a match there is a
 * coincidence, and a false positive makes the fail-closed verify reject an
 * image that carries no metadata at all.
 */
function rawMetadataScan(data: Uint8Array, start: number, end: number): boolean {
  const limit = Math.min(end, data.length);

  for (let i = Math.max(0, start); i + 5 < limit; i++) {
    if (
      data[i] === 0x45 &&     // E
      data[i + 1] === 0x78 && // x
      data[i + 2] === 0x69 && // i
      data[i + 3] === 0x66 && // f
      data[i + 4] === 0x00 && // NUL
      data[i + 5] === 0x00    // NUL
    ) {
      return true;
    }
  }

  for (let i = Math.max(0, start); i + XMP_SIGNATURE.length <= limit; i++) {
    let match = true;
    for (let j = 0; j < XMP_SIGNATURE.length; j++) {
      if (data[i + j] !== XMP_SIGNATURE[j]) {
        match = false;
        break;
      }
    }
    if (match) return true;
  }

  return false;
}

/**
 * Check if a byte array contains EXIF-like metadata.
 *
 * Format-aware and boundary-respecting -- it inspects the regions where
 * metadata can actually live, and every region the strippers are supposed to
 * have removed:
 * - JPEG: drop-set markers (APP1/APP13/COM) via the header walk AND the
 *   scan-stream walk, a raw scan of the header segments, a raw scan of kept
 *   APPn payloads between scans, a raw scan of anything past the closing EOI
 *   (a surviving Samsung SEF trailer must still be reported), and a terminal
 *   "SEFT" check for the signature-less trailer that no scan can see.
 * - PNG: eXIf/tEXt/zTXt/iTXt/tIME chunks, a raw scan of non-IDAT chunk
 *   payloads, and a raw scan of anything past IEND.
 * - Unrecognized or malformed input: conservative whole-buffer raw scan.
 *
 * When the strip degrades to copying through (no findable EOI, no IEND, a
 * nonsense chunk length), this widens to the whole surviving remainder. False
 * positives are possible there and are the correct trade: fail closed.
 *
 * Compressed payloads (JPEG entropy-coded scan data, PNG IDAT) are excluded:
 * they are arbitrary bytes that can hold "Exif\0\0" by coincidence, and the
 * strippers never touch them, so a hit there can only be a false positive.
 *
 * @param data File bytes
 * @returns true if metadata detected
 */
export function hasExif(data: Uint8Array): boolean {
  if (data.length < 4) return false;

  // JPEG
  if (data[0] === 0xFF && data[1] === 0xD8) {
    let pos = 2;
    let sosPos = -1;

    while (pos < data.length - 1) {
      if (data[pos] !== 0xFF) { pos++; continue; }
      const marker = (data[pos] << 8) | data[pos + 1];
      if (marker === JPEG_SOS) { sosPos = pos; break; }
      if (marker === JPEG_EOI) break;
      if (JPEG_DROP_MARKERS.has(marker)) return true;
      if (pos + 3 >= data.length) break;
      const segLen = (data[pos + 2] << 8) | data[pos + 3];
      if (segLen < 2) break;
      pos += 2 + segLen;
    }

    // Header region. If the segment walk could not reach a SOS the structure is
    // not trustworthy, so fall back to scanning the whole buffer.
    if (rawMetadataScan(data, 0, sosPos === -1 ? data.length : sosPos)) return true;

    if (sosPos !== -1) {
      const { eoiPos, segments } = walkJpegScanStream(data, sosPos);

      // Inter-scan segments, reported on exactly the rule the strip removes
      // them by -- the two halves must not disagree, or a photo becomes
      // permanently unpostable. The only payload scanned is the one segment
      // kept here (APP14); tables, frame/scan headers and entropy data are all
      // excluded for the same reason: the strip can never remove them, so a hit
      // there could only be an unclearable false positive.
      for (const segment of segments) {
        if (isDroppedInterScanSegment(segment.marker)) return true;
        if (
          segment.marker === APP14 &&
          rawMetadataScan(data, segment.start, segment.end)
        ) {
          return true;
        }
      }

      if (eoiPos === -1) {
        // No findable EOI. stripJpegMetadata falls back to copying to the end
        // in exactly this case, so a trailer WOULD survive the strip -- scan
        // the whole remainder rather than trusting a boundary we never found.
        // False positives are possible here (entropy data is in range), which
        // is the correct trade for structurally ambiguous input: fail closed.
        if (rawMetadataScan(data, sosPos, data.length)) return true;
      } else if (rawMetadataScan(data, eoiPos + 2, data.length)) {
        // Post-EOI trailer, if any survived.
        return true;
      }
    }

    // A Samsung SEF trailer that carries neither an Exif signature nor an XMP
    // packet is invisible to every scan above -- and its plain-text blocks are
    // still capture metadata (time, carrier country, capture mode). A correctly
    // truncated output ends in FFD9, so a terminal "SEFT" can only mean such a
    // trailer rode through the copy-to-end path. Four anchored bytes make a
    // coincidence a 2^-32 event.
    if (endsWithSefTrailer(data)) return true;

    return false;
  }

  // PNG
  if (data.length >= 8 && isPngSignature(data)) {
    let pos = 8;

    while (pos + 12 <= data.length) {
      const chunkLen =
        (data[pos] << 24) | (data[pos + 1] << 16) | (data[pos + 2] << 8) | data[pos + 3];
      const chunkType = String.fromCharCode(
        data[pos + 4], data[pos + 5], data[pos + 6], data[pos + 7],
      );
      const totalChunkSize = 4 + 4 + chunkLen + 4;

      // Any chunk the stripper is supposed to remove is metadata by definition.
      if (PNG_STRIP_CHUNKS.has(chunkType)) return true;

      if (chunkLen < 0 || pos + totalChunkSize > data.length) {
        // Truncated or nonsense length -- scan the remainder conservatively.
        return rawMetadataScan(data, pos, data.length);
      }

      if (chunkType !== 'IDAT' && rawMetadataScan(data, pos + 8, pos + 8 + chunkLen)) {
        return true;
      }

      pos += totalChunkSize;

      // IEND ends the stream; anything after it is a trailer.
      if (chunkType === 'IEND') {
        return rawMetadataScan(data, pos, data.length);
      }
    }

    // Ran out of chunks without reaching IEND. stripPngMetadata copies that
    // tail through (its !truncatedAtIend fallback), and an Exif\0\0 fits in
    // 6 bytes, so the remainder still has to be scanned.
    return rawMetadataScan(data, pos, data.length);
  }

  // Unrecognized or malformed format: stay conservative and scan everything.
  return rawMetadataScan(data, 0, data.length);
}

// ---------------------------------------------------------------------------
// RNFS-backed sanitizer (wraps pure cores)
// ---------------------------------------------------------------------------

/**
 * Decode a base64 string to Uint8Array.
 */
function base64ToUint8Array(base64: string): Uint8Array {
  const g = globalThis as unknown as { atob: (s: string) => string };
  const binary = g.atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Encode Uint8Array to base64 string.
 */
function uint8ArrayToBase64(bytes: Uint8Array): string {
  const g = globalThis as unknown as { btoa: (s: string) => string };
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return g.btoa(binary);
}

/**
 * EXIF orientation of a JPEG on disk, read from its head slice only.
 *
 * Never throws: a failed or short read is indistinguishable from "no
 * orientation tag" for routing purposes, and the caller's fallback (strip
 * without re-encode, then fail-closed verify) is the pre-existing behavior. A
 * genuinely unreadable file still surfaces its error on the full read below.
 */
async function readSourceOrientation(filePath: string): Promise<number | null> {
  try {
    const headBase64 = await read(filePath, ORIENTATION_HEAD_BYTES, 0, 'base64');
    return readJpegOrientation(base64ToUint8Array(headBase64));
  } catch {
    return null;
  }
}

/**
 * Sanitize a still image file, stripping all EXIF/GPS/XMP metadata.
 *
 * For JPEG: byte-level strip of APP1/APP13 segments (no recompression).
 * For PNG: byte-level strip of eXIf/tEXt/zTXt/iTXt/tIME chunks.
 * For WebP/HEIC/other: re-encode via reencodeImage, then strip.
 *
 * Files >8MB are pre-encoded via reencodeImage before stripping (memory bound),
 * as are JPEGs whose EXIF orientation is anything but 1 (rotation would be lost
 * with the APP1 otherwise).
 *
 * The pre-encode temp file is this function's own property: it always lives in
 * Caches with a `-staging.bin` suffix so the orphan GC covers it, regardless of
 * where the caller's outPath points (avatarService passes a non-Caches path).
 *
 * Always verifies the output is clean; throws if metadata persists (fail-closed).
 *
 * @param sourcePath Absolute path to the source image
 * @param mimeType MIME type of the source image
 * @param outPath Absolute path for the sanitized output
 * @throws Error if sanitization fails or metadata persists after strip
 */
export async function sanitizeStillImage(
  sourcePath: string,
  mimeType: string,
  outPath: string,
): Promise<void> {
  const isJpeg = mimeType === 'image/jpeg' || mimeType === 'image/jpg';
  const isPng = mimeType === 'image/png';
  const isDirectlyStrippable = isJpeg || isPng;

  let workPath = sourcePath;
  let tempCompressPath: string | null = null;
  const preencodePath = `${CachesDirectoryPath}/${basename(outPath)}.pre-staging.bin`;

  try {
    // For non-JPEG/PNG formats, or large files, pre-encode.
    // DEFENSE IN DEPTH: the native re-encode drops metadata by construction,
    // but the byte-level strip below plus verifyNoImageMetadata remain the
    // authoritative, fail-closed layer. Never treat reencodeImage as the strip.
    if (!isDirectlyStrippable) {
      await reencodeImage(sourcePath, preencodePath, {
        maxDimension: 2048,
        quality: 0.9,
        format: 'jpeg',
      });
      tempCompressPath = preencodePath;
      workPath = preencodePath;
    } else {
      // Check if file is too large for in-memory strip
      const st = await stat(sourcePath);
      let needsPreencode = st.size > MAX_STRIP_SIZE_BYTES;

      // ORIENTATION: a JPEG whose rotation lives only in its EXIF orientation
      // tag would render sideways once the strip drops that tag, so it takes
      // the same pre-encode path -- the native re-encode bakes the rotation
      // into the pixels. Skipped when the size check already routed here, so
      // reencodeImage still runs at most once.
      if (!needsPreencode && isJpeg) {
        const orientation = await readSourceOrientation(sourcePath);
        needsPreencode = orientation !== null && orientation !== 1;
      }

      if (needsPreencode) {
        await reencodeImage(sourcePath, preencodePath, {
          maxDimension: 2048,
          quality: 0.9,
          format: isJpeg ? 'jpeg' : 'png',
        });
        tempCompressPath = preencodePath;
        workPath = preencodePath;
      }
    }

    // Read the file to strip
    const rawBase64 = await readFile(workPath, 'base64');
    const data = base64ToUint8Array(rawBase64);

    // Determine actual format (after possible re-encode)
    let stripped: Uint8Array;
    if (data.length >= 2 && data[0] === 0xFF && data[1] === 0xD8) {
      // JPEG
      stripped = stripJpegMetadata(data);
    } else if (data.length >= 8 && isPngSignature(data)) {
      // PNG
      stripped = stripPngMetadata(data);
    } else {
      // After the native re-encode this should be JPEG.
      // Try JPEG strip as last resort
      stripped = stripJpegMetadata(data);
    }

    // Write sanitized output
    await writeFile(outPath, uint8ArrayToBase64(stripped), 'base64');

    // Fail-closed verification: re-read and check
    await verifyNoImageMetadata(outPath);
  } finally {
    // Clean up temp compress file if created
    if (tempCompressPath) {
      await unlink(tempCompressPath).catch(() => {});
    }
  }
}

/**
 * Verify that an image file contains no EXIF/GPS metadata.
 * Throws a user-facing error if metadata is detected (fail-closed).
 *
 * @param filePath Absolute path to the image file
 * @throws Error if metadata is detected
 */
export async function verifyNoImageMetadata(filePath: string): Promise<void> {
  const rawBase64 = await readFile(filePath, 'base64');
  const data = base64ToUint8Array(rawBase64);
  if (hasExif(data)) {
    throw new Error(
      'Could not remove metadata from this image. The image cannot be sent.',
    );
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Last path segment of an absolute path (no node:path in RN). */
function basename(filePath: string): string {
  const slash = filePath.lastIndexOf('/');
  return slash === -1 ? filePath : filePath.slice(slash + 1);
}

/** True if the buffer's last four bytes are the ASCII "SEFT" trailer magic. */
function endsWithSefTrailer(data: Uint8Array): boolean {
  const end = data.length;
  if (end < 4) return false;
  return (
    data[end - 4] === 0x53 && // S
    data[end - 3] === 0x45 && // E
    data[end - 2] === 0x46 && // F
    data[end - 1] === 0x54    // T
  );
}

function isPngSignature(data: Uint8Array): boolean {
  for (let i = 0; i < 8; i++) {
    if (data[i] !== PNG_SIGNATURE[i]) return false;
  }
  return true;
}
