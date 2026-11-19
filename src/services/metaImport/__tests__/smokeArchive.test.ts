/// <reference types="node" />
/**
 * Smoke archive generator tests (#930).
 *
 * Verifies that `buildSmokeEntries` / `writeStoredZip` produce archives
 * that parse correctly through the real `parseArchive` pipeline, that
 * the same seed gives byte-identical output, and that the ZIP format
 * is well-formed (local/central CRC and size equality, as `local.rs:99`
 * checks).
 */

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import zlib from 'node:zlib';

import { buildArchive, JPEG_HEAD } from '../testUtils/builders';
import {
  KNOWN_ROOT_KEYS,
  buildSmokeEntries,
  buildPng,
  writeStoredZip,
  type SmokeEntry,
} from '../testUtils/smokeArchive';
import { fakeDeriveImportKey } from '../testUtils/fakeImportKey';
import { parseArchive } from '../parseArchive';

import type { EntrySpec } from '../testUtils/builders';
import type { ArchiveImportSession } from '../archiveAccess';
import type { ParsedItem, ParsedPost, ParseSummary } from '../types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Convert SmokeEntry list to EntrySpecs that buildArchive can use.
 *
 * The generator produces real file bytes; the mock session only needs:
 * - JSON entries: UTF-8 text (kind: 'json' required since no inference for text)
 * - Media entries: a 128-byte head for sniffing; kind omitted so inferKind
 *   determines it from the extension (D4 — avoids duplicating extension logic)
 */
function smokeEntriesToSpecs(entries: readonly SmokeEntry[]): EntrySpec[] {
  return entries.map((e): EntrySpec => {
    const entryPath = e.path;
    if (entryPath.endsWith('.json')) {
      return {
        path: entryPath,
        kind: 'json',
        text: Buffer.from(e.bytes).toString('utf8'),
      };
    }
    // Use the first 128 bytes as the head for magic-byte sniffing
    const head = new Uint8Array(e.bytes.buffer, e.bytes.byteOffset, Math.min(128, e.bytes.length));
    return { path: entryPath, head };
  });
}

interface ParseResult {
  items: ParsedItem[];
  summary: ParseSummary;
}

