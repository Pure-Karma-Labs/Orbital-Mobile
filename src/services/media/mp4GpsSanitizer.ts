/**
 * MP4 GPS metadata sanitizer -- strips location atoms from MP4/MOV files.
 *
 * SECURITY: react-native-compressor actively preserves and re-injects GPS
 * metadata. This sanitizer is the authoritative strip for video files.
 *
 * Strategy: Parse top-level boxes to find `moov`, read `moov` fully (reject if
 * >16MB), recursively neutralize location-bearing atoms:
 * - (c)xyz (Apple QuickTime location)
 * - loci (3GPP location)
 * - ilst entries whose keys name contains "location" (ISO metadata)
 *
 * Neutralization: rewrite 4CC to `free`, zero payload. Sizes unchanged so
 * chunk offsets (stco/co64) remain valid. Written back in-place via RNFS
 * write(path, contents, position).
 *
 * Independent verification pass (verifyNoGpsAtoms) scans structural boxes
 * only (never mdat). Throws user-facing error if GPS detected (fail-closed).
 *
 * Pure cores (patchMoovGps, scanMoovForGps) exported for Jest.
 */

import {
  read,
  stat,
  write,
} from '@dr.pogodin/react-native-fs';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum allowed moov box size (16MB). Reject if larger to bound memory. */
const MAX_MOOV_SIZE = 16 * 1024 * 1024;

/** GPS-bearing atom 4CCs to neutralize */
const GPS_ATOMS = new Set(['©xyz', 'loci']);

/** ISO-6709 coordinate pattern (e.g. +37.7749-122.4194) */
const ISO6709_RE = /[+-]\d{2,3}\.\d+[+-]\d{2,3}\.\d+/;

/** 4CC for `free` box (neutralization target) */
const FREE_4CC = new Uint8Array([0x66, 0x72, 0x65, 0x65]); // 'free'

// ---------------------------------------------------------------------------
// Helpers
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
 * Read a 32-bit big-endian unsigned integer from a Uint8Array.
 */
function readU32(data: Uint8Array, offset: number): number {
  return (
    ((data[offset] << 24) >>> 0) +
    (data[offset + 1] << 16) +
    (data[offset + 2] << 8) +
    data[offset + 3]
  );
}

/**
 * Read a 64-bit big-endian unsigned integer from a Uint8Array.
 * Returns as a number (safe for sizes up to ~9PB).
 */
function readU64(data: Uint8Array, offset: number): number {
  // High 32 bits * 2^32 + low 32 bits
  const hi = readU32(data, offset);
  const lo = readU32(data, offset + 4);
  return hi * 0x100000000 + lo;
}

/**
 * Read 4CC (4-character code) from a Uint8Array.
 */
function read4CC(data: Uint8Array, offset: number): string {
  return String.fromCharCode(
    data[offset], data[offset + 1], data[offset + 2], data[offset + 3],
  );
}

// ---------------------------------------------------------------------------
// Pure core: patch moov GPS atoms
// ---------------------------------------------------------------------------

/**
 * Patch a moov box buffer to neutralize GPS-bearing atoms.
 *
 * Walks all children recursively. For GPS atoms, overwrites the 4CC with 'free'
 * and zeros the payload. Size bytes are unchanged so stco/co64 remain valid.
 *
 * Also detects location ilst entries (ISO metadata where the keys table
 * contains "location").
 *
 * @param moov The complete moov box bytes (including the 8-byte header)
 * @returns { patched: boolean } indicating whether any atoms were neutralized
 */
