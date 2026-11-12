/**
 * No location, EXIF or tag data may be READ by the Meta import (#925).
 *
 * `pruningReviver` deletes those subtrees at `JSON.parse` time, so no object
 * downstream has ever held a coordinate. This test is the second lock: a
 * source grep over every non-test module in `src/services/metaImport/`
 * asserting that the field names appear nowhere outside a comment — because
 * the way the reviver's guarantee would be lost is somebody adding
 * `exif_data` to a schema pick, not somebody deleting the reviver.
 *
 * ## Why a grep and not a behavioural test
 *
 * A behavioural test can only prove the absence of the fields it thought to
 * build a fixture for. The grep is blind to intent: ANY mention of these names
 * in executable code fails, including in a future module nobody has written
 * yet (the file list is read from disk, so `mediaPrePass.ts` and
 * `parseArchive.ts` are covered the moment they land).
 *
 * Exactly one exemption exists: the denylist in `jsonSafety.ts` that does the
 * deleting. It is located by name, and if it is ever renamed this test fails
 * loudly rather than quietly scanning less.
 */

import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const MODULE_DIR = join(__dirname, '..');

/**
 * Names that must not be read.
 *
 * Word-bounded and case-insensitive: `place` must not match `replace`, and
 * `EXIF_DATA` must not escape by shouting.
 */
const FORBIDDEN =
  /\b(?:exif\w*|latitude|longitude|coordinates?|place|tags|cross_post_source)\b/i;

/**
 * Blank out comments while preserving every string literal.
 *
 * A leak would most likely BE a string literal (`pickField(media, 'tags')`),
 * so stripping strings would strip the evidence. Comments are replaced by
 * spaces rather than deleted so that reported line numbers stay true.
 */
function stripComments(source: string): string {
  const out: string[] = [];
  let state: 'code' | 'line' | 'block' | 'single' | 'double' | 'template' = 'code';
  let i = 0;

  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];

    switch (state) {
      case 'code':
        if (ch === '/' && next === '/') {
          state = 'line';
          out.push('  ');
          i += 2;
          continue;
        }
        if (ch === '/' && next === '*') {
          state = 'block';
          out.push('  ');
          i += 2;
          continue;
        }
        if (ch === "'") state = 'single';
        else if (ch === '"') state = 'double';
        else if (ch === '`') state = 'template';
        out.push(ch);
        i++;
        continue;

      case 'line':
        if (ch === '\n') {
          state = 'code';
          out.push('\n');
        } else {
          out.push(' ');
        }
        i++;
        continue;

      case 'block':
        if (ch === '*' && next === '/') {
          state = 'code';
          out.push('  ');
          i += 2;
          continue;
        }
        out.push(ch === '\n' ? '\n' : ' ');
        i++;
        continue;

      default: {
        // Inside a string: copy verbatim, honour escapes, close on the quote.
        const quote = state === 'single' ? "'" : state === 'double' ? '"' : '`';
        if (ch === '\\') {
          out.push(ch, next ?? '');
          i += 2;
          continue;
        }
        if (ch === quote) state = 'code';
        out.push(ch);
        i++;
        continue;
      }
    }
  }

  return out.join('');
}

/** Remove the one sanctioned mention: `jsonSafety.ts`'s deletion denylist. */
function removeDenylist(file: string, source: string): string {
  if (file !== 'jsonSafety.ts') return source;
  const start = source.indexOf('const PRUNED_KEYS');
  expect(start).toBeGreaterThanOrEqual(0);
  const end = source.indexOf(']);', start);
  expect(end).toBeGreaterThan(start);
  return source.slice(0, start) + source.slice(end);
}

function sourceFiles(): string[] {
  return readdirSync(MODULE_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => entry.name)
    .sort();
}

describe('the Meta import never reads location, EXIF or tag data', () => {
  it('scans every module in the directory', () => {
    // Non-vacuity: if the glob ever stops finding files, this test would pass
    // by scanning nothing.
    const files = sourceFiles();
    expect(files).toContain('facebookParser.ts');
    expect(files).toContain('instagramParser.ts');
    expect(files).toContain('jsonSafety.ts');
    expect(files.length).toBeGreaterThanOrEqual(6);
  });

  it('strips comments without touching string literals', () => {
    // The stripper is the part of this test that could silently go blind.
    const stripped = stripComments(`const a = 'tags'; // exif_data\n/* latitude */ const b = 1;`);
    expect(stripped).toContain("'tags'");
    expect(stripped).not.toContain('exif_data');
    expect(stripped).not.toContain('latitude');
  });

  it.each(sourceFiles())('%s names no location, EXIF or tag field', (file) => {
    const source = readFileSync(join(MODULE_DIR, file), 'utf8');
    const code = removeDenylist(file, stripComments(source));
    const offenders = code
      .split('\n')
      .map((line, i) => ({ line: i + 1, text: line }))
      .filter((row) => FORBIDDEN.test(row.text));
    expect(offenders).toEqual([]);
  });
});
