/**
 * generate-emoji-assets.mjs
 *
 * Generates individual 128px WebP emoji assets from OpenMoji SVGs and emits
 * a TypeScript asset map for use by the Emoji component.
 *
 * Input:
 *   - node_modules/emoji-datasource/emoji.json  (base emoji entries)
 *   - node_modules/openmoji/color/svg/           (SVG source files)
 *
 * Output:
 *   - assets/emoji/*.webp        (one per emoji, lowercase unified code)
 *   - src/emoji/assetMap.ts      (require() map keyed by uppercase unified)
 *
 * Regenerate with: npm run generate:emoji
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import sharp from 'sharp';
import prettier from 'prettier';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const emojiJsonPath = path.join(root, 'node_modules/emoji-datasource/emoji.json');
const svgDir = path.join(root, 'node_modules/openmoji/color/svg');
const outputDir = path.join(root, 'assets/emoji');
const assetMapPath = path.join(root, 'src/emoji/assetMap.ts');

// ---------------------------------------------------------------------------
// Load emoji data (all 1,911 base entries — no skin_variations children)
// ---------------------------------------------------------------------------

const emojiData = JSON.parse(fs.readFileSync(emojiJsonPath, 'utf8'));

// ---------------------------------------------------------------------------
// SVG resolution fallback chain
// Matches emoji-datasource-openmoji/scripts/build.js:76-90
// ---------------------------------------------------------------------------

function resolveSvgPath(unified, nonQualified) {
  const candidates = [
    `${unified}.svg`,
    `${unified.replace(/-FE0F/g, '')}.svg`,
  ];
  if (nonQualified) {
    candidates.push(`${nonQualified}.svg`);
  }

  for (const filename of candidates) {
    const fullPath = path.join(svgDir, filename);
    if (fs.existsSync(fullPath)) {
      return fullPath;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Filename: lowercase unified with hyphens replaced by underscores
// (Android drawable-name safe)
// ---------------------------------------------------------------------------

function toFilename(unified) {
  return unified.toLowerCase().replace(/-/g, '_') + '.webp';
}

// ---------------------------------------------------------------------------
// Bounded-concurrency promise pool
// ---------------------------------------------------------------------------

async function poolMap(items, concurrency, fn) {
  const results = [];
  let index = 0;

  async function worker() {
    while (index < items.length) {
      const i = index++;
      results[i] = await fn(items[i], i);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log(`Emoji asset generator`);
  console.log(`  Source: ${emojiData.length} entries from emoji-datasource`);
  console.log(`  SVGs:  ${svgDir}`);
  console.log(`  Output: ${outputDir}`);
  console.log();

  // Wipe and recreate output directory for idempotency
  if (fs.existsSync(outputDir)) {
    fs.rmSync(outputDir, { recursive: true });
  }
  fs.mkdirSync(outputDir, { recursive: true });

  let generated = 0;
  const skipped = [];

  // Sort entries by unified code for deterministic output
  const sorted = [...emojiData].sort((a, b) => a.unified.localeCompare(b.unified));

  // Generate WebP assets with bounded concurrency
  await poolMap(sorted, 16, async (entry) => {
    const svgPath = resolveSvgPath(entry.unified, entry.non_qualified);
    if (!svgPath) {
      skipped.push(entry.unified);
      return;
    }

    const filename = toFilename(entry.unified);
    const outputPath = path.join(outputDir, filename);

    await sharp(svgPath)
      .resize(128, 128, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .webp({ quality: 80, effort: 6 })
      .toFile(outputPath);

    generated++;
  });

  console.log(`Generated: ${generated}`);
  if (skipped.length > 0) {
    console.log(`Skipped (${skipped.length}): ${skipped.join(', ')}`);
  } else {
    console.log(`Skipped: 0`);
  }

  // Fail hard if any emoji could not be resolved
  if (skipped.length > 0) {
    console.error(`\nERROR: ${skipped.length} emoji failed to resolve an SVG. Aborting.`);
    process.exit(1);
  }

  // ---------------------------------------------------------------------------
  // Emit src/emoji/assetMap.ts
  // ---------------------------------------------------------------------------

  const requireLines = sorted.map((entry) => {
    const filename = toFilename(entry.unified);
    return `  '${entry.unified}': require('../../assets/emoji/${filename}'),`;
  });

  const rawSource = [
    `/* eslint-disable @typescript-eslint/no-require-imports */`,
    `// GENERATED FILE — do not edit. Regenerate with: npm run generate:emoji`,
    ``,
    `import type { ImageSourcePropType } from 'react-native';`,
    ``,
    `export const emojiAssetMap: Record<string, ImageSourcePropType> = {`,
    ...requireLines,
    `};`,
    ``,
  ].join('\n');

  // Format with prettier using the repo's config
  const prettierConfigPath = path.join(root, '.prettierrc.js');
  const prettierConfig = await prettier.resolveConfig(prettierConfigPath);
  const formatted = await prettier.format(rawSource, {
    ...prettierConfig,
    parser: 'typescript',
  });

  fs.writeFileSync(assetMapPath, formatted);
  console.log(`\nAsset map written to: ${assetMapPath}`);

  // Total asset size
  const files = fs.readdirSync(outputDir);
  let totalBytes = 0;
  for (const f of files) {
    totalBytes += fs.statSync(path.join(outputDir, f)).size;
  }
  console.log(`Total asset size: ${(totalBytes / 1024 / 1024).toFixed(2)} MB (${files.length} files)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
