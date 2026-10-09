/**
 * Public wrapper for the OrbitalMediaExport TurboModule.
 *
 * Consumers import from 'orbital-media-export' only — never from
 * ./NativeOrbitalMediaExport directly. Exactly one module in the app may
 * import it (src/services/mediaExportService.ts), enforced by the
 * `media-export-import-restricted` rule in
 * scripts/check-security-invariants.mjs.
 *
 * Contract notes:
 * - Saving is a COPY. Nothing here moves, renames or deletes the source: the
 *   decrypted file under MEDIA_DIR is the app's durable archive.
 * - Every path argument reaches native as a PLAIN absolute path. This wrapper
 *   strips a leading `file://` so callers may pass either form.
 * - `displayName` must be a basename. Native re-validates it (empty,
 *   absolute, `/`, `\`, `..`, leading dot) and rejects with EINVALIDNAME
 *   before touching the filesystem; this wrapper does NOT sanitize, because
 *   the single source of truth for export filenames is the service's closed
 *   extension map.
 * - NOTHING IS LOGGED HERE and nothing identifying ever reaches a thrown
 *   Error. MediaExportError carries a code and a FIXED message chosen by that
 *   code — there is no message parameter, so a native message, a path, a
 *   filename or a media id cannot be interpolated into it even by accident.
 *   (The native layer is equally silent: no NSLog/os_log/android.util.Log.)
 * - Native string RESOLUTIONS are narrowed here. An unrecognized string is a
 *   contract violation, not a value to pass through: it is rejected as
 *   EEXPORT rather than leaking an unknown state into the UI.
 */

import type {
  ExportFileItem,
  Spec,
} from './NativeOrbitalMediaExport';

export type { ExportFileItem };

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Result of exportFiles. Android never returns 'cancelled' (no picker). */
export type ExportFilesResult = 'saved' | 'cancelled';

/** Add-only photo-library authorization. 'notRequired' on Android. */
export type PhotoAddPermissionStatus =
  | 'granted'
  | 'denied'
  | 'restricted'
  | 'notDetermined'
  | 'notRequired';

/** Native error codes surfaced by the module. */
export type MediaExportErrorCode =
  | 'EPERMISSION'
  | 'EUNSUPPORTED'
  | 'ENOSPC'
  | 'ENOENT'
  | 'ECANCELLED'
  | 'EEXPORT'
  | 'EINVALIDNAME';

/** Every code the module may surface, for exhaustive handling in callers. */
export const MEDIA_EXPORT_ERROR_CODES: readonly MediaExportErrorCode[] = [
  'EPERMISSION',
  'EUNSUPPORTED',
  'ENOSPC',
  'ENOENT',
  'ECANCELLED',
  'EEXPORT',
  'EINVALIDNAME',
];

/**
 * Fixed, non-identifying messages. These are developer-facing text for a
 * stack trace or a __DEV__ warning, NOT user copy — the service maps codes to
 * user-visible strings. They are constants on purpose: see the header note.
 */
const MESSAGES: Record<MediaExportErrorCode, string> = {
  EPERMISSION: 'photo library access not granted',
  EUNSUPPORTED: 'destination rejected this media type',
  ENOSPC: 'not enough space to save',
  ENOENT: 'source unavailable',
  ECANCELLED: 'export cancelled',
  EEXPORT: 'export failed',
  EINVALIDNAME: 'invalid export filename',
};

export class MediaExportError extends Error {
  readonly code: MediaExportErrorCode;

  constructor(code: MediaExportErrorCode) {
    super(MESSAGES[code]);
    this.name = 'MediaExportError';
    this.code = code;
  }
}

export function isMediaExportError(e: unknown): e is MediaExportError {
  return e instanceof MediaExportError;
}

/** Parameters of a single photo-library save. */
export type SavePhotoRequest = {
  /** Absolute path (a `file://` prefix is stripped here). */
  sourcePath: string;
  /** MIME type from the service's closed photo/video allowlist. */
  mimeType: string;
  /** Basename, extension included. */
  displayName: string;
  /** Post creation time, ms since epoch. 0 = unknown. */
  createdAtMs: number;
};

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

