package com.orbital.archivereader

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.ParcelFileDescriptor
import android.system.ErrnoException
import android.system.Os
import android.system.OsConstants
import com.facebook.react.bridge.ActivityEventListener
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.bridge.UiThreadUtil
import com.facebook.react.bridge.WritableArray
import com.facebook.react.bridge.WritableMap
import com.facebook.react.module.annotations.ReactModule
import java.io.File
import java.io.FileNotFoundException
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong

/**
 * Platform half of the archive reader (#920, plan §5 "Android").
 *
 * Rust owns ZIP parsing, every cap and extraction; this module owns only the
 * things that need a platform API: the document picker, SAF persistable
 * permissions, file descriptors and staging-file creation. It never parses an
 * archive, never reads entry bytes, and never chooses a path Rust writes to.
 *
 * ## Permissions
 *
 * ZERO, deliberately: both manifests in this package declare none and security
 * invariant 29 asserts that. `ACTION_OPEN_DOCUMENT` grants a per-document URI
 * for the documents the user picked, and `takePersistableUriPermission` makes
 * that grant survive a reboot — so a paused import can resume on a cold start
 * without ever holding a storage permission.
 *
 * ## fd ownership (plan §10 F2)
 *
 * `openParts` hands JS the RAW descriptor number of a `ParcelFileDescriptor`
 * this module keeps alive in [descriptors]. Rust dups it; this module stays the
 * owner until `closeParts(handleIds)`. Two consequences the JS side relies on:
 *   - On ANY `openParts` failure every descriptor opened by that call is closed
 *     before the rejection, so the caller only ever closes handles it was
 *     actually given.
 *   - `closeParts` is the only close, is idempotent, and ignores unknown ids.
 *
 * ## Threading
 *
 * One serial [ExecutorService] carries everything that can block (the picker
 * launch is posted to the activity, the opens and the staging-file creation are
 * syscalls). `closeParts`, `cancelOpenParts` and `unlinkStagingFile` run INLINE
 * on the calling thread: JS calls them from `finally` blocks and treats them as
 * already done on return, so handing them to the executor would let a `close`
 * land after the next `openParts`.
 *
 * ## Error contract
 *
 * Rejections carry one of PICKER_BUSY, ARCHIVE_ACCESS_LOST,
 * ARCHIVE_NOT_SEEKABLE, ARCHIVE_STAGING_UNAVAILABLE, ARCHIVE_NO_SPACE,
 * ECANCELLED or ARCHIVE_INTERNAL as the code, with a fixed message that names
 * no file, path, URI or byte. A part is identified by index, never by name.
 *
 * Silence is part of that contract: there is no logging call anywhere in this
 * file, because an archive path or document URI must never reach logcat. The
 * forbidden tokens are deliberately not spelled out here so a grep-based pin
 * cannot be satisfied — or tripped — by this comment.
 */
