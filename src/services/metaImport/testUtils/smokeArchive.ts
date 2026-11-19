/// <reference types="node" />
/**
 * Synthetic Meta-archive generator for the QA smoke runbook (#930).
 *
 * Produces byte-for-byte reproducible FB/IG archives from a seed. The ZIP is
 * STORED (method=0) with no data descriptors, so the local-header sizes and
 * CRC equal the central-directory record — the invariant `local.rs:99` checks.
 *
 * ## Constraints
 *
 * - Imports ONLY `metaJson.ts`, `mojibakeEscape.ts` (siblings) and `node:zlib`.
 * - `/// <reference types="node" />` for Node type resolution without
 *   `@types/node` in the `types` tsconfig field.
 * - NO `node:crypto` (invariant 30). CRC comes from `zlib.crc32`; the PRNG is
 *   seed-only (Mulberry32).
 * - Erasable syntax only: `import type`, no enums, no namespaces.
 * - Paths under ALLOWED_ROOTS from `allowlist.rs`; an optional `wrapperDir`
 *   prefix is stripped by the Rust layer since it is not a known root key.
 */

import zlib from 'node:zlib';

import {
  fbJsonText,
  fbMediaUri,
  fbJsonPath,
  igFlatJsonText,
  igMediaUri,
  igFlatJsonPath,
  mp4Head,
  type FbLayout,
  type FbPostSpec,
  type IgPostSpec,
} from './metaJson.ts';
import { mojibakeEscape } from './mojibakeEscape.ts';

// ---------------------------------------------------------------------------
// PRNG — Mulberry32 (seed-only, no Date.now() or Math.random())
// ---------------------------------------------------------------------------

/**
 * A Mulberry32 PRNG returning values in [0, 1).
 *
 * Deterministic from `seed`; no external state. Used everywhere a random
 * value is needed so the same seed always produces the same archive.
 */
function makePrng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 0x1_0000_0000;
  };
}

// ---------------------------------------------------------------------------
// DOS timestamp
// ---------------------------------------------------------------------------

function dosTime(epochMs: number): { time: number; date: number } {
  const d = new Date(epochMs);
  const time =
    ((d.getUTCHours() & 0x1f) << 11) |
    ((d.getUTCMinutes() & 0x3f) << 5) |
    ((d.getUTCSeconds() >> 1) & 0x1f);
  const date =
    (((d.getUTCFullYear() - 1980) & 0x7f) << 9) |
    (((d.getUTCMonth() + 1) & 0x0f) << 5) |
    (d.getUTCDate() & 0x1f);
  return { time, date };
}

// ---------------------------------------------------------------------------
// PNG writer
// ---------------------------------------------------------------------------

/** Big-endian uint32 into a pre-allocated Buffer at offset. */
function writeBE32(buf: Buffer, offset: number, val: number): void {
  buf[offset] = (val >>> 24) & 0xff;
  buf[offset + 1] = (val >>> 16) & 0xff;
  buf[offset + 2] = (val >>> 8) & 0xff;
  buf[offset + 3] = val & 0xff;
}

/** Build one PNG chunk: 4-byte length + 4-byte type + data + 4-byte CRC. */
function pngChunk(type: string, data: Uint8Array): Buffer {
  const typeBuf = Buffer.from(type, 'ascii');
  const len = data.length;
  const chunk = Buffer.allocUnsafe(12 + len);
  writeBE32(chunk, 0, len);
  typeBuf.copy(chunk, 4);
  Buffer.from(data).copy(chunk, 8);
  // CRC covers type + data
  const crc = zlib.crc32(Buffer.from(data), zlib.crc32(typeBuf));
  writeBE32(chunk, 8 + len, crc >>> 0);
  return chunk;
}

/**
 * Minimal valid PNG for a noise image.
 *
 * Color type 2 = RGB (no alpha). Filter byte 0 (None) on every row.
 *
 * @param width - pixel width
 * @param height - pixel height
 * @param prng - PRNG for noise pixels
 * @param deflateLevel - 0 for STORED (large image), Z_DEFAULT_COMPRESSION otherwise
 */
