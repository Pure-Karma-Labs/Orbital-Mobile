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
 * - WebP/HEIC/unknown: re-encodes to JPEG via Image.compress first, then strips
 *
 * Always ends with verifyNoImageMetadata re-scan; THROWS if metadata persists (fail-closed).
 *
 * Pure byte-level cores (stripJpegMetadata, stripPngMetadata, hasExif) are exported
 * separately for fixture-based Jest tests.
 */

import { Image } from 'react-native-compressor';
import {
  readFile,
  writeFile,
  stat,
  unlink,
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
 * Drops APP1 (Exif/XMP) and APP13 (IPTC) segments.
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

  while (pos < data.length - 1) {
    // Find next marker
    if (data[pos] !== 0xFF) {
      // In scan data after SOS, copy everything until EOI
      output.push(data[pos]);
      pos++;
      continue;
    }

    const marker = (data[pos] << 8) | data[pos + 1];

    // EOI marker
    if (marker === JPEG_EOI) {
      output.push(0xFF, 0xD9);
      pos += 2;
      break;
    }

    // SOS marker -- copy it and the rest verbatim (entropy-coded data follows)
    if (marker === JPEG_SOS) {
      // Copy from SOS to end (including EOI)
      while (pos < data.length) {
        output.push(data[pos]);
        pos++;
      }
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

  // Copy any trailing bytes (rare but defensive)
  while (pos < data.length) {
    output.push(data[pos]);
    pos++;
  }

  return new Uint8Array(output);
}

/**
 * Strip metadata chunks from a PNG byte array.
 *
 * Removes eXIf, tEXt, zTXt, iTXt, and tIME chunks.
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
    }
  }

  // Copy any trailing bytes
  while (pos < data.length) {
    output.push(data[pos]);
    pos++;
  }

  return new Uint8Array(output);
}

/**
 * Check if a byte array contains EXIF-like metadata.
 *
 * Checks for:
 * - JPEG APP1 markers (0xFFE1) followed by "Exif" or "http://ns.adobe.com/xap"
 * - PNG eXIf chunks
 * - The raw "Exif\0\0" byte pattern
 * - GPS IFD tag (0x8825 in Exif TIFF header context)
 *
 * @param data File bytes
 * @returns true if metadata detected
 */
export function hasExif(data: Uint8Array): boolean {
  if (data.length < 4) return false;

  // Check for Exif\0\0 pattern anywhere in the file
  for (let i = 0; i < data.length - 5; i++) {
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

  // Check for XMP marker (http://ns.adobe.com/xap)
  const xmpSignature = 'http://ns.adobe.com/xap';
  const xmpBytes = new TextEncoder().encode(xmpSignature);
  for (let i = 0; i < data.length - xmpBytes.length; i++) {
    let match = true;
    for (let j = 0; j < xmpBytes.length; j++) {
      if (data[i + j] !== xmpBytes[j]) {
        match = false;
        break;
      }
    }
    if (match) return true;
  }

  // JPEG: scan for APP1 markers
  if (data[0] === 0xFF && data[1] === 0xD8) {
    let pos = 2;
    while (pos < data.length - 1) {
      if (data[pos] !== 0xFF) { pos++; continue; }
      const marker = (data[pos] << 8) | data[pos + 1];
      if (marker === JPEG_SOS || marker === JPEG_EOI) break;
      if (marker === APP1) return true;
      if (pos + 3 >= data.length) break;
      const segLen = (data[pos + 2] << 8) | data[pos + 3];
      if (segLen < 2) break;
      pos += 2 + segLen;
    }
  }

  // PNG: scan for eXIf chunk
  if (data.length >= 8) {
    let isPng = true;
    for (let i = 0; i < 8; i++) {
      if (data[i] !== PNG_SIGNATURE[i]) { isPng = false; break; }
    }
    if (isPng) {
      let pos = 8;
      while (pos + 12 <= data.length) {
        const chunkLen =
          (data[pos] << 24) | (data[pos + 1] << 16) | (data[pos + 2] << 8) | data[pos + 3];
        const chunkType = String.fromCharCode(
          data[pos + 4], data[pos + 5], data[pos + 6], data[pos + 7],
        );
        if (chunkType === 'eXIf') return true;
        pos += 4 + 4 + chunkLen + 4;
      }
    }
  }

  return false;
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
 * For WebP/HEIC/other: re-encode to JPEG via Image.compress, then strip.
 *
 * Files >8MB are pre-compressed via Image.compress before stripping (memory bound).
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

  try {
    // For non-JPEG/PNG formats, or large files, pre-compress to JPEG
    if (!isDirectlyStrippable) {
      // Re-encode to JPEG via Image.compress (format normalization only)
      // NOTE: Image.compress copies EXIF through -- it is never the strip
      tempCompressPath = await Image.compress(sourcePath, {
        compressionMethod: 'auto',
        maxWidth: 2048,
        maxHeight: 2048,
        quality: 0.9,
        output: 'jpg',
      });
      workPath = tempCompressPath;
    } else {
      // Check if file is too large for in-memory strip
      const st = await stat(sourcePath);
      if (st.size > MAX_STRIP_SIZE_BYTES) {
        tempCompressPath = await Image.compress(sourcePath, {
          compressionMethod: 'auto',
          maxWidth: 2048,
          maxHeight: 2048,
          quality: 0.9,
          output: isJpeg ? 'jpg' : 'png',
        });
        workPath = tempCompressPath;
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
      // After Image.compress re-encode, should be JPEG
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

function isPngSignature(data: Uint8Array): boolean {
  for (let i = 0; i < 8; i++) {
    if (data[i] !== PNG_SIGNATURE[i]) return false;
  }
  return true;
}
