/**
 * make-meta-archive.mjs — synthetic Meta import archive generator.
 *
 * Thin CLI over src/services/metaImport/testUtils/smokeArchive.ts. Loads the
 * TypeScript source directly with --experimental-strip-types (Node ≥22.2).
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
import { createRequire } from 'node:module';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Node version guard (strip-types requires >=22.2.0)
// ---------------------------------------------------------------------------

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 2)) {
  process.stderr.write(
    `make-meta-archive: requires Node >=22.2.0, got ${process.versions.node}\n`,
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
// Argument parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = {
    source: 'fb',
    posts: 10,
    photosPerPost: 1,
    videoPosts: 0,
    largeImage: false,
    gps: false,
    seed: 1,
    startYear: 2004,
    endYear: new Date().getFullYear() - 1,
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
        opts.posts = parseInt(args[++i], 10);
        break;
      case '--photos-per-post':
        opts.photosPerPost = parseInt(args[++i], 10);
        break;
      case '--video-posts':
        opts.videoPosts = parseInt(args[++i], 10);
        break;
      case '--large-image':
        opts.largeImage = true;
        break;
      case '--gps':
        opts.gps = true;
        break;
      case '--seed':
        opts.seed = parseInt(args[++i], 10);
        break;
      case '--start-year':
        opts.startYear = parseInt(args[++i], 10);
        break;
      case '--end-year':
        opts.endYear = parseInt(args[++i], 10);
        break;
      case '--text-only':
        opts.textOnly = true;
        break;
      case '--wrapper-dir':
        opts.wrapperDir = args[++i];
        break;
      case '--out':
        opts.out = args[++i];
        break;
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
const { buildSmokeEntries, writeStoredZip } = await import(SMOKE_ARCHIVE_TS);

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

process.stdout.write(
  [
    `sha256:  ${sha256}`,
    `source:  ${opts.source}`,
    `posts:   ${opts.posts}`,
    `photos:  ${photoEntries.length}`,
    `videos:  ${videoEntries.length} (held_video)`,
    `json:    ${jsonEntries.length}`,
    `size:    ${totalBytes} bytes (${totalMB} MB)`,
    `out:     ${opts.out}`,
    '',
  ].join('\n'),
);
