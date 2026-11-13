/**
 * Repair Meta's UTF-8-as-latin1 mojibake (#925).
 *
 * ## The defect
 *
 * Meta's "Download Your Information" exporter writes JSON whose every
 * non-ASCII character is a `\u00XX` escape of a UTF-8 **byte**, not of a code
 * point. `JSON.parse` dutifully produces one code point per byte, so a post
 * containing `é` (UTF-8 `C3 A9`) arrives as the two-character string `Ã©`, and
 * an emoji arrives as four such characters. Both local real exports show the
 * same thing: all JSON is ASCII, and the latin1→UTF-8 repair below succeeded
 * on all 192 affected strings.
 *
 * ## The rule (single pass, deterministic)
 *
 *  1. If ANY code point is above 0xFF, leave the string alone. A real UTF-8
 *     character above U+00FF proves this string was never byte-escaped.
 *  2. If NO code point is in 0x80–0xFF, leave it alone. Pure ASCII cannot be
 *     mojibake.
 *  3. Otherwise take the latin1 byte image and STRICT-decode it. A success is
 *     the repair; `null` leaves the original standing.
 *
 * Strictness is the whole mechanism. A genuinely-typed lone `é` has the byte
 * image `E9`, which is a truncated 3-byte sequence and fails strict decode, so
 * it survives untouched. A lenient decoder would turn it into U+FFFD and
 * destroy the post.
 *
 * ## Properties
 *
 *  - **One layer per call, by choice.** Double-encoded mojibake repairs ONE
 *    level. Looping to a fixed point would be a guess about how many times
 *    Meta's pipeline mangled the string, and a guess that sometimes eats real
 *    content. The parser calls this exactly once per string, so one layer is
 *    the whole observable behaviour.
 *  - **Idempotent on everything except double-encoded input**, which is the
 *    precise form of the "single pass" rule above and worth stating exactly.
 *    A repaired string is stable because it either contains a code point above
 *    0xFF (rule 1 stops a second pass) or is a latin1 string whose byte image
 *    is not valid UTF-8 (rule 3 declines): `Ã©` → `é` → `é`. The ONLY way a
 *    second call changes anything is if the first call's output is itself
 *    well-formed mojibake, i.e. the input carried two layers. Refusing in that
 *    case would make doubly-mangled text permanently unreadable, which is
 *    worse than peeling one layer at a time.
 *  - **Accepted false positive.** A post that literally typed the characters
 *    `Ã©` is repaired to `é`. Two code points of a Latin-1 Supplement sequence
 *    that happens to be valid UTF-8 is overwhelmingly more likely to be the
 *    defect than the intent.
 */

import { decodeUtf8Strict } from '../../utils/utf8';

/**
 * Repair one string's mojibake, or return it unchanged.
 *
 * Never throws and never returns `null`: the caller's fallback IS the original
 * string, so there is no failure to report.
 */
export function repairMojibake(text: string): string {
  let sawHighByte = false;
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    // A code point above 0xFF (including any surrogate half, which is above
    // 0xFF by definition) means this string is not a byte image.
    if (unit > 0xff) return text;
    if (unit >= 0x80) sawHighByte = true;
  }
  if (!sawHighByte) return text;

  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);

  return decodeUtf8Strict(bytes) ?? text;
}