let native: Spec | null = null;

/**
 * Resolve the TurboModule on first use. Lazy for the same reason as the
 * transcoder: a failed autolink must surface at the first save, not as a red
 * screen at app boot.
 */
function getNative(): Spec {
  if (native === null) {
    native = require('./NativeOrbitalMediaExport').default as Spec;
  }
  return native;
}

/** Strip a leading file:// scheme; native APIs take plain filesystem paths. */
function normalizePath(p: string): string {
  return p.startsWith('file://') ? p.slice('file://'.length) : p;
}

function isErrorCode(v: unknown): v is MediaExportErrorCode {
  return (
    typeof v === 'string' &&
    (MEDIA_EXPORT_ERROR_CODES as readonly string[]).includes(v)
  );
}

/**
 * Normalize ANY rejection to a MediaExportError. An unrecognized or missing
 * code becomes EEXPORT; the original error's message is read by nothing.
 */
function toExportError(e: unknown): MediaExportError {
  if (e instanceof MediaExportError) {
    return e;
  }
  const code =
    typeof e === 'object' && e !== null && isErrorCode((e as { code?: unknown }).code)
      ? (e as { code: MediaExportErrorCode }).code
      : 'EEXPORT';
  return new MediaExportError(code);
}

function narrowPermission(value: unknown): PhotoAddPermissionStatus {
  switch (value) {
    case 'granted':
    case 'denied':
    case 'restricted':
    case 'notDetermined':
    case 'notRequired':
      return value;
    default:
      // A native status we do not know how to reason about must not be
      // treated as "granted" OR silently as "denied" — it is a broken
      // contract, so it fails the operation.
      throw new MediaExportError('EEXPORT');
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Add one photo or video to the system photo library.
 *
 * The caller must have add-only permission already (see
 * requestPhotoAddPermission) on iOS; on Android this needs no permission on
 * API 29+ and WRITE_EXTERNAL_STORAGE on API 24-28, which the service requests
 * through PermissionsAndroid.
 *
 * @throws MediaExportError
 */
export async function saveToPhotoLibrary(
  request: SavePhotoRequest,
): Promise<void> {
  try {
    await getNative().saveToPhotoLibrary(
      normalizePath(request.sourcePath),
      request.mimeType,
      request.displayName,
      request.createdAtMs,
    );
  } catch (e) {
    throw toExportError(e);
  }
}

/**
 * Export files to a user-chosen destination (iOS: one document picker for the
 * whole batch; Android: Download/Orbital).
 *
 * Resolves 'cancelled' only on iOS. An empty batch is a caller bug and is
 * rejected without reaching native, because UIDocumentPickerViewController
 * has no defined behaviour for an empty URL list.
 *
 * @throws MediaExportError
 */
export async function exportFiles(
  items: readonly ExportFileItem[],
): Promise<ExportFilesResult> {
  if (items.length === 0) {
    throw new MediaExportError('EEXPORT');
  }
  let result: string;
  try {
    result = await getNative().exportFiles(
      items.map((item) => ({
        sourcePath: normalizePath(item.sourcePath),
        mimeType: item.mimeType,
        displayName: item.displayName,
      })),
    );
  } catch (e) {
    throw toExportError(e);
  }
  if (result === 'saved' || result === 'cancelled') {
    return result;
  }
  throw new MediaExportError('EEXPORT');
}

/**
 * Current add-only photo-library authorization. 'notRequired' on Android.
 * Never prompts.
 *
 * @throws MediaExportError
 */
export async function getPhotoAddPermission(): Promise<PhotoAddPermissionStatus> {
  try {
    return narrowPermission(await getNative().getPhotoAddPermission());
  } catch (e) {
    throw toExportError(e);
  }
}

/**
 * Request add-only photo-library access, prompting at most once per install
 * (the OS decides). Resolves the resulting status — a denial is a value, not
 * an error. 'notRequired' on Android.
 *
 * @throws MediaExportError
 */
export async function requestPhotoAddPermission(): Promise<PhotoAddPermissionStatus> {
  try {
    return narrowPermission(await getNative().requestPhotoAddPermission());
  } catch (e) {
    throw toExportError(e);
  }
}
