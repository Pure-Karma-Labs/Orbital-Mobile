/**
 * Image metadata sanitizer -- strips EXIF/GPS/XMP metadata from images.
 *
 * SECURITY: This is the ONE authoritative strip utility for still images.
 * The picker's resize re-encode is NOT a reliable strip -- Android's
 * react-native-image-picker skips re-encode for images <= 2048px (proven
 * byte-identical pass-through in 2026-07-16 smoke test).
 *
 * Supported formats:
 * - JPEG: drops APP1 (Exif/XMP) + APP13 segments; keeps JFIF/ICC/Adobe + scan data
 * - PNG: drops eXIf/tEXt/zTXt/iTXt/tIME chunks
 * Both strippers also truncate the output at the end of the image stream (JPEG
 * EOI / PNG IEND). Anything a camera appended past that point -- notably the
 * Samsung Motion Photo SEF trailer, which embeds an MP4 whose frames carry
 * their own Exif/GPS headers -- is metadata by another name and is dropped.
 * - WebP/HEIC/unknown: re-encodes to JPEG via reencodeImage first, then strips
 *
 * Always ends with verifyNoImageMetadata re-scan; THROWS if metadata persists (fail-closed).
 *
 * Pure byte-level cores (stripJpegMetadata, stripPngMetadata, hasExif) are exported
 * separately for fixture-based Jest tests.
 */

import { reencodeImage } from 'orbital-media-transcoder';
import {
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

// JPEG markers
const JPEG_SOS = 0xFFDA;
const JPEG_EOI = 0xFFD9;

// APP segment markers
const APP1 = 0xFFE1;  // Exif / XMP
const APP13 = 0xFFED; // Photoshop / IPTC

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
 * Drops APP1 (Exif/XMP) and APP13 (IPTC) segments, plus anything past the EOI
 * that closes the compressed stream (Samsung Motion Photo SEF trailers and the
 * like -- see the SOS branch below).
 * Keeps APP0 (JFIF), APP2 (ICC), APP14 (Adobe), and all other markers + scan data.
 * No recompression -- scan data is byte-identical.
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
      const eoiPos = findJpegEoi(data, pos);
      // Malformed input with no EOI at all: keep the pre-existing behavior and
      // copy to the end. verifyNoImageMetadata remains the fail-closed backstop.
      const streamEnd = eoiPos === -1 ? data.length : eoiPos + 2;
      for (let i = pos; i < streamEnd; i++) {
        output.push(data[i]);
      }
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

    // Decide whether to keep or drop this segment
    const shouldDrop =
      marker === APP1 ||   // Exif, XMP
      marker === APP13;    // IPTC / Photoshop

    if (shouldDrop) {
      // Skip entire segment
      pos = segEnd;
    } else {
      // Keep segment
      for (let i = pos; i < segEnd; i++) {
        output.push(data[i]);
      }
      pos = segEnd;
    }
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

/**
 * Index of the EOI marker that closes the compressed stream, walking forward
 * from a SOS marker.
 *
 * Not a plain search for the FFD9 byte pair: entropy-coded data legitimately
 * contains 0xFF bytes (stuffed as FF00, or RSTn restart markers), and
 * progressive JPEGs interleave further header segments (DHT/DQT/SOS) between
 * scans, so segments are skipped by their declared length. Anything the walk
 * cannot make sense of degrades to "no EOI found" (-1) rather than throwing --
 * the caller then keeps the pre-existing copy-to-end behavior.
 *
 * @param data JPEG file bytes
 * @param sosPos Offset of the SOS marker to start walking from
 * @returns Offset of the closing EOI marker, or -1 if there is none
 */
function findJpegEoi(data: Uint8Array, sosPos: number): number {
  let pos = sosPos;

  while (pos < data.length - 1) {
    if (data[pos] !== 0xFF) {
      pos++;
      continue;
    }

    const marker = (data[pos] << 8) | data[pos + 1];

    if (marker === JPEG_EOI) {
      return pos;
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

    // Header segment -- the SOS we started on, or a later scan's tables.
    // Skip its declared length and resume scanning the entropy data.
    if (pos + 3 >= data.length) {
      return -1;
    }
    const segLength = (data[pos + 2] << 8) | data[pos + 3];
    if (segLength < 2) {
      pos += 2;
      continue;
    }
    pos += 2 + segLength;
  }

  return -1;
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

    if (pos + totalChunkSize > data.length) {
      // Truncated chunk -- copy remaining bytes
      for (let i = pos; i < data.length; i++) {
        output.push(data[i]);
      }
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
 * - JPEG: APP1 markers (0xFFE1) via the segment walk, a raw scan of the header
 *   segments, and a raw scan of anything past the closing EOI (a surviving
 *   Samsung SEF trailer must still be reported).
 * - PNG: eXIf/tEXt/zTXt/iTXt/tIME chunks, a raw scan of non-IDAT chunk
 *   payloads, and a raw scan of anything past IEND.
 * - Unrecognized or malformed input: conservative whole-buffer raw scan.
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
      if (marker === APP1) return true;
      if (pos + 3 >= data.length) break;
      const segLen = (data[pos + 2] << 8) | data[pos + 3];
      if (segLen < 2) break;
      pos += 2 + segLen;
    }

    // Header region. If the segment walk could not reach a SOS the structure is
    // not trustworthy, so fall back to scanning the whole buffer.
    if (rawMetadataScan(data, 0, sosPos === -1 ? data.length : sosPos)) return true;

    // Post-EOI trailer, if any survived.
    if (sosPos !== -1) {
      const eoiPos = findJpegEoi(data, sosPos);
      if (eoiPos === -1) {
        // No findable EOI. stripJpegMetadata falls back to copying to the end
        // in exactly this case, so a trailer WOULD survive the strip -- scan
        // the whole remainder rather than trusting a boundary we never found.
        // False positives are possible here (entropy data is in range), which
        // is the correct trade for structurally ambiguous input: fail closed.
        return rawMetadataScan(data, sosPos, data.length);
      }
      if (rawMetadataScan(data, eoiPos + 2, data.length)) return true;
    }

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
 * Sanitize a still image file, stripping all EXIF/GPS/XMP metadata.
 *
 * For JPEG: byte-level strip of APP1/APP13 segments (no recompression).
 * For PNG: byte-level strip of eXIf/tEXt/zTXt/iTXt/tIME chunks.
 * For WebP/HEIC/other: re-encode via reencodeImage, then strip.
 *
 * Files >8MB are pre-encoded via reencodeImage before stripping (memory bound).
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
      if (st.size > MAX_STRIP_SIZE_BYTES) {
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

function isPngSignature(data: Uint8Array): boolean {
  for (let i = 0; i < 8; i++) {
    if (data[i] !== PNG_SIGNATURE[i]) return false;
  }
  return true;
}
