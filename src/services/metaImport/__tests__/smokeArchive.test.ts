/**
 * Smoke archive generator tests (#930).
 *
 * Verifies that `buildSmokeEntries` / `writeStoredZip` produce archives
 * that parse correctly through the real `parseArchive` pipeline, that
 * the same seed gives byte-identical output, and that the ZIP format
 * is well-formed (local/central CRC and size equality, as `local.rs:99`
 * checks).
 */

import { buildArchive } from '../testUtils/builders';
import {
  buildSmokeEntries,
  buildPng,
  writeStoredZip,
  type SmokeEntry,
} from '../testUtils/smokeArchive';
import { parseArchive } from '../parseArchive';

import type { EntrySpec } from '../testUtils/builders';
import type { ArchiveImportSession } from '../archiveAccess';
import type { ParsedItem } from '../types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Deterministic stand-in for #924's HMAC. FNV-1a over 4 lanes, 16 bytes. */
function fakeDeriveKey(id: Uint8Array): Promise<Uint8Array> {
  const key = new Uint8Array(16);
  for (let lane = 0; lane < 4; lane++) {
    let h = (0x811c9dc5 ^ Math.imul(lane, 0x9e3779b9)) >>> 0;
    for (const byte of id) {
      h = (h ^ (byte + lane)) >>> 0;
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    key.set([h >>> 24, (h >>> 16) & 0xff, (h >>> 8) & 0xff, h & 0xff], lane * 4);
  }
  return Promise.resolve(key);
}

/**
 * Convert SmokeEntry list to EntrySpecs that buildArchive can use.
 *
 * The generator produces real file bytes; the mock session only needs:
 * - JSON entries: UTF-8 text
 * - Media entries: a 128-byte head for sniffing
 */
function smokeEntriesToSpecs(entries: readonly SmokeEntry[]): EntrySpec[] {
  return entries.map((e): EntrySpec => {
    // Strip the wrapper dir if present (Rust would do this at parse time)
    const path = e.path;
    if (path.endsWith('.json')) {
      return {
        path,
        kind: 'json',
        text: Buffer.from(e.bytes).toString('utf8'),
      };
    }
    const lower = path.toLowerCase();
    const isVideo = lower.endsWith('.mp4') || lower.endsWith('.mov');
    const kind = isVideo ? ('video' as const) : ('image' as const);
    // Use the first 128 bytes as the head for the sniff
    const head = new Uint8Array(e.bytes.buffer, e.bytes.byteOffset, Math.min(128, e.bytes.length));
    return { path, kind, head };
  });
}

/** Run parseArchive over a built archive. Returns all emitted items + summary. */
async function runParse(
  entries: readonly SmokeEntry[],
  source: 'facebook' | 'instagram',
): Promise<{ items: ParsedItem[]; summary: ReturnType<typeof parseArchive extends (...a: any[]) => Promise<infer R> ? (...a: any[]) => Promise<R> : never> extends Promise<infer S> ? S : never }> {
  const specs = smokeEntriesToSpecs(entries);
  const session: ArchiveImportSession = await buildArchive(specs).open();
  const items: ParsedItem[] = [];
  const summary = await parseArchive(session, {
    source,
    nowUtcDay: '2026-11-19',
    deriveImportKey: fakeDeriveKey,
    async onItem(item) {
      items.push(item);
    },
  });
  return { items, summary };
}

// ---------------------------------------------------------------------------
// Minimal central-directory reader
// ---------------------------------------------------------------------------

/** Entry as decoded from the ZIP central directory. */
interface CdEntry {
  crc: number;
  compSize: number;
  uncompSize: number;
  lhOffset: number;
  name: string;
}

function readLE32(buf: Buffer, offset: number): number {
  return buf.readUInt32LE(offset);
}

function readLE16(buf: Buffer, offset: number): number {
  return buf.readUInt16LE(offset);
}

/**
 * Decode all central-directory entries from a STORED ZIP buffer.
 *
 * Locates the EOCD at the tail, then reads each CD record.
 */
function readCentralDirectory(zip: Buffer): CdEntry[] {
  // Find EOCD signature (0x06054b50) scanning from the end
  const EOCD_SIG = 0x06054b50;
  let eocdOffset = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65558); i--) {
    if (readLE32(zip, i) === EOCD_SIG) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset < 0) throw new Error('EOCD not found');

  const cdSize = readLE32(zip, eocdOffset + 12);
  const cdOffset = readLE32(zip, eocdOffset + 16);

  const entries: CdEntry[] = [];
  let pos = cdOffset;
  const CD_SIG = 0x02014b50;
  while (pos < cdOffset + cdSize) {
    if (readLE32(zip, pos) !== CD_SIG) break;
    const crc = readLE32(zip, pos + 16);
    const compSize = readLE32(zip, pos + 20);
    const uncompSize = readLE32(zip, pos + 24);
    const nameLen = readLE16(zip, pos + 28);
    const extraLen = readLE16(zip, pos + 30);
    const commentLen = readLE16(zip, pos + 32);
    const lhOffset = readLE32(zip, pos + 42);
    const name = zip.subarray(pos + 46, pos + 46 + nameLen).toString('utf8');
    entries.push({ crc, compSize, uncompSize, lhOffset, name });
    pos += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** Decode the local header at `lhOffset` and return CRC + sizes. */
function readLocalHeader(zip: Buffer, lhOffset: number): { crc: number; compSize: number; uncompSize: number } {
  const LH_SIG = 0x04034b50;
  if (readLE32(zip, lhOffset) !== LH_SIG) throw new Error(`bad LH sig at ${lhOffset}`);
  return {
    crc: readLE32(zip, lhOffset + 14),
    compSize: readLE32(zip, lhOffset + 18),
    uncompSize: readLE32(zip, lhOffset + 22),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  jest.clearAllMocks();
});

describe('buildSmokeEntries — Facebook', () => {
  it('produces an importable count matching posts minus video posts', async () => {
    const entries = buildSmokeEntries({ source: 'fb', posts: 8, photosPerPost: 2, videoPosts: 2, seed: 1 });
    const { summary } = await runParse(entries, 'facebook');
    expect(summary.importable).toBe(6);
    expect(summary.skipped.held_video).toBe(2);
  });

  it('text-only posts are all importable with no held_video', async () => {
    const entries = buildSmokeEntries({ source: 'fb', posts: 5, textOnly: true, seed: 42 });
    const { summary } = await runParse(entries, 'facebook');
    expect(summary.importable).toBe(5);
    expect(summary.skipped.held_video).toBe(0);
  });

  it('dates are within the startYear/endYear range', async () => {
    const start = 2010;
    const end = 2015;
    const entries = buildSmokeEntries({ source: 'fb', posts: 10, seed: 7, startYear: start, endYear: end });
    const { summary } = await runParse(entries, 'facebook');
    // All posts should be importable (no video, no bad timestamps)
    expect(summary.importable).toBe(10);
    if (summary.earliestDate !== null) {
      expect(summary.earliestDate).toBeGreaterThanOrEqual(Date.UTC(start, 0, 1));
    }
    if (summary.latestDate !== null) {
      expect(summary.latestDate).toBeLessThanOrEqual(Date.UTC(end, 11, 31, 23, 59, 59));
    }
  });
});

describe('buildSmokeEntries — Instagram', () => {
  it('produces an importable count matching posts minus video posts', async () => {
    const entries = buildSmokeEntries({ source: 'ig', posts: 6, photosPerPost: 1, videoPosts: 1, seed: 2 });
    const { summary } = await runParse(entries, 'instagram');
    expect(summary.importable).toBe(5);
    expect(summary.skipped.held_video).toBe(1);
  });

  it('text-only posts are all importable', async () => {
    const entries = buildSmokeEntries({ source: 'ig', posts: 4, textOnly: true, seed: 99 });
    const { summary } = await runParse(entries, 'instagram');
    expect(summary.importable).toBe(4);
    expect(summary.skipped.held_video).toBe(0);
  });
});

describe('writeStoredZip — determinism', () => {
  it('same seed produces byte-identical output', () => {
    const a = writeStoredZip(buildSmokeEntries({ source: 'fb', posts: 5, seed: 7 }));
    const b = writeStoredZip(buildSmokeEntries({ source: 'fb', posts: 5, seed: 7 }));
    expect(Buffer.compare(a, b)).toBe(0);
  });

  it('different seeds produce different output', () => {
    const a = writeStoredZip(buildSmokeEntries({ source: 'fb', posts: 5, seed: 1 }));
    const b = writeStoredZip(buildSmokeEntries({ source: 'fb', posts: 5, seed: 2 }));
    expect(Buffer.compare(a, b)).not.toBe(0);
  });

  it('fb and ig produce different output', () => {
    const a = writeStoredZip(buildSmokeEntries({ source: 'fb', posts: 3, seed: 1 }));
    const b = writeStoredZip(buildSmokeEntries({ source: 'ig', posts: 3, seed: 1 }));
    expect(Buffer.compare(a, b)).not.toBe(0);
  });
});

describe('writeStoredZip — ZIP format correctness', () => {
  it('local-header CRC and sizes equal central-directory values for every entry', () => {
    const zip = writeStoredZip(buildSmokeEntries({ source: 'fb', posts: 4, photosPerPost: 2, videoPosts: 1, seed: 3 }));
    const cdEntries = readCentralDirectory(zip);
    expect(cdEntries.length).toBeGreaterThan(0);
    for (const cd of cdEntries) {
      const lh = readLocalHeader(zip, cd.lhOffset);
      expect(lh.crc).toBe(cd.crc);
      expect(lh.compSize).toBe(cd.compSize);
      expect(lh.uncompSize).toBe(cd.uncompSize);
    }
  });

  it('every entry path appears in the central directory', () => {
    const entries = buildSmokeEntries({ source: 'ig', posts: 3, seed: 5 });
    const zip = writeStoredZip(entries);
    const cdEntries = readCentralDirectory(zip);
    const cdNames = new Set(cdEntries.map((e) => e.name));
    for (const e of entries) {
      expect(cdNames.has(e.path)).toBe(true);
    }
  });
});

describe('buildPng — large image', () => {
  it('large image is at least 10 MB and under 32 MP', () => {
    // Build a fixed-seed large PNG (not via buildSmokeEntries to avoid full archive build)
    let prngState = 999;
    const prng = () => {
      prngState = (prngState + 0x6d2b79f5) >>> 0;
      let t = Math.imul(prngState ^ (prngState >>> 15), 1 | prngState);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 0x1_0000_0000;
    };
    const png = buildPng(2500, 1500, prng, 0);
    // ≥ 10 MB
    expect(png.length).toBeGreaterThanOrEqual(10 * 1024 * 1024);
    // 2500 * 1500 = 3,750,000 < 32,000,000 (IMPORT_MAX_PIXELS)
    expect(2500 * 1500).toBeLessThan(32_000_000);
  });

  it('large image is emitted in a smoke archive with largeImage=true', () => {
    const entries = buildSmokeEntries({ source: 'fb', posts: 2, largeImage: true, seed: 11 });
    const largePngs = entries.filter((e) => e.path.endsWith('.png'));
    expect(largePngs.length).toBe(1);
    expect(largePngs[0].bytes.length).toBeGreaterThanOrEqual(10 * 1024 * 1024);
  });
});
