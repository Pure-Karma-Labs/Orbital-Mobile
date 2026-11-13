/**
 * Strict UTF-8 codec (#925).
 *
 * ## Why a new module, and why here
 *
 * The Meta import has to answer one question the rest of the app never asks:
 * *are these bytes well-formed UTF-8?* Meta's exporter writes every non-ASCII
 * character as a `\u00XX` escape of a UTF-8 BYTE, so a repaired string is the
 * strict decode of its own latin1 byte image — and a string that is NOT
 * mojibake must FAIL that decode, or `repairMojibake` would corrupt it. A
 * lenient decoder answers "yes" to everything (U+FFFD for anything it dislikes)
 * and is therefore useless as a test.
 *
 * This lives in `src/utils/` rather than `src/services/metaImport/` because it
 * is a general codec, not import policy, and because the codec census below
 * says the app will want exactly one of these eventually.
 *
 * ## Codec census (2026-11-12) and the consolidation trigger
 *
 * Cited by SYMBOL, never by line number: two of the four line references this
 * table first carried were already stale by the time #987 reviewed them, and a
 * census nobody can trust is a census nobody re-reads.
 *
 * | Site | Shape | Status |
 * |---|---|---|
 * | `contentCrypto.ts` — `encodeUTF8` / `decodeUTF8` | hand-rolled pair, LENIENT decode (no validation, no surrogate check) | replace with this pair the next time that file is touched for encoding reasons; it is on the message hot path and is not being destabilised for a refactor |
 * | `crypto/utils.ts` — `encodeUTF8` | latin1-TRUNCATING (`charCodeAt` into a byte, #373), 2 live ASCII-only callers (`identityKeyProbe.ts`, `inviteCrypto.ts`) | rename or delete when those callers are next edited. **#925 never calls it** — for a Meta post it would silently truncate every non-ASCII character to one byte |
 * | `orbital-archive-reader/src/index.tsx` — `utf8Encode` / `utf8Decode` | its own hand-rolled pair | STAYS. The package must not depend on app `src/`, and its pair only ever sees the token codec's ASCII/base64url |
 * | `crypto/safetyNumber.ts` — `new TextEncoder()` | already the sanctioned encode |
 *
 * ## Hermes (0.82.1, measured on the Pods binary)
 *
 * `TextEncoder` **exists**; `TextDecoder` **does not**. Jest's node environment
 * has both, which is a trap: a `new TextDecoder()` added anywhere in `src/` or
 * a package's own `src` passes every test and throws on device. Security invariant
 * 29.8 clause 8 bans it repo-wide for exactly that reason, and clause 7 pins
 * `encodeUtf8Strict` to the `TextEncoder` wrapper rather than a hand-rolled
 * loop. `decodeUtf8Strict` therefore cannot be a `TextDecoder({fatal:true})`
 * wrapper on device — it is hand-written, and its test asserts byte-for-byte
 * parity with Node's `TextDecoder({fatal:true})` over a table plus 10k seeded
 * random buffers, so "hand-written" does not mean "hand-specified".
 */

/**
 * Decode `bytes` as strict UTF-8, or `null` if they are not well-formed.
 *
 * Rejects, with no replacement character anywhere: a continuation byte in lead
 * position, `0xC0`/`0xC1` and `0xF5`–`0xFF` (always overlong or out of range),
 * a short continuation run (truncated input included), a non-continuation byte
 * inside a sequence, an overlong encoding, a surrogate code point
 * (U+D800–U+DFFF — CESU-8/WTF-8 input is NOT accepted) and anything above
 * U+10FFFF.
 *
 * The output is UTF-16, so astral code points come back as surrogate PAIRS;
 * that is the JS string representation of the code point, not an accepted
 * surrogate in the input.
 */
