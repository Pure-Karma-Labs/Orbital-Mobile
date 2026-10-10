import type { TurboModule } from 'react-native';
import { TurboModuleRegistry } from 'react-native';

/**
 * Codegen-facing types. Deliberately PLAIN: every string return is a bare
 * `string` here and is narrowed in index.tsx. Codegen's string-literal union
 * support differs across platforms and versions, and a mismatch would surface
 * as a silent `undefined` at the bridge rather than a type error.
 */

export type ExportFileItem = {
  /** Plain absolute path (no file:// scheme — index.tsx strips it). */
  sourcePath: string;
  /** Routing MIME type from the closed allowlist, NOT the peer's string. */
  mimeType: string;
  /** Basename only. Re-validated natively; see index.tsx. */
  displayName: string;
};

export interface Spec extends TurboModule {
  /**
   * Add one photo or video to the system photo library. Add-only access
   * (PHAccessLevelAddOnly on iOS, MediaStore on Android) — nothing is read
   * back, no album is created, and the source file is never moved, renamed or
   * deleted.
   *
   * `createdAtMs` is the post's creation time in milliseconds since the epoch;
   * 0 means "unknown, let the OS decide".
   *
   * Rejects with one of the MediaExportError codes (see index.tsx).
   */
  saveToPhotoLibrary(
    sourcePath: string,
    mimeType: string,
    displayName: string,
    createdAtMs: number,
  ): Promise<void>;

  /**
   * Export arbitrary files to a user-chosen destination.
   *
   * iOS: presents one UIDocumentPickerViewController for the whole batch and
   * resolves 'saved' or 'cancelled'.
   * Android: writes straight into Download/Orbital and ALWAYS resolves
   * 'saved' — there is no picker and therefore no cancellation.
   *
   * Narrowed to ExportFilesResult in index.tsx.
   */
  exportFiles(items: Array<ExportFileItem>): Promise<string>;

  /**
   * Current add-only photo-library authorization.
   * Narrowed to PhotoAddPermissionStatus in index.tsx.
   * Always 'notRequired' on Android (MediaStore needs no runtime permission on
   * API 29+, and the API 24-28 WRITE_EXTERNAL_STORAGE grant is requested from
   * JS via PermissionsAndroid, not here).
   */
  getPhotoAddPermission(): Promise<string>;

  /**
   * Request add-only photo-library access. Resolves the resulting status;
   * never rejects for a denial. Always 'notRequired' on Android.
   */
  requestPhotoAddPermission(): Promise<string>;
}

export default TurboModuleRegistry.getEnforcing<Spec>('OrbitalMediaExport');
