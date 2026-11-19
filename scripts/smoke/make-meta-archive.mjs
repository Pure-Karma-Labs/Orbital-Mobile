/**
 * make-meta-archive.mjs — synthetic Meta import archive generator.
 *
 * Thin CLI over src/services/metaImport/testUtils/smokeArchive.ts. Loads the
 * TypeScript source directly with --experimental-strip-types (Node ≥22.6.0).
 *
 * Usage:
 *   node --experimental-strip-types scripts/smoke/make-meta-archive.mjs \
 *     --source fb --posts 30 --photos-per-post 2 --video-posts 2 \
 *     --gps --seed 1 --out /tmp/fb.zip
 *
 * Or via the npm script:
 *   npm run smoke:meta-archive -- --source fb --out /tmp/fb.zip
 *
 * Prints sha256 and a summary to stdout. All paths outside src/ so
 * node:crypto is legal here (invariant 30 covers src/ only).
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Node version guard (--experimental-strip-types requires >=22.6.0;
// zlib.crc32 requires >=22.2.0, so the 22.6 guard covers both).
// ---------------------------------------------------------------------------

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 6)) {
  process.stderr.write(
    `make-meta-archive: requires Node >=22.6.0 (--experimental-strip-types), got ${process.versions.node}\n`,
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Locate the TS source relative to this script
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// scripts/smoke/ → ../../src/services/metaImport/testUtils/smokeArchive.ts
const SMOKE_ARCHIVE_TS = resolve(
  __dirname,
  '../../src/services/metaImport/testUtils/smokeArchive.ts',
);

// ---------------------------------------------------------------------------
// Argument parsing (B2: validated numeric args; B3: pinned endYear default)
// ---------------------------------------------------------------------------

/**
 * Validate and parse a numeric flag value (B2).
 *
 * Rejects missing values (undefined, or a string starting with '--') and
 * non-integer / out-of-range values. Exits 1 with a message naming the flag.
 */
function parseIntArg(flag, rawValue, min, max) {
  if (rawValue === undefined || rawValue.startsWith('--')) {
    process.stderr.write(
      `make-meta-archive: ${flag} requires a value (got ${rawValue ?? 'nothing'})\n`,
    );
    process.exit(1);
  }
  const n = Number(rawValue);
  if (!Number.isInteger(n) || n < min || n > max) {
    process.stderr.write(
      `make-meta-archive: ${flag} must be an integer in [${min}, ${max}], got "${rawValue}"\n`,
    );
    process.exit(1);
  }
  return n;
}

function parseArgs(argv) {
  const args = argv.slice(2);
  // B3: endYear default pinned to 2025 — the same literal the library uses.
  // The CLI no longer reads the clock for the default, so sha256 is reproducible
  // without passing --end-year explicitly.
  const opts = {
    source: 'fb',
    posts: 10,
    photosPerPost: 1,
    videoPosts: 0,
    largeImage: false,
    gps: false,
    seed: 1,
    startYear: 2004,
    endYear: 2025,
    textOnly: false,
    wrapperDir: undefined,
    out: undefined,
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    switch (a) {
      case '--source':
        opts.source = args[++i];
        break;
      case '--posts':
        opts.posts = parseIntArg('--posts', args[++i], 1, 100_000);
        break;
      case '--photos-per-post':
        opts.photosPerPost = parseIntArg('--photos-per-post', args[++i], 1, 100);
        break;
      case '--video-posts':
        opts.videoPosts = parseIntArg('--video-posts', args[++i], 0, 100_000);
        break;
      case '--large-image':
        opts.largeImage = true;
        break;
      case '--gps':
        opts.gps = true;
        break;
      case '--seed':
        opts.seed = parseIntArg('--seed', args[++i], 0, 2_147_483_647);
        break;
      case '--start-year':
        opts.startYear = parseIntArg('--start-year', args[++i], 2004, 9999);
        break;
      case '--end-year':
        opts.endYear = parseIntArg('--end-year', args[++i], 2004, 9999);
        break;
      case '--text-only':
        opts.textOnly = true;
        break;
      case '--wrapper-dir': {
        const val = args[++i];
        if (val === undefined || val.startsWith('--')) {
          process.stderr.write(
            `make-meta-archive: --wrapper-dir requires a value (got ${val ?? 'nothing'})\n`,
          );
          process.exit(1);
        }
        opts.wrapperDir = val;
        break;
      }
      case '--out': {
        const val = args[++i];
        if (val === undefined || val.startsWith('--')) {
          process.stderr.write(
            `make-meta-archive: --out requires a value (got ${val ?? 'nothing'})\n`,
          );
          process.exit(1);
        }
        opts.out = val;
        break;
      }
      default:
        process.stderr.write(`make-meta-archive: unknown flag ${a}\n`);
        process.exit(1);
    }
  }
  if (!opts.out) {
    process.stderr.write('make-meta-archive: --out <path> is required\n');
    process.exit(1);
  }
  if (opts.source !== 'fb' && opts.source !== 'ig') {
    process.stderr.write('make-meta-archive: --source must be fb or ig\n');
    process.exit(1);
  }
  return opts;
}

