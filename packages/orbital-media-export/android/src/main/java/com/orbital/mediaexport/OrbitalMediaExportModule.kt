package com.orbital.mediaexport

import android.content.ContentValues
import android.media.MediaScannerConnection
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.system.ErrnoException
import android.system.OsConstants
import androidx.annotation.RequiresApi
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReadableArray
import java.io.File
import java.io.FileNotFoundException
import java.io.IOException
import java.io.InputStream
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/**
 * First-party media/file exporter.
 *
 * Saving is a COPY: nothing in this file deletes, moves or renames the source.
 * The decrypted file under MEDIA_DIR is the app's durable archive (the server
 * may evict the ciphertext after confirmArchived), so the only writes here go
 * to the destination. The `media-export-native-pins` invariant in
 * scripts/check-security-invariants.mjs enforces that.
 *
 * Two write paths:
 *   - API 29+ : MediaStore insert with IS_PENDING, stream copy, publish. The
 *     app needs NO runtime permission for its own MediaStore inserts.
 *   - API 24-28: a file in the matching public directory under /Orbital, then
 *     MediaScannerConnection so the gallery sees it. That path needs the
 *     WRITE_EXTERNAL_STORAGE grant, which the JS service requests through
 *     PermissionsAndroid — never from here, so a permission prompt can only
 *     ever follow a user-initiated save.
 *
 * Error messages are fixed code-shaped phrases; no paths, filenames or media
 * ids, and no android.util.Log anywhere in this module.
 */