export function patchMoovGps(moov: Uint8Array): { patched: boolean } {
  let patched = false;

  // Collect keys table entries for ilst location detection
  const keysEntries: Array<{ index: number; name: string }> = [];

  function walkBoxes(data: Uint8Array, start: number, end: number): void {
    let pos = start;

    while (pos + 8 <= end) {
      let boxSize = readU32(data, pos);
      const boxType = read4CC(data, pos + 4);

      // Handle 64-bit extended size
      let headerSize = 8;
      if (boxSize === 1 && pos + 16 <= end) {
        boxSize = readU64(data, pos + 8);
        headerSize = 16;
      } else if (boxSize === 0) {
        // Box extends to end of container
        boxSize = end - pos;
      }

      if (boxSize < headerSize || pos + boxSize > end) {
        break; // Malformed -- stop walking
      }

      const payloadStart = pos + headerSize;
      const payloadEnd = pos + boxSize;

      // Check if this is a GPS atom to neutralize
      if (GPS_ATOMS.has(boxType)) {
        // Overwrite 4CC with 'free'
        data[pos + 4] = FREE_4CC[0];
        data[pos + 5] = FREE_4CC[1];
        data[pos + 6] = FREE_4CC[2];
        data[pos + 7] = FREE_4CC[3];
        // Zero the payload
        for (let i = payloadStart; i < payloadEnd; i++) {
          data[i] = 0;
        }
        patched = true;
        pos += boxSize;
        continue;
      }

      // Collect keys entries for ilst detection
      if (boxType === 'keys' && payloadStart + 8 <= payloadEnd) {
        // keys box format: version(4) + entry_count(4) + entries
        const entryCount = readU32(data, payloadStart + 4);
        let keyPos = payloadStart + 8;
        for (let i = 0; i < entryCount && keyPos + 8 <= payloadEnd; i++) {
          const keySize = readU32(data, keyPos);
          if (keySize < 8 || keyPos + keySize > payloadEnd) break;
          // key namespace (4 bytes) + key value string
          const keyName = String.fromCharCode(
            ...Array.from(data.slice(keyPos + 8, keyPos + keySize)),
          );
          keysEntries.push({ index: i + 1, name: keyName }); // 1-based index
          keyPos += keySize;
        }
      }

      // Check ilst children against collected keys
      if (boxType === 'ilst' && keysEntries.length > 0) {
        // ilst children are indexed by key position (1-based, big-endian 32-bit)
        let ilstPos = payloadStart;
        while (ilstPos + 8 <= payloadEnd) {
          let itemSize = readU32(data, ilstPos);
          const itemIndex = readU32(data, ilstPos + 4);

          if (itemSize === 1 && ilstPos + 16 <= payloadEnd) {
            itemSize = readU64(data, ilstPos + 8);
          } else if (itemSize === 0) {
            itemSize = payloadEnd - ilstPos;
          }

          if (itemSize < 8 || ilstPos + itemSize > payloadEnd) break;

          // Check if this key's name contains 'location'
          const matchingKey = keysEntries.find(k => k.index === itemIndex);
          if (matchingKey && matchingKey.name.toLowerCase().includes('location')) {
            // Neutralize: overwrite 4CC (index) with 'free' and zero payload
            data[ilstPos + 4] = FREE_4CC[0];
            data[ilstPos + 5] = FREE_4CC[1];
            data[ilstPos + 6] = FREE_4CC[2];
            data[ilstPos + 7] = FREE_4CC[3];
            for (let i = ilstPos + 8; i < ilstPos + itemSize; i++) {
              data[i] = 0;
            }
            patched = true;
          }

          ilstPos += itemSize;
        }
      }

      // Container boxes: recurse into children
      const containers = new Set([
        'moov', 'trak', 'mdia', 'minf', 'stbl', 'udta', 'meta', 'edts',
      ]);
      if (containers.has(boxType)) {
        let childStart = payloadStart;
        // meta box has a 4-byte version/flags field before children
        if (boxType === 'meta') {
          childStart = payloadStart + 4;
        }
        walkBoxes(data, childStart, payloadEnd);
      }

      pos += boxSize;
    }
  }

  // Walk from moov's payload (skip the 8-byte moov header)
  const moovSize = readU32(moov, 0);
  const moovType = read4CC(moov, 4);
  let moovPayloadStart = 8;
  if (moovType !== 'moov') {
    // Shouldn't happen but be defensive
    return { patched: false };
  }
  if (moovSize === 1 && moov.length >= 16) {
    moovPayloadStart = 16;
  }

  walkBoxes(moov, moovPayloadStart, moov.length);

  return { patched };
}

/**
 * Scan a moov box buffer for any remaining GPS atoms.
 *
 * Independent of patchMoovGps -- uses its own walk logic so a bug in
 * the patch code can't blind the verification.
 *
 * @param moov The complete moov box bytes
 * @returns true if any GPS atoms are found
 */