export function buildPng(
  width: number,
  height: number,
  prng: () => number,
  deflateLevel: number = zlib.constants.Z_DEFAULT_COMPRESSION,
): Buffer {
  // PNG signature
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  // IHDR: width(4) height(4) bitDepth(1) colorType(2=RGB) compress(0) filter(0) interlace(0)
  const ihdrData = Buffer.allocUnsafe(13);
  writeBE32(ihdrData, 0, width);
  writeBE32(ihdrData, 4, height);
  ihdrData[8] = 8; // bit depth
  ihdrData[9] = 2; // RGB
  ihdrData[10] = 0;
  ihdrData[11] = 0;
  ihdrData[12] = 0;
  const ihdr = pngChunk('IHDR', ihdrData);

  // Raw image data: for each row, filter byte (0) + width*3 RGB bytes
  const rowBytes = 1 + width * 3;
  const raw = Buffer.allocUnsafe(height * rowBytes);
  for (let y = 0; y < height; y++) {
    const rowBase = y * rowBytes;
    raw[rowBase] = 0; // filter: None
    for (let x = 0; x < width; x++) {
      const p = rowBase + 1 + x * 3;
      raw[p] = Math.floor(prng() * 256);
      raw[p + 1] = Math.floor(prng() * 256);
      raw[p + 2] = Math.floor(prng() * 256);
    }
  }
  const compressed = zlib.deflateSync(raw, { level: deflateLevel });
  const idat = pngChunk('IDAT', compressed);

  // IEND
  const iend = pngChunk('IEND', new Uint8Array(0));

  return Buffer.concat([sig, ihdr, idat, iend]);
}

// ---------------------------------------------------------------------------
// Minimal MP4 bytes (ftyp box, giving held_video)
// ---------------------------------------------------------------------------

/**
 * Returns bytes starting with an `ftyp isom` box (from the single canonical
 * `mp4Head()` in metaJson.ts — C3), padded with PRNG noise.
 *
 * Only the first 12 bytes come from `mp4Head()` so the PRNG sequence is
 * unchanged from before the C3 migration (byte-identity preserved).
 */
function buildMp4Head(prng: () => number, size = 256): Buffer {
  const buf = Buffer.allocUnsafe(size);
  const head = mp4Head(); // canonical definition from metaJson.ts
  // Copy the magic bytes: box-size(4) + 'ftyp'(4) + 'isom'(4)
  for (let i = 0; i < 12; i++) buf[i] = head[i];
  for (let i = 12; i < size; i++) buf[i] = Math.floor(prng() * 256);
  return buf;
}

// ---------------------------------------------------------------------------
// STORED ZIP writer
// ---------------------------------------------------------------------------

export interface ZipEntry {
  readonly path: string;
  readonly bytes: Uint8Array;
  /** Epoch ms, used for the DOS timestamp. */
  readonly modifiedMs: number;
}

/** Little-endian uint32 write. */
function writeLE32(buf: Buffer, offset: number, val: number): void {
  buf.writeUInt32LE(val >>> 0, offset);
}

/** Little-endian uint16 write. */
function writeLE16(buf: Buffer, offset: number, val: number): void {
  buf.writeUInt16LE(val & 0xffff, offset);
}

/**
 * Build a STORED ZIP from the given entries.
 *
 * Local-header CRC + sizes equal central-directory values (no data
 * descriptors, no bit 3), so `local.rs:99` accepts every entry.
 *
 * C1: throws when the entry count exceeds the ZIP32 EOCD limit (0xffff) or
 * when any local-header offset or the central-directory offset would overflow
 * a 32-bit field. The generator does not implement Zip64.
 */
