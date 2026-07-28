import type { TurboModule } from 'react-native';
import { TurboModuleRegistry } from 'react-native';
import type { EventEmitter } from 'react-native/Libraries/Types/CodegenTypes';

export type TranscodeProgressEvent = {
  jobId: string;
  /** 0..1 */
  progress: number;
};

export type VideoTranscodeOptions = {
  /** Long-side cap in px (e.g. 1280 -> 720p). Never upscales. */
  maxDimension: number;
  /** Target video bitrate, bits/sec (e.g. 2000000). Honored on BOTH platforms. */
  bitrate: number;
};

export type VideoMetadata = {
  /** Rotation-corrected display width */
  width: number;
  height: number;
  /** Seconds (float) */
  duration: number;
};

export type ImageReencodeOptions = {
  /** Long-side cap in px; 0 = no scaling. Never upscales. */
  maxDimension: number;
  /** 0..1, JPEG only (ignored for png) */
  quality: number;
  /** 'jpeg' | 'png' -- validated in the index.tsx wrapper */
  format: string;
};

export interface Spec extends TurboModule {
  /**
   * Transcode to H.264/AAC non-fragmented MP4 at destPath (overwrites; both
   * platforms unlink destPath first). destPath MUST end in `.mp4` --
   * AVFoundation requires the extension to match the container type.
   * Paths are plain absolute paths (no file:// scheme -- wrapper normalizes).
   * Rejects with code ECANCELLED if cancelTranscode(jobId) is called;
   * deletes partial output on every failure path.
   */
  transcodeVideo(
    jobId: string,
    sourcePath: string,
    destPath: string,
    options: VideoTranscodeOptions,
  ): Promise<void>;

  /** Fire-and-forget; no-op for unknown/finished jobs. */
  cancelTranscode(jobId: string): void;

  getVideoMetadata(sourcePath: string): Promise<VideoMetadata>;

  /**
   * Decode frame nearest atMs (clamped to duration), apply rotation, scale to
   * maxDimension (long side), encode metadata-free JPEG at quality to destPath.
   */
  extractThumbnail(
    sourcePath: string,
    atMs: number,
    destPath: string,
    maxDimension: number,
    quality: number,
  ): Promise<void>;

  /**
   * Decode (JPEG/PNG/WebP/HEIC), apply EXIF orientation, downscale, encode to
   * destPath. Output carries NO metadata -- defense-in-depth only; the
   * byte-level strip + verifyNoImageMetadata in imageSanitizer remain
   * authoritative.
   */
  reencodeImage(
    sourcePath: string,
    destPath: string,
    options: ImageReencodeOptions,
  ): Promise<void>;

  readonly onTranscodeProgress: EventEmitter<TranscodeProgressEvent>;
}

export default TurboModuleRegistry.getEnforcing<Spec>('OrbitalMediaTranscoder');
