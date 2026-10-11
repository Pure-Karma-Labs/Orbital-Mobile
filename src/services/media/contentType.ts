/**
 * Content types: normalization and byte-level format detection (#880).
 *
 * PURE: this module imports nothing (the `mediaLimits.ts` precedent), so the
 * export service, the upload sanitizer, the download path and the bulk runner
 * can all share ONE definition of "what format is this really" without
 * dragging in RNFS, the native TurboModules or the store.
 *
 * ## Why a byte check exists at all
 *
 * `orbital_media.content_type` is PEER-SUPPLIED and, worse, routinely WRONG
 * for our own rows: the upload pipeline re-encodes every still image that is
 * not already JPEG or PNG, so a row labelled `image/heic` by the Android
 * picker names JPEG bytes. A label is a claim about a file; only the file can
 * settle it. The sniff therefore corrects the LABEL and nothing else — it
 * never decides whether something may be saved (that is the closed allowlist
 * in `exportFileName.ts`) and it never changes a destination.
 *
 * The sniff is ADVISORY: `null` means "nothing recognized", and every caller
 * falls back to the declared type. That is what makes a short read, a
 * truncated header or an unknown container harmless.
 *
 * ## Aliases
 *
 * `CONTENT_TYPE_ALIASES` is a deliberate, audited extension of the closed
 * allowlist: each entry maps a non-canonical spelling a REAL client emits onto
 * the canonical type, so the allowlist does not have to grow a second key for
 * the same bytes. Every alias must name the client that emits it. Adding one
 * admits a new spelling to every routing decision in the app, so the bar is
 * "we have seen this on the wire", never "this looks plausible".
 */

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

/**
 * Non-canonical content types, mapped to the canonical spelling.
 *
 * - `image/jpg`: emitted by react-native-image-picker on iOS for every JPEG it
 *   hands back, so EVERY iOS-posted photo carries it. Before #880 it matched
 *   no entry in either export map and save-to-device refused all of them.
 */
export const CONTENT_TYPE_ALIASES: Readonly<Record<string, string>> = {
  'image/jpg': 'image/jpeg',
};

/**
 * Normalize a wire content type for map lookup: lower-cased, parameters
 * (`; charset=utf-8`) dropped, surrounding space trimmed, then aliased.
 */
export function normalizeContentType(contentType: string | null | undefined): string {
  if (typeof contentType !== 'string') return '';
  const semi = contentType.indexOf(';');
  const type = (semi === -1 ? contentType : contentType.slice(0, semi)).trim().toLowerCase();
  // hasOwnProperty, not `in`: `in` walks the prototype chain, so a content
  // type of 'constructor' or 'toString' would otherwise resolve to a function.
  return Object.prototype.hasOwnProperty.call(CONTENT_TYPE_ALIASES, type)
    ? CONTENT_TYPE_ALIASES[type]
    : type;
}

// ---------------------------------------------------------------------------
// Byte-level sniff
// ---------------------------------------------------------------------------

/**
 * How many leading bytes `sniffContentType` needs.
 *
 * 128 rather than the 16 the signatures themselves need: an ISO-BMFF `ftyp`
 * box lists its compatible brands after the major brand, and the brand that
 * decides between AVIF, HEIC and HEIF for a `mif1` major brand can sit well
 * past byte 32 in files written by real encoders. A short read is tolerated
 * (see the module header), so reading more than the minimum costs nothing but
 * buys the decisive brands.
 */
export const SNIFF_HEAD_BYTES = 128;

