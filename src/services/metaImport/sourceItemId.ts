/**
 * `source_item_id` v1 — the per-post identity the Meta import dedups on (#925).
 *
 * ## What this is for
 *
 * #924 derives a 16-byte `import_key` as
 * `hmacSha256(K_import, ascii(source) ‖ 0x00 ‖ sourceItemId)[0..16]`, and the
 * 16 bytes are the BACKEND's `threads.import_key` CHECK constraint
 * (`threads_import_key_len`, migration 046 `meta-import-schema`): an imported
 * post is a row in `threads`, and the server dedups on
 * `(group_id, author_id, import_key)`. `import_items` is #921's MOBILE SQLite
 * table, which never leaves the device — naming it as the server's was wrong
 * about which layer enforces the width. The KEY property
 * is therefore **determinism across exports**: the same post, re-downloaded
 * next month into a differently-named ZIP, must frame to the same bytes, or a
 * re-import duplicates the member's whole history.
 *
 * ## Why raw framing and not a hash
 *
 * The issue originally said "hash of the text". This is a length-prefixed,
 * **injective** framing instead:
 *
 *  - A hash only adds collision surface. The HMAC downstream truncates to 128
 *    bits anyway, so hashing here buys nothing and costs a second preimage.
 *  - It keeps crypto and FFI out of the parser entirely — this module does no
 *    hashing, no HMAC, no HKDF, and imports nothing from `src/services/crypto/`.
 *  - HMAC accepts any input length, so there is no reason to compress.
 *  - #924's KAT treats `source_item_id` as opaque bytes, so the framing is
 *    free to be legible.
 *
 * Injectivity holds **by construction** for well-formed input: every
 * variable-length field is length-prefixed, every string goes through
 * `encodeUtf8Strict` (so a lone surrogate returns `null` here and becomes
 * `malformed_post` rather than a lossy U+FFFD that two different posts could
 * share), and the media list is length-prefixed per element.
 * `source ‖ 0x00 ‖ id` stays unambiguous downstream because `source` is one of
 * two NUL-free ASCII literals.
 *
 * ## Layout (big-endian throughout)
 *
 * ```
 * u8  version = 0x01
 * u8  kind
 *
 * kind 0x01 — content-derived (Facebook always; Instagram's fallback)
 *   i64 timestamp            epoch SECONDS, two's complement
 *   u32 textLen,  bytes      UTF-8 of the repaired, PRE-NFC text
 *   u32 urlLen,   bytes      UTF-8 of the accepted link url; 0 when none
 *   u32 mediaCount
 *   mediaCount × (u32 len, bytes)   UTF-8 of each media BASENAME, sorted by
 *                                   UTF-8 byte order, duplicates kept, and
 *                                   including VIDEO items
 *
 * kind 0x02 — platform id (Instagram `fbid`)
 *   u32 idLen, bytes         UTF-8 of the fbid string
 * ```
 *
 * ### Three decisions inside that layout
 *
 *  - **Pre-NFC text.** The archive's bytes are deterministic; the platform's
 *    Unicode normalisation tables are not (Hermes's `normalize('NFC')` is
 *    platform-backed, so the same post could frame differently on two OS
 *    versions). NFC applies to the STORED body only. The golden vectors
 *    include a decomposed/precomposed pair that deliberately frames
 *    DIFFERENTLY, to document the choice.
 *  - **All media, including video.** A post held for video must keep the same
 *    identity as the day it imports, if video is ever supported — and a post
 *    whose only difference from another is a video attachment is a different
 *    post.
 *  - **Basenames, not uris.** Meta's uri prefixes differ between export
 *    layouts (`your_facebook_activity/posts/media/…` vs `posts/media/…`) for
 *    the same photo. The basename is what is stable, and sorting them removes
 *    the export's ordering from the identity.
 *
 * ## Contract surface — what may NOT change silently
 *
 *  - The `version` byte bumps only on a breaking change, which means a full
 *    re-import for every member. New `kind` values are additive and do not bump
 *    it.
 *  - **`MAX_JSON_BYTES` is part of this contract.** Instagram's identity is
 *    `fbid` when `posts.json` is readable and content-derived when it is not,
 *    and `posts.json` crosses 12 MiB near ~1,300 posts. Lowering the cap flips
 *    some members from kind 0x02 to kind 0x01 and duplicates their posts on
 *    re-import — the same blast radius as a version bump, so treat it as one.
 *  - The output is **plaintext-class**: it embeds the post text verbatim. See
 *    `types.ts`. Never log it, never put it in an error, never persist it.
 */

import { encodeUtf8Strict } from '../../utils/utf8';

/** Framing version. A bump means a full re-import for every member. */
export const SOURCE_ITEM_ID_VERSION = 0x01;

/** `kind` byte: content-derived frame. */
export const SOURCE_ITEM_ID_KIND_CONTENT = 0x01;

/** `kind` byte: platform-supplied id (Instagram `fbid`). */
export const SOURCE_ITEM_ID_KIND_PLATFORM = 0x02;