export function scanMoovForGps(moov: Uint8Array): boolean {
  const keysEntries: Array<{ index: number; name: string }> = [];

  function walkBoxes(data: Uint8Array, start: number, end: number): boolean {
    let pos = start;

    while (pos + 8 <= end) {
      let boxSize = readU32(data, pos);
      const boxType = read4CC(data, pos + 4);

      let headerSize = 8;
      if (boxSize === 1 && pos + 16 <= end) {
        boxSize = readU64(data, pos + 8);
        headerSize = 16;
      } else if (boxSize === 0) {
        boxSize = end - pos;
      }

      if (boxSize < headerSize || pos + boxSize > end) break;

      const payloadStart = pos + headerSize;
      const payloadEnd = pos + boxSize;

      // Direct GPS atom check
      if (GPS_ATOMS.has(boxType)) {
        return true;
      }

      // Collect keys for ilst check
      if (boxType === 'keys' && payloadStart + 8 <= payloadEnd) {
        const entryCount = readU32(data, payloadStart + 4);
        let keyPos = payloadStart + 8;
        for (let i = 0; i < entryCount && keyPos + 8 <= payloadEnd; i++) {
          const keySize = readU32(data, keyPos);
          if (keySize < 8 || keyPos + keySize > payloadEnd) break;
          const keyName = String.fromCharCode(
            ...Array.from(data.slice(keyPos + 8, keyPos + keySize)),
          );
          keysEntries.push({ index: i + 1, name: keyName });
          keyPos += keySize;
        }
      }

      // Check ilst for location keys
      if (boxType === 'ilst' && keysEntries.length > 0) {
        let ilstPos = payloadStart;
        while (ilstPos + 8 <= payloadEnd) {
          let itemSize = readU32(data, ilstPos);
          const itemIndex = readU32(data, ilstPos + 4);

          if (itemSize === 1 && ilstPos + 16 <= payloadEnd) {
            itemSize = readU64(data, ilstPos + 8);
          } else if (itemSize === 0) {
            itemSize = payloadEnd - ilstPos;
          }

          if (itemSize < 8 || ilstPos + itemSize > payloadEnd) break;

          const matchingKey = keysEntries.find(k => k.index === itemIndex);
          if (matchingKey && matchingKey.name.toLowerCase().includes('location')) {
            return true;
          }

          ilstPos += itemSize;
        }
      }

      // Recurse into container boxes
      const containers = new Set([
        'moov', 'trak', 'mdia', 'minf', 'stbl', 'udta', 'meta', 'edts',
      ]);
      if (containers.has(boxType)) {
        let childStart = payloadStart;
        if (boxType === 'meta') {
          childStart = payloadStart + 4;
        }
        if (walkBoxes(data, childStart, payloadEnd)) return true;
      }

      pos += boxSize;
    }

    return false;
  }

  let moovPayloadStart = 8;
  if (moov.length >= 16 && readU32(moov, 0) === 1) {
    moovPayloadStart = 16;
  }

  return walkBoxes(moov, moovPayloadStart, moov.length);
}

// ---------------------------------------------------------------------------
// File-level operations (RNFS-backed)
// ---------------------------------------------------------------------------

/**
 * Find the moov box in an MP4 file via top-level box walk.
 *
 * @param filePath Absolute path to the MP4 file
 * @returns { offset, size } of the moov box, or null if not found
 */
async function findMoovBox(filePath: string): Promise<{
  offset: number;
  size: number;
} | null> {
  const st = await stat(filePath);
  const fileSize = st.size;
  let pos = 0;

  while (pos + 8 <= fileSize) {
    // Read 8 bytes for box header
    const headerB64 = await read(filePath, 8, pos, 'base64');
    const header = base64ToUint8Array(headerB64);

    let boxSize = readU32(header, 0);
    const boxType = read4CC(header, 4);

    if (boxSize === 1) {
      // 64-bit extended size
      if (pos + 16 > fileSize) break;
      const extB64 = await read(filePath, 8, pos + 8, 'base64');
      const ext = base64ToUint8Array(extB64);
      boxSize = readU64(ext, 0);
    } else if (boxSize === 0) {
      boxSize = fileSize - pos;
    }

    if (boxSize < 8 || pos + boxSize > fileSize) break;

    if (boxType === 'moov') {
      return { offset: pos, size: boxSize };
    }

    pos += boxSize;
  }

  return null;
}

/**
 * Sanitize an MP4 file by removing GPS/location metadata from the moov box.
 *
 * Reads the moov box, patches GPS atoms in memory, writes back in-place.
 * Sizes are unchanged so chunk offsets remain valid.
 *
 * @param filePath Absolute path to the MP4 file (modified in-place)
 * @throws Error if moov not found, moov too large, or file is not a valid MP4
 */
