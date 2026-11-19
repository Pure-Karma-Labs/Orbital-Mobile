/**
 * Shared deterministic stand-in for #924's `deriveImportKey` (#930 D5).
 *
 * Extracted from `smokeArchive.test.ts` and `parseArchive.test.ts` where it
 * was copy-pasted verbatim. One definition: a four-lane FNV-1a over the
 * framed bytes, 16 bytes wide like the real HMAC, stable across runs, and
 * distinct for distinct input — which is all the dedup set needs. It is
 * deliberately NOT a real MAC: a parser that reached for crypto would be
 * the bug.
 */
export function fakeDeriveImportKey(sourceItemId: Uint8Array): Promise<Uint8Array> {
  const key = new Uint8Array(16);
  for (let lane = 0; lane < 4; lane++) {
    let hash = (0x811c9dc5 ^ Math.imul(lane, 0x9e3779b9)) >>> 0;
    for (const byte of sourceItemId) {
      hash = (hash ^ (byte + lane)) >>> 0;
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    key.set([hash >>> 24, (hash >>> 16) & 0xff, (hash >>> 8) & 0xff, hash & 0xff], lane * 4);
  }
  return Promise.resolve(key);
}
