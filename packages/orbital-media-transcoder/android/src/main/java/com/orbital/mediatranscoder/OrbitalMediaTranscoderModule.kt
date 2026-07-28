package com.orbital.mediatranscoder

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.ImageDecoder
import android.graphics.Matrix
import android.media.MediaMetadataRetriever
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import androidx.exifinterface.media.ExifInterface
import androidx.media3.common.Effect
import androidx.media3.common.MediaItem
import androidx.media3.common.MimeTypes
import androidx.media3.common.audio.AudioProcessor
import androidx.media3.common.util.UnstableApi
import androidx.media3.effect.Presentation
import androidx.media3.transformer.Composition
import androidx.media3.transformer.DefaultEncoderFactory
import androidx.media3.transformer.EditedMediaItem
import androidx.media3.transformer.EditedMediaItemSequence
import androidx.media3.transformer.Effects
import androidx.media3.transformer.ExportException
import androidx.media3.transformer.ExportResult
import androidx.media3.transformer.ProgressHolder
import androidx.media3.transformer.Transformer
import androidx.media3.transformer.VideoEncoderSettings
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReadableMap
import java.io.File
import java.io.FileNotFoundException
import java.io.FileOutputStream
import java.io.IOException
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.math.max
import kotlin.math.roundToInt

/**
 * First-party media transcoder.
 *
 * Video goes through media3 Transformer, whose surface-to-surface GL pipeline
 * has no ByteBuffer YUV path — the corrupt-color-format bug class that made
 * react-native-compressor unusable on Android is structurally impossible here.
 *
 * Error messages carry error-code constants only, never paths or filenames.
 */
