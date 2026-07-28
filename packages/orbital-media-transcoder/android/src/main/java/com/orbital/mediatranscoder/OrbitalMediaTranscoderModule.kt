package com.orbital.mediatranscoder

import com.facebook.fbreact.specs.NativeOrbitalMediaTranscoderSpec
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReadableMap

/**
 * Stub implementation — codegen shape only. Real media3 pipeline lands in the
 * next commit.
 */
class OrbitalMediaTranscoderModule(reactContext: ReactApplicationContext) :
  NativeOrbitalMediaTranscoderSpec(reactContext) {

  override fun transcodeVideo(
    jobId: String,
    sourcePath: String,
    destPath: String,
    options: ReadableMap,
    promise: Promise,
  ) {
    promise.reject("ETRANSCODE", "not implemented")
  }

  override fun cancelTranscode(jobId: String) {}

  override fun getVideoMetadata(sourcePath: String, promise: Promise) {
    promise.reject("EMETADATA", "not implemented")
  }

  override fun extractThumbnail(
    sourcePath: String,
    atMs: Double,
    destPath: String,
    maxDimension: Double,
    quality: Double,
    promise: Promise,
  ) {
    promise.reject("ETHUMBNAIL", "not implemented")
  }

  override fun reencodeImage(
    sourcePath: String,
    destPath: String,
    options: ReadableMap,
    promise: Promise,
  ) {
    promise.reject("EIMAGE", "not implemented")
  }

  companion object {
    const val NAME = "OrbitalMediaTranscoder"
  }
}