// ---------------------------------------------------------------------------
// Locate gps-small.jpg for --gps
// ---------------------------------------------------------------------------

function readGpsJpg(scriptDir) {
  const GPS_JPG = resolve(
    scriptDir,
    '../../src/services/__tests__/fixtures/gps-small.jpg',
  );
  try {
    return readFileSync(GPS_JPG);
  } catch {
    process.stderr.write(
      `make-meta-archive: could not read gps-small.jpg at ${GPS_JPG}\n`,
    );
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const opts = parseArgs(process.argv);

// Read GPS bytes before the dynamic import so they're ready.
const gpsJpgBytes = opts.gps ? readGpsJpg(__dirname) : undefined;

// Dynamic import of the TS source (strip-types handles the .ts extension).
const { buildSmokeEntries, writeStoredZip, KNOWN_ROOT_KEYS } = await import(SMOKE_ARCHIVE_TS);

// B4: validate --wrapper-dir against the known root keys from the library.
if (opts.wrapperDir !== undefined && KNOWN_ROOT_KEYS.has(opts.wrapperDir)) {
  process.stderr.write(
    `make-meta-archive: --wrapper-dir "${opts.wrapperDir}" is a known root key — ` +
      `Rust will not strip it and the archive will appear empty. ` +
      `Use a custom name such as "my_export".\n`,
  );
  process.exit(1);
}

const archiveOpts = {
  source: opts.source,
  posts: opts.posts,
  photosPerPost: opts.photosPerPost,
  videoPosts: opts.videoPosts,
  largeImage: opts.largeImage,
  gps: opts.gps,
  gpsJpgBytes,
  seed: opts.seed,
  startYear: opts.startYear,
  endYear: opts.endYear,
  textOnly: opts.textOnly,
  wrapperDir: opts.wrapperDir,
};

const entries = buildSmokeEntries(archiveOpts);
const zip = writeStoredZip(entries);

writeFileSync(opts.out, zip);

// Compute sha256 and summary
const sha256 = createHash('sha256').update(zip).digest('hex');

const jsonEntries = entries.filter((e) => e.path.endsWith('.json'));
const photoEntries = entries.filter((e) => /\.(jpg|jpeg|png)$/i.test(e.path));
const videoEntries = entries.filter((e) => /\.mp4$/i.test(e.path));

const totalBytes = zip.length;
const totalMB = (totalBytes / 1_048_576).toFixed(2);

// B3: find which post holds the GPS photo and the large image (by path pattern)
// so the operator can locate them in the runbook steps.
const gpsEntry = entries.find((e) => /smoke_gps_/.test(e.path));
const largeEntry = entries.find((e) => /smoke_large_/.test(e.path));
const gpsDte = gpsEntry ? new Date(gpsEntry.modifiedMs).toISOString().slice(0, 10) : null;
const largeDte = largeEntry ? new Date(largeEntry.modifiedMs).toISOString().slice(0, 10) : null;

// B3: print full resolved options + Node/zlib version for reproducibility.
process.stdout.write(
  [
    `sha256:      ${sha256}`,
    ``,
    `-- options (reproduce with these exact values) --`,
    `source:      ${opts.source}`,
    `seed:        ${opts.seed}`,
    `posts:       ${opts.posts}`,
    `startYear:   ${opts.startYear}`,
    `endYear:     ${opts.endYear}`,
    `gps:         ${opts.gps}`,
    `largeImage:  ${opts.largeImage}`,
    `textOnly:    ${opts.textOnly}`,
    `videoPosts:  ${opts.videoPosts}`,
    `wrapperDir:  ${opts.wrapperDir ?? '(none)'}`,
    ``,
    `-- runtime --`,
    `node:        ${process.version}`,
    `zlib:        ${process.versions.zlib}`,
    ``,
    `-- content --`,
    `photos:      ${photoEntries.length}`,
    `videos:      ${videoEntries.length} (held_video)`,
    `json:        ${jsonEntries.length}`,
    `size:        ${totalBytes} bytes (${totalMB} MB)`,
    ...(gpsDte ? [`gpsPostDate: ${gpsDte}`] : []),
    ...(largeDte ? [`largePostDate: ${largeDte}`] : []),
    ``,
    `out:         ${opts.out}`,
    ``,
  ].join('\n'),
);