export function writeStoredZip(entries: readonly ZipEntry[]): Buffer {
  const LH_SIG = 0x04034b50;
  const CD_SIG = 0x02014b50;
  const EOCD_SIG = 0x06054b50;
  const METHOD_STORED = 0;
  const VERSION = 0x0014; // 2.0

  // C1: ZIP32 limits.
  if (entries.length > 0xffff) {
    throw new Error(
      `writeStoredZip: entry count ${entries.length} exceeds ZIP32 limit 0xffff (65535). ` +
        `Zip64 is not implemented.`,
    );
  }

  // Accumulate parts: local headers + data, then central directory records.
  const parts: Buffer[] = [];
  const cdParts: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.path, 'utf8');
    const data = Buffer.from(entry.bytes);
    const crc = zlib.crc32(data) >>> 0;
    const size = data.length;
    const { time, date } = dosTime(entry.modifiedMs);

    // C1: check that the local-header offset fits in 32 bits.
    if (offset > 0xffffffff) {
      throw new Error(
        `writeStoredZip: local-header offset 0x${offset.toString(16)} exceeds ZIP32 limit 0xffffffff. ` +
          `Zip64 is not implemented.`,
      );
    }

    // ----- Local file header (30 + name) -----
    const lhOffset = offset; // C3: captured here, no localOffsets array needed
    const lh = Buffer.alloc(30 + nameBuf.length);
    writeLE32(lh, 0, LH_SIG);
    writeLE16(lh, 4, VERSION);    // version needed
    writeLE16(lh, 6, 0x0000);     // flags: no data descriptor
    writeLE16(lh, 8, METHOD_STORED);
    writeLE16(lh, 10, time);
    writeLE16(lh, 12, date);
    writeLE32(lh, 14, crc);
    writeLE32(lh, 18, size);      // compressed = uncompressed (STORED)
    writeLE32(lh, 22, size);
    writeLE16(lh, 26, nameBuf.length);
    writeLE16(lh, 28, 0);         // extra field length
    nameBuf.copy(lh, 30);

    parts.push(lh, data);
    offset += lh.length + data.length;

    // ----- Central directory record (46 + name) -----
    const cd = Buffer.alloc(46 + nameBuf.length);
    writeLE32(cd, 0, CD_SIG);
    writeLE16(cd, 4, VERSION);    // version made by
    writeLE16(cd, 6, VERSION);    // version needed
    writeLE16(cd, 8, 0x0000);     // flags
    writeLE16(cd, 10, METHOD_STORED);
    writeLE16(cd, 12, time);
    writeLE16(cd, 14, date);
    writeLE32(cd, 16, crc);
    writeLE32(cd, 20, size);
    writeLE32(cd, 24, size);
    writeLE16(cd, 28, nameBuf.length);
    writeLE16(cd, 30, 0);         // extra field length
    writeLE16(cd, 32, 0);         // file comment length
    writeLE16(cd, 34, 0);         // disk number start
    writeLE16(cd, 36, 0);         // internal attributes
    writeLE32(cd, 38, 0);         // external attributes
    writeLE32(cd, 42, lhOffset);  // local header offset
    nameBuf.copy(cd, 46);

    cdParts.push(cd);
  }

  const cdBuf = Buffer.concat(cdParts);
  const cdOffset = offset;
  const cdSize = cdBuf.length;
  const count = entries.length;

  // C1: check that the central-directory offset fits in 32 bits.
  if (cdOffset > 0xffffffff) {
    throw new Error(
      `writeStoredZip: central-directory offset 0x${cdOffset.toString(16)} exceeds ZIP32 limit 0xffffffff. ` +
        `Zip64 is not implemented.`,
    );
  }

  // ----- End of central directory (22 bytes) -----
  const eocd = Buffer.alloc(22);
  writeLE32(eocd, 0, EOCD_SIG);
  writeLE16(eocd, 4, 0);             // disk number
  writeLE16(eocd, 6, 0);             // disk with start of CD
  writeLE16(eocd, 8, count);         // entries on this disk
  writeLE16(eocd, 10, count);        // total entries
  writeLE32(eocd, 12, cdSize);
  writeLE32(eocd, 16, cdOffset);
  writeLE16(eocd, 20, 0);            // comment length

  return Buffer.concat([...parts, cdBuf, eocd]);
}

// ---------------------------------------------------------------------------
// Known root-key guard (B4)
// ---------------------------------------------------------------------------

/**
 * Mirror of `allowlist.rs`'s `is_known_root_key` = ALLOWED_ROOTS ∪ DENIED_ROOTS.
 *
 * The Rust layer strips the first path segment only when it is NOT a known root
 * key. If `wrapperDir` IS a known root key, the strip never fires: every path
 * stays under a recognized root and the reader accepts zero posts from the
 * wrapper layer, silently making the archive look empty. Reject such values
 * early with a helpful message.
 *
 * Also exported so the CLI can validate `--wrapper-dir` without duplicating the
 * list (B4).
 */