export function decodeUtf8Strict(bytes: Uint8Array): string | null {
  const length = bytes.length;
  // Code units are flushed in blocks rather than appended one at a time: a
  // 12 MiB posts.json repair touches a few hundred strings, but each one is
  // built here and `+=` per code point is what makes that quadratic in Hermes.
  const FLUSH_AT = 1024;
  const units: number[] = [];
  let out = '';
  let i = 0;

  while (i < length) {
    const b0 = bytes[i];
    let codePoint: number;
    let extra: number;
    let minimum: number;

    if (b0 < 0x80) {
      codePoint = b0;
      extra = 0;
      minimum = 0;
    } else if (b0 >= 0xc2 && b0 <= 0xdf) {
      codePoint = b0 & 0x1f;
      extra = 1;
      minimum = 0x80;
    } else if (b0 >= 0xe0 && b0 <= 0xef) {
      codePoint = b0 & 0x0f;
      extra = 2;
      minimum = 0x800;
    } else if (b0 >= 0xf0 && b0 <= 0xf4) {
      codePoint = b0 & 0x07;
      extra = 3;
      minimum = 0x10000;
    } else {
      // 0x80-0xBF (continuation in lead position), 0xC0/0xC1 (always an
      // overlong 1-byte value) and 0xF5-0xFF (always > U+10FFFF).
      return null;
    }

    if (i + extra >= length) return null; // truncated sequence
    for (let k = 1; k <= extra; k++) {
      const b = bytes[i + k];
      if ((b & 0xc0) !== 0x80) return null;
      codePoint = (codePoint << 6) | (b & 0x3f);
    }
    i += extra + 1;

    if (codePoint < minimum) return null; // overlong
    if (codePoint > 0x10ffff) return null; // out of range (0xF4 0x90+ ...)
    if (codePoint >= 0xd800 && codePoint <= 0xdfff) return null; // surrogate

    if (codePoint > 0xffff) {
      const rest = codePoint - 0x10000;
      units.push(0xd800 + (rest >> 10), 0xdc00 + (rest & 0x3ff));
    } else {
      units.push(codePoint);
    }

    if (units.length >= FLUSH_AT) {
      out += String.fromCharCode(...units);
      units.length = 0;
    }
  }

  if (units.length > 0) out += String.fromCharCode(...units);
  return out;
}

/**
 * Whether `text` contains a surrogate code unit that is not part of a pair.
 *
 * Kept OUT of `encodeUtf8Strict` so that function stays a pure `TextEncoder`
 * wrapper (invariant 29.8 clause 7 forbids a code-unit loop in its window —
 * this is the one that is allowed to exist, and it reads code units without
 * producing bytes).
 */
function hasUnpairedSurrogate(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit < 0xd800 || unit > 0xdfff) continue;
    if (unit > 0xdbff) return true; // low surrogate with no high before it
    const next = i + 1 < text.length ? text.charCodeAt(i + 1) : -1;
    if (next < 0xdc00 || next > 0xdfff) return true; // high with no low after
    i++;
  }
  return false;
}

/**
 * UTF-8 encode a string, or `null` if it is not strictly encodable.
 *
 * `null` for two inputs `TextEncoder` would otherwise accept silently:
 *
 *  - **a non-string.** `new TextEncoder().encode(undefined)` returns the 9
 *    bytes of `"undefined"`. Every string reaching the Meta parsers comes out
 *    of `JSON.parse` on an attacker-supplied file, so "it is a string" is a
 *    runtime fact, not a type-system one — hence `unknown`.
 *  - **an unpaired surrogate.** `TextEncoder` substitutes U+FFFD, which is
 *    LOSSY and therefore not injective: two different posts could frame to the
 *    same `source_item_id`. `#925` treats `null` as `malformed_post`, which is
 *    what makes the v1 framing injective by construction.
 */
export function encodeUtf8Strict(value: unknown): Uint8Array | null {
  if (typeof value !== 'string') return null;
  if (hasUnpairedSurrogate(value)) return null;
  return new TextEncoder().encode(value);
}