export async function sanitizeMp4Gps(filePath: string): Promise<void> {
  const moovInfo = await findMoovBox(filePath);
  if (!moovInfo) {
    // No moov box -- might not be a valid MP4 but we don't reject
    // (fail-closed verification will catch any GPS in verify step)
    return;
  }

  if (moovInfo.size > MAX_MOOV_SIZE) {
    throw new Error(
      'Video metadata section is too large to process safely. Please try a shorter video.',
    );
  }

  // Read the entire moov box
  const moovB64 = await read(filePath, moovInfo.size, moovInfo.offset, 'base64');
  const moov = base64ToUint8Array(moovB64);

  // Patch GPS atoms
  const { patched } = patchMoovGps(moov);

  if (patched) {
    // Write patched moov back in-place
    await write(filePath, uint8ArrayToBase64(moov), moovInfo.offset, 'base64');
  }

  // Scan for trailing ISO-6709 pattern (Samsung SEF-style trailers)
  // beyond the last top-level box
  const st = await stat(filePath);
  const fileSize = st.size;

  // Find end of last top-level box
  let pos = 0;
  let lastBoxEnd = 0;
  while (pos + 8 <= fileSize) {
    const headerB64 = await read(filePath, Math.min(16, fileSize - pos), pos, 'base64');
    const header = base64ToUint8Array(headerB64);

    let boxSize = readU32(header, 0);
    if (boxSize === 1 && header.length >= 16) {
      boxSize = readU64(header, 8);
    } else if (boxSize === 0) {
      boxSize = fileSize - pos;
    }

    if (boxSize < 8 || pos + boxSize > fileSize) break;
    pos += boxSize;
    lastBoxEnd = pos;
  }

  if (lastBoxEnd < fileSize) {
    // There are trailing bytes -- check for ISO-6709 pattern
    const trailerSize = fileSize - lastBoxEnd;
    if (trailerSize > 0 && trailerSize <= 1024 * 1024) {
      const trailerB64 = await read(filePath, trailerSize, lastBoxEnd, 'base64');
      const trailer = base64ToUint8Array(trailerB64);
      const trailerStr = String.fromCharCode(...Array.from(trailer));
      if (ISO6709_RE.test(trailerStr)) {
        throw new Error(
          'Could not remove location data from this video.',
        );
      }
    }
  }
}

/**
 * Verify that an MP4 file contains no GPS/location metadata.
 * Independent second pass over structural boxes only (never mdat).
 *
 * @param filePath Absolute path to the MP4 file
 * @throws Error if GPS metadata is detected
 */
export async function verifyNoGpsAtoms(filePath: string): Promise<void> {
  const moovInfo = await findMoovBox(filePath);
  if (!moovInfo) return; // No moov = no GPS

  if (moovInfo.size > MAX_MOOV_SIZE) {
    throw new Error(
      'Could not remove location data from this video.',
    );
  }

  const moovB64 = await read(filePath, moovInfo.size, moovInfo.offset, 'base64');
  const moov = base64ToUint8Array(moovB64);

  if (scanMoovForGps(moov)) {
    throw new Error(
      'Could not remove location data from this video.',
    );
  }

  // Also check for trailing ISO-6709 pattern
  const st = await stat(filePath);
  const fileSize = st.size;
  let pos = 0;
  let lastBoxEnd = 0;
  while (pos + 8 <= fileSize) {
    const headerB64 = await read(filePath, Math.min(16, fileSize - pos), pos, 'base64');
    const header = base64ToUint8Array(headerB64);
    let boxSize = readU32(header, 0);
    if (boxSize === 1 && header.length >= 16) {
      boxSize = readU64(header, 8);
    } else if (boxSize === 0) {
      boxSize = fileSize - pos;
    }
    if (boxSize < 8 || pos + boxSize > fileSize) break;
    pos += boxSize;
    lastBoxEnd = pos;
  }

  if (lastBoxEnd < fileSize) {
    const trailerSize = fileSize - lastBoxEnd;
    if (trailerSize > 0 && trailerSize <= 1024 * 1024) {
      const trailerB64 = await read(filePath, trailerSize, lastBoxEnd, 'base64');
      const trailer = base64ToUint8Array(trailerB64);
      const trailerStr = String.fromCharCode(...Array.from(trailer));
      if (ISO6709_RE.test(trailerStr)) {
        throw new Error(
          'Could not remove location data from this video.',
        );
      }
    }
  }
}
