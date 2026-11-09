// ===========================================================================
// STUB — NOT THE IMPLEMENTATION. Brief B5 (Android glue) replaces this file
// wholesale with the real module; see plan §5 "Android".
//
// It exists only so `OrbitalArchiveReaderPackage.kt` compiles: that file is
// hand-edited and `noOverwrite`-protected so it can register BOTH modules, and
// a `when` branch naming a class that does not exist is a compile error, which
// would break every Android build in between B3 and B5.
//
// Every method here rejects or no-ops with ARCHIVE_INTERNAL. Nothing in this
// file is a design decision: B5 owns the picker, the SAF persistable grants,
// the descriptor map, the staging-file creation and the executor.
//
// What B5 MUST honour (contracts the TypeScript side already relies on):
//  * Reject codes only: PICKER_BUSY, ARCHIVE_ACCESS_LOST, ARCHIVE_NOT_SEEKABLE,
//    ARCHIVE_STAGING_UNAVAILABLE, ARCHIVE_NO_SPACE, ECANCELLED,
//    ARCHIVE_INTERNAL. No file name, path, URI or content in any message.
//  * `pickArchiveParts` settles EXACTLY once, including on back-dismiss.
//  * `openParts` closes every descriptor it already opened before it rejects.
//    The caller only ever closes handles it was actually given.
//  * `closeParts`, `cancelOpenParts` and `unlinkStagingFile` must do their work
//    INLINE on the calling thread, NOT on the executor: the JS side calls them
//    from `finally` blocks and treats them as already done on return.
//  * `createStagingFile` creates `<cacheDir>/<uuid>-archive-staging.bin` with a
//    LOWER-CASE hex UUID (Rust validates `^[0-9a-f-]{36}-archive-staging\.bin$`
//    and keys its live-staging ledger on the lower-cased leaf, so an uppercase
//    UUID is rejected outright), exclusively (`createNewFile()` must return
//    true), and resolves the ABSOLUTE path.
//  * `getStagingDirectory()` returns the absolute path of the directory
//    `createStagingFile` writes into — `reactContext.cacheDir`, never
//    `externalCacheDir`.
//  * `unlinkStagingFile` silently refuses any path outside that directory or
//    with a leaf that is not `<uuid>-archive-staging.bin`.
// ===========================================================================
package com.orbital.archivereader

import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.module.annotations.ReactModule

@ReactModule(name = OrbitalArchiveAccessModule.NAME)
class OrbitalArchiveAccessModule(reactContext: ReactApplicationContext) :
  NativeOrbitalArchiveAccessSpec(reactContext) {

  override fun getName(): String = NAME

  override fun pickArchiveParts(promise: Promise) = promise.reject(NOT_IMPLEMENTED, NOT_IMPLEMENTED)

  override fun openParts(refs: ReadableArray?, promise: Promise) =
    promise.reject(NOT_IMPLEMENTED, NOT_IMPLEMENTED)

  override fun closeParts(handleIds: ReadableArray?) = Unit

  override fun cancelOpenParts() = Unit

  override fun createStagingFile(promise: Promise) =
    promise.reject(NOT_IMPLEMENTED, NOT_IMPLEMENTED)

  override fun getStagingDirectory(): String = reactApplicationContext.cacheDir.absolutePath

  override fun unlinkStagingFile(path: String?) = Unit

  override fun releaseParts(refs: ReadableArray?, promise: Promise) =
    promise.reject(NOT_IMPLEMENTED, NOT_IMPLEMENTED)

  override fun releaseAllPersistedParts(promise: Promise) =
    promise.reject(NOT_IMPLEMENTED, NOT_IMPLEMENTED)

  companion object {
    const val NAME = "OrbitalArchiveAccess"
    private const val NOT_IMPLEMENTED = "ARCHIVE_INTERNAL"
  }
}
