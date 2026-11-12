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
const FORBIDDEN = /\b(?:exif\w*|latitude|longitude|coordinates?|place|tags|cross_post_source)\b/i;

/**
 * Where a `/` may legally begin a regex literal rather than a division.
 *
 * JavaScript cannot be tokenised without this distinction, and the stripper
 * has to make it: see `stripComments`. The set is the punctuation after which
 * no value can have been produced, so `/` cannot be an operator.
 */
const REGEX_MAY_START_AFTER = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';']);

/** The only keyword in this directory's modules a regex literal follows. */
const RETURN_BEFORE_REGEX = /\breturn$/;

/** How much preceding code the regex/division decision needs. `return` + slack. */
const TAIL_CHARS = 16;

/**
 * Blank out comments while preserving every string literal.
 *
 * A leak would most likely BE a string literal (`pickField(media, 'tags')`),
 * so stripping strings would strip the evidence. Comments are replaced by
 * spaces rather than deleted so that reported line numbers stay true.
 *
 * ## Why this knows about regex literals
 *
 * `facebookParser.ts` writes `const HTTP_URL = /^https?:\/\//;`. A stripper
 * that only looks for two slashes sees the literal's closing `//` as the
 * start of a line comment and blanks the rest of the line. Today that costs
 * one `;` and nothing else — but it means the stripper goes BLIND from that
 * point to end of line, so the next regex literal somebody writes could hide
 * a real `pickField(media, 'exif_data')` sitting after it, and this whole
 * test would still be green. The tokenising rule is therefore honoured: a `/`
 * opens a regex only where a value cannot already be on the stack, escapes
 * are respected, and a `/` inside a `[...]` class does not close the literal.
 */
function stripComments(source: string): string {
  const out: string[] = [];
  let state: 'code' | 'line' | 'block' | 'single' | 'double' | 'template' | 'regex' = 'code';
  let i = 0;
  /** The last `TAIL_CHARS` characters of CODE emitted, for the `/` decision. */
  let tail = '';
  /** Inside a `[...]` character class of the regex literal being scanned. */
  let inCharClass = false;

  const regexMayStart = (): boolean => {
    const before = tail.replace(/\s+$/, '');
    if (before.length === 0) return true;
    return REGEX_MAY_START_AFTER.has(before[before.length - 1]) || RETURN_BEFORE_REGEX.test(before);
  };

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
        if (ch === '/' && regexMayStart()) {
          state = 'regex';
          inCharClass = false;
          out.push(ch);
          tail = (tail + ch).slice(-TAIL_CHARS);
          i++;
          continue;
        }
        if (ch === "'") state = 'single';
        else if (ch === '"') state = 'double';
        else if (ch === '`') state = 'template';
        out.push(ch);
        tail = (tail + ch).slice(-TAIL_CHARS);
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

      case 'regex': {
        // A regex literal is kept VERBATIM — it is code, and a leak written
        // as `/exif_data/.test(key)` must still be caught.
        if (ch === '\\') {
          out.push(ch, next ?? '');
          i += 2;
          continue;
        }
        if (ch === '\n') {
          // Unterminated: the `/` was division after all. Bail out rather
          // than swallow the rest of the file on a misread.
          state = 'code';
          out.push('\n');
          i++;
          continue;
        }
        if (inCharClass) {
          if (ch === ']') inCharClass = false;
        } else if (ch === '[') {
          inCharClass = true;
        } else if (ch === '/') {
          state = 'code';
        }
        out.push(ch);
        tail = (tail + ch).slice(-TAIL_CHARS);
        i++;
        continue;
      }

      default: {
        // Inside a string: copy verbatim, honour escapes, close on the quote.
        const quote = state === 'single' ? "'" : state === 'double' ? '"' : '`';
        if (ch === '\\') {
          out.push(ch, next ?? '');
          i += 2;
          continue;
        }
        if (ch === quote) {
          state = 'code';
          // A closed string is a VALUE, so a `/` after it is division.
          tail = (tail + ch).slice(-TAIL_CHARS);
        }
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

/** Directory names whose contents are fixtures and tests, not the import. */
const NOT_THE_IMPORT = new Set(['__tests__', 'testUtils']);

/**
 * Every non-test module under `src/services/metaImport/`, RECURSIVELY.
 *
 * Recursive because a flat `readdirSync` scans only what the directory
 * happens to hold today: the moment anybody groups these modules into a
 * subdirectory, a flat scan stops looking at them and this test goes green by
 * scanning less. Paths are returned relative to `MODULE_DIR` so a failure
 * names the file a reader can open.
 *
 * `__tests__/` and `testUtils/` are skipped: fixtures exist precisely TO
 * carry `exif_data` and GPS subtrees for the reviver to prune, so scanning
 * them would make this test impossible to keep green for the right reason.
 */
function sourceFiles(dir: string = MODULE_DIR, prefix = ''): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      if (NOT_THE_IMPORT.has(entry.name)) continue;
      found.push(...sourceFiles(join(dir, entry.name), relative));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith('.ts')) found.push(relative);
  }
  return found.sort();
}

describe('the Meta import never reads location, EXIF or tag data', () => {
  it('scans every module in the directory', () => {
    // Non-vacuity: if the glob ever stops finding files, this test would pass
    // by scanning nothing.
    const files = sourceFiles();
    expect(files).toContain('facebookParser.ts');
    expect(files).toContain('instagramParser.ts');
    expect(files).toContain('jsonSafety.ts');
    // The real count, not a floor somebody picked once: the directory holds
    // twelve non-test modules, and a number well under that (it was 6) would
    // still pass on a scan that had quietly lost half of them.
    expect(files.length).toBeGreaterThanOrEqual(12);
  });

  it('strips comments without touching string literals', () => {
    // The stripper is the part of this test that could silently go blind.
    const stripped = stripComments(`const a = 'tags'; // exif_data\n/* latitude */ const b = 1;`);
    expect(stripped).toContain("'tags'");
    expect(stripped).not.toContain('exif_data');
    expect(stripped).not.toContain('latitude');
  });

  it('keeps reading code that follows a regex literal containing //', () => {
    // The live case is `facebookParser.ts`'s `HTTP_URL = /^https?:\/\//;`.
    // A stripper that reads that literal's closing `//` as a line comment is
    // blind from there to the end of the line — so the leak is written on
    // the SAME line here, and must survive the strip while the genuine
    // trailing comment is still removed.
    const stripped = stripComments(
      `const u = /^https?:\\/\\//; const leak = pickField(m, 'exif_data'); // latitude\n`,
    );
    expect(stripped).toContain("pickField(m, 'exif_data')");
    expect(stripped).toContain('/^https?:\\/\\//;');
    expect(stripped).not.toContain('latitude');
    expect(FORBIDDEN.test(stripped)).toBe(true);
  });

  it('still treats a division slash as division, not as a regex', () => {
    // The other half of the rule: after a VALUE, `/` is an operator. Reading
    // `a / b` as a regex would swallow everything to the next slash — which
    // is how a stripper hides a leak while looking more clever.
    const stripped = stripComments(`const r = total / count; const t = 'tags'; // exif_data`);
    expect(stripped).toContain('total / count');
    expect(stripped).toContain("'tags'");
    expect(stripped).not.toContain('exif_data');
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
