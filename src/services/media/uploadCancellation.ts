/**
 * Upload cancellation sentinel — deliberately a ZERO-IMPORT leaf module.
 *
 * Both `mediaUploadService.ts` and `media/videoProcessing.ts` throw this exact
 * message when an in-flight upload is aborted, and `isUploadCancellation()`
 * (mediaUploadService) matches on it. Siting the constant here rather than in
 * either thrower keeps the two modules free of a cycle: videoProcessing is
 * imported BY mediaUploadService, so a constant living in mediaUploadService
 * would make videoProcessing import its own importer.
 *
 * Mirrors `DOWNLOAD_ABORTED_MESSAGE` on the download side.
 */

/** Message carried by every self-thrown upload-cancellation Error. */
export const UPLOAD_CANCELLED_MESSAGE = 'Upload cancelled';
