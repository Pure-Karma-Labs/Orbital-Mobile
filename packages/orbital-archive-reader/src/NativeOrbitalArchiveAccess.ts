import type { TurboModule } from 'react-native';
import { TurboModuleRegistry } from 'react-native';

/**
 * Codegen spec for the HAND-WRITTEN glue TurboModule (#920, plan §3/§5).
 *
 * This file is NOT generated. ubrn generates `NativeOrbitalArchiveReader.ts`
 * (the Rust crate's installer) next to it, and both specs are picked up by the
 * one `OrbitalArchiveReaderSpec` codegen library declared in package.json.
 * Keeping them in one library is what lets a single pod and a single Gradle
 * project carry both modules.
 *
 * ## Division of labour
 *
 * The glue owns everything that needs a platform API or an entitlement:
 * the document picker, iOS security scope and bookmarks, Android SAF
 * persistable permissions, opening file descriptors, and CREATING staging
 * files (which on iOS must carry an explicit `NSFileProtectionCompleteUnlessOpen`
 * — the app default would make a read fail while the device is locked).
 *
 * Rust owns ZIP parsing, the allowlist, every cap, and extraction. It never
 * chooses a path to write: it opens the glue-created staging path with
 * `create(false)` + `O_NOFOLLOW`.
 *
 * ## Types are deliberately PLAIN
 *
 * Every string here is a bare `string` and every integer a bare `number`;
 * narrowing to branded/union types happens in `index.tsx`. Codegen's support
 * for string-literal unions differs across platforms and versions, and a
 * mismatch surfaces as a silent `undefined` at the bridge rather than a type
 * error (the `orbital-media-export` lesson).
 *
 * ## Error contract
 *
 * Every rejection carries one of the `ArchiveErrorCode` strings as its `code`
 * and NOTHING else — no file name, no path, no URI, no byte content — except
 * `userInfo.partIndex`, a single number, on an `openParts`
 * `ARCHIVE_ACCESS_LOST`. A part is identified by index, never by name; the
 * index space is documented once, on `ArchiveReaderError.partIndex` in
 * `index.tsx`, which also normalises anything it does not recognise to
 * `ARCHIVE_INTERNAL`.
 */

/**
 * One opened part. `fd` is BORROWED by Rust (plan §10 F2): the glue owns it
 * until `closeParts(handleIds)`, and Rust keeps only a dup.
 */
export type ArchivePartHandle = {
  /** Opaque glue-side handle; the only thing `closeParts` accepts. */
  handleId: string;
  /** Raw descriptor number. Valid only until `closeParts`. */
  fd: number;
  /** `fstat` size. Rust re-checks `seek(End)` against it. */
  byteLength: number;
  /** `"dev:ino"` from `fstat`. Rust rejects an fd whose identity differs. */
  fileId: string;
  /**
   * The part ref, REFRESHED if the platform handed back a renewed bookmark.
   * `index.tsx` re-encodes it into the token the caller persists.
   */
  ref: string;
  /** Whether a persistable grant is held for this ref (Android SAF). */
  persist: boolean;
};

export interface Spec extends TurboModule {
  /**
   * Present the system document picker for one or more ZIP files.
   *
   * Resolves the raw part refs, or `null` when the user cancelled — including
   * a swipe dismiss. Settles EXACTLY ONCE (the #971 double-callback lesson).
   * A second concurrent call rejects `PICKER_BUSY`.
   */
  pickArchiveParts(): Promise<Array<string> | null>;

  /**
   * Open every ref and return a borrowed descriptor per part.
   *
   * Rejects `ARCHIVE_ACCESS_LOST` when a ref no longer resolves (Android also
   * refuses any ref that is not a content URI) or the read is refused. That
   * rejection, and only that one, carries `userInfo.partIndex` — the zero-based
   * index into `refs`; see `ArchiveReaderError.partIndex` in `index.tsx`.
   *
   * On ANY rejection the glue must have closed every descriptor it had already
   * opened for this call, so the caller never has to close handles it was not
   * given.
   *
   * A ref stays usable longer than a release suggests: see the
   * token-revocation invariant in the `index.tsx` header (§4).
   */
  openParts(refs: Array<string>): Promise<Array<ArchivePartHandle>>;

  /**
   * Close the descriptors for these handles. Idempotent; unknown ids are
   * ignored. Synchronous so it can run inside a `finally` that must not yield.
   */
  closeParts(handleIds: Array<string>): void;

  /**
   * Cancel an in-flight `openParts`. iOS cancels the `NSFileCoordinator`;
   * Android is a no-op. Never settles the caller's promise itself.
   */
  cancelOpenParts(): void;

  /**
   * Create `<Caches>/<uuid>-archive-staging.bin` and resolve its absolute path.
   *
   * The UUID must be LOWER-CASE hex: Rust validates the leaf against
   * `^[0-9a-f-]{36}-archive-staging\.bin$` and keys its live-staging ledger on
   * the lower-cased leaf. The file is created EXCLUSIVELY (it fails if the path
   * exists), with `NSFileProtectionCompleteUnlessOpen` and excluded from
   * backup on iOS.
   */
  createStagingFile(): Promise<string>;

  /**
   * The directory `createStagingFile` writes into, as an absolute path.
   *
   * Synchronous because `openArchive` must hand it to Rust before any job
   * starts. It exists so the staging directory is asked of the component that
   * creates the files rather than re-derived in JS: Rust forces each staging
   * path's canonicalised parent to equal this directory, so a JS-side guess
   * that differed by one symlink would turn every extract into
   * `ARCHIVE_STAGING_UNAVAILABLE`.
   */
  getStagingDirectory(): string;

  /**
   * Unlink one staging file. Synchronous so it can run inside a `finally`.
   *
   * REFUSES, silently, any path that is not
   * `<getStagingDirectory()>/<uuid>-archive-staging.bin`: this is the only
   * delete this module exposes, and it must never be reachable as a general
   * unlink. Never throws for a path that does not exist.
   *
   * It lives here, rather than the service calling `react-native-fs`, so the
   * name check sits next to `createStagingFile` and this package keeps exactly
   * one native dependency.
   */
  unlinkStagingFile(path: string): void;

  /**
   * Release the persistable grant for these refs. Android calls
   * `releasePersistableUriPermission`; iOS is a no-op. Never throws for a ref
   * that holds no grant.
   *
   * This does NOT revoke access on either platform — see the token-revocation
   * invariant in the `index.tsx` header (§4).
   */
  releaseParts(refs: Array<string>): Promise<void>;

  /**
   * Release EVERY persistable grant this app holds (plan §10 F3).
   *
   * Android: iterates `contentResolver.persistedUriPermissions` and releases
   * all of them. iOS: no-op. Called from `localWipe` on BOTH wipe paths,
   * logout and account deletion (#921) — logout now clears the import job
   * rows too, so no grant is left worth keeping for a resume.
   */
  releaseAllPersistedParts(): Promise<void>;
}

export default TurboModuleRegistry.getEnforcing<Spec>('OrbitalArchiveAccess');
