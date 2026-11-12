/**
 * Mojibake generation for the Meta import tests (#925).
 *
 * Its own leaf module, deliberately: three pure-text suites (`mojibake`,
 * `text`, `sourceItemId`) want nothing but this function, and importing it
 * from `builders.ts` dragged in the archive mock graph — `__mocks__`, the
 * policy layer, the native binding types — to escape one string. `builders.ts`
 * re-exports it, so nothing that already imports it has to change.
 */

/**
 * Turn a synthetic string into the mojibake Meta's exporter would produce.
 *
 * Meta writes every non-ASCII character as a `\u00XX` escape of a UTF-8 BYTE,
 * so `JSON.parse` yields one code point per byte: `'é'` → `'Ã©'`. This is the
 * exact inverse of `repairMojibake`, which is why the mojibake tests can be
 * written in readable text rather than in escape soup.
 *
 * Deliberately hand-rolled rather than `encodeUtf8Strict`: a fixture builder
 * that shared the implementation under test could agree with it about a bug.
 */
export function mojibakeEscape(text: string): string {
  let out = '';
  for (const codePoint of text) {
    const cp = codePoint.codePointAt(0) ?? 0;
    if (cp < 0x80) {
      out += String.fromCharCode(cp);
    } else if (cp < 0x800) {
      out += String.fromCharCode(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    } else if (cp < 0x10000) {
      out += String.fromCharCode(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    } else {
      out += String.fromCharCode(
        0xf0 | (cp >> 18),
        0x80 | ((cp >> 12) & 0x3f),
        0x80 | ((cp >> 6) & 0x3f),
        0x80 | (cp & 0x3f),
      );
    }
  }
  return out;
}
