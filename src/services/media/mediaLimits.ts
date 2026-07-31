/**
 * Size limits shared by the media upload and download paths.
 *
 * Lives in its own module so `api/media.ts` can enforce a download byte
 * ceiling without importing `mediaUploadService` (which imports `api/media`).
 */

/**
 * Maximum PLAINTEXT file size accepted for upload (50MB).
 *
 * Historically set by the receiver-side one-shot decrypt, which held ~3.3x the
 * file size in transient memory. Streaming decrypt (#578) removed that
 * constraint; raising the cap is #458.
 */
export const MAX_UPLOAD_SIZE_BYTES = 50 * 1024 * 1024;

/**
 * Maximum number of bytes the attachment wire format adds on top of the
 * plaintext: IV(16) + at most one full PKCS7 pad block(16) + HMAC(32).
 *
 * Exact ciphertext length is `16 + ceil((n + 1) / 16) * 16 + 32`, so the
 * overhead is 49..64 bytes for any n.
 */
export const MAX_CIPHERTEXT_OVERHEAD_BYTES = 64;

/**
 * Hard ceiling on a ciphertext blob we will write to disk on download (#661).
 *
 * A plaintext file exactly at MAX_UPLOAD_SIZE_BYTES encrypts to more than
 * MAX_UPLOAD_SIZE_BYTES, so clamping the download ceiling at the upload cap
 * would reject a legitimately at-cap file.
 */
export const MAX_CIPHERTEXT_BYTES =
  MAX_UPLOAD_SIZE_BYTES + MAX_CIPHERTEXT_OVERHEAD_BYTES;

/**
 * Read size for the streaming crypto passes (1MB).
 *
 * Shared by the upload encrypt pass and both download decrypt passes so there
 * is exactly one chunk constant for FFI-bound file reads.
 */
export const STREAM_READ_SIZE_BYTES = 1 * 1024 * 1024;

/**
 * Free-space margin required beyond the download itself. Filling the last byte
 * of a device is worse than failing the download.
 *
 * The download preflight formula is:
 *   freeSpace - alreadyReserved > 2 * ciphertextByteCeiling(size) + this
 * The 2x is because the ciphertext staging file and the plaintext `.tmp`
 * coexist for the whole of decrypt pass 2.
 */
export const DISK_HEADROOM_BYTES = 64 * 1024 * 1024;

/**
 * Upper bound on bytes we will accept onto disk for one download (#661).
 *
 * `expectedBytes` is server truth (ciphertext length) for received media, but
 * the uploader's OWN row records the PLAINTEXT length — so the maximum
 * wire-format overhead is added before the global clamp, or a legitimately
 * at-cap self-upload would be rejected on re-download.
 *
 * Pure policy: this module imports nothing, so both the transport
 * (`api/media.ts`) and the service (`mediaDownloadService.ts`) can share one
 * definition without an import cycle.
 */
export function ciphertextByteCeiling(expectedBytes?: number | null): number {
  if (
    expectedBytes == null ||
    !Number.isFinite(expectedBytes) ||
    expectedBytes <= 0
  ) {
    return MAX_CIPHERTEXT_BYTES;
  }
  return Math.min(
    expectedBytes + MAX_CIPHERTEXT_OVERHEAD_BYTES,
    MAX_CIPHERTEXT_BYTES,
  );
}
