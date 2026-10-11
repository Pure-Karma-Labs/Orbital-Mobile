/**
 * Export routing and filename sanitation for #878 "Save to device".
 *
 * PURE: this module imports nothing but the equally pure `contentType.ts`
 * (the `mediaLimits.ts` precedent), so the service, the lightbox and the bulk
 * runner can all share one definition of "what may be saved and under what
 * name" without dragging in the native TurboModule, RNFS or the store.
 *
 * ## Why routing is a CLOSED allowlist
 *
 * `orbital_media.content_type` and `file_name` are PEER-SUPPLIED. Our own
 * composer only ever posts photos and videos (`useMediaPicker.ts`), so any
 * other content type on a row was crafted by another client. The on-disk
 * extension is derived from the sender's `file_name` and is therefore equally
 * untrusted — which is why the extension written into the exported file comes
 * from the map below, keyed on the content type, and never from the row.
 *
 * Anything absent from both maps is REFUSED. That is deliberate for the
 * specific types a hostile peer would reach for: `text/html` (a saved page
 * that runs script when opened), `image/svg+xml` (XML with script),
 * `application/x-apple-aspen-config` (an iOS configuration profile — opening
 * one offers to install an MDM payload), and apk/dex/jar/exe/sh. A closed
 * allowlist refuses all of them without naming them, and refuses the next one
 * nobody thought of too.
 *
 * The allowlist is applied to the DECLARED type, before the disclosure and the
 * permission prompt — a byte check can never rescue a refused type, and the
 * user must not be asked for photo access to save something we will refuse.
 * `reconcileExportLabel` runs later and only corrects the LABEL.
 */

import { normalizeContentType } from './contentType';

export { normalizeContentType };

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

/**
 * Content types the system photo library accepts, mapped to the extension we
 * write. PhotoKit takes HEIC/HEIF, WebP and GIF; anything it rejects at run
 * time comes back as EUNSUPPORTED and the service offers the Files route
 * instead, so this list being slightly optimistic is a recoverable state.
 */
export const PHOTO_LIBRARY_EXTENSIONS: Readonly<Record<string, string>> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/heic': 'heic',
  'image/heif': 'heif',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/x-m4v': 'm4v',
};

/**
 * Content types that go to the document route (iOS: the Files picker;
 * Android: `Download/Orbital`), mapped to the extension we write.
 *
 * Includes the image and video types OUTSIDE the photo list, because a gallery
 * that cannot display them is a worse destination than the file system.
 */
export const DOCUMENT_EXTENSIONS: Readonly<Record<string, string>> = {
  'application/pdf': 'pdf',
  'text/plain': 'txt',
  'text/csv': 'csv',
  'application/rtf': 'rtf',
  'text/rtf': 'rtf',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
    'docx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.ms-powerpoint': 'ppt',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation':
    'pptx',
  // image/* and video/* outside the photo-library list.
  'image/tiff': 'tiff',
  'image/bmp': 'bmp',
  'image/avif': 'avif',
  'image/x-icon': 'ico',
  'video/webm': 'webm',
  'video/x-matroska': 'mkv',
  'video/3gpp': '3gp',
  'video/x-msvideo': 'avi',
  'video/mpeg': 'mpg',
};

/** Where a single item is routed, and the extension its copy will carry. */
export type ExportRoute =
  | { kind: 'photo'; extension: string }
  | { kind: 'document'; extension: string }
  | { kind: 'refused' };

/**
 * Every extension either map can produce. Used by `telemetryScrub.ts` to keep
 * its filename scrub in step with what this module can actually write.
 */
export const EXPORT_EXTENSIONS: readonly string[] = Array.from(
  new Set([
    ...Object.values(PHOTO_LIBRARY_EXTENSIONS),
    ...Object.values(DOCUMENT_EXTENSIONS),
  ]),
).sort();

/**
 * Route one item by content type. `refused` is the default for everything
 * outside both maps — see the module header.
 */
export function resolveExportRoute(
  contentType: string | null | undefined,
): ExportRoute {
  const type = normalizeContentType(contentType);

  // hasOwnProperty, not `in`: `in` walks the prototype chain, so a content
  // type of 'constructor' or 'toString' would otherwise resolve to a function.
  if (Object.prototype.hasOwnProperty.call(PHOTO_LIBRARY_EXTENSIONS, type)) {
    return { kind: 'photo', extension: PHOTO_LIBRARY_EXTENSIONS[type] };
  }
  if (Object.prototype.hasOwnProperty.call(DOCUMENT_EXTENSIONS, type)) {
    return { kind: 'document', extension: DOCUMENT_EXTENSIONS[type] };
  }
  return { kind: 'refused' };
}

/** The content type an exported copy is labelled with, and its extension. */
export interface ExportLabel {
  contentType: string;
  extension: string;
}

/**
 * Reconcile the row's DECLARED content type with what the decrypted bytes say,
 * returning the label the copy is written with.
 *
 * The two outputs come from ONE route lookup, so the extension can never
 * disagree with the content type it was derived from.
 *
 * Rules:
 *  1. A refused declared type THROWS. Refusal happens before the download and
 *     before the disclosure (see the module header), so reaching here with one
 *     means a caller skipped that gate — which must be loud, not silently
 *     relabelled into something saveable.
 *  2. HEIC and HEIF are kept as DECLARED when the bytes are the other one of
 *     the pair. They are the same container with different brands, both go to
 *     the same destination, and the brands in a short head are not a strong
 *     enough signal to rename a user's file over.
 *  3. Otherwise an ALLOWED sniffed type wins: the bytes are the only honest
 *     description of a file.
 *  4. A sniffed type that is null or refused leaves the declared type. The
 *     sniff is advisory, and the declared type has already passed the
 *     allowlist.
 *
 * Never returns a refused type, so the caller always has an extension.
 */
