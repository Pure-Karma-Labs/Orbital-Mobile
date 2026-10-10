/**
 * Predicate identifying PLAINTEXT-ADJACENT media staging residue in the
 * Caches directory.
 *
 * Lives in its own zero-import module (precedent: `mediaLimits.ts`) so both
 * consumers share exactly one definition:
 *
 *   1. `cleanupOrphanedChunks` (mediaUploadService) — the bootstrap reaper.
 *      Applies a 1h age guard + re-stat so it never truncates a live transfer.
 *   2. `localWipe` (authService) — logout and account deletion. NO age guard:
 *      wipe semantics delete everything matching, right now.
 *
 * RULE: any new staging/temp suffix written into Caches by the media pipeline
 * MUST match this predicate, or it silently survives a device wipe.
 *
 * LOCATION INVARIANT: staging residue must be written to the TOP LEVEL of the
 * Caches directory. Both sweeps are non-recursive `readDir` listings, so a
 * file in a subdirectory is structurally unreachable no matter what it is
 * named.
 *
 * ONE DOCUMENTED EXCEPTION (#878): the iOS document-export staging directory
 * `Caches/orbital-export/`, whose per-call `<uuid>/<name>` layout is forced by
 * UIDocumentPickerViewController — the picker exports a URL list, so each file
 * must keep its real display name and therefore needs its own directory. It is
 * deliberately NOT matched by the predicate below, because a suffix match
 * could never reach it. Instead `clearMediaExportStaging()`
 * (`mediaExportService.ts`) deletes the WHOLE directory, and it is wired into
 * both of this module's consumers next to their existing
 * `Caches/thumbnails` directory unlink. A new staging path that cannot sit at
 * the top level must follow that pattern: a named whole-directory sweep in
 * both consumers, never a new suffix here.
 *
 * DELIBERATELY EXCLUDED (each tracked separately, not an oversight):
 *   - `rn_image_picker_lib_temp_*` — Android picker temps: third-party naming,
 *     pre-sanitizer originals (#700).
 *   - `avatar-sanitized-*.jpg` / `avatar-upload-*.enc` — avatar staging temps
 *     have a separate lifecycle (#700).
 *   - the `avatars/` subdirectory — wiped at directory level by
 *     `clearAvatarCache`, not by suffix matching.
 *
 * Mechanical writer-to-predicate binding (incl. the native `-alias-staging.mp4`
 * writer in OrbitalMediaTranscoder.mm) is tracked as #702; the identity-reset
 * wipe path as #701.
 */
export function isStagingResidueName(name: string): boolean {
  const isChunk = name.includes('-chunk-') && name.endsWith('.bin');
  // Intentionally covers BOTH ciphertext staging suffixes: the upload's
  // `{id}-cipher.bin` and the download's `{id}-dl-cipher.bin` (#578).
  const isCipher = name.endsWith('-cipher.bin');
  // -staging.mp4 covers the video transcode staging file, which must carry
  // an .mp4 extension for AVAssetWriter.
  const isStaging =
    name.endsWith('-staging.bin') || name.endsWith('-staging.mp4');
  return isChunk || isCipher || isStaging;
}