// The bare Kotlin @OptIn does NOT suppress lint's UnsafeOptInUsageError for
// media3's @UnstableApi surface; the androidx annotation is required.
@androidx.annotation.OptIn(markerClass = UnstableApi::class)
class OrbitalMediaTranscoderModule(reactContext: ReactApplicationContext) :
  NativeOrbitalMediaTranscoderSpec(reactContext) {

  private class JobHandle(val destPath: String, val promise: Promise) {
    var transformer: Transformer? = null
    var progressRunnable: Runnable? = null
  }

  private val jobs = ConcurrentHashMap<String, JobHandle>()
  private val invalidated = AtomicBoolean(false)

  private var handlerThread: HandlerThread? = null
  private var transcodeHandler: Handler? = null
  private var workExecutor: ExecutorService? = null

  // -------------------------------------------------------------------------
  // Threading
  // -------------------------------------------------------------------------

  /** Transformer requires a Looper thread; created on first transcode. */
  @Synchronized
  private fun handler(): Handler {
    var h = transcodeHandler
    if (h == null) {
      val thread = HandlerThread("OrbitalMediaTranscoder").also { it.start() }
      handlerThread = thread
      h = Handler(thread.looper)
      transcodeHandler = h
    }
    return h
  }

  @Synchronized
  private fun executor(): ExecutorService {
    var e = workExecutor
    if (e == null) {
      e = Executors.newSingleThreadExecutor()
      workExecutor = e
    }
    return e
  }

  // -------------------------------------------------------------------------
  // transcodeVideo
  // -------------------------------------------------------------------------

  override fun transcodeVideo(
    jobId: String,
    sourcePath: String,
    destPath: String,
    options: ReadableMap,
    promise: Promise,
  ) {
    if (invalidated.get()) {
      promise.reject("ECANCELLED", "module invalidated")
      return
    }
    // Read the ReadableMap on the calling thread — it is not guaranteed to
    // stay valid once this method returns.
    val maxDimension = options.getDouble("maxDimension").toInt()
    val bitrate = options.getDouble("bitrate").toInt()

    handler().post { startTranscode(jobId, sourcePath, destPath, maxDimension, bitrate, promise) }
  }

  private fun startTranscode(
    jobId: String,
    sourcePath: String,
    destPath: String,
    maxDimension: Int,
    bitrate: Int,
    promise: Promise,
  ) {
    val source = File(sourcePath)
    if (!source.exists()) {
      promise.reject("ENOENT", "source unavailable")
      return
    }
    // Documented overwrite semantics, identical on both platforms.
    File(destPath).delete()

    val dims =
      try {
        readVideoDims(sourcePath)
      } catch (e: Exception) {
        promise.reject("EMETADATA", "metadata unavailable")
        return
      }

    val (targetWidth, targetHeight) = scaledEvenDims(dims.width, dims.height, maxDimension)

    val job = JobHandle(destPath, promise)
    jobs[jobId] = job

    val listener =
      object : Transformer.Listener {
        override fun onCompleted(composition: Composition, exportResult: ExportResult) {
          settle(jobId) { it.promise.resolve(null) }
        }

        override fun onError(
          composition: Composition,
          exportResult: ExportResult,
          exportException: ExportException,
        ) {
          settle(jobId) {
            File(it.destPath).delete()
            it.promise.reject("ETRANSCODE", exportException.errorCodeName)
          }
        }
      }

    val transformer =
      try {
        Transformer.Builder(reactApplicationContext)
          .setVideoMimeType(MimeTypes.VIDEO_H264)
          .setAudioMimeType(MimeTypes.AUDIO_AAC)
          .setEncoderFactory(
            DefaultEncoderFactory.Builder(reactApplicationContext)
              .setRequestedVideoEncoderSettings(
                VideoEncoderSettings.Builder().setBitrate(bitrate).build(),
              )
              .build(),
          )
          .setLooper(handler().looper)
          .addListener(listener)
          .build()
      } catch (e: Exception) {
        jobs.remove(jobId)
        promise.reject("ETRANSCODE", "transformer unavailable")
        return
      }
    job.transformer = transformer

    // Presentation is applied UNCONDITIONALLY, even at scale == 1. Skipping it
    // lets media3 transmux already-<=720p H.264 sources: the encoder settings
    // would never apply, the transcode-integrity guard would become a coin
    // flip, and GPS carried outside the moov would survive untouched.
    val presentation =
      Presentation.createForWidthAndHeight(
        targetWidth,
        targetHeight,
        Presentation.LAYOUT_SCALE_TO_FIT,
      )
    val effects = Effects(emptyList<AudioProcessor>(), listOf<Effect>(presentation))
    val item =
      EditedMediaItem.Builder(MediaItem.fromUri(Uri.fromFile(source)))
        .setEffects(effects)
        .build()
    val composition =
      Composition.Builder(EditedMediaItemSequence.Builder(item).build())
        .setHdrMode(Composition.HDR_MODE_TONE_MAP_HDR_TO_SDR_USING_OPEN_GL)
        .build()

    try {
      transformer.start(composition, destPath)
    } catch (e: Exception) {
      settle(jobId) {
        File(it.destPath).delete()
        it.promise.reject("ETRANSCODE", "transformer start failed")
      }
      return
    }

    val holder = ProgressHolder()
    val poller =
      object : Runnable {
        override fun run() {
          val active = jobs[jobId] ?: return
          val t = active.transformer ?: return
          if (t.getProgress(holder) == Transformer.PROGRESS_STATE_AVAILABLE) {
            emitProgress(jobId, holder.progress / 100.0)
          }
          handler().postDelayed(this, PROGRESS_INTERVAL_MS)
        }
      }
    job.progressRunnable = poller
    handler().postDelayed(poller, PROGRESS_INTERVAL_MS)
  }

  /**
   * Remove a job and run [action] exactly once. The ConcurrentHashMap removal
   * is the only race guard: whoever removes the handle owns settling it.
   * Must run on the transcode handler thread.
   */
  private fun settle(jobId: String, action: (JobHandle) -> Unit) {
    val job = jobs.remove(jobId) ?: return
    job.progressRunnable?.let { transcodeHandler?.removeCallbacks(it) }
    job.progressRunnable = null
    action(job)
  }

  override fun cancelTranscode(jobId: String) {
    val h = transcodeHandler ?: return
    h.post {
      settle(jobId) { job ->
        // cancel() fires no listener callback, so the promise is settled here.
        try {
          job.transformer?.cancel()
        } catch (e: Exception) {
          // Best effort — the job is being torn down regardless.
        }
        File(job.destPath).delete()
        job.promise.reject("ECANCELLED", "transcode cancelled")
      }
    }
  }

  // -------------------------------------------------------------------------
  // getVideoMetadata
  // -------------------------------------------------------------------------

  override fun getVideoMetadata(sourcePath: String, promise: Promise) {
    executor().execute {
      try {
        val dims = readVideoDims(sourcePath)
        val out = Arguments.createMap()
        out.putDouble("width", dims.width.toDouble())
        out.putDouble("height", dims.height.toDouble())
        out.putDouble("duration", dims.durationMs / 1000.0)
        promise.resolve(out)
      } catch (e: FileNotFoundException) {
        promise.reject("ENOENT", "source unavailable")
      } catch (e: Exception) {
        promise.reject("EMETADATA", "metadata unavailable")
      }
    }
  }

  // -------------------------------------------------------------------------
  // extractThumbnail
  // -------------------------------------------------------------------------

  override fun extractThumbnail(
    sourcePath: String,
    atMs: Double,
    destPath: String,
    maxDimension: Double,
    quality: Double,
    promise: Promise,
  ) {
    executor().execute {
      if (!File(sourcePath).exists()) {
        promise.reject("ENOENT", "source unavailable")
        return@execute
      }
      val retriever = MediaMetadataRetriever()
      var bitmap: Bitmap? = null
      try {
        retriever.setDataSource(sourcePath)
        val durationMs =
          retriever
            .extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)
            ?.toLongOrNull() ?: 0L
        val requestedMs = max(0L, atMs.toLong())
        val clampedMs = if (durationMs > 0) requestedMs.coerceAtMost(durationMs) else requestedMs
        val timeUs = clampedMs * 1000L

        bitmap =
          retriever.getFrameAtTime(timeUs, MediaMetadataRetriever.OPTION_CLOSEST_SYNC)
            ?: retriever.getFrameAtTime(timeUs, MediaMetadataRetriever.OPTION_CLOSEST)
            ?: retriever.frameAtTime
        if (bitmap == null) {
          promise.reject("ETHUMBNAIL", "no decodable frame")
          return@execute
        }

        val rotation =
          retriever
            .extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_ROTATION)
            ?.toIntOrNull() ?: 0
        val rawWidth =
          retriever
            .extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH)
            ?.toIntOrNull() ?: 0
        val rawHeight =
          retriever
            .extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT)
            ?.toIntOrNull() ?: 0

        bitmap = rotateFrameIfNeeded(bitmap, rotation, rawWidth, rawHeight)
        bitmap = scaleToLongSide(bitmap, maxDimension.toInt())

        writeBitmap(bitmap, destPath, Bitmap.CompressFormat.JPEG, qualityPercent(quality))
        promise.resolve(null)
      } catch (e: Exception) {
        File(destPath).delete()
        promise.reject("ETHUMBNAIL", "thumbnail extraction failed")
      } finally {
        bitmap?.recycle()
        try {
          retriever.release()
        } catch (e: IOException) {
          // release() is documented to throw on some API levels; nothing to do.
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // reencodeImage
  // -------------------------------------------------------------------------

  override fun reencodeImage(
    sourcePath: String,
    destPath: String,
    options: ReadableMap,
    promise: Promise,
  ) {
    val maxDimension = options.getDouble("maxDimension").toInt()
    val quality = options.getDouble("quality")
    val format = options.getString("format") ?: "jpeg"

    executor().execute {
      if (!File(sourcePath).exists()) {
        promise.reject("ENOENT", "source unavailable")
        return@execute
      }
      var bitmap: Bitmap? = null
      try {
        bitmap =
          if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            decodeWithImageDecoder(sourcePath, maxDimension)
          } else {
            decodeWithBitmapFactory(sourcePath, maxDimension)
          }
        val compressFormat =
          if (format == "png") Bitmap.CompressFormat.PNG else Bitmap.CompressFormat.JPEG
        // Bitmap.compress writes no metadata for either format.
        writeBitmap(bitmap, destPath, compressFormat, qualityPercent(quality))
        promise.resolve(null)
      } catch (e: Exception) {
        File(destPath).delete()
        promise.reject("EIMAGE", "image re-encode failed")
      } finally {
        bitmap?.recycle()
      }
    }
  }

  @androidx.annotation.RequiresApi(Build.VERSION_CODES.P)
  private fun decodeWithImageDecoder(sourcePath: String, maxDimension: Int): Bitmap {
    val source = ImageDecoder.createSource(File(sourcePath))
    // ImageDecoder applies EXIF orientation itself; ALLOCATOR_SOFTWARE keeps
    // the result compressible (hardware bitmaps cannot be encoded).
    return ImageDecoder.decodeBitmap(source) { decoder, info, _ ->
      decoder.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
      if (maxDimension > 0) {
        val longSide = max(info.size.width, info.size.height)
        if (longSide > maxDimension) {
          val scale = maxDimension.toDouble() / longSide
          decoder.setTargetSize(
            max(1, (info.size.width * scale).roundToInt()),
            max(1, (info.size.height * scale).roundToInt()),
          )
        }
      }
    }
  }

  /**
   * API 24-27 path. HEIC has no platform decoder before API 28, so decodeFile
   * returns null and the caller surfaces EIMAGE.
   */
  private fun decodeWithBitmapFactory(sourcePath: String, maxDimension: Int): Bitmap {
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeFile(sourcePath, bounds)
    if (bounds.outWidth <= 0 || bounds.outHeight <= 0) {
      throw IOException("undecodable source")
    }

    val opts = BitmapFactory.Options()
    if (maxDimension > 0) {
      var sample = 1
      var longSide = max(bounds.outWidth, bounds.outHeight)
      while (longSide / (sample * 2) >= maxDimension) {
        sample *= 2
      }
      opts.inSampleSize = sample
      longSide /= sample
    }
    val decoded = BitmapFactory.decodeFile(sourcePath, opts) ?: throw IOException("undecodable source")

    // Output carries no EXIF, so orientation must be baked into the pixels.
    // androidx ExifInterface reads JPEG/WebP/HEIF/PNG/DNG; the framework one
    // is JPEG-only on these API levels.
    val orientation =
      try {
        ExifInterface(sourcePath)
          .getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL)
      } catch (e: IOException) {
        ExifInterface.ORIENTATION_NORMAL
      }
    val oriented = applyExifOrientation(decoded, orientation)
    return scaleToLongSide(oriented, maxDimension)
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Metro Fast Refresh tears the module down mid-transcode. Without this,
   * in-flight jobs keep encoding into orphaned staging files and late progress
   * emits fire against a dead event-emitter callback.
   */
  override fun invalidate() {
    invalidated.set(true)
    val h = transcodeHandler
    if (h != null) {
      // quitSafely() below drains already-queued messages, so this runs.
      h.post { cancelAllJobs() }
    } else {
      cancelAllJobs()
    }
    handlerThread?.quitSafely()
    handlerThread = null
    transcodeHandler = null
    workExecutor?.shutdownNow()
    workExecutor = null
    super.invalidate()
  }

  private fun cancelAllJobs() {
    for (jobId in jobs.keys.toList()) {
      settle(jobId) { job ->
        try {
          job.transformer?.cancel()
        } catch (e: Exception) {
          // Best effort during teardown.
        }
        File(job.destPath).delete()
        job.promise.reject("ECANCELLED", "module invalidated")
      }
    }
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private fun emitProgress(jobId: String, progress: Double) {
    if (invalidated.get() || !jobs.containsKey(jobId)) return
    val event = Arguments.createMap()
    event.putString("jobId", jobId)
    event.putDouble("progress", progress)
    try {
      emitOnTranscodeProgress(event)
    } catch (e: RuntimeException) {
      // No JS listener bound yet (or the runtime is tearing down) — progress
      // is advisory, never fail a transcode over it.
    }
  }

  private data class VideoDims(val width: Int, val height: Int, val durationMs: Long)

  /** Rotation-corrected display dimensions plus duration. */
  private fun readVideoDims(sourcePath: String): VideoDims {
    if (!File(sourcePath).exists()) throw FileNotFoundException("source unavailable")
    val retriever = MediaMetadataRetriever()
    try {
      retriever.setDataSource(sourcePath)
      val width =
        retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH)?.toIntOrNull()
          ?: throw IOException("no video width")
      val height =
        retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT)?.toIntOrNull()
          ?: throw IOException("no video height")
      val rotation =
        retriever
          .extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_ROTATION)
          ?.toIntOrNull() ?: 0
      val durationMs =
        retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLongOrNull()
          ?: 0L
      return if (rotation == 90 || rotation == 270) {
        VideoDims(height, width, durationMs)
      } else {
        VideoDims(width, height, durationMs)
      }
    } finally {
      try {
        retriever.release()
      } catch (e: IOException) {
        // release() is documented to throw on some API levels; nothing to do.
      }
    }
  }

  /** Never upscales; both dimensions rounded to even (H.264 requirement). */
  private fun scaledEvenDims(width: Int, height: Int, maxDimension: Int): Pair<Int, Int> {
    val longSide = max(width, height)
    val scale = if (maxDimension > 0) minOf(1.0, maxDimension.toDouble() / longSide) else 1.0
    val w = max(2, (width * scale).roundToInt() and 1.inv())
    val h = max(2, (height * scale).roundToInt() and 1.inv())
    return Pair(w, h)
  }

  /**
   * MediaMetadataRetriever already applies the container rotation on most
   * devices. Only rotate when the decoded frame provably still carries the raw
   * orientation; 180-degree cases are indistinguishable, so they are left
   * alone rather than risk a double rotation.
   */
  private fun rotateFrameIfNeeded(
    bitmap: Bitmap,
    rotationDegrees: Int,
    rawWidth: Int,
    rawHeight: Int,
  ): Bitmap {
    if (rotationDegrees != 90 && rotationDegrees != 270) return bitmap
    if (rawWidth <= 0 || rawHeight <= 0) return bitmap
    val stillRaw = bitmap.width == rawWidth && bitmap.height == rawHeight
    if (!stillRaw) return bitmap
    val matrix = Matrix().apply { postRotate(rotationDegrees.toFloat()) }
    return replaceBitmap(bitmap, matrix)
  }

  private fun applyExifOrientation(bitmap: Bitmap, orientation: Int): Bitmap {
    val matrix = Matrix()
    when (orientation) {
      ExifInterface.ORIENTATION_FLIP_HORIZONTAL -> matrix.setScale(-1f, 1f)
      ExifInterface.ORIENTATION_ROTATE_180 -> matrix.setRotate(180f)
      ExifInterface.ORIENTATION_FLIP_VERTICAL -> matrix.setScale(1f, -1f)
      ExifInterface.ORIENTATION_TRANSPOSE -> {
        matrix.setRotate(90f)
        matrix.postScale(-1f, 1f)
      }
      ExifInterface.ORIENTATION_ROTATE_90 -> matrix.setRotate(90f)
      ExifInterface.ORIENTATION_TRANSVERSE -> {
        matrix.setRotate(270f)
        matrix.postScale(-1f, 1f)
      }
      ExifInterface.ORIENTATION_ROTATE_270 -> matrix.setRotate(270f)
      else -> return bitmap
    }
    return replaceBitmap(bitmap, matrix)
  }

  private fun replaceBitmap(bitmap: Bitmap, matrix: Matrix): Bitmap {
    val out = Bitmap.createBitmap(bitmap, 0, 0, bitmap.width, bitmap.height, matrix, true)
    if (out !== bitmap) bitmap.recycle()
    return out
  }

  private fun scaleToLongSide(bitmap: Bitmap, maxDimension: Int): Bitmap {
    if (maxDimension <= 0) return bitmap
    val longSide = max(bitmap.width, bitmap.height)
    if (longSide <= maxDimension) return bitmap
    val scale = maxDimension.toDouble() / longSide
    val width = max(1, (bitmap.width * scale).roundToInt())
    val height = max(1, (bitmap.height * scale).roundToInt())
    val out = Bitmap.createScaledBitmap(bitmap, width, height, true)
    if (out !== bitmap) bitmap.recycle()
    return out
  }

  private fun writeBitmap(
    bitmap: Bitmap,
    destPath: String,
    format: Bitmap.CompressFormat,
    quality: Int,
  ) {
    val dest = File(destPath)
    dest.parentFile?.mkdirs()
    dest.delete()
    FileOutputStream(dest).use { out ->
      if (!bitmap.compress(format, quality, out)) {
        throw IOException("encode failed")
      }
      out.flush()
    }
  }

  private fun qualityPercent(quality: Double): Int =
    (quality * 100).roundToInt().coerceIn(1, 100)

  private companion object {
    const val PROGRESS_INTERVAL_MS = 500L
  }
}