export function reconcileExportLabel(
  declared: string | null | undefined,
  sniffed: string | null,
): ExportLabel {
  const declaredType = normalizeContentType(declared);
  const declaredRoute = resolveExportRoute(declaredType);
  if (declaredRoute.kind === 'refused') {
    throw new Error('reconcileExportLabel: declared content type is refused');
  }

  if (sniffed !== null) {
    const sniffedType = normalizeContentType(sniffed);
    const bothHeifFamily = isHeifFamily(declaredType) && isHeifFamily(sniffedType);
    if (!bothHeifFamily) {
      const sniffedRoute = resolveExportRoute(sniffedType);
      if (sniffedRoute.kind !== 'refused') {
        return { contentType: sniffedType, extension: sniffedRoute.extension };
      }
    }
  }

  return { contentType: declaredType, extension: declaredRoute.extension };
}

function isHeifFamily(type: string): boolean {
  return type === 'image/heic' || type === 'image/heif';
}

// ---------------------------------------------------------------------------
// Filename
// ---------------------------------------------------------------------------

/** Total length ceiling, extension included. */
const MAX_NAME_LENGTH = 100;

/**
 * Control characters (C0 + DEL + C1) and the Unicode bidi/format characters.
 *
 * The bidi set is the same defence as `stripFormatChars` in EmojiText: a
 * RIGHT-TO-LEFT OVERRIDE inside a name makes `evil.txt<RLO>gpj.exe` render as
 * `evil.txtexe.jpg` in a file browser.
 */
const STRIP_RE =
  // eslint-disable-next-line no-control-regex -- the C0/C1 ranges are the point
  /[\u0000-\u001F\u007F-\u009F​-‏‪-‮⁠-⁤⁦-⁯﻿]/g;

/** Characters no filesystem or MediaStore DISPLAY_NAME should carry. */
const UNSAFE_RE = /[/\\:*?"<>|]/g;

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/**
 * `Orbital-YYYYMMDD-HHmmss` — the stem used when the peer gave us nothing
 * usable. Local time, because it is a label a human reads next to the photo.
 */
export function fallbackExportStem(atMs: number): string {
  const d = new Date(Number.isFinite(atMs) && atMs > 0 ? atMs : Date.now());
  const date = `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`;
  const time = `${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
  return `Orbital-${date}-${time}`;
}

/**
 * Build the basename the exported copy is written under.
 *
 * Guarantees — each is re-validated natively, which rejects with EINVALIDNAME
 * rather than touching the filesystem, so these are belt AND braces:
 *  - non-empty, and never only dots or spaces;
 *  - no `/`, `\`, `:`, `*`, `?`, `"`, `<`, `>`, `|`;
 *  - no `..` path segment and no leading `.` (no hidden files, no traversal);
 *  - not absolute;
 *  - `extension` is the one from the closed map, never the peer's;
 *  - at most MAX_NAME_LENGTH characters in total.
 *
 * @param fileName  The peer-supplied `orbital_media.file_name`, or null.
 * @param extension The extension from `resolveExportRoute`, without a dot.
 * @param createdAtMs Post creation time, used only by the fallback stem.
 */
export function buildExportFileName(
  fileName: string | null | undefined,
  extension: string,
  createdAtMs: number,
): string {
  // NFC first: a decomposed name round-trips differently through MediaStore
  // and APFS, and normalizing before the length cap means the cap counts the
  // same characters the filesystem will.
  let stem = typeof fileName === 'string' ? fileName.normalize('NFC') : '';

  stem = stem.replace(STRIP_RE, '').replace(UNSAFE_RE, '-');

  // Drop a trailing extension so `photo.jpg` does not become `photo.jpg.jpg`
  // and `photo.exe` does not keep a second, misleading extension.
  //
  // Only the LAST segment, and only when it LOOKS like an extension: 2-5
  // alphanumerics. The lower bound of 2 is load-bearing — no extension either
  // map can produce is one character, while `Report v1.2` must keep its `.2`.
  const dot = stem.lastIndexOf('.');
  if (dot > 0 && /^[A-Za-z0-9]{2,5}$/.test(stem.slice(dot + 1))) {
    stem = stem.slice(0, dot);
  }

  // Collapse runs of dots (kills every `..` segment, not just the first) and
  // trim leading/trailing dots and whitespace — a leading dot is a hidden
  // file, a trailing one is stripped by Windows and by some providers.
  stem = stem.replace(/\.{2,}/g, '.').replace(/^[.\s]+|[.\s]+$/g, '');

  // Collapse internal whitespace runs: a name is a label, not a layout.
  stem = stem.replace(/\s+/g, ' ');

  const suffix = `.${extension}`;
  if (stem.length === 0) {
    stem = fallbackExportStem(createdAtMs);
  }

  const room = MAX_NAME_LENGTH - suffix.length;
  if (stem.length > room) {
    // Re-trim: the cut may have landed on a dot or a space.
    stem = stem.slice(0, room).replace(/[.\s]+$/g, '');
    if (stem.length === 0) stem = 'Orbital';
  }

  return `${stem}${suffix}`;
}
