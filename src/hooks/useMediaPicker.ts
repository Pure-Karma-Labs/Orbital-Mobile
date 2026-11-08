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
 *
 * CONCURRENCY (#971): this module owns the app-wide "one pick at a time" lock.
 * Every launch in the app must go through `launchLibraryOnce` -- see the lock
 * section below for why a per-component guard is not enough.
 */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Alert } from 'react-native';
import { launchImageLibrary } from 'react-native-image-picker';
import type {
  ErrorCode,
  ImageLibraryOptions,
  ImagePickerResponse,
} from 'react-native-image-picker';
import { captureError } from '../services/telemetry';

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
export const ALLOWED_VIDEO_MIMES = new Set([
  'video/mp4',
  'video/quicktime',
  'video/x-m4v',
]);

// ---------------------------------------------------------------------------
// App-wide in-flight lock (#971)
// ---------------------------------------------------------------------------

/**
 * Whether a library launch is currently in flight, anywhere in the app.
 *
 * MODULE scope, not component scope, because the native picker is a SINGLETON:
 * `ImagePickerManager` keeps one `self.callback`, so a second launch while the
 * first is still loading its assets overwrites it and the first load's
 * completion fires the second launch's callback. The second completion then
 * fires the same callback again, and `RCTTurboModule` aborts the process
 * ("Callback arg cannot be called more than once", #971). A guard that lived in
 * a hook or a screen would not see a launch from another surface -- the crash
 * report's two launches were 11 seconds apart, which is a user tapping again
 * because a multi-second HEVC load shows no progress.
 *
 * The iOS patch makes the native side safe on its own; this lock is what keeps
 * the SECOND pick from being silently dropped, and what gives the UI something
 * to dim.
 *
 * JS is single-threaded, so the test-and-set in `launchLibraryOnce` cannot
 * interleave; no mutex is needed.
 */
let inFlight = false;

/** `useSyncExternalStore` listeners -- one per mounted `usePickerInFlight`. */
const inFlightSubscribers = new Set<() => void>();

function setInFlight(next: boolean): void {
  if (inFlight === next) return;
  inFlight = next;
  // Copy before iterating: a listener that unsubscribes during the notify
  // (an unmount triggered by a state change) must not mutate the live set.
  for (const notify of [...inFlightSubscribers]) notify();
}

function subscribeInFlight(onStoreChange: () => void): () => void {
  inFlightSubscribers.add(onStoreChange);
  return () => {
    inFlightSubscribers.delete(onStoreChange);
  };
}

function getInFlightSnapshot(): boolean {
  return inFlight;
}

/**
 * Subscribe to the app-wide pick lock. Returns true while any surface has a
 * launch in flight, so a button that would be swallowed by the lock can be
 * disabled and dimmed instead of taking a press that does nothing.
 */
export function usePickerInFlight(): boolean {
  return useSyncExternalStore(subscribeInFlight, getInFlightSnapshot);
}

/**
 * The ONLY approved way to open the media library.
 *
 * Returns `null` -- immediately, without launching -- when another surface
 * already has a pick in flight. Callers treat `null` as "not my turn" and
 * return; it is not an error and it is not a cancellation.
 *
 * The lock is released in `finally`, so a resolve, a `didCancel`, an
 * `errorCode` response and a rejection all free it. There is no timer and no
 * AppState reset: after the native patch every presented picker ends in exactly
 * one terminal event, and a picker that cannot be presented resolves
 * `errOthers`.
 */
export async function launchLibraryOnce(
  options: ImageLibraryOptions,
): Promise<ImagePickerResponse | null> {
  if (inFlight) return null;
  setInFlight(true);
  try {
    return await launchImageLibrary(options);
  } finally {
    setInFlight(false);
  }
}

/**
 * Picker `errorCode`s already reported this session.
 *
 * Budgeted like `groupKeyTelemetry`: a user who denied photo permission can tap
 * attach all day, and that is ONE fact, not forty events. The key space is the
 * `ErrorCode` union itself, so the set holds at most three entries and needs no
 * eviction.
 */
const reportedPickerErrors = new Set<ErrorCode>();