export const KNOWN_ROOT_KEYS: ReadonlySet<string> = new Set([
  // ALLOWED_ROOTS from allowlist.rs
  'your_facebook_activity',
  'your_activity_across_facebook',
  'your_instagram_activity',
  'posts',
  'media',
  'content',
  'photos_and_videos',
  // DENIED_ROOTS from allowlist.rs
  'messages',
  'inbox',
  'friends_and_followers',
  'ads_information',
  'security_and_login_information',
  'personal_information',
  'stories',
  'reels',
  'profile',
  'other_content',
]);

// ---------------------------------------------------------------------------
// Smoke archive options
// ---------------------------------------------------------------------------

export interface SmokeArchiveOptions {
  /** `'fb'` (default) or `'ig'`. */
  readonly source?: 'fb' | 'ig';
  /**
   * Total number of posts. Defaults to 3.
   * The first `videoPosts` are video posts; the rest are photo (or text) posts.
   */
  readonly posts?: number;
  /** Photos per non-video post. Defaults to 1. Ignored when `textOnly` is true. */
  readonly photosPerPost?: number;
  /**
   * First N posts each get one `.mp4`, making `held_video` skips.
   * Must be ≤ `posts`. Defaults to 0.
   */
  readonly videoPosts?: number;
  /**
   * Add one large 2500×1500 noise PNG (≈11.3 MB at deflate level 0) to the
   * first photo post's media. Ignored when `textOnly` is true.
   */
  readonly largeImage?: boolean;
  /**
   * Add a GPS-tagged JPEG to the first photo post's media.
   * `gpsJpgBytes` MUST be provided when this is `true` (C2: the synthetic
   * JPEG fallback was removed — a fixture that emitted undecodable noise was
   * the only caller, and the CLI always passes the real fixture file).
   * Ignored when `textOnly` is true.
   */
  readonly gps?: boolean;
  /**
   * Raw bytes for the GPS fixture image (e.g. `fs.readFileSync(gpsSmallPath)`).
   * Required when `gps` is `true`. Pass from the CLI to avoid importing
   * `node:fs` here.
   */
  readonly gpsJpgBytes?: Uint8Array;
  /**
   * Integer seed for the PRNG. Defaults to 1.
   * Same seed + same options → byte-identical output.
   */
  readonly seed?: number;
  /**
   * First year of the generated timestamp range. Must be ≥ 2004 (the server
   * floor in `dateBounds.ts`). Defaults to 2004.
   */
  readonly startYear?: number;
  /**
   * Last year of the generated timestamp range. Timestamps are capped to
   * December 31 of this year so they remain well before "today" and never fail
   * the importable-date check. The caller (CLI) should pass `currentYear - 1`
   * to get a deterministic cap without reading the clock here. Defaults to 2025.
   */
  readonly endYear?: number;
  /**
   * All posts are text-only (no media). Useful for the 5000-post performance
   * run. `largeImage` and `gps` are silently ignored when true.
   */
  readonly textOnly?: boolean;
  /**
   * Optional wrapper directory prepended to every path. The Rust parser strips
   * it because it is not a known root key (see `allowlist.rs:is_known_root_key`).
   * Example: `'my_export'` → `'my_export/your_facebook_activity/...'`.
   */
  readonly wrapperDir?: string;
}

// ---------------------------------------------------------------------------
// Archive entry
// ---------------------------------------------------------------------------

export interface SmokeEntry {
  /** Archive-relative path, possibly under a wrapperDir prefix. */
  readonly path: string;
  /** File contents. */
  readonly bytes: Uint8Array;
  /** Epoch ms of the post this entry belongs to (drives the ZIP timestamp). */
  readonly modifiedMs: number;
}

// ---------------------------------------------------------------------------
// buildSmokeEntries
// ---------------------------------------------------------------------------

/**
 * Build the in-memory entry list for a synthetic Meta archive.
 *
 * Returns `{path, bytes, modifiedMs}[]` for every entry the ZIP should contain.
 * The list is in the order the ZIP writer expects (JSON file first, then media).
 *
 * No `node:fs` or `node:crypto` calls — deterministic from the seed.
 */