export interface ContentIdInput {
  readonly kind: 'content';
  /**
   * Epoch SECONDS (the post's `timestamp`/`creation_timestamp` as exported),
   * not the epoch-ms `originalDate` carried on `ParsedPost`.
   */
  readonly timestampSeconds: number;
  /** The repaired, PRE-NFC post text. May be empty. */
  readonly text: string;
  /** The accepted `^https?://` link, or `null`. */
  readonly linkUrl: string | null;
  /**
   * Raw media uris, in file order. Basenames are taken and sorted here, so
   * the caller never has to.
   */
  readonly mediaUris: readonly string[];
}

export interface PlatformIdInput {
  readonly kind: 'platform';
  /** Instagram `fbid` exactly as the export spelled it. */
  readonly platformId: string;
}

export type SourceItemIdInput = ContentIdInput | PlatformIdInput;

/** Everything after the last `/`. `a/b/c.jpg` → `c.jpg`, `c.jpg` → `c.jpg`. */
export function basenameOfUri(uri: string): string {
  const slash = uri.lastIndexOf('/');
  return slash === -1 ? uri : uri.slice(slash + 1);
}

/** Lexicographic comparison of two byte strings (shorter prefix sorts first). */
function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const shared = a.length < b.length ? a.length : b.length;
  for (let i = 0; i < shared; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return a.length - b.length;
}

/**
 * Sort basenames by UTF-8 **byte** order, or `null` if one is not strictly
 * encodable.
 *
 * Not `Array.prototype.sort()`: the default sorts by UTF-16 code unit, which
 * disagrees with UTF-8 byte order for every astral character — `'�'`
 * sorts BEFORE `'\u{10000}'` in UTF-8 (`EF BF BD` < `F0 90 80 80`) and AFTER
 * it in UTF-16 (`FFFD` > `D800`). Either order would be self-consistent, but
 * only one of them is a property of the bytes rather than of the engine, and
 * the golden vectors pin it.
 *
 * Duplicates are KEPT: two attachments of the same photo are two media items.
 */
export function sortBasenamesUtf8(names: readonly string[]): string[] | null {
  const pairs: { name: string; bytes: Uint8Array }[] = [];
  for (const name of names) {
    const bytes = encodeUtf8Strict(name);
    if (bytes === null) return null;
    pairs.push({ name, bytes });
  }
  pairs.sort((a, b) => compareBytes(a.bytes, b.bytes));
  return pairs.map((pair) => pair.name);
}

/**
 * Build the v1 frame, or `null` when the post cannot be framed injectively.
 *
 * `null` means `malformed_post`, and happens when:
 *  - any string is not strictly UTF-8-encodable (an unpaired surrogate, which
 *    `TextEncoder` would silently replace), or is not a string at all;
 *  - a content frame's `timestampSeconds` is not a safe integer. The caller
 *    has already refused absent/non-integer timestamps with
 *    `missing_timestamp`; this is the framing's own floor.
 */
export function buildSourceItemId(input: SourceItemIdInput): Uint8Array | null {
  if (input.kind === 'platform') {
    const id = encodeUtf8Strict(input.platformId);
    if (id === null) return null;

    const frame = new Uint8Array(2 + 4 + id.length);
    const view = new DataView(frame.buffer);
    frame[0] = SOURCE_ITEM_ID_VERSION;
    frame[1] = SOURCE_ITEM_ID_KIND_PLATFORM;
    view.setUint32(2, id.length, false);
    frame.set(id, 6);
    return frame;
  }

  if (!Number.isSafeInteger(input.timestampSeconds)) return null;

  const text = encodeUtf8Strict(input.text);
  if (text === null) return null;

  const url = input.linkUrl === null ? new Uint8Array(0) : encodeUtf8Strict(input.linkUrl);
  if (url === null) return null;

  const sorted = sortBasenamesUtf8(input.mediaUris.map(basenameOfUri));
  if (sorted === null) return null;
  const media: Uint8Array[] = [];
  for (const name of sorted) {
    // Re-encoding rather than threading the bytes out of the sort keeps this
    // function's framing loop readable; `encodeUtf8Strict` already proved each
    // name encodable, so the `null` branch here is unreachable in practice and
    // is kept only so a future change cannot make it silently lossy.
    const bytes = encodeUtf8Strict(name);
    if (bytes === null) return null;
    media.push(bytes);
  }

  let size = 2 + 8 + 4 + text.length + 4 + url.length + 4;
  for (const bytes of media) size += 4 + bytes.length;

  const frame = new Uint8Array(size);
  const view = new DataView(frame.buffer);
  let at = 0;

  frame[at++] = SOURCE_ITEM_ID_VERSION;
  frame[at++] = SOURCE_ITEM_ID_KIND_CONTENT;

  // i64, two's complement, big-endian. `BigInt` rather than a hand-rolled
  // 32-bit pair: Hermes has BigInt, the conversion is exact for a safe
  // integer, and a negative timestamp (a pre-1970 back-dated post) frames
  // correctly without a sign-handling branch of our own.
  view.setBigInt64(at, BigInt(input.timestampSeconds), false);
  at += 8;

  view.setUint32(at, text.length, false);
  at += 4;
  frame.set(text, at);
  at += text.length;

  view.setUint32(at, url.length, false);
  at += 4;
  frame.set(url, at);
  at += url.length;

  view.setUint32(at, media.length, false);
  at += 4;
  for (const bytes of media) {
    view.setUint32(at, bytes.length, false);
    at += 4;
    frame.set(bytes, at);
    at += bytes.length;
  }

  return frame;
}
