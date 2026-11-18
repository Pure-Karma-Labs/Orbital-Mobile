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
import { stripFormatChars, URL_PATTERN_SOURCE } from './urlPattern';
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

/** A body that is nothing but a URL, with no other text around it. */
const WHOLE_URL_RE = new RegExp(`^${URL_PATTERN_SOURCE}$`, 'i');

/** Line terminators, including the two Unicode separators `\s` also matches. */
const LINE_BREAK_RE = /[\r\n\u2028\u2029]/;

const ZWJ = '\u200D';

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
 * `stripFormatChars` runs FIRST on this path and removes every `Cf` character,
 * which today includes ZWJ and the tag characters: those two arms are
 * therefore defence in depth rather than live paths, and they are kept so that
 * narrowing the strip later cannot silently start splitting emoji. The
 * variation-selector, skin-tone, combining-mark and surrogate arms are live —
 * none of those characters is `Cf`.
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

  const points = Array.from(collapsed);
  if (points.length <= MAX_HEADLINE_CODE_POINTS) return collapsed;

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

  // Format characters are stripped before anything is measured or matched: a
  // bidi override in a row title can make the headline read as a different
  // string entirely, and the list has no other context to correct it with.
  const body = stripFormatChars(t.body ?? '');
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
