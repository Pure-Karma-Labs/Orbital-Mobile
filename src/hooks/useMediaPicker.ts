/**
 * useMediaPicker -- reusable hook for picking photos and videos from the library.
 *
 * Returns selected media with local URIs for display and upload, plus management
 * functions (remove, clear). Maximum 10 items selected at once.
 *
 * SECURITY: The picker's resize re-encode is NOT a reliable EXIF/GPS strip --
 * Android's react-native-image-picker skips the re-encode for images <= 2048px.
 * The explicit strip lives in imageSanitizer.ts (for images) and
 * mp4GpsSanitizer.ts (for videos), called by mediaUploadService before encryption.
 */

import { useCallback, useState } from 'react';
import { Alert } from 'react-native';
import { launchImageLibrary } from 'react-native-image-picker';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PickedMedia {
  /** Local URI for display (thumbnail) and upload (file read) */
  uri: string;
  /** MIME type (e.g. 'image/jpeg', 'video/mp4') */
  type: string;
  /** File name */
  fileName: string;
  /** File size in bytes */
  fileSize: number;
  /** Image/video width in pixels */
  width?: number;
  /** Image/video height in pixels */
  height?: number;
  /** Video duration in seconds (undefined for images) */
  duration?: number;
}

/** Maximum number of media items that can be selected */
const MAX_SELECTION = 10;

/** Maximum source file size before compression (500MB) -- avoid doomed compressions */
const MAX_SOURCE_SIZE_BYTES = 500 * 1024 * 1024;

/** Allowed video MIME types */
const ALLOWED_VIDEO_MIMES = new Set([
  'video/mp4',
  'video/quicktime',
  'video/x-m4v',
]);

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useMediaPicker() {
  const [selectedMedia, setSelectedMedia] = useState<PickedMedia[]>([]);

  /**
   * Open the media library picker. Allows multi-select up to MAX_SELECTION.
   * Picker options include photos and videos (mediaType: 'mixed').
   *
   * Pick-time validation:
   * - Video MIME allowlist (mp4, quicktime, m4v) with Alert on unsupported format
   * - Source size guard 500MB (avoids doomed compressions)
   */
  const pickMedia = useCallback(async () => {
    try {
      const result = await launchImageLibrary({
        mediaType: 'mixed',
        selectionLimit: MAX_SELECTION,
        maxWidth: 2048,
        maxHeight: 2048,
        quality: 0.9,
        includeBase64: false,
        assetRepresentationMode: 'compatible',
      });

      if (result.didCancel || !result.assets) return;

      const picked: PickedMedia[] = [];
      let filtered = false;

      for (const a of result.assets) {
        if (!a.uri || !a.type) continue;

        // Video MIME allowlist
        if (a.type.startsWith('video/') && !ALLOWED_VIDEO_MIMES.has(a.type)) {
          filtered = true;
          continue;
        }

        // Source size guard
        if (a.fileSize && a.fileSize > MAX_SOURCE_SIZE_BYTES) {
          filtered = true;
          continue;
        }

        picked.push({
          uri: a.uri,
          type: a.type,
          fileName: a.fileName ?? (a.type.startsWith('video/') ? 'video.mp4' : 'photo.jpg'),
          fileSize: a.fileSize ?? 0,
          width: a.width,
          height: a.height,
          duration: a.duration,
        });
      }

      if (filtered && picked.length === 0) {
        Alert.alert(
          'Unsupported Media',
          'Some files were not added because they are in an unsupported format or are too large.',
        );
      } else if (filtered) {
        Alert.alert(
          'Some Files Skipped',
          'Some files were skipped because they are in an unsupported format or are too large.',
        );
      }

      setSelectedMedia((prev) => [...prev, ...picked].slice(0, MAX_SELECTION));
    } catch {
      // Silently fail -- picker cancelled or permission denied
      if (__DEV__) {
        console.warn('[useMediaPicker] pickMedia failed');
      }
    }
  }, []);

  /**
   * Remove a media item by index.
   */
  const removeMedia = useCallback((index: number) => {
    setSelectedMedia((prev) => prev.filter((_, i) => i !== index));
  }, []);

  /**
   * Clear all selected media.
   */
  const clearMedia = useCallback(() => {
    setSelectedMedia([]);
  }, []);

  return {
    selectedMedia,
    pickMedia,
    removeMedia,
    clearMedia,
  };
}
