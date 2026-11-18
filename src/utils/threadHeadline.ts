/**
 * The display-time headline for a thread row (#927 §7).
 *
 * ## Why this exists
 *
 * Meta's exports have no post titles. Every imported thread therefore arrives
 * with an empty title, and the list rendered all of them as "(no title)" — a
 * screen of identical rows. This derives something to read from what the
 * thread actually has: its body, or its photos.
 *
 * ## Rules of the house
 *
 * - **Pure and total.** No store, no React, no I/O, no logging (rule 35 pins
 *   the zero-log bar on this file). The same thread always yields the same
 *   string.
 * - **Display only, never written back.** The stored title stays empty, search
 *   is unaffected, and the navigation param stays the stored title — no
 *   decrypted body text enters navigation state.
 * - **No `Intl`, no segmenter, no new dependency.** `Intl` is lint-banned here
 *   (Hermes ships a trimmed ICU and has no `Segmenter` at all), so the cut is
 *   done by code point with a small, explicit back-off — see `safeCutIndex`.
 */

import type { Thread } from '../types/store';
import { URL_PATTERN_SOURCE } from './urlPattern';
import { extractUrlHost } from './urlHost';

/** What a caller shows when this returns null in a list row. */
export const NO_TITLE_FALLBACK = '(no title)';

/** The text branch's ceiling, in CODE POINTS (not UTF-16 units). */
const MAX_HEADLINE_CODE_POINTS = 60;

/**
 * The earliest index a word-boundary cut may land on. Below it, cutting at the
 * last space would throw away most of the line (a 60-character first word with
 * a space at index 3 would leave "the…"), so a hard cut reads better.
 */
const MIN_WORD_CUT = 30;

/**
 * How much of a collapsed line is ever expanded into code points.
 *
 * `Array.from` on the whole line allocates one string per code point, and a
 * body is bounded only by the backend's ceiling — a single-line 100 kB post
 * would build a 100 000-element array to read 60 characters off the front,
 * once per row, during a list render.
 *
 * `4 * (MAX + 2)` UTF-16 units is a deliberate over-count: the widest code
 * point is 2 units, so the prefix always holds at least `2 * (MAX + 2)` code
 * points — more than the cap plus the one lookahead the word-boundary search
 * needs. Nothing past it can change the answer.
 */
const MAX_PREFIX_UNITS = 4 * (MAX_HEADLINE_CODE_POINTS + 2);

/** A body that is nothing but a URL, with no other text around it. */
const WHOLE_URL_RE = new RegExp(`^${URL_PATTERN_SOURCE}$`, 'i');

/** Line terminators, including the two Unicode separators `\s` also matches. */
const LINE_BREAK_RE = /[\r\n\u2028\u2029]/;

const ZWJ = '\u200D';

/**
 * The characters a headline strips: the ones that can make a row read as a
 * string it is not, and nothing else.
 *
 * - **Bidi controls** (U+061C, U+200E, U+200F, U+202A-U+202E, U+2066-U+2069).
 *   An RTL override makes "gnp.exe" read as "exe.png" with no visible cause,
 *   and a list row has no surrounding context to correct it with.
 * - **Zero-width non-emoji** (U+200B, U+200C, U+2060, U+FEFF). Invisible, and
 *   usable to split a word or to pad a line past the cut.
 *
 * DELIBERATELY narrower than `stripFormatChars`, which removes every `Cf`
 * character. That set also holds U+200D (ZWJ) and the tag block
 * U+E0020-U+E007F, which spoof nothing: they are how a ZWJ emoji is built.
 * Stripping them took every such emoji in an imported post apart into its
 * components, which is the same damage {@link safeCutIndex} exists to
 * prevent at the other end of the line.
 *
 * `stripFormatChars` itself is unchanged and still guards URL display:
 * `extractUrlHost` applies it to every URL, including the one the link
 * branch below hands it, so an invisible character inside a host is still
 * removed before the host is shown.
 */