/**
 * Report a picker `errorCode` to Sentry at `warning`.
 *
 * Shared by both consumers (this hook and EditProfileScreen) so one failed
 * launch is one event whichever surface raised it. Goes through `captureError`,
 * the approved capture path, which reports a rebuilt Error carrying only the
 * class name, the scrubbed message and scrubbed frames.
 *
 * WHAT IS SENT: the `errorCode` and nothing else. It is a closed three-value
 * union, which is the only kind of value `captureMessage`/`captureError`
 * messages may be built from -- `errorMessage` is a native string that can
 * carry a URI or file name, and the `uri`/`fileName` of a picked asset is user
 * content. Neither is ever passed in.
 */
export function reportPickerError(errorCode: ErrorCode): void {
  if (reportedPickerErrors.has(errorCode)) return;
  reportedPickerErrors.add(errorCode);
  captureError(new Error(`Image picker error: ${errorCode}`), {
    level: 'warning',
    tags: { feature: 'media-picker', picker_error_code: errorCode },
  });
}

/**
 * User-facing copy per `errorCode`. `permission` means the library never
 * opened; `others` also covers a pick whose media failed to load (e.g. an
 * iCloud video that could not be downloaded), so it must not blame permissions.
 */
export function pickerErrorCopy(errorCode: ErrorCode): { title: string; body: string } {
  if (errorCode === 'permission') {
    return {
      title: 'Photo Library Unavailable',
      body: 'The photo library could not be opened. Check Photos permission in Settings and try again.',
    };
  }
  return {
    title: 'Could Not Add Media',
    body: 'The selected media could not be loaded. Please try again.',
  };
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useMediaPicker() {
  const [selectedMedia, setSelectedMedia] = useState<PickedMedia[]>([]);
  const isPicking = usePickerInFlight();

  /**
   * A pick is not abortable, and its asset load takes seconds, so it routinely
   * outlives the screen that started it. Same guard as ThreadDetailScreen's
   * post-send alerts (#744): an unguarded `Alert` pops over whatever screen the
   * user navigated to, and the state append would be a no-op warning. The
   * Sentry report is deliberately NOT gated -- the failure happened either way.
   */
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  /**
   * Open the media library picker. Allows multi-select up to MAX_SELECTION.
   * Picker options include photos and videos (mediaType: 'mixed').
   *
   * A no-op while another surface holds the app-wide lock (#971) -- the
   * caller's button is dimmed by `isPicking` in that case, so this is the
   * belt to that suspenders.
   *
   * Pick-time validation:
   * - Video MIME allowlist (mp4, quicktime, m4v) with Alert on unsupported format
   * - Source size guard 500MB (avoids doomed compressions)
   */
  const pickMedia = useCallback(async () => {
    try {
      const result = await launchLibraryOnce({
        mediaType: 'mixed',
        selectionLimit: MAX_SELECTION,
        maxWidth: 2048,
        maxHeight: 2048,
        quality: 0.9,
        includeBase64: false,
        assetRepresentationMode: 'compatible',
      });

      // Another pick already owns the picker -- not an error, not a cancel.
      if (result === null) return;

      // A launch that never opened (no permission, no root view controller).
      // Silence here is what made the native abort look like a dead button.
      if (result.errorCode !== undefined) {
        reportPickerError(result.errorCode);
        if (mountedRef.current) {
          const copy = pickerErrorCopy(result.errorCode);
          Alert.alert(copy.title, copy.body);
        }
        return;
      }

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

      // Nothing below this line may touch the screen that is gone: the pick
      // outlived it, and its selection belongs to a composer that unmounted.
      if (!mountedRef.current) return;

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
      if (__DEV__) {
        console.warn('[useMediaPicker] pickMedia failed');
      }
      // A rejected launch used to be indistinguishable from a dead button: the
      // lock released and nothing else happened. `others` copy, not
      // `permission` -- a throw here is a native/bridge failure, not a denial.
      if (mountedRef.current) {
        const copy = pickerErrorCopy('others');
        Alert.alert(copy.title, copy.body);
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
    /** True while ANY surface has a pick in flight -- gate the attach button on it. */
    isPicking,
    removeMedia,
    clearMedia,
  };
}