class OrbitalMediaExportModule(reactContext: ReactApplicationContext) :
  NativeOrbitalMediaExportSpec(reactContext) {

  private val invalidated = AtomicBoolean(false)
  private var workExecutor: ExecutorService? = null

  /** Where one export lands. DOWNLOADS also serves every document type. */
  private enum class Bucket {
    IMAGES,
    VIDEO,
    DOWNLOADS,
  }

  @Synchronized
  private fun executor(): ExecutorService {
    var e = workExecutor
    if (e == null) {
      // Single thread: writes are serialized in JS too, and a parallel copy
      // would only contend for the same flash device.
      e = Executors.newSingleThreadExecutor()
      workExecutor = e
    }
    return e
  }

  // -------------------------------------------------------------------------
  // Permissions
  // -------------------------------------------------------------------------

  /**
   * Android has no add-only photo-library authorization. API 29+ needs nothing
   * for an app's own MediaStore inserts, and the API 24-28 storage grant is a
   * PermissionsAndroid concern in JS, so both of these are constant.
   */
  override fun getPhotoAddPermission(promise: Promise) {
    promise.resolve(PERMISSION_NOT_REQUIRED)
  }

  override fun requestPhotoAddPermission(promise: Promise) {
    promise.resolve(PERMISSION_NOT_REQUIRED)
  }

  // -------------------------------------------------------------------------
  // saveToPhotoLibrary
  // -------------------------------------------------------------------------

  override fun saveToPhotoLibrary(
    sourcePath: String,
    mimeType: String,
    displayName: String,
    createdAtMs: Double,
    promise: Promise,
  ) {
    if (invalidated.get()) {
      promise.reject(E_CANCELLED, "module invalidated")
      return
    }
    if (!isValidDisplayName(displayName)) {
      promise.reject(E_INVALID_NAME, "invalid export filename")
      return
    }
    if (!isUsablePath(sourcePath)) {
      promise.reject(E_NOT_FOUND, "source unavailable")
      return
    }
    val bucket = galleryBucketFor(mimeType)
    if (bucket == null) {
      promise.reject(E_UNSUPPORTED, "not a gallery media type")
      return
    }

    executor().execute {
      if (invalidated.get()) {
        promise.reject(E_CANCELLED, "module invalidated")
        return@execute
      }
      val failure = writeOne(sourcePath, mimeType, displayName, createdAtMs, bucket)
      if (failure == null) {
        promise.resolve(null)
      } else {
        promise.reject(failure, "export failed")
      }
    }
  }

  // -------------------------------------------------------------------------
  // exportFiles
  // -------------------------------------------------------------------------

  /**
   * Writes every item into Download/Orbital and ALWAYS resolves 'saved' — there
   * is no picker on Android, so there is nothing for the user to cancel.
   *
   * A mid-batch failure rejects, and the items already written stay written:
   * re-driving the whole batch would duplicate them, and duplicates cannot be
   * detected (the app never reads the destination back). The caller therefore
   * treats a rejection as "this batch is done, some of it failed".
   */
  override fun exportFiles(items: ReadableArray, promise: Promise) {
    if (invalidated.get()) {
      promise.reject(E_CANCELLED, "module invalidated")
      return
    }
    if (items.size() == 0) {
      promise.reject(E_EXPORT, "nothing to export")
      return
    }

    // Validate the WHOLE batch before writing anything: a malformed item must
    // not leave half a batch on disk.
    val paths = ArrayList<String>(items.size())
    val mimes = ArrayList<String>(items.size())
    val names = ArrayList<String>(items.size())
    for (i in 0 until items.size()) {
      val item = items.getMap(i)
      if (item == null) {
        promise.reject(E_EXPORT, "malformed export item")
        return
      }
      val name = item.getString("displayName")
      val path = item.getString("sourcePath")
      if (name == null || !isValidDisplayName(name)) {
        promise.reject(E_INVALID_NAME, "invalid export filename")
        return
      }
      if (path == null || !isUsablePath(path)) {
        promise.reject(E_NOT_FOUND, "source unavailable")
        return
      }
      paths.add(path)
      mimes.add(item.getString("mimeType") ?: FALLBACK_MIME)
      names.add(name)
    }

    executor().execute {
      for (i in paths.indices) {
        if (invalidated.get()) {
          promise.reject(E_CANCELLED, "module invalidated")
          return@execute
        }
        val failure = writeOne(paths[i], mimes[i], names[i], 0.0, Bucket.DOWNLOADS)
        if (failure != null) {
          promise.reject(failure, "export failed")
          return@execute
        }
      }
      promise.resolve(RESULT_SAVED)
    }
  }

  // -------------------------------------------------------------------------
  // Writers
  // -------------------------------------------------------------------------

  /** @return null on success, otherwise a MediaExportError code. */
  private fun writeOne(
    sourcePath: String,
    mimeType: String,
    displayName: String,
    createdAtMs: Double,
    bucket: Bucket,
  ): String? {
    val sourceFile = File(sourcePath)
    // The source is opened FIRST so that "the file we were asked to export is
    // gone" (ENOENT) is never confused with "the destination refused us".
    val input: InputStream =
      try {
        sourceFile.inputStream()
      } catch (e: FileNotFoundException) {
        return E_NOT_FOUND
      } catch (e: SecurityException) {
        return E_PERMISSION
      }
    return input.use {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        writeScoped(it, mimeType, displayName, createdAtMs, bucket)
      } else {
        writeLegacy(it, mimeType, displayName, bucket)
      }
    }
  }

  /**
   * API 29+. IS_PENDING keeps the row invisible until the bytes are there; on
   * ANY failure the row is deleted, so a half-written export never shows up in
   * the gallery. A leftover pending row (process death mid-copy) expires
   * through the OS's own DATE_EXPIRES, which is why there is no sweep here.
   */
  @RequiresApi(Build.VERSION_CODES.Q)
  private fun writeScoped(
    input: InputStream,
    mimeType: String,
    displayName: String,
    createdAtMs: Double,
    bucket: Bucket,
  ): String? {
    val resolver = reactApplicationContext.contentResolver
    val values =
      ContentValues().apply {
        put(MediaStore.MediaColumns.DISPLAY_NAME, displayName)
        put(MediaStore.MediaColumns.MIME_TYPE, mimeType)
        put(MediaStore.MediaColumns.RELATIVE_PATH, relativePathFor(bucket))
        put(MediaStore.MediaColumns.IS_PENDING, 1)
        // DATE_TAKEN is MILLISECONDS and exists for Images/Video only; setting
        // it on Downloads is an IllegalArgumentException.
        if (bucket != Bucket.DOWNLOADS && createdAtMs > 0) {
          put(MediaStore.MediaColumns.DATE_TAKEN, createdAtMs.toLong())
        }
      }

    val inserted =
      try {
        resolver.insert(collectionFor(bucket), values)
      } catch (e: IllegalArgumentException) {
        return E_UNSUPPORTED
      } catch (e: SecurityException) {
        return E_PERMISSION
      } catch (e: IllegalStateException) {
        return E_EXPORT
      }
    // A null insert is a real provider behaviour (full volume, a name the
    // provider refuses) that @react-native-camera-roll/camera-roll ignores —
    // hence the explicit code rather than a crash on the next line.
    val uri: Uri = inserted ?: return E_EXPORT

    try {
      val out = resolver.openOutputStream(uri) ?: throw IOException("destination unavailable")
      out.use { input.copyTo(it, COPY_BUFFER_BYTES) }
    } catch (e: Throwable) {
      deleteQuietly(uri)
      return codeFor(e)
    }

    return try {
      val publish = ContentValues().apply { put(MediaStore.MediaColumns.IS_PENDING, 0) }
      resolver.update(uri, publish, null, null)
      null
    } catch (e: Exception) {
      deleteQuietly(uri)
      codeFor(e)
    }
  }

  /**
   * API 24-28. No MediaStore insert API worth using, so the file goes into the
   * public directory and the media scanner indexes it. Names are de-duplicated
   * here because the filesystem will not do it for us, and a partial file is
   * deleted on failure.
   */
  @Suppress("DEPRECATION") // getExternalStoragePublicDirectory: API 24-28 only
  private fun writeLegacy(
    input: InputStream,
    mimeType: String,
    displayName: String,
    bucket: Bucket,
  ): String? {
    val root = Environment.getExternalStoragePublicDirectory(legacyDirFor(bucket))
    val dir = File(root, ORBITAL_DIR)
    if (!dir.exists() && !dir.mkdirs()) {
      return E_EXPORT
    }
    val target = uniqueTarget(dir, displayName) ?: return E_EXPORT
    try {
      target.outputStream().use { input.copyTo(it, COPY_BUFFER_BYTES) }
    } catch (e: Throwable) {
      // Only ever the DESTINATION we just created.
      target.delete()
      return codeFor(e)
    }
    try {
      MediaScannerConnection.scanFile(
        reactApplicationContext,
        arrayOf(target.absolutePath),
        arrayOf(mimeType),
        null,
      )
    } catch (e: Exception) {
      // The bytes are on disk and visible over MTP either way; an unindexed
      // file is not worth failing the save for.
    }
    return null
  }

  // -------------------------------------------------------------------------
  // Destinations
  // -------------------------------------------------------------------------

  @RequiresApi(Build.VERSION_CODES.Q)
  private fun collectionFor(bucket: Bucket): Uri =
    when (bucket) {
      Bucket.IMAGES -> MediaStore.Images.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
      Bucket.VIDEO -> MediaStore.Video.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
      Bucket.DOWNLOADS -> MediaStore.Downloads.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
    }

  /** Pictures/Orbital, Movies/Orbital, Download/Orbital. */
  private fun relativePathFor(bucket: Bucket): String =
    legacyDirFor(bucket) + File.separator + ORBITAL_DIR

  private fun legacyDirFor(bucket: Bucket): String =
    when (bucket) {
      Bucket.IMAGES -> Environment.DIRECTORY_PICTURES
      Bucket.VIDEO -> Environment.DIRECTORY_MOVIES
      Bucket.DOWNLOADS -> Environment.DIRECTORY_DOWNLOADS
    }

  private fun galleryBucketFor(mimeType: String): Bucket? {
    val mime = mimeType.lowercase()
    return when {
      mime.startsWith("image/") -> Bucket.IMAGES
      mime.startsWith("video/") -> Bucket.VIDEO
      else -> null
    }
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /**
   * Re-validate the caller's filename. The service builds these from a closed
   * extension map, but a name that escapes its directory would turn an export
   * into an arbitrary write, so the writer does not trust it.
   */
  private fun isValidDisplayName(name: String): Boolean {
    if (name.isEmpty() || name.length > MAX_NAME_LENGTH) return false
    if (name.startsWith("/") || name.startsWith(".")) return false
    if (name.contains("/") || name.contains("\\") || name.contains("..")) return false
    // C0/DEL only: a NUL truncates a native path, and the rest are never
    // legitimate in a filename. Format characters (ZWJ in an emoji name) are
    // deliberately allowed.
    return name.none { it.code < 0x20 || it.code == 0x7f }
  }

  private fun isUsablePath(path: String): Boolean = path.startsWith("/")

  private fun uniqueTarget(dir: File, displayName: String): File? {
    var candidate = File(dir, displayName)
    if (!candidate.exists()) return candidate
    val base = displayName.substringBeforeLast('.', displayName)
    val ext = displayName.substringAfterLast('.', "")
    var n = 1
    while (candidate.exists()) {
      if (n > MAX_NAME_ATTEMPTS) return null
      val suffixed = if (ext.isEmpty()) "$base ($n)" else "$base ($n).$ext"
      candidate = File(dir, suffixed)
      n++
    }
    return candidate
  }

  private fun deleteQuietly(uri: Uri) {
    try {
      // The row WE inserted moments ago, never the source.
      reactApplicationContext.contentResolver.delete(uri, null, null)
    } catch (e: Exception) {
      // Best effort: a pending row the OS will expire on its own.
    }
  }

  private fun codeFor(e: Throwable): String =
    when {
      e is SecurityException -> E_PERMISSION
      isOutOfSpace(e) -> E_NOSPC
      e is FileNotFoundException -> E_NOT_FOUND
      e is IllegalArgumentException -> E_UNSUPPORTED
      else -> E_EXPORT
    }

  /**
   * ENOSPC arrives as an ErrnoException cause on modern Android and as a bare
   * IOException message on older ones; both are checked, bounded against a
   * cyclic cause chain. Free space itself is checked in JS (RNFS) before the
   * batch starts — this is the mid-write fallback.
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

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Metro Fast Refresh (and a logout that drops the runtime) tears the module
   * down. Queued writes are abandoned rather than finished into a dead
   * runtime; a write already streaming bytes completes and then settles into a
   * promise nobody is listening to, which is harmless — the destination row is
   * either published or deleted by writeScoped either way.
   */
  override fun invalidate() {
    invalidated.set(true)
    workExecutor?.shutdownNow()
    workExecutor = null
    super.invalidate()
  }

  private companion object {
    const val E_PERMISSION = "EPERMISSION"
    const val E_UNSUPPORTED = "EUNSUPPORTED"
    const val E_NOSPC = "ENOSPC"
    const val E_NOT_FOUND = "ENOENT"
    const val E_CANCELLED = "ECANCELLED"
    const val E_EXPORT = "EEXPORT"
    const val E_INVALID_NAME = "EINVALIDNAME"

    const val PERMISSION_NOT_REQUIRED = "notRequired"
    const val RESULT_SAVED = "saved"

    const val ORBITAL_DIR = "Orbital"
    const val FALLBACK_MIME = "application/octet-stream"
    const val COPY_BUFFER_BYTES = 256 * 1024
    const val MAX_NAME_LENGTH = 255
    const val MAX_NAME_ATTEMPTS = 999
    const val MAX_CAUSE_DEPTH = 8
  }
}