const SPOOF_CHARS_RE = /[\u061C\u200B\u200C\u200E\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/gu;

/** {@link SPOOF_CHARS_RE} applied — the headline's own, narrower strip. */
function stripSpoofChars(text: string): string {
  return text.replace(SPOOF_CHARS_RE, '');
}

/**
 * Code points that attach to whatever precedes them: a cut must never land
 * immediately BEFORE one, because doing so orphans the base character they
 * modify (and, for a variation selector, changes how it renders).
 *
 * - `Mn`/`Me`/`Mc` — combining marks, which covers both the combining accent
 *   case and the enclosing keycap (U+20E3) and variation selectors (U+FE0F).
 * - U+1F3FB–U+1F3FF — skin-tone modifiers.
 * - U+E0020–U+E007F — tag characters, the tail of a subdivision flag.
 * - ZWJ — the joiner itself.
 *
 * Every arm is LIVE. The headline's strip ({@link SPOOF_CHARS_RE}) keeps ZWJ
 * and the tag characters precisely so these clusters reach the cut whole, and
 * this function is what then refuses to cut inside one.
 */
function attachesToPrevious(codePoint: string): boolean {
  if (codePoint === ZWJ) return true;
  return /^[\p{Mn}\p{Me}\p{Mc}\u{1F3FB}-\u{1F3FF}\u{E0020}-\u{E007F}]$/u.test(codePoint);
}

/** A regional indicator — two of them in a row are one flag. */
function isRegionalIndicator(codePoint: string): boolean {
  return /^[\u{1F1E6}-\u{1F1FF}]$/u.test(codePoint);
}

/**
 * The largest index `<= index` at which `points` can be cut without splitting
 * a character cluster. `points` is an array of CODE POINTS, so a surrogate
 * pair is never split by construction; this handles the clusters built on top
 * of them.
 *
 * It backs off while the cut would land before an attaching code point, right
 * after a ZWJ, or in the middle of a regional-indicator pair. The loop
 * strictly decrements, so it always terminates; an index driven to 0 (a line
 * of nothing but combining marks) cuts everything, which is the safe answer
 * rather than a mangled one.
 */
function safeCutIndex(points: readonly string[], index: number): number {
  let cut = Math.min(index, points.length);

  while (cut > 0) {
    const next = points[cut];
    if (next !== undefined && attachesToPrevious(next)) {
      cut -= 1;
      continue;
    }
    if (points[cut - 1] === ZWJ) {
      cut -= 1;
      continue;
    }
    // Count the run of regional indicators ending at cut - 1: an odd run means
    // the cut would split a flag in half.
    let run = 0;
    while (run < cut && isRegionalIndicator(points[cut - 1 - run])) run += 1;
    if (run % 2 === 1) {
      cut -= 1;
      continue;
    }
    break;
  }

  return cut;
}

/** "Photo" / "3 photos" — the media branch's wording. */
function describePhotoCount(mediaCount: number): string {
  return mediaCount === 1 ? 'Photo' : `${mediaCount} photos`;
}

/**
 * The first non-empty line of `body`, whitespace collapsed and cut to roughly
 * {@link MAX_HEADLINE_CODE_POINTS} code points with a trailing ellipsis.
 */
function headlineFromText(text: string): string | null {
  const line = text.split(LINE_BREAK_RE).find((candidate) => candidate.trim() !== '');
  if (line === undefined) return null;

  const collapsed = line.replace(/\s+/g, ' ').trim();
  if (collapsed === '') return null;

  // Expand a bounded PREFIX, never the whole line — see MAX_PREFIX_UNITS.
  let end = MAX_PREFIX_UNITS;
  if (collapsed.length > end) {
    // Never end the prefix on a lone high surrogate: `Array.from` would turn
    // it into an unpaired code point that could reach the output.
    const lastUnit = collapsed.charCodeAt(end - 1);
    if (lastUnit >= 0xd800 && lastUnit <= 0xdbff) end -= 1;
  }
  const prefix = collapsed.length > end ? collapsed.slice(0, end) : collapsed;
  const points = Array.from(prefix);

  // Short enough to show whole — and that is only knowable when the prefix IS
  // the line. A truncated prefix always holds more than the cap, so a line
  // longer than it always needs an ellipsis.
  if (prefix === collapsed && points.length <= MAX_HEADLINE_CODE_POINTS) return collapsed;

  // A word boundary, if there is one far enough in to leave a useful headline.
  for (let i = MAX_HEADLINE_CODE_POINTS; i >= MIN_WORD_CUT; i -= 1) {
    if (points[i] === ' ') {
      return `${points.slice(0, i).join('')}…`;
    }
  }

  return `${points.slice(0, safeCutIndex(points, MAX_HEADLINE_CODE_POINTS)).join('')}…`;
}

/**
 * What to show as this thread's headline, or `null` when the thread offers
 * nothing to derive one from (the caller then shows {@link NO_TITLE_FALLBACK},
 * or "Thread" in a top bar).
 *
 * First match wins:
 *   1. A non-empty title — returned EXACTLY as stored, untouched.
 *   2. A body that is nothing but a URL → its host, or "Link".
 *   3. Any other non-empty body → its first line, collapsed and cut.
 *   4. An empty body with photos → "Photo" / "3 photos", or "Photos" when the
 *      count is unknown (a pre-010 cached row) and the thread is a media one.
 *   5. Otherwise null.
 *
 * `mediaCount` is the SERVER's count and includes reply media, so a text-less
 * post whose replies carry photos can read "3 photos" when it has two of its
 * own. That is the accepted trade (plan §1): the alternative is no count at
 * all, and the field is never used for anything but this wording.
 *
 * @example
 *   threadHeadline({ title: 'Trip', body: null, contentType: 'text', mediaCount: 0 })
 *     // 'Trip'
 *   threadHeadline({ title: '', body: 'https://example.com', contentType: 'link', mediaCount: 0 })
 *     // 'example.com'
 *   threadHeadline({ title: null, body: null, contentType: 'media', mediaCount: 3 })
 *     // '3 photos'
 */
export function threadHeadline(
  t: Pick<Thread, 'title' | 'body' | 'contentType' | 'mediaCount'>,
): string | null {
  const title = t.title ?? '';
  if (title.trim() !== '') return title;

  // Spoofing characters are stripped before anything is measured or matched:
  // a bidi override in a row title can make the headline read as a different
  // string entirely, and the list has no other context to correct it with.
  // ZWJ and tag characters survive, so an emoji sequence stays one cluster.
  const body = stripSpoofChars(t.body ?? '');
  const trimmedBody = body.trim();

  if (trimmedBody !== '') {
    if (WHOLE_URL_RE.test(trimmedBody)) {
      return extractUrlHost(trimmedBody) ?? 'Link';
    }
    const text = headlineFromText(body);
    if (text !== null) return text;
  }

  const mediaCount = t.mediaCount;
  if (mediaCount !== null && Number.isInteger(mediaCount) && mediaCount > 0) {
    return describePhotoCount(mediaCount);
  }
  // Unknown count (a row hydrated from a pre-010 cache) on a media thread: it
  // has photos, and how many is the only part we cannot say.
  if (mediaCount === null && t.contentType === 'media') return 'Photos';

  return null;
}