/** The 8-byte PNG signature. */
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** ISO-BMFF major brands that mean HEIC regardless of the compatible brands. */
const HEIC_MAJOR_BRANDS = new Set(['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'hevm', 'hevs']);

/** Compatible brands that settle a `mif1`/`msf1` major brand as HEIC. */
const HEIC_COMPATIBLE_BRANDS = new Set(['heic', 'heix', 'heim', 'heis']);

/** Major OR compatible brands that mean AVIF. */
const AVIF_BRANDS = new Set(['avif', 'avis']);

/**
 * ISO-BMFF major brands that mean plain MP4.
 *
 * `3gp*`/`3g2*` are deliberately ABSENT: Android recorders write a `3gp4`
 * major brand into files that are otherwise ordinary MP4s, so mapping it would
 * relabel a working `video/mp4` row as `video/3gpp` and move it to the
 * document route. An unmapped brand returns null and the declared type stands.
 */
const MP4_MAJOR_BRANDS = new Set([
  'isom',
  'iso2',
  'iso3',
  'iso4',
  'iso5',
  'iso6',
  'iso7',
  'iso8',
  'iso9',
  'mp41',
  'mp42',
  'avc1',
  'dash',
  'mmp4',
]);

/** Read `length` bytes at `offset` as case-sensitive ASCII. */
function ascii(bytes: Uint8Array, offset: number, length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) {
    out += String.fromCharCode(bytes[offset + i]);
  }
  return out;
}

function hasPngSignature(head: Uint8Array): boolean {
  for (let i = 0; i < PNG_SIGNATURE.length; i++) {
    if (head[i] !== PNG_SIGNATURE[i]) return false;
  }
  return true;
}

/**
 * Decide an ISO-BMFF file's type from its `ftyp` box.
 *
 * `head` is known to be at least 12 bytes with `ftyp` at offset 4.
 */
function sniffIsoBmff(head: Uint8Array): string | null {
  // Box size is a big-endian u32 at offset 0. Below 16 there is no room for
  // the size, the 'ftyp' tag, a major brand and a minor version — which also
  // rejects size 1 (the 64-bit `largesize` form) and size 0 ("to EOF").
  const size = ((head[0] << 24) | (head[1] << 16) | (head[2] << 8) | head[3]) >>> 0;
  if (size < 16) return null;

  const major = ascii(head, 8, 4);

  if (HEIC_MAJOR_BRANDS.has(major)) return 'image/heic';
  if (AVIF_BRANDS.has(major)) return 'image/avif';
  if (major === 'qt  ') return 'video/quicktime';
  if (major === 'M4V ' || major === 'M4VH' || major === 'M4VP') {
    return 'video/x-m4v';
  }
  if (MP4_MAJOR_BRANDS.has(major)) return 'video/mp4';

  if (major !== 'mif1' && major !== 'msf1') return null;

  // `mif1`/`msf1` is the generic HEIF brand: AVIF and HEIC both use it as the
  // major brand and declare their real codec among the compatible brands,
  // which start at offset 16 and run to the end of the box, 4-byte aligned.
  const end = Math.min(size, head.length);
  let sawHeic = false;
  for (let offset = 16; offset + 4 <= end; offset += 4) {
    const brand = ascii(head, offset, 4);
    if (AVIF_BRANDS.has(brand)) return 'image/avif';
    if (HEIC_COMPATIBLE_BRANDS.has(brand)) sawHeic = true;
  }
  if (sawHeic) return 'image/heic';

  // No decisive brand. That is only trustworthy when the WHOLE box was in the
  // bytes we read — otherwise the brand that would have settled it may simply
  // be past the end of the head, and claiming HEIF would be a guess. Returning
  // null leaves the declared type in place, which is the safe fallback.
  return size <= head.length ? 'image/heif' : null;
}

/**
 * Identify a media type from the first bytes of a file, or null.
 *
 * Only returns types that are already on an export allowlist: a format we do
 * not recognize, and anything a hostile peer would reach for (SVG, HTML, a
 * configuration profile), yields null so the declared type — which has already
 * been through the allowlist — stands.
 *
 * `head` may be SHORTER than `SNIFF_HEAD_BYTES`; every signature checks its
 * own length first, so a short or empty read simply returns null.
 */
export function sniffContentType(head: Uint8Array): string | null {
  const len = head.length;

  // JPEG: SOI (FF D8) plus the first marker byte of the next segment. The
  // third byte is load-bearing — FF D8 alone is two bytes of anything.
  if (len >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) {
    return 'image/jpeg';
  }
  if (len >= 8 && hasPngSignature(head)) return 'image/png';
  if (len >= 6) {
    const gif = ascii(head, 0, 6);
    if (gif === 'GIF87a' || gif === 'GIF89a') return 'image/gif';
  }
  if (len >= 12 && ascii(head, 0, 4) === 'RIFF' && ascii(head, 8, 4) === 'WEBP') {
    return 'image/webp';
  }
  if (len >= 12 && ascii(head, 4, 4) === 'ftyp') return sniffIsoBmff(head);

  return null;
}