/** Run parseArchive over a built archive. Returns all emitted items + summary. */
async function runParse(
  entries: readonly SmokeEntry[],
  source: 'facebook' | 'instagram',
): Promise<ParseResult> {
  const specs = smokeEntriesToSpecs(entries);
  const session: ArchiveImportSession = await buildArchive(specs).open();
  const items: ParsedItem[] = [];
  const summary = await parseArchive(session, {
    source,
    nowUtcDay: '2026-11-19',
    deriveImportKey: fakeDeriveImportKey,
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

/**
 * Decode all central-directory entries from a STORED ZIP buffer.
 *
 * Locates the EOCD at the tail, then reads each CD record.
 * Uses Buffer's own readUInt32LE/readUInt16LE directly — the pass-through
 * helpers were removed (D — no-op wrappers add noise).
 */
function readCentralDirectory(zip: Buffer): CdEntry[] {
  // Find EOCD signature (0x06054b50) scanning from the end
  const EOCD_SIG = 0x06054b50;
  let eocdOffset = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65558); i--) {
    if (zip.readUInt32LE(i) === EOCD_SIG) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset < 0) throw new Error('EOCD not found');

  const cdSize = zip.readUInt32LE(eocdOffset + 12);
  const cdOffset = zip.readUInt32LE(eocdOffset + 16);

  const entries: CdEntry[] = [];
  let pos = cdOffset;
  const CD_SIG = 0x02014b50;
  while (pos < cdOffset + cdSize) {
    if (zip.readUInt32LE(pos) !== CD_SIG) break;
    const crc = zip.readUInt32LE(pos + 16);
    const compSize = zip.readUInt32LE(pos + 20);
    const uncompSize = zip.readUInt32LE(pos + 24);
    const nameLen = zip.readUInt16LE(pos + 28);
    const extraLen = zip.readUInt16LE(pos + 30);
    const commentLen = zip.readUInt16LE(pos + 32);
    const lhOffset = zip.readUInt32LE(pos + 42);
    const name = zip.subarray(pos + 46, pos + 46 + nameLen).toString('utf8');
    entries.push({ crc, compSize, uncompSize, lhOffset, name });
    pos += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** Decode the local header at `lhOffset` and return CRC + sizes. */
function readLocalHeader(zip: Buffer, lhOffset: number): { crc: number; compSize: number; uncompSize: number } {
  const LH_SIG = 0x04034b50;
  if (zip.readUInt32LE(lhOffset) !== LH_SIG) throw new Error(`bad LH sig at ${lhOffset}`);
  return {
    crc: zip.readUInt32LE(lhOffset + 14),
    compSize: zip.readUInt32LE(lhOffset + 18),
    uncompSize: zip.readUInt32LE(lhOffset + 22),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

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
    // D1: assert bounds rather than silently skipping the checks when null
    expect(summary.earliestDate).not.toBeNull();
    expect(summary.latestDate).not.toBeNull();
    expect(summary.earliestDate!).toBeGreaterThanOrEqual(Date.UTC(start, 0, 1));
    expect(summary.latestDate!).toBeLessThanOrEqual(Date.UTC(end, 11, 31, 23, 59, 59));
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
    // Regular photos are now smoke_photo_*.png; the large image is smoke_large_*.png
    const largePngs = entries.filter((e) => /smoke_large_/.test(e.path));
    expect(largePngs.length).toBe(1);
    expect(largePngs[0].bytes.length).toBeGreaterThanOrEqual(10 * 1024 * 1024);
  });
});

// ---------------------------------------------------------------------------
// PNG verification helpers
// ---------------------------------------------------------------------------

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

interface PngChunk {
  type: string;
  data: Buffer;
  storedCrc: number;
}

/** Decode all chunks from a PNG buffer (after the 8-byte signature). */
function parsePngChunks(png: Buffer): PngChunk[] {
  let pos = 8; // skip signature
  const chunks: PngChunk[] = [];
  while (pos < png.length) {
    const dataLen = png.readUInt32BE(pos);
    const type = png.subarray(pos + 4, pos + 8).toString('ascii');
    const data = Buffer.from(png.subarray(pos + 8, pos + 8 + dataLen));
    const storedCrc = png.readUInt32BE(pos + 8 + dataLen);
    chunks.push({ type, data, storedCrc });
    pos += 12 + dataLen;
  }
  return chunks;
}

/** Compute CRC32 over (type_ascii + data), matching buildPng's pngChunk(). */
function chunkCrc(type: string, data: Buffer): number {
  const typeBuf = Buffer.from(type, 'ascii');
  return zlib.crc32(data, zlib.crc32(typeBuf)) >>> 0;
}

describe('buildSmokeEntries — regular photos are valid PNGs', () => {
  it('every smoke_photo entry has a valid PNG signature', () => {
    const entries = buildSmokeEntries({ source: 'fb', posts: 4, photosPerPost: 2, videoPosts: 1, seed: 55 });
    const photos = entries.filter((e) => /smoke_photo_/.test(e.path));
    expect(photos.length).toBeGreaterThan(0);
    for (const e of photos) {
      const buf = Buffer.from(e.bytes);
      expect(buf.subarray(0, 8).equals(PNG_SIG)).toBe(true);
    }
  });

  it('every smoke_photo entry has IHDR with width=64, height=64, colorType=RGB', () => {
    const entries = buildSmokeEntries({ source: 'ig', posts: 3, photosPerPost: 2, seed: 77 });
    const photos = entries.filter((e) => /smoke_photo_/.test(e.path));
    expect(photos.length).toBeGreaterThan(0);
    for (const e of photos) {
      const buf = Buffer.from(e.bytes);
      const chunks = parsePngChunks(buf);
      const ihdr = chunks.find((c) => c.type === 'IHDR');
      expect(ihdr).toBeDefined();
      if (!ihdr) continue;
      expect(ihdr.data.readUInt32BE(0)).toBe(64);  // width
      expect(ihdr.data.readUInt32BE(4)).toBe(64);  // height
      expect(ihdr.data[8]).toBe(8);                 // bit depth
      expect(ihdr.data[9]).toBe(2);                 // color type: RGB
    }
  });

  it('every smoke_photo IDAT inflates to height*(1+width*3) bytes', () => {
    const W = 64;
    const H = 64;
    const entries = buildSmokeEntries({ source: 'fb', posts: 3, photosPerPost: 1, seed: 88 });
    const photos = entries.filter((e) => /smoke_photo_/.test(e.path));
    expect(photos.length).toBeGreaterThan(0);
    for (const e of photos) {
      const buf = Buffer.from(e.bytes);
      const chunks = parsePngChunks(buf);
      const idatChunks = chunks.filter((c) => c.type === 'IDAT');
      expect(idatChunks.length).toBeGreaterThan(0);
      const compressed = Buffer.concat(idatChunks.map((c) => c.data));
      const raw = zlib.inflateSync(compressed);
      // Each row: 1 filter byte + W*3 RGB bytes
      expect(raw.length).toBe(H * (1 + W * 3));
    }
  });

  it('every chunk CRC in every smoke_photo matches the computed CRC', () => {
    const entries = buildSmokeEntries({ source: 'fb', posts: 3, photosPerPost: 2, seed: 99 });
    const photos = entries.filter((e) => /smoke_photo_/.test(e.path));
    expect(photos.length).toBeGreaterThan(0);
    for (const e of photos) {
      const buf = Buffer.from(e.bytes);
      const chunks = parsePngChunks(buf);
      for (const chunk of chunks) {
        expect(chunkCrc(chunk.type, chunk.data)).toBe(chunk.storedCrc);
      }
    }
  });

  it('no two smoke_photo byte arrays are identical', () => {
    const entries = buildSmokeEntries({ source: 'fb', posts: 5, photosPerPost: 2, seed: 111 });
    const photos = entries.filter((e) => /smoke_photo_/.test(e.path));
    expect(photos.length).toBeGreaterThan(1);
    for (let i = 0; i < photos.length; i++) {
      for (let j = i + 1; j < photos.length; j++) {
        expect(Buffer.compare(Buffer.from(photos[i].bytes), Buffer.from(photos[j].bytes))).not.toBe(0);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// B4 — wrapperDir known-root-key guard
// ---------------------------------------------------------------------------

describe('buildSmokeEntries — wrapperDir guard (B4)', () => {
  it('throws when wrapperDir is a known root key', () => {
    // Pick any value from KNOWN_ROOT_KEYS — Rust would not strip it,
    // causing the archive to appear empty to the parser.
    const knownKey = KNOWN_ROOT_KEYS.values().next().value as string;
    expect(() => buildSmokeEntries({ source: 'fb', posts: 1, wrapperDir: knownKey })).toThrow(
      /known root key/,
    );
  });

  it('accepts a custom wrapperDir that is not a known root key', () => {
    // D3: previously this was not tested; a valid custom name must work without throwing
    const entries = buildSmokeEntries({ source: 'fb', posts: 2, seed: 1, wrapperDir: 'my_export' });
    expect(entries.length).toBeGreaterThan(0);
    // Every path is prefixed with the custom wrapper
    for (const e of entries) {
      expect(e.path).toMatch(/^my_export\//);
    }
  });
});

// ---------------------------------------------------------------------------
// D2 — GPS fixture round-trip
// ---------------------------------------------------------------------------

describe('buildSmokeEntries — GPS fixture (D2)', () => {
  it('GPS photo entry uses provided gpsJpgBytes and parses as importable', async () => {
    // Use JPEG_HEAD as the GPS fixture — the GPS metadata lives in the JSON,
    // not in the image bytes, so any valid JPEG magic is sufficient.
    const gpsJpgBytes = new Uint8Array(JPEG_HEAD);
    const entries = buildSmokeEntries({ source: 'fb', posts: 2, seed: 1, gps: true, gpsJpgBytes });
    const gpsPaths = entries.filter((e) => /smoke_gps_/.test(e.path));
    expect(gpsPaths.length).toBe(1);
    const { summary } = await runParse(entries, 'facebook');
    expect(summary.importable).toBeGreaterThan(0);
  });

  it('throws when gps=true and gpsJpgBytes is not provided', () => {
    expect(() => buildSmokeEntries({ source: 'fb', posts: 1, seed: 1, gps: true })).toThrow(
      /gpsJpgBytes is required/,
    );
  });
});

// ---------------------------------------------------------------------------
// A1 — Instagram single-media post shape
// ---------------------------------------------------------------------------

describe('buildSmokeEntries — IG single-media shape (A1)', () => {
  it('single-media IG posts parse without post-level timestamp/title', async () => {
    // photosPerPost=1 produces single-media posts for all photo entries.
    const entries = buildSmokeEntries({ source: 'ig', posts: 3, photosPerPost: 1, seed: 3 });
    const { summary } = await runParse(entries, 'instagram');
    // All 3 should be importable — date and caption come from media[0].
    expect(summary.importable).toBe(3);
  });

  it('carousel IG posts (photosPerPost>1) remain importable', async () => {
    const entries = buildSmokeEntries({ source: 'ig', posts: 2, photosPerPost: 3, seed: 4 });
    const { summary } = await runParse(entries, 'instagram');
    expect(summary.importable).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// A2 — Mojibake caption repair round-trip
// ---------------------------------------------------------------------------

describe('buildSmokeEntries — mojibake caption repair (A2)', () => {
  it('FB: first post caption is repaired through parseArchive', async () => {
    const entries = buildSmokeEntries({ source: 'fb', posts: 1, seed: 1 });
    const { items } = await runParse(entries, 'facebook');
    const post = items.find((item) => item.outcome === 'import') as ParsedPost | undefined;
    expect(post).not.toBeUndefined();
    // 'Café 📸' — the mojibakeEscape round-trip must land here.
    expect(post!.body).toBe('Café 📸');
  });

  it('IG: first single-media post caption (on media[0].title) is repaired', async () => {
    const entries = buildSmokeEntries({ source: 'ig', posts: 1, photosPerPost: 1, seed: 1 });
    const { items } = await runParse(entries, 'instagram');
    const post = items.find((item) => item.outcome === 'import') as ParsedPost | undefined;
    expect(post).not.toBeUndefined();
    expect(post!.body).toBe('Café 📸');
  });
});

// ---------------------------------------------------------------------------
// D6 — CLI smoke: make-meta-archive.mjs exits 0 and writes a valid ZIP
// ---------------------------------------------------------------------------

describe('make-meta-archive.mjs CLI (D6)', () => {
  it('exits 0 and writes a non-empty ZIP for --source fb', () => {
    const outPath = path.join(
      process.env['TMPDIR'] ?? '/tmp',
      `smoke-d6-fb-${Date.now()}.zip`,
    );
    const repo = path.resolve(__dirname, '../../../../');
    const script = path.join(repo, 'scripts/smoke/make-meta-archive.mjs');
    const result = spawnSync(
      process.execPath,
      ['--experimental-strip-types', script, '--source', 'fb', '--posts', '2', '--seed', '1', '--out', outPath],
      { encoding: 'utf8', timeout: 30_000 },
    );
    expect(result.status).toBe(0);
    // The CLI logs a sha256 line to stdout
    expect(result.stdout).toMatch(/sha256:/);
  });

  it('exits 0 and writes a non-empty ZIP for --source ig', () => {
    const outPath = path.join(
      process.env['TMPDIR'] ?? '/tmp',
      `smoke-d6-ig-${Date.now()}.zip`,
    );
    const repo = path.resolve(__dirname, '../../../../');
    const script = path.join(repo, 'scripts/smoke/make-meta-archive.mjs');
    const result = spawnSync(
      process.execPath,
      ['--experimental-strip-types', script, '--source', 'ig', '--posts', '2', '--seed', '1', '--out', outPath],
      { encoding: 'utf8', timeout: 30_000 },
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/sha256:/);
  });
});