@ReactModule(name = OrbitalArchiveAccessModule.NAME)
class OrbitalArchiveAccessModule(reactContext: ReactApplicationContext) :
  NativeOrbitalArchiveAccessSpec(reactContext), ActivityEventListener {

  private val invalidated = AtomicBoolean(false)
  private var workExecutor: ExecutorService? = null

  /** Open descriptors by handle id. `remove` is the atomic close-once gate. */
  private val descriptors = ConcurrentHashMap<String, ParcelFileDescriptor>()
  private val handleSeq = AtomicLong(0)

  private val pickLock = Any()
  private var pendingPick: Promise? = null
  private var listenerRegistered = false

  override fun getName(): String = NAME

  // -------------------------------------------------------------------------
  // Executor
  // -------------------------------------------------------------------------

  /**
   * Single thread: the opens are serialized in JS too (one archive at a time),
   * and a second thread would only contend for the same providers.
   *
   * Returns null once the module is invalidated, so no work is ever queued into
   * a dead runtime.
   */
  @Synchronized
  private fun executor(): ExecutorService? {
    if (invalidated.get()) return null
    var e = workExecutor
    if (e == null) {
      e = Executors.newSingleThreadExecutor()
      workExecutor = e
    }
    return e
  }

  /** @return false when the work could not be queued (the promise is settled). */
  private fun submit(promise: Promise, block: () -> Unit): Boolean {
    val e = executor()
    if (e == null) {
      promise.reject(E_CANCELLED, MSG_CANCELLED)
      return false
    }
    return try {
      e.execute(block)
      true
    } catch (e2: RuntimeException) {
      // RejectedExecutionException: shutdownNow raced us.
      promise.reject(E_CANCELLED, MSG_CANCELLED)
      false
    }
  }

  // -------------------------------------------------------------------------
  // pickArchiveParts
  // -------------------------------------------------------------------------

  /**
   * `ACTION_OPEN_DOCUMENT`, multi-select, ZIP.
   *
   * `type` plus `EXTRA_MIME_TYPES` because providers are inconsistent about
   * which MIME they report for a ZIP; `application/octet-stream` is in the list
   * so a download that lost its type is still selectable. Nothing here trusts
   * the MIME — Rust rejects anything that is not a ZIP.
   *
   * Settles EXACTLY once, on every path: result, cancel (including a back or
   * swipe dismiss, which arrives as RESULT_CANCELED), no activity, a launch
   * that throws, and `invalidate`. A second concurrent call is PICKER_BUSY.
   */
  override fun pickArchiveParts(promise: Promise) {
    if (invalidated.get()) {
      promise.reject(E_CANCELLED, MSG_CANCELLED)
      return
    }
    if (reactApplicationContext.currentActivity == null) {
      promise.reject(E_INTERNAL, MSG_INTERNAL)
      return
    }
    synchronized(pickLock) {
      if (pendingPick != null) {
        promise.reject(E_PICKER_BUSY, MSG_PICKER_BUSY)
        return
      }
      pendingPick = promise
      if (!listenerRegistered) {
        // Registered once and kept: removing it between picks could drop a
        // result that arrives while the activity is being recreated.
        reactApplicationContext.addActivityEventListener(this)
        listenerRegistered = true
      }
    }

    val intent =
      Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
        addCategory(Intent.CATEGORY_OPENABLE)
        type = MIME_ZIP
        putExtra(Intent.EXTRA_MIME_TYPES, PICKER_MIME_TYPES)
        putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
        addFlags(
          Intent.FLAG_GRANT_READ_URI_PERMISSION or
            Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION,
        )
      }
    // Launched on the UI thread, not the executor and not the calling thread:
    // presenting an activity off the main looper is undefined, and the result
    // comes back through the listener either way.
    UiThreadUtil.runOnUiThread {
      val host = reactApplicationContext.currentActivity
      if (host == null) {
        takePendingPick()?.reject(E_INTERNAL, MSG_INTERNAL)
        return@runOnUiThread
      }
      try {
        host.startActivityForResult(intent, PICK_REQUEST_CODE)
      } catch (e: Throwable) {
        // ActivityNotFoundException (no documents UI), SecurityException, or an
        // activity torn down between the check and the call.
        takePendingPick()?.reject(E_INTERNAL, MSG_INTERNAL)
      }
    }
  }

  /** @return the pending promise exactly once; null if it was already settled. */
  private fun takePendingPick(): Promise? =
    synchronized(pickLock) {
      val p = pendingPick
      pendingPick = null
      p
    }

  override fun onActivityResult(
    activity: Activity,
    requestCode: Int,
    resultCode: Int,
    data: Intent?,
  ) {
    if (requestCode != PICK_REQUEST_CODE) return
    val promise = takePendingPick() ?: return

    if (resultCode != Activity.RESULT_OK || data == null) {
      promise.resolve(null)
      return
    }
    val uris = pickedUris(data)
    if (uris.isEmpty()) {
      // RESULT_OK with nothing selectable behaves as a cancel rather than an
      // error: there is nothing for the user to act on.
      promise.resolve(null)
      return
    }

    // The grant the picker actually handed back. ACTION_OPEN_DOCUMENT normally
    // returns a persistable read grant, but a provider may decline, and taking
    // a flag the result does not carry is a SecurityException.
    val canPersist = (data.flags and Intent.FLAG_GRANT_READ_URI_PERMISSION) != 0
    val refs: WritableArray = Arguments.createArray()
    for (uri in uris) {
      if (canPersist) takePersistableQuietly(uri)
      refs.pushString(uri.toString())
    }
    promise.resolve(refs)
  }

  override fun onNewIntent(intent: Intent) = Unit

  /** `clipData` for a multi-select, `data` for a single pick. */
  private fun pickedUris(data: Intent): List<Uri> {
    val clip = data.clipData
    if (clip != null) {
      val out = ArrayList<Uri>(clip.itemCount)
      for (i in 0 until clip.itemCount) {
        val uri = clip.getItemAt(i)?.uri
        if (uri != null) out.add(uri)
      }
      return out
    }
    val single = data.data
    return if (single == null) emptyList() else listOf(single)
  }

  /**
   * Make the read grant survive a reboot so a paused import can resume.
   *
   * Best effort: a provider that refuses only costs the resume path, and
   * `openParts` reports what is actually held as `persist` rather than what we
   * asked for here.
   */
  private fun takePersistableQuietly(uri: Uri) {
    try {
      reactApplicationContext.contentResolver.takePersistableUriPermission(
        uri,
        Intent.FLAG_GRANT_READ_URI_PERMISSION,
      )
    } catch (e: SecurityException) {
      // Not persistable (a non-document provider, or the grant limit).
    } catch (e: IllegalArgumentException) {
      // Not a document URI.
    }
  }

  // -------------------------------------------------------------------------
  // openParts
  // -------------------------------------------------------------------------

  /**
   * Open every ref read-only and hand back one borrowed descriptor per part.
   *
   * `openFileDescriptor(uri, "r")` only — never `openInputStream`, and never
   * the asset-fd APIs: those can hand back a sub-section descriptor (offset +
   * declared length inside a larger file), which a ZIP reader that seeks from
   * the end would mis-parse, and `openInputStream` is not seekable at all.
   *
   * A descriptor that is not a regular file (an MTP/USB provider streaming
   * through a pipe) is ARCHIVE_NOT_SEEKABLE: the user is told to copy the file
   * to the device, which is the only thing that fixes it.
   */
  override fun openParts(refs: ReadableArray?, promise: Promise) {
    if (invalidated.get()) {
      promise.reject(E_CANCELLED, MSG_CANCELLED)
      return
    }
    if (refs == null || refs.size() == 0) {
      promise.reject(E_INTERNAL, MSG_INTERNAL)
      return
    }
    // Copied off the ReadableArray on the calling thread: it is only valid for
    // the duration of the call.
    val parsed = ArrayList<Uri>(refs.size())
    for (i in 0 until refs.size()) {
      val ref = refs.getString(i)
      val uri = if (ref == null || ref.isEmpty()) null else parseUriQuietly(ref)
      if (uri == null) {
        // A token whose ref no longer parses can only be fixed by re-picking.
        promise.reject(E_ACCESS_LOST, MSG_ACCESS_LOST)
        return
      }
      parsed.add(uri)
    }

    submit(promise) { openAll(parsed, promise) }
  }

  private fun openAll(uris: List<Uri>, promise: Promise) {
    val resolver = reactApplicationContext.contentResolver
    val opened = ArrayList<ParcelFileDescriptor>(uris.size)
    val handles: WritableArray = Arguments.createArray()
    val ids = ArrayList<String>(uris.size)

    for (uri in uris) {
      if (invalidated.get()) {
        closeAll(opened)
        promise.reject(E_CANCELLED, MSG_CANCELLED)
        return
      }
      val pfd =
        try {
          resolver.openFileDescriptor(uri, "r")
        } catch (e: Throwable) {
          closeAll(opened)
          val code = openFailureCode(e)
          promise.reject(code, messageFor(code))
          return
        }
      if (pfd == null) {
        // A provider is allowed to return null for a document it can no longer
        // produce; it means the same thing as FileNotFoundException.
        closeAll(opened)
        promise.reject(E_ACCESS_LOST, MSG_ACCESS_LOST)
        return
      }
      opened.add(pfd)

      val stat =
        try {
          Os.fstat(pfd.fileDescriptor)
        } catch (e: ErrnoException) {
          closeAll(opened)
          promise.reject(E_ACCESS_LOST, MSG_ACCESS_LOST)
          return
        }
      if (!OsConstants.S_ISREG(stat.st_mode)) {
        closeAll(opened)
        promise.reject(E_NOT_SEEKABLE, MSG_NOT_SEEKABLE)
        return
      }

      val handleId = "ar" + handleSeq.incrementAndGet()
      ids.add(handleId)
      val map: WritableMap = Arguments.createMap()
      map.putString("handleId", handleId)
      map.putInt("fd", pfd.fd)
      map.putDouble("byteLength", stat.st_size.toDouble())
      map.putString("fileId", stat.st_dev.toString() + ":" + stat.st_ino.toString())
      // Android never rewrites a ref; iOS refreshes a stale bookmark here.
      map.putString("ref", uri.toString())
      map.putBoolean("persist", holdsPersistedRead(uri))
      handles.pushMap(map)
    }

    // A wipe or a teardown that landed while we were opening: the caller will
    // never see these handles, so this call still owns them.
    if (invalidated.get()) {
      closeAll(opened)
      promise.reject(E_CANCELLED, MSG_CANCELLED)
      return
    }

    // Published only now: until the promise resolves, failure cleanup is the
    // local list's job, and `closeParts` can never double-close.
    for (i in ids.indices) {
      descriptors[ids[i]] = opened[i]
    }
    promise.resolve(handles)
  }

  private fun openFailureCode(e: Throwable): String =
    when (e) {
      // Grant revoked (reboot without a persistable grant, or the user removed
      // the SD card's volume), document deleted, or a malformed URI. All three
      // are "pick the file again".
      is SecurityException -> E_ACCESS_LOST
      is FileNotFoundException -> E_ACCESS_LOST
      is IllegalArgumentException -> E_ACCESS_LOST
      else -> E_INTERNAL
    }

  /** The one fixed phrase per code. Never a name, path, URI or byte count. */
  private fun messageFor(code: String): String =
    when (code) {
      E_PICKER_BUSY -> MSG_PICKER_BUSY
      E_ACCESS_LOST -> MSG_ACCESS_LOST
      E_NOT_SEEKABLE -> MSG_NOT_SEEKABLE
      E_STAGING_UNAVAILABLE -> MSG_STAGING_UNAVAILABLE
      E_NO_SPACE -> MSG_NO_SPACE
      E_CANCELLED -> MSG_CANCELLED
      else -> MSG_INTERNAL
    }

  private fun parseUriQuietly(ref: String): Uri? =
    try {
      Uri.parse(ref)
    } catch (e: Throwable) {
      null
    }

  private fun holdsPersistedRead(uri: Uri): Boolean =
    try {
      reactApplicationContext.contentResolver.persistedUriPermissions.any {
        it.isReadPermission && it.uri == uri
      }
    } catch (e: Throwable) {
      false
    }

  // -------------------------------------------------------------------------
  // closeParts / cancelOpenParts
  // -------------------------------------------------------------------------

  /** INLINE and idempotent: `remove` is what makes the close happen once. */
  override fun closeParts(handleIds: ReadableArray?) {
    val ids = handleIds ?: return
    for (i in 0 until ids.size()) {
      val id = ids.getString(i) ?: continue
      val pfd = descriptors.remove(id) ?: continue
      closeQuietly(pfd)
    }
  }

  /**
   * No-op by design.
   *
   * iOS cancels its `NSFileCoordinator`; the Android opens are plain syscalls
   * with nothing to interrupt. The JS-side grace timer rejects locally and
   * closes whatever the eventual settle hands back (plan §10 F2/F4), so this
   * must NOT settle the caller's promise itself — doing so would double-settle
   * against that backstop.
   */
  override fun cancelOpenParts() = Unit

  // -------------------------------------------------------------------------
  // Staging
  // -------------------------------------------------------------------------

  /**
   * The internal cache directory, canonicalised.
   *
   * Canonical because Rust forces each staging path's canonicalised parent to
   * equal this string; one unresolved symlink here would turn every extract
   * into ARCHIVE_STAGING_UNAVAILABLE. NEVER `externalCacheDir`: that is
   * world-readable to anything with storage access, and these files hold
   * decrypted user media.
   */
  override fun getStagingDirectory(): String = stagingDirectory()

  private fun stagingDirectory(): String {
    val dir = reactApplicationContext.cacheDir
    return try {
      dir.canonicalPath
    } catch (e: Throwable) {
      dir.absolutePath
    }
  }

  /**
   * `<cacheDir>/<lowercase-uuid>-archive-staging.bin`, created EXCLUSIVELY.
   *
   * `java.util.UUID.toString()` is already lower-case hex, which is required:
   * Rust validates the leaf and keys its live-staging ledger on the lower-cased
   * name, so an upper-case UUID is refused outright. The leaf is re-checked
   * against the same pattern `unlinkStagingFile` enforces, so the only file
   * this module can create is one it can also delete.
   *
   * `createNewFile()` returning false means the path already exists — with a
   * fresh UUID that is not a collision but a sign the cache is not ours, so it
   * fails rather than reusing the file.
   */
  override fun createStagingFile(promise: Promise) {
    if (invalidated.get()) {
      promise.reject(E_CANCELLED, MSG_CANCELLED)
      return
    }
    submit(promise) {
      val dir = stagingDirectory()
      val name = UUID.randomUUID().toString() + STAGING_SUFFIX
      if (!STAGING_LEAF.matches(name)) {
        promise.reject(E_INTERNAL, MSG_INTERNAL)
        return@submit
      }
      val parent = File(dir)
      if (!parent.isDirectory && !parent.mkdirs()) {
        promise.reject(E_STAGING_UNAVAILABLE, MSG_STAGING_UNAVAILABLE)
        return@submit
      }
      val file = File(parent, name)
      val created =
        try {
          file.createNewFile()
        } catch (e: Throwable) {
          val code = if (isOutOfSpace(e)) E_NO_SPACE else E_STAGING_UNAVAILABLE
          promise.reject(code, messageFor(code))
          return@submit
        }
      if (!created) {
        promise.reject(E_STAGING_UNAVAILABLE, MSG_STAGING_UNAVAILABLE)
        return@submit
      }
      // Built from the canonical directory string so it matches what
      // getStagingDirectory() reported, byte for byte.
      promise.resolve(dir + File.separator + name)
    }
  }

  /**
   * INLINE, silent, and the only delete this module exposes.
   *
   * Refuses anything that is not exactly
   * `<getStagingDirectory()>/<lowercase-uuid>-archive-staging.bin`, so it can
   * never be driven into a general unlink: no parent directory, no traversal
   * segment and no other leaf can satisfy the pattern. A path that does not
   * exist is not an error — the caller runs this from a `finally` and a file
   * the reaper already swept is the normal case.
   */
  override fun unlinkStagingFile(path: String?) {
    val target = path ?: return
    if (!isStagingPath(target)) return
    try {
      File(target).delete()
    } catch (e: SecurityException) {
      // Best effort: the reaper and the next wipe both sweep this directory.
    }
  }

  private fun isStagingPath(path: String): Boolean {
    val prefix = stagingDirectory() + File.separator
    if (!path.startsWith(prefix)) return false
    val leaf = path.substring(prefix.length)
    return STAGING_LEAF.matches(leaf)
  }

  // -------------------------------------------------------------------------
  // Grants
  // -------------------------------------------------------------------------

  /**
   * Drop the persistable grants behind these refs.
   *
   * Never throws for a ref that holds no grant: releasing is idempotent from
   * the caller's point of view, and a token may have been minted before the
   * provider declined to persist it.
   */
  override fun releaseParts(refs: ReadableArray?, promise: Promise) {
    if (refs == null || refs.size() == 0) {
      promise.resolve(null)
      return
    }
    val parsed = ArrayList<Uri>(refs.size())
    for (i in 0 until refs.size()) {
      val ref = refs.getString(i) ?: continue
      val uri = parseUriQuietly(ref) ?: continue
      parsed.add(uri)
    }
    if (parsed.isEmpty()) {
      promise.resolve(null)
      return
    }
    submit(promise) {
      val resolver = reactApplicationContext.contentResolver
      for (uri in parsed) {
        try {
          resolver.releasePersistableUriPermission(
            uri,
            Intent.FLAG_GRANT_READ_URI_PERMISSION,
          )
        } catch (e: SecurityException) {
          // No grant held.
        } catch (e: IllegalArgumentException) {
          // Not a document URI.
        }
      }
      promise.resolve(null)
    }
  }

  /**
   * Release EVERY persistable grant this app holds (plan §10 F3).
   *
   * Called from `localWipe` on the ACCOUNT DELETION path only — logout keeps
   * the grants so a cold-start resume still works. It iterates
   * `persistedUriPermissions` rather than a list of refs because the grants
   * outlive the app's own storage: a wipe must leave nothing behind that a
   * reinstall could resume from, including grants whose tokens were in a
   * database we just deleted. Archive parts are the only persisted grants this
   * app ever takes.
   */
  override fun releaseAllPersistedParts(promise: Promise) {
    submit(promise) {
      val resolver = reactApplicationContext.contentResolver
      val held =
        try {
          resolver.persistedUriPermissions
        } catch (e: Throwable) {
          promise.resolve(null)
          return@submit
        }
      for (permission in held) {
        var flags = 0
        if (permission.isReadPermission) flags = flags or Intent.FLAG_GRANT_READ_URI_PERMISSION
        if (permission.isWritePermission) flags = flags or Intent.FLAG_GRANT_WRITE_URI_PERMISSION
        if (flags == 0) continue
        try {
          resolver.releasePersistableUriPermission(permission.uri, flags)
        } catch (e: SecurityException) {
          // Already gone.
        } catch (e: IllegalArgumentException) {
          // Not a document URI.
        }
      }
      promise.resolve(null)
    }
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Metro Fast Refresh, a logout that drops the runtime, or a host teardown.
   *
   * Everything this module owns is released here: a pending pick is rejected
   * (its JS listener is gone, and leaving it unsettled would hold PICKER_BUSY
   * forever), the activity listener goes away, every descriptor is closed, and
   * the executor is stopped so nothing is queued into a dead runtime.
   */
  override fun invalidate() {
    invalidated.set(true)
    takePendingPick()?.reject(E_CANCELLED, MSG_CANCELLED)
    synchronized(pickLock) {
      if (listenerRegistered) {
        reactApplicationContext.removeActivityEventListener(this)
        listenerRegistered = false
      }
    }
    closeAllDescriptors()
    synchronized(this) {
      workExecutor?.shutdownNow()
      workExecutor = null
    }
    super.invalidate()
  }

  private fun closeAllDescriptors() {
    for (id in descriptors.keys.toList()) {
      val pfd = descriptors.remove(id) ?: continue
      closeQuietly(pfd)
    }
  }

  private fun closeAll(pfds: List<ParcelFileDescriptor>) {
    for (pfd in pfds) closeQuietly(pfd)
  }

  private fun closeQuietly(pfd: ParcelFileDescriptor) {
    try {
      pfd.close()
    } catch (e: Throwable) {
      // An already-closed descriptor is the only realistic cause, and the
      // caller treats close as unconditionally done.
    }
  }

  /**
   * ENOSPC arrives as an `ErrnoException` cause on modern Android and as a bare
   * IOException message on older ones; both are checked, bounded against a
   * cyclic cause chain.
   */
  private fun isOutOfSpace(error: Throwable?): Boolean {
    var current: Throwable? = error
    var depth = 0
    while (current != null && depth < MAX_CAUSE_DEPTH) {
      if (current is ErrnoException &&
        (current.errno == OsConstants.ENOSPC || current.errno == OsConstants.EDQUOT)
      ) {
        return true
      }
      val message = current.message
      if (message != null &&
        (message.contains("ENOSPC") || message.contains("No space left on device"))
      ) {
        return true
      }
      current = current.cause
      depth++
    }
    return false
  }

  companion object {
    const val NAME = "OrbitalArchiveAccess"

    private const val PICK_REQUEST_CODE = 0x0920

    private const val MIME_ZIP = "application/zip"
    private val PICKER_MIME_TYPES =
      arrayOf("application/zip", "application/x-zip-compressed", "application/octet-stream")

    private const val STAGING_SUFFIX = "-archive-staging.bin"

    /**
     * The ONLY leaf this module creates or deletes. Lower-case hex only: the
     * Rust side matches `^[0-9a-f-]{36}-archive-staging\.bin$` and this is the
     * stricter UUID shape of the same thing.
     */
    private val STAGING_LEAF =
      Regex(
        "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}" +
          "-archive-staging\\.bin$",
      )

    private const val MAX_CAUSE_DEPTH = 8

    // Codes. Fixed messages, never a name, path, URI or byte count.
    private const val E_PICKER_BUSY = "PICKER_BUSY"
    private const val E_ACCESS_LOST = "ARCHIVE_ACCESS_LOST"
    private const val E_NOT_SEEKABLE = "ARCHIVE_NOT_SEEKABLE"
    private const val E_STAGING_UNAVAILABLE = "ARCHIVE_STAGING_UNAVAILABLE"
    private const val E_NO_SPACE = "ARCHIVE_NO_SPACE"
    private const val E_CANCELLED = "ECANCELLED"
    private const val E_INTERNAL = "ARCHIVE_INTERNAL"

    private const val MSG_PICKER_BUSY = "picker busy"
    private const val MSG_ACCESS_LOST = "archive access lost"
    private const val MSG_NOT_SEEKABLE = "archive not seekable"
    private const val MSG_STAGING_UNAVAILABLE = "staging unavailable"
    private const val MSG_NO_SPACE = "no space"
    private const val MSG_CANCELLED = "cancelled"
    private const val MSG_INTERNAL = "archive glue failed"
  }
}
