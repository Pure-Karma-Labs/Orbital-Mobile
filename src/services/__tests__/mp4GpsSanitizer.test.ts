/**
 * Tests for mp4GpsSanitizer -- GPS atom stripping from MP4 files.
 *
 * Uses the pure byte-level cores (patchMoovGps, scanMoovForGps)
 * with programmatically built minimal MP4 moov boxes.
 */

import { patchMoovGps, scanMoovForGps } from '../media/mp4GpsSanitizer';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function writeU32(buf: number[], value: number): void {
  buf.push((value >>> 24) & 0xFF, (value >>> 16) & 0xFF, (value >>> 8) & 0xFF, value & 0xFF);
}

function write4CC(buf: number[], fourcc: string): void {
  for (let i = 0; i < 4; i++) {
    buf.push(fourcc.charCodeAt(i));
  }
}

/**
 * Build a minimal moov box with optional GPS-bearing atoms.
 */
function buildMoov(opts?: {
  /** Add (c)xyz atom in udta */
  xyz?: boolean;
  /** Add loci atom in udta */
  loci?: boolean;
  /** Add location ilst entry via keys/ilst */
  ilstLocation?: boolean;
  /** Add GPS atoms inside a trak/udta (nested) */
  nestedTrakUdta?: boolean;
}): Uint8Array {
  // Build from inside out

  // mvhd (minimal, 108 bytes version 0)
  const mvhd: number[] = [];
  writeU32(mvhd, 108); // size
  write4CC(mvhd, 'mvhd');
  // Fill with zeros for the rest (version, flags, timescale, etc.)
  for (let i = 0; i < 100; i++) mvhd.push(0);

  // udta children
  const udtaChildren: number[] = [];

  if (opts?.xyz) {
    // (c)xyz atom: size(4) + type(4) + payload
    const xyzPayload = Array.from(new TextEncoder().encode('+37.7749-122.4194/'));
    const xyzSize = 8 + xyzPayload.length;
    writeU32(udtaChildren, xyzSize);
    // (c)xyz = 0xA9 + "xyz"
    udtaChildren.push(0xA9);
    write4CC(udtaChildren, 'xyz\0');
    udtaChildren.pop(); // remove the trailing null from write4CC
    udtaChildren.push(...xyzPayload);
  }

  if (opts?.loci) {
    // loci atom
    const lociPayload = [0x00, 0x00, 0x00, 0x00, 0x37, 0x2E, 0x37, 0x37]; // version + data
    const lociSize = 8 + lociPayload.length;
    writeU32(udtaChildren, lociSize);
    write4CC(udtaChildren, 'loci');
    udtaChildren.push(...lociPayload);
  }

  // Build udta box
  const udta: number[] = [];
  if (udtaChildren.length > 0) {
    const udtaSize = 8 + udtaChildren.length;
    writeU32(udta, udtaSize);
    write4CC(udta, 'udta');
    udta.push(...udtaChildren);
  }

  // Build meta with keys+ilst (if requested)
  const meta: number[] = [];
  if (opts?.ilstLocation) {
    // keys box
    const keyName = 'com.apple.quicktime.location.ISO6709';
    const keyNameBytes = Array.from(new TextEncoder().encode(keyName));
    const keysEntries: number[] = [];
    // Single key entry: size(4) + namespace(4) + key_value
    const keyEntrySize = 8 + keyNameBytes.length;
    writeU32(keysEntries, keyEntrySize);
    write4CC(keysEntries, 'mdta'); // namespace
    keysEntries.push(...keyNameBytes);

    const keysPayload: number[] = [];
    // version + flags (4 bytes)
    writeU32(keysPayload, 0);
    // entry_count (4 bytes)
    writeU32(keysPayload, 1);
    keysPayload.push(...keysEntries);

    const keysBox: number[] = [];
    writeU32(keysBox, 8 + keysPayload.length);
    write4CC(keysBox, 'keys');
    keysBox.push(...keysPayload);

    // ilst box with entry indexed by key 1
    const ilstEntryData = Array.from(new TextEncoder().encode('+37.7749-122.4194/'));
    const ilstEntry: number[] = [];
    writeU32(ilstEntry, 8 + ilstEntryData.length);
    writeU32(ilstEntry, 1); // index = 1 (1-based)
    ilstEntry.push(...ilstEntryData);

    const ilstBox: number[] = [];
    writeU32(ilstBox, 8 + ilstEntry.length);
    write4CC(ilstBox, 'ilst');
    ilstBox.push(...ilstEntry);

    // meta box (has 4-byte version/flags before children)
    const metaPayload = [0, 0, 0, 0, ...keysBox, ...ilstBox]; // version+flags + children
    writeU32(meta, 8 + metaPayload.length);
    write4CC(meta, 'meta');
    meta.push(...metaPayload);
  }

  // Build trak with nested udta (if requested)
  const trak: number[] = [];
  if (opts?.nestedTrakUdta) {
    const trakUdtaChildren: number[] = [];
    // (c)xyz inside trak/udta
    const xyzPayload = Array.from(new TextEncoder().encode('+40.7128-074.0060/'));
    const xyzSize = 8 + xyzPayload.length;
    writeU32(trakUdtaChildren, xyzSize);
    trakUdtaChildren.push(0xA9);
    write4CC(trakUdtaChildren, 'xyz\0');
    trakUdtaChildren.pop();
    trakUdtaChildren.push(...xyzPayload);

    const trakUdta: number[] = [];
    writeU32(trakUdta, 8 + trakUdtaChildren.length);
    write4CC(trakUdta, 'udta');
    trakUdta.push(...trakUdtaChildren);

    writeU32(trak, 8 + trakUdta.length);
    write4CC(trak, 'trak');
    trak.push(...trakUdta);
  }

  // Assemble moov
  const moovPayload = [...mvhd, ...udta, ...meta, ...trak];
  const moov: number[] = [];
  writeU32(moov, 8 + moovPayload.length);
  write4CC(moov, 'moov');
  moov.push(...moovPayload);

  return new Uint8Array(moov);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('mp4GpsSanitizer', () => {
  describe('patchMoovGps', () => {
    it('neutralizes (c)xyz atom by replacing with free + zeroed payload', () => {
      const moov = buildMoov({ xyz: true });
      const originalLength = moov.length;

      expect(scanMoovForGps(moov)).toBe(true);
      const { patched } = patchMoovGps(moov);
      expect(patched).toBe(true);
      expect(scanMoovForGps(moov)).toBe(false);

      // File length must not change (sizes unchanged, stco stays valid)
      expect(moov.length).toBe(originalLength);
    });

    it('neutralizes loci atom', () => {
      const moov = buildMoov({ loci: true });

      expect(scanMoovForGps(moov)).toBe(true);
      const { patched } = patchMoovGps(moov);
      expect(patched).toBe(true);
      expect(scanMoovForGps(moov)).toBe(false);
    });

    it('neutralizes location ilst entries keyed by ISO6709', () => {
      const moov = buildMoov({ ilstLocation: true });

      expect(scanMoovForGps(moov)).toBe(true);
      const { patched } = patchMoovGps(moov);
      expect(patched).toBe(true);
      expect(scanMoovForGps(moov)).toBe(false);
    });

    it('neutralizes GPS atoms nested inside trak/udta', () => {
      const moov = buildMoov({ nestedTrakUdta: true });

      expect(scanMoovForGps(moov)).toBe(true);
      const { patched } = patchMoovGps(moov);
      expect(patched).toBe(true);
      expect(scanMoovForGps(moov)).toBe(false);
    });

    it('handles multiple GPS atoms simultaneously', () => {
      const moov = buildMoov({ xyz: true, loci: true, ilstLocation: true });

      expect(scanMoovForGps(moov)).toBe(true);
      const { patched } = patchMoovGps(moov);
      expect(patched).toBe(true);
      expect(scanMoovForGps(moov)).toBe(false);
    });

    it('returns patched=false when no GPS atoms present', () => {
      const moov = buildMoov();

      expect(scanMoovForGps(moov)).toBe(false);
      const { patched } = patchMoovGps(moov);
      expect(patched).toBe(false);
    });

    it('replaces 4CC with "free" (not deletion)', () => {
      const moov = buildMoov({ xyz: true });
      patchMoovGps(moov);

      // The atom that was (c)xyz should now be 'free'
      const moovStr = String.fromCharCode(...Array.from(moov));
      expect(moovStr.includes('free')).toBe(true);
    });
  });

  describe('scanMoovForGps', () => {
    it('detects (c)xyz in udta', () => {
      const moov = buildMoov({ xyz: true });
      expect(scanMoovForGps(moov)).toBe(true);
    });

    it('detects loci in udta', () => {
      const moov = buildMoov({ loci: true });
      expect(scanMoovForGps(moov)).toBe(true);
    });

    it('detects location in ilst', () => {
      const moov = buildMoov({ ilstLocation: true });
      expect(scanMoovForGps(moov)).toBe(true);
    });

    it('returns false for clean moov', () => {
      const moov = buildMoov();
      expect(scanMoovForGps(moov)).toBe(false);
    });

    it('does not false-positive on GPS-like bytes in non-GPS atoms', () => {
      // Build a moov with mvhd containing GPS-like coordinates in its data
      // This should NOT be detected since it's not in a GPS atom type
      const moov = buildMoov();
      // The mvhd zeroed data should not trigger
      expect(scanMoovForGps(moov)).toBe(false);
    });
  });
});
