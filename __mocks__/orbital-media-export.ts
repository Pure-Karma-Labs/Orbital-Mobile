/**
 * Mock for the orbital-media-export TurboModule wrapper (mapped in
 * jest.config.js moduleNameMapper). Mirrors every export of
 * packages/orbital-media-export/src/index.tsx.
 *
 * MediaExportError is a real class (not a jest.fn) so that `instanceof` and
 * `e.code` routing in mediaExportService behave exactly as in production, and
 * so a test can drive every error branch with
 * `saveToPhotoLibrary.mockRejectedValue(new MediaExportError('ENOSPC'))`.
 */

export type MediaExportErrorCode =
  | 'EPERMISSION'
  | 'EUNSUPPORTED'
  | 'ENOSPC'
  | 'ENOENT'
  | 'ECANCELLED'
  | 'EEXPORT'
  | 'EINVALIDNAME';

export type ExportFilesResult = 'saved' | 'cancelled';

export type PhotoAddPermissionStatus =
  | 'granted'
  | 'denied'
  | 'restricted'
  | 'notDetermined'
  | 'notRequired';

export type ExportFileItem = {
  sourcePath: string;
  mimeType: string;
  displayName: string;
};

export type SavePhotoRequest = {
  sourcePath: string;
  mimeType: string;
  displayName: string;
  createdAtMs: number;
};

export const MEDIA_EXPORT_ERROR_CODES: readonly MediaExportErrorCode[] = [
  'EPERMISSION',
  'EUNSUPPORTED',
  'ENOSPC',
  'ENOENT',
  'ECANCELLED',
  'EEXPORT',
  'EINVALIDNAME',
];

export class MediaExportError extends Error {
  readonly code: MediaExportErrorCode;

  constructor(code: MediaExportErrorCode) {
    super(code);
    this.name = 'MediaExportError';
    this.code = code;
  }
}

export const isMediaExportError = jest.fn(
  (e: unknown): e is MediaExportError => e instanceof MediaExportError,
);

export const saveToPhotoLibrary = jest.fn<Promise<void>, [SavePhotoRequest]>(
  () => Promise.resolve(),
);

export const exportFiles = jest.fn<
  Promise<ExportFilesResult>,
  [readonly ExportFileItem[]]
>(() => Promise.resolve('saved' as ExportFilesResult));

export const getPhotoAddPermission = jest.fn<
  Promise<PhotoAddPermissionStatus>,
  []
>(() => Promise.resolve('granted' as PhotoAddPermissionStatus));

export const requestPhotoAddPermission = jest.fn<
  Promise<PhotoAddPermissionStatus>,
  []
>(() => Promise.resolve('granted' as PhotoAddPermissionStatus));