export function buildSmokeEntries(opts: SmokeArchiveOptions = {}): SmokeEntry[] {
  // B4: reject wrapperDir values that are known root keys — Rust would not strip
  // them and the archive would list zero posts (silently empty).
  if (opts.wrapperDir !== undefined && KNOWN_ROOT_KEYS.has(opts.wrapperDir)) {
    throw new Error(
      `buildSmokeEntries: wrapperDir "${opts.wrapperDir}" is a known root key — ` +
        `Rust will not strip it and the archive will appear empty. ` +
        `Use a custom name such as "my_export" that is not in ALLOWED_ROOTS or DENIED_ROOTS.`,
    );
  }

  const source = opts.source ?? 'fb';
  const totalPosts = opts.posts ?? 3;
  const photosPerPost = opts.photosPerPost ?? 1;
  const videoPosts = Math.min(opts.videoPosts ?? 0, totalPosts);
  const largeImage = !opts.textOnly && (opts.largeImage ?? false);
  const gps = !opts.textOnly && (opts.gps ?? false);
  const seed = opts.seed ?? 1;
  const startYear = opts.startYear ?? 2004;
  // Default endYear to 2025 (a fixed value before the app's current year of 2026).
  // The CLI overrides this with `currentYear - 1` for a tighter cap.
  const endYear = opts.endYear ?? 2025;
  const textOnly = opts.textOnly ?? false;
  const wrapperDir = opts.wrapperDir;

  const prng = makePrng(seed);

  // Epoch bounds for generated timestamps
  const minMs = Date.UTC(startYear, 0, 1);               // Jan 1 of startYear
  const maxMs = Date.UTC(endYear, 11, 31, 23, 59, 59);  // Dec 31 of endYear

  /** Generate a random epoch-seconds timestamp in [startYear, endYear]. */
  function randTimestamp(): number {
    return Math.floor((minMs + prng() * (maxMs - minMs)) / 1000);
  }

  /** Prefix with wrapperDir when set. */
  function prefixed(p: string): string {
    return wrapperDir !== undefined ? `${wrapperDir}/${p}` : p;
  }

  /**
   * A2: the post at index 0 carries a mojibake-escaped caption so the
   * latin1→UTF-8 repair path in `mojibake.ts` is exercised on every archive.
   */
  function postCaption(i: number): string {
    return i === 0 ? mojibakeEscape('Café 📸') : `Synthetic post ${i + 1}`;
  }

  // C2: gpsJpgBytes is required when gps is true (the synthetic-noise fallback
  // was removed — it emitted undecodable bytes and the CLI always provides the
  // real fixture).
  if (gps && opts.gpsJpgBytes === undefined) {
    throw new Error(
      'buildSmokeEntries: gpsJpgBytes is required when gps is true (C2: synthetic fallback removed)',
    );
  }

  // ---------------------------------------------------------------------------
  // C4: per-source context — one emitter, two descriptors.
  //
  // The FB and IG branches were ~85 near-identical lines. The descriptor holds
  // only what differs between sources; the main loop runs once and calls the
  // correct descriptor methods. Output is byte-identical to the pre-C4 code
  // for any FB archive (A1 changed only IG single-media; A2 changed both).
  // ---------------------------------------------------------------------------

  /** Media item accumulated before the post spec is built. */
  interface AccumMediaItem {
    name: string;
    ts: number;
    withMetadata?: boolean;
  }

  /**
   * Per-source context: encapsulates what differs between FB and IG without
   * duplicating the PRNG/entry/timing logic.
   */
  interface SourceContext {
    pushTextPost(ts: number, caption: string): void;
    pushVideoPost(ts: number, caption: string, name: string): void;
    /** items.length is known before this call (all media already pushed). */
    pushPhotoPost(ts: number, caption: string, items: readonly AccumMediaItem[]): void;
    jsonText(): string;
    mediaUri(name: string): string;
    jsonPath(index: number): string;
  }

  function makeFbContext(): SourceContext {
    const layout: FbLayout = 'activity';
    const posts: FbPostSpec[] = [];
    return {
      pushTextPost(ts, caption) {
        posts.push({ timestamp: ts, post: caption });
      },
      pushVideoPost(ts, caption, name) {
        posts.push({ timestamp: ts, post: caption, media: [{ name }] });
      },
      pushPhotoPost(ts, caption, items) {
        posts.push({
          timestamp: ts,
          post: caption,
          media: items.map((m) => ({
            name: m.name,
            ...(m.withMetadata === true ? { withMetadata: true as const } : {}),
          })),
        });
      },
      jsonText() { return fbJsonText({ layout, posts }); },
      mediaUri(name) { return fbMediaUri(name, layout); },
      jsonPath(index) { return fbJsonPath(index, layout); },
    };
  }

  function makeIgContext(): SourceContext {
    const posts: IgPostSpec[] = [];
    return {
      pushTextPost(ts, caption) {
        posts.push({ creationTimestamp: ts, title: caption });
      },
      pushVideoPost(ts, caption, name) {
        posts.push({
          creationTimestamp: ts,
          title: caption,
          media: [{ name, creationTimestamp: ts }],
        });
      },
      pushPhotoPost(ts, caption, items) {
        // A1: a single-media IG post has no post-level creation_timestamp/title;
        // the parser falls back to media[0].creation_timestamp and
        // media[0].title (see instagramParser.ts header and scanMedia).
        if (items.length === 1) {
          posts.push({
            media: [{
              name: items[0].name,
              creationTimestamp: items[0].ts,
              title: caption,
              ...(items[0].withMetadata === true ? { withMetadata: true as const } : {}),
            }],
          });
        } else {
          posts.push({
            creationTimestamp: ts,
            title: caption,
            media: items.map((m) => ({
              name: m.name,
              creationTimestamp: m.ts,
              ...(m.withMetadata === true ? { withMetadata: true as const } : {}),
            })),
          });
        }
      },
      jsonText() { return igFlatJsonText({ posts }); },
      mediaUri(name) { return igMediaUri(name); },
      jsonPath(index) { return igFlatJsonPath(index); },
    };
  }

  const ctx = source === 'fb' ? makeFbContext() : makeIgContext();
  const entries: SmokeEntry[] = [];

  for (let i = 0; i < totalPosts; i++) {
    const ts = randTimestamp();
    const isVideo = i < videoPosts;
    const caption = postCaption(i);

    if (textOnly) {
      ctx.pushTextPost(ts, caption);
      continue;
    }

    if (isVideo) {
      const name = `smoke_video_${i + 1}.mp4`;
      entries.push({
        path: prefixed(ctx.mediaUri(name)),
        bytes: buildMp4Head(prng),
        modifiedMs: ts * 1000,
      });
      ctx.pushVideoPost(ts, caption, name);
    } else {
      const photoIndex = i - videoPosts + 1;
      const isFirstPhotoPost = i === videoPosts;
      const accumItems: AccumMediaItem[] = [];

      for (let j = 0; j < photosPerPost; j++) {
        const name = `smoke_photo_${photoIndex}_${j + 1}.png`;
        accumItems.push({ name, ts });
        entries.push({
          path: prefixed(ctx.mediaUri(name)),
          bytes: buildPng(64, 64, prng),
          modifiedMs: ts * 1000,
        });
      }

      // GPS photo on the first photo post: withMetadata injects exif_data
      // lat/long into the JSON (fbMediaMetadata / igMediaMetadata in metaJson.ts).
      // C2: gpsJpgBytes required (checked above).
      if (gps && isFirstPhotoPost) {
        const gpsName = `smoke_gps_${photoIndex}.jpg`;
        accumItems.push({ name: gpsName, ts, withMetadata: true });
        entries.push({
          path: prefixed(ctx.mediaUri(gpsName)),
          bytes: opts.gpsJpgBytes as Uint8Array,
          modifiedMs: ts * 1000,
        });
      }

      // Large PNG on the first photo post.
      if (largeImage && isFirstPhotoPost) {
        const largeName = `smoke_large_${photoIndex}.png`;
        accumItems.push({ name: largeName, ts });
        entries.push({
          path: prefixed(ctx.mediaUri(largeName)),
          bytes: buildPng(2500, 1500, prng, 0),
          modifiedMs: ts * 1000,
        });
      }

      ctx.pushPhotoPost(ts, caption, accumItems);
    }
  }

  entries.unshift({
    path: prefixed(ctx.jsonPath(1)),
    bytes: Buffer.from(ctx.jsonText(), 'utf8'),
    modifiedMs: maxMs,
  });

  return entries;
}
