/**
 * useMediaPicker — reusable hook for picking photos from the library or camera.
 *
 * Returns selected media with base64 data for encryption, plus management
 * functions (remove, clear). Maximum 10 items selected at once.
 *
 * Picker options force re-encoding at 2048px max to strip EXIF/GPS metadata.
 * Uses includeBase64: true so no file system access is needed.
 */

import { useCallback, useState } from 'react';
import { launchImageLibrary, launchCamera, type Asset } from 'react-native-image-picker';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PickedMedia {
  /** Local URI for display (thumbnail) */
  uri: string;
  /** Base64-encoded file data for encryption */
  base64: string;
  /** MIME type (e.g. 'image/jpeg') */
  type: string;
  /** File name */
  fileName: string;
  /** File size in bytes */
  fileSize: number;
  /** Image width in pixels */
  width?: number;
  /** Image height in pixels */
  height?: number;
}

/** Maximum number of media items that can be selected */
const MAX_SELECTION = 10;

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useMediaPicker() {
  const [selectedMedia, setSelectedMedia] = useState<PickedMedia[]>([]);

  /**
   * Open the photo library picker. Allows multi-select up to MAX_SELECTION.
   * Picker re-encodes at 2048px to strip EXIF metadata.
   */
  const pickPhotos = useCallback(async () => {
    try {
      const result = await launchImageLibrary({
        mediaType: 'photo',
        selectionLimit: MAX_SELECTION,
        maxWidth: 2048,
        maxHeight: 2048,
        quality: 0.9,
        includeBase64: true,
        assetRepresentationMode: 'compatible',
      });

      if (result.didCancel || !result.assets) return;

      const picked: PickedMedia[] = result.assets
        .filter((a: Asset) => a.uri && a.base64 && a.type)
        .map((a: Asset) => ({
          uri: a.uri!,
          base64: a.base64!,
          type: a.type!,
          fileName: a.fileName ?? 'photo.jpg',
          fileSize: a.fileSize ?? 0,
          width: a.width,
          height: a.height,
        }));

      setSelectedMedia((prev) => [...prev, ...picked].slice(0, MAX_SELECTION));
    } catch {
      // Silently fail — picker cancelled or permission denied
      if (__DEV__) {
        console.warn('[useMediaPicker] pickPhotos failed');
      }
    }
  }, []);

  /**
   * Open the camera to take a photo.
   */
  const takePhoto = useCallback(async () => {
    try {
      const result = await launchCamera({
        mediaType: 'photo',
        maxWidth: 2048,
        maxHeight: 2048,
        quality: 0.9,
        includeBase64: true,
      });

      if (result.didCancel || !result.assets) return;

      const asset = result.assets[0];
      if (asset?.uri && asset.base64 && asset.type) {
        const picked: PickedMedia = {
          uri: asset.uri,
          base64: asset.base64,
          type: asset.type,
          fileName: asset.fileName ?? 'photo.jpg',
          fileSize: asset.fileSize ?? 0,
          width: asset.width,
          height: asset.height,
        };

        setSelectedMedia((prev) => [...prev, picked].slice(0, MAX_SELECTION));
      }
    } catch {
      if (__DEV__) {
        console.warn('[useMediaPicker] takePhoto failed');
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
    pickPhotos,
    takePhoto,
    removeMedia,
    clearMedia,
  };
}
