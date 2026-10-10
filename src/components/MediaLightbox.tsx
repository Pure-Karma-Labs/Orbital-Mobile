/**
 * MediaLightbox — Full-screen modal viewer for media items.
 *
 * Opens over the current screen with a dark background. Supports horizontal
 * swiping between images via a paging ScrollView. Shows close button, image
 * counter, and prev/next navigation arrows.
 *
 * Uses React Native Modal with fade animation. Status bar is hidden when
 * the lightbox is visible.
 *
 * Video pages are delegated to LightboxVideoPage, which mounts the native
 * player ONLY for the active page. The lightbox is the sole trigger for
 * full-video downloads (thumbnails download everywhere else). Video transport
 * chrome is the custom JS overlay in components/videoControls — the native
 * player controls were removed in #662.
 *
 * GestureHandlerRootView is mounted INSIDE the Modal: on Android a Modal is a
 * separate window, and the app-root GestureHandlerRootView in App.tsx does not
 * reach into it, so the scrubber pan and the tap-to-show layer would be dead.
 *
 * SAVE (#878): the Save button copies the current item out of the app through
 * `mediaExportService`. Three things about it are deliberate:
 *  - Feedback is an INLINE PILL, never a nested Modal. A second Modal over
 *    this one is the stacking bug `handleReport` exists to work around, and on
 *    iOS the document picker has to present over THIS Modal from
 *    `RCTPresentedViewController()`.
 *  - Exportability arrives as the host-supplied `canExport` prop. There is no
 *    async DB query in the lightbox: ThreadHeader and ReplyItem pass nothing
 *    (their conversation is current by definition) and FileLibraryScreen hands
 *    in a Set lookup projected from its page query.
 *  - The press STAMPS the video controls' control-interaction timestamp, so a
 *    Save tap over a playing video cannot also satisfy VideoControls'
 *    full-page Tap and toggle the chrome (#518's suppression window).
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  Image,
  InteractionManager,
  Modal,
  Platform,
  ScrollView,
  StatusBar,
  Text,
  TouchableOpacity,
  View,
  useWindowDimensions,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../theme';
import { useMediaDownload } from '../hooks/useMediaDownload';
import { OrbitalSpinner } from './OrbitalSpinner';
import { LightboxVideoPage } from './LightboxVideoPage';
import { useAppStore } from '../stores/useAppStore';
import { describeExportOutcome, saveMediaItem } from '../services/mediaExportService';
import type { MediaItem } from '../types/store';
import type { ReportTarget } from '../types/store';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface MediaLightboxProps {
  visible: boolean;
  mediaItems: MediaItem[];
  initialIndex: number;
  onClose: () => void;
  /**
   * Whether this item may be saved to the device. Defaults to TRUE: a host
   * that shows media from the conversation the user is currently in has no
   * decision to make. Only FileLibraryScreen, which can list media from orbits
   * the user has left, supplies one.
   */
  canExport?: (mediaId: string) => boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CLOSE_BUTTON_SIZE = 40;
const NAV_BUTTON_SIZE = 44;

/** How long the ✓ stays up after a successful save. */
export const SAVED_BADGE_MS = 2000;

/** Save-button glyphs. None is emoji-eligible, so none needs U+FE0E. */
const SAVE_GLYPH = '⤓';
const SAVED_GLYPH = '✓';
const SAVE_ERROR_GLYPH = '⚠';

/** Per-item save state. Absent from the map === idle. */
type SaveStatus =
  | { phase: 'saving' }
  | { phase: 'saved'; message: string }
  | { phase: 'error'; message: string }
  | { phase: 'blocked' };

const NOT_SAVEABLE_MESSAGE = 'Not available to save';

// ---------------------------------------------------------------------------
// Single image page component — isolates useMediaDownload per item.
// Video pages go through LightboxVideoPage instead (chosen at the map site by
// contentType, so neither component pays for the other's hooks).
// ---------------------------------------------------------------------------

interface LightboxPageProps {
  mediaId: string;
  pageWidth: number;
  pageHeight: number;
}

const LightboxPage = React.memo(function LightboxPage({
  mediaId,
  pageWidth,
  pageHeight,
}: LightboxPageProps): React.JSX.Element {
  const theme = useTheme();

  const { downloadState, localPath } = useMediaDownload(mediaId, {
    cancelOnUnmount: true,
  });

  const pageStyle: ViewStyle = {
    width: pageWidth,
    height: pageHeight,
    alignItems: 'center',
    justifyContent: 'center',
  };

  const hintTextStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.body,
    fontSize: theme.typography.fontSize.sm,
    color: 'rgba(255, 255, 255, 0.6)',
    marginTop: theme.spacing.base,
  };

  if (downloadState === 'downloaded' && localPath) {
    return (
      <View testID={`lightbox-page-${mediaId}`} style={pageStyle}>
        <Image
          source={{ uri: `file://${localPath}` }}
          style={{ width: pageWidth, height: pageHeight }}
          resizeMode="contain"
        />
      </View>
    );
  }

  // Unavailable — server purged, no local copy
  if (downloadState === 'unavailable' && !localPath) {
    return (
      <View testID={`lightbox-page-${mediaId}`} style={pageStyle}>
        <Text style={hintTextStyle}>{'No longer available'}</Text>
      </View>
    );
  }

  // Not yet downloaded — show spinner
  return (
    <View testID={`lightbox-page-${mediaId}`} style={pageStyle}>
      <OrbitalSpinner size={32} />
    </View>
  );
});

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function MediaLightbox({
  visible,
  mediaItems,
  initialIndex,
  onClose,
  canExport,
}: MediaLightboxProps): React.JSX.Element {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const scrollRef = useRef<ScrollView>(null);
  const [currentIndex, setCurrentIndex] = useState(initialIndex);
  const pendingReportRef = useRef<ReportTarget | null>(null);

  // --- Save state ----------------------------------------------------------
  const [saveStatuses, setSaveStatuses] = useState<Record<string, SaveStatus>>({});
  /** The id whose ✓ is currently up — the ONLY key of the badge timer effect. */
  const [savedId, setSavedId] = useState<string | null>(null);
  const saveControllersRef = useRef<Map<string, AbortController>>(new Map());
  /** Post-await UI writes are guarded by this (house rule: mountedRef). */
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  /**
   * VideoControls' `stampControlInteraction`, registered from the active video
   * page while one is mounted. Null when the current page is an image.
   *
   * Threaded DOWN as a registrar (MediaLightbox -> LightboxVideoPage ->
   * ActiveVideoPage -> VideoControls) rather than lifting the timestamp up,
   * because VideoControls owns the suppression window and must stay the one
   * place that decides what counts as a control interaction.
   */
  const controlStampRef = useRef<(() => void) | null>(null);
  const registerControlStamp = useCallback((stamp: (() => void) | null) => {
    controlStampRef.current = stamp;
  }, []);

  // Render-time index reset: MediaLightbox stays mounted across open/close,
  // so currentIndex is stale on reopen. Reset synchronously during render
  // (prev-state pattern) so the windowed children mount the correct pages
  // in the same commit — avoids triggering downloads for wrong pages.
  const [prevVisible, setPrevVisible] = useState(visible);
  if (visible !== prevVisible) {
    setPrevVisible(visible);
    if (visible) {
      setCurrentIndex(initialIndex);
    }
  }

  const { width: screenWidth, height: screenHeight } = useWindowDimensions();

  // Scroll to initialIndex when modal becomes visible
  useEffect(() => {
    if (!visible || !scrollRef.current) {
      return;
    }
    // Small delay to ensure ScrollView is laid out
    const timer = setTimeout(() => {
      scrollRef.current?.scrollTo({
        x: initialIndex * screenWidth,
        animated: false,
      });
    }, 50);
    setCurrentIndex(initialIndex);
    return () => clearTimeout(timer);
  }, [visible, initialIndex, screenWidth]);

  const handleMomentumScrollEnd = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const offsetX = event.nativeEvent.contentOffset.x;
      const index = Math.round(offsetX / screenWidth);
      setCurrentIndex(Math.max(0, Math.min(index, mediaItems.length - 1)));
    },
    [screenWidth, mediaItems.length],
  );

  const goToPrev = useCallback(() => {
    const newIndex = Math.max(0, currentIndex - 1);
    scrollRef.current?.scrollTo({ x: newIndex * screenWidth, animated: true });
    setCurrentIndex(newIndex);
  }, [currentIndex, screenWidth]);

  const goToNext = useCallback(() => {
    const newIndex = Math.min(mediaItems.length - 1, currentIndex + 1);
    scrollRef.current?.scrollTo({ x: newIndex * screenWidth, animated: true });
    setCurrentIndex(newIndex);
  }, [currentIndex, mediaItems.length, screenWidth]);

  const handleReport = useCallback(() => {
    const currentItem = mediaItems[currentIndex];
    if (!currentItem) return;
    const target: ReportTarget = {
      contentType: 'media',
      contentId: currentItem.id,
    };

    if (Platform.OS === 'ios') {
      // iOS: stash target and open via onDismiss to avoid modal-stacking bug
      pendingReportRef.current = target;
      onClose();
    } else {
      // Android: Modal.onDismiss never fires (iOS-only in RN).
      // Close lightbox then open report sheet after interactions settle.
      onClose();
      InteractionManager.runAfterInteractions(() => {
        useAppStore.getState().openReportSheet(target);
      });
    }
  }, [mediaItems, currentIndex, onClose]);

  // ---------------------------------------------------------------------------
  // Save (#878)
  // ---------------------------------------------------------------------------

  const activeItem = mediaItems[currentIndex];
  const currentId = activeItem?.id ?? null;
  const currentStatus = currentId ? saveStatuses[currentId] : undefined;

  /**
   * The store's own download state for the current item, so a save that has to
   * fetch the file first reads as "Downloading…" rather than a silent spinner.
   * Primitive selector only — a derived object here re-renders on every write.
   */
  const currentDownloadState = useAppStore((state) =>
    currentId ? state.media[currentId]?.downloadState : undefined,
  );

  const exportable = currentId === null ? false : (canExport?.(currentId) ?? true);

  const announce = useCallback((message: string) => {
    // iOS has no live region (accessibilityLiveRegion is Android-only), so the
    // announcement is the only channel on both platforms. Transitions only —
    // announcing every render would talk over the user.
    AccessibilityInfo.announceForAccessibility(message);
  }, []);

  const clearStatus = useCallback((mediaId: string) => {
    setSaveStatuses((prev) => {
      if (prev[mediaId] === undefined) return prev;
      const next = { ...prev };
      delete next[mediaId];
      return next;
    });
  }, []);

  /**
   * The ✓ badge timer. ONE effect, keyed on the saved id and the current id,
   * so its cleanup runs on unmount AND whenever the page changes — a swipe
   * must not leave a timer that later clears a badge for a different item, and
   * swiping back must not find a stale ✓.
   */
  useEffect(() => {
    if (savedId === null) return;
    if (savedId !== currentId) {
      setSavedId(null);
      clearStatus(savedId);
      return;
    }
    const timer = setTimeout(() => {
      setSavedId(null);
      clearStatus(savedId);
    }, SAVED_BADGE_MS);
    return () => clearTimeout(timer);
  }, [savedId, currentId, clearStatus]);

  /** Closing the lightbox aborts an in-flight save and drops every pill. */
  useEffect(() => {
    if (visible) return;
    for (const controller of saveControllersRef.current.values()) {
      controller.abort();
    }
    saveControllersRef.current.clear();
    setSaveStatuses({});
    setSavedId(null);
  }, [visible]);

  const handleSave = useCallback(() => {
    // FIRST: a press on this button can also satisfy VideoControls' full-page
    // Tap (RNGH handlers do not take part in the JS responder system), which
    // would toggle the chrome off under the user's finger.
    controlStampRef.current?.();

    const item = mediaItems[currentIndex];
    if (!item) return;
    const mediaId = item.id;

    // Same predicate the button's disabled state is drawn from, so what the
    // user sees and what the press does cannot disagree.
    if (!exportable) {
      setSaveStatuses((prev) => ({ ...prev, [mediaId]: { phase: 'blocked' } }));
      announce(NOT_SAVEABLE_MESSAGE);
      return;
    }

    // Double-press guard, read from a REF rather than from `saveStatuses`.
    // Two presses in the same tick both see the pre-press state map — React
    // has not re-rendered in between — so a state-based guard lets both
    // through and two copies land in Photos. The ref is written below, before
    // anything awaits, so the second press in the same tick sees it.
    if (saveControllersRef.current.has(mediaId)) return;

    // Drop any ✓ badge before starting. Its 2s timer is keyed on `savedId`,
    // and left armed it fires MID-SAVE and deletes this save's 'saving'
    // status — which, with the old state-based guard, un-latched it. The ref
    // guard above now covers that, but a pill that vanishes while the save is
    // still running is wrong on its own.
    setSavedId(null);

    const controller = new AbortController();
    saveControllersRef.current.set(mediaId, controller);
    setSaveStatuses((prev) => ({ ...prev, [mediaId]: { phase: 'saving' } }));
    announce('Saving');

    saveMediaItem(mediaId, controller.signal)
      .then((result) => {
        saveControllersRef.current.delete(mediaId);
        if (!mountedRef.current) return;
        const message = describeExportOutcome(result);
        if (result.outcome === 'saved') {
          setSaveStatuses((prev) => ({ ...prev, [mediaId]: { phase: 'saved', message } }));
          setSavedId(mediaId);
          announce(message);
          return;
        }
        if (result.outcome === 'cancelled') {
          clearStatus(mediaId);
          return;
        }
        setSaveStatuses((prev) => ({ ...prev, [mediaId]: { phase: 'error', message } }));
        announce(message);
      })
      .catch(() => {
        // saveMediaItem never throws; this is belt and braces so a rejection
        // can never leave the button stuck on "saving".
        saveControllersRef.current.delete(mediaId);
        if (!mountedRef.current) return;
        setSaveStatuses((prev) => ({
          ...prev,
          [mediaId]: { phase: 'error', message: "Couldn't save" },
        }));
      });
  }, [mediaItems, currentIndex, exportable, announce, clearStatus]);

  /** iOS only — Modal.onDismiss fires after the dismiss animation completes. */
  const handleDismiss = useCallback(() => {
    if (pendingReportRef.current) {
      const target = pendingReportRef.current;
      pendingReportRef.current = null;
      useAppStore.getState().openReportSheet(target);
    }
  }, []);

  // ---------------------------------------------------------------------------
  // Styles
  // ---------------------------------------------------------------------------

  const backdropStyle: ViewStyle = {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.95)',
  };

  const closeButtonStyle: ViewStyle = {
    position: 'absolute',
    top: insets.top + theme.spacing.sm,
    right: theme.spacing.base,
    width: CLOSE_BUTTON_SIZE,
    height: CLOSE_BUTTON_SIZE,
    borderRadius: CLOSE_BUTTON_SIZE / 2,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 10,
  };

  const closeTextStyle: TextStyle = {
    color: '#FFFFFF',
    fontSize: theme.typography.fontSize.lg,
    fontFamily: theme.typography.fontFamily.body,
  };

  /**
   * Save sits immediately LEFT of Close, one `spacing.base` gutter away:
   *   right = spacing.base (Close's own inset)
   *         + CLOSE_BUTTON_SIZE (Close's width)
   *         + spacing.base (the gutter between them)
   * Written out rather than hard-coded so it tracks Close if either changes.
   * It never auto-hides — unlike the video chrome, this is app chrome.
   */
  const saveButtonStyle: ViewStyle = {
    position: 'absolute',
    top: insets.top + theme.spacing.sm,
    right: theme.spacing.base + CLOSE_BUTTON_SIZE + theme.spacing.base,
    width: CLOSE_BUTTON_SIZE,
    height: CLOSE_BUTTON_SIZE,
    borderRadius: CLOSE_BUTTON_SIZE / 2,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 10,
    // Non-exportable: dimmed rather than removed, so the affordance's absence
    // is explained by a tap instead of being a mystery.
    opacity: exportable ? 1 : 0.4,
  };

  const statusPillContainerStyle: ViewStyle = {
    position: 'absolute',
    top: insets.top + theme.spacing.sm + CLOSE_BUTTON_SIZE + theme.spacing.sm,
    left: 0,
    right: 0,
    alignItems: 'center',
    zIndex: 10,
  };

  const counterContainerStyle: ViewStyle = {
    position: 'absolute',
    top: insets.top + theme.spacing.sm,
    left: 0,
    right: 0,
    alignItems: 'center',
    zIndex: 10,
  };

  const counterPillStyle: ViewStyle = {
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.xs,
    borderRadius: theme.borderRadius.full,
  };

  const counterTextStyle: TextStyle = {
    color: '#FFFFFF',
    fontFamily: theme.typography.fontFamily.mono,
    fontSize: theme.typography.fontSize.sm,
  };

  const navButtonStyle: ViewStyle = {
    position: 'absolute',
    width: NAV_BUTTON_SIZE,
    height: NAV_BUTTON_SIZE,
    borderRadius: NAV_BUTTON_SIZE / 2,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 10,
  };

  const navTextStyle: TextStyle = {
    color: '#FFFFFF',
    fontSize: theme.typography.fontSize.xl,
    fontFamily: theme.typography.fontFamily.body,
  };

  const showNav = mediaItems.length > 1;
  const navVerticalCenter = screenHeight / 2 - NAV_BUTTON_SIZE / 2;
  const currentIsVideo = mediaItems[currentIndex]?.contentType?.startsWith('video/') ?? false;
  const currentIsImage = mediaItems[currentIndex]?.contentType?.startsWith('image/') ?? false;

  // --- Save button presentation -------------------------------------------

  const saveGlyph =
    currentStatus?.phase === 'saved'
      ? SAVED_GLYPH
      : currentStatus?.phase === 'error'
        ? SAVE_ERROR_GLYPH
        : SAVE_GLYPH;

  const saveAccessibilityLabel = currentIsVideo
    ? 'Save video'
    : currentIsImage
      ? 'Save photo'
      : 'Save file';

  /**
   * The pill's text. `waiting` is not a separate status: a save whose source
   * is still being fetched reads the STORE's download state, which is the one
   * place that knows how far along the transfer is.
   */
  const statusMessage: string | null =
    currentStatus === undefined
      ? null
      : currentStatus.phase === 'saving'
        ? currentDownloadState === 'downloaded'
          ? 'Saving…'
          : 'Downloading…'
        : currentStatus.phase === 'blocked'
          ? NOT_SAVEABLE_MESSAGE
          : currentStatus.message;

  return (
    <Modal
      visible={visible}
      presentationStyle="overFullScreen"
      animationType="fade"
      transparent
      onRequestClose={onClose}
      onDismiss={handleDismiss}
      statusBarTranslucent
    >
      <StatusBar hidden={visible} />
      {/* Doubles as the backdrop. Android Modals are separate windows, so
          App.tsx's root GestureHandlerRootView does not reach in here and the
          video overlay's gestures would be dead without this one. */}
      <GestureHandlerRootView style={backdropStyle}>
        {/* Report button */}
        <TouchableOpacity
          style={{
            position: 'absolute',
            top: insets.top + theme.spacing.sm,
            left: theme.spacing.base,
            width: CLOSE_BUTTON_SIZE,
            height: CLOSE_BUTTON_SIZE,
            borderRadius: CLOSE_BUTTON_SIZE / 2,
            backgroundColor: 'rgba(0, 0, 0, 0.5)',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 10,
          }}
          onPress={handleReport}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          accessibilityRole="button"
          accessibilityLabel={currentIsVideo ? 'Report video' : 'Report photo'}
          testID="media-lightbox-report-button"
        >
          <Text style={closeTextStyle}>{'⚑'}</Text>
        </TouchableOpacity>

        {/* Save button — see saveButtonStyle for the geometry derivation. */}
        <TouchableOpacity
          style={saveButtonStyle}
          onPress={handleSave}
          // right: 0 — Close owns the shared edge, so the two 40px circles
          // separated by one gutter never claim the same pixels.
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 0 }}
          accessibilityRole="button"
          accessibilityLabel={saveAccessibilityLabel}
          // `disabled` is reported but the press still lands: a tap on a
          // non-exportable item must EXPLAIN itself ("Not available to save"),
          // and a truly disabled TouchableOpacity swallows the press.
          accessibilityState={{
            disabled: !exportable,
            busy: currentStatus?.phase === 'saving',
          }}
          testID="lightbox-save"
        >
          <Text style={closeTextStyle}>{saveGlyph}</Text>
        </TouchableOpacity>

        {/* Inline save status — a PILL, never a nested Modal (see header). */}
        {statusMessage !== null && (
          <View style={statusPillContainerStyle} pointerEvents="none">
            <View style={counterPillStyle}>
              <Text style={counterTextStyle} testID="lightbox-save-status">
                {statusMessage}
              </Text>
            </View>
          </View>
        )}

        {/* Close button */}
        <TouchableOpacity
          style={closeButtonStyle}
          onPress={onClose}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          accessibilityRole="button"
          accessibilityLabel="Close lightbox"
          testID="lightbox-close"
        >
          <Text style={closeTextStyle}>{'✕'}</Text>
        </TouchableOpacity>

        {/* Counter */}
        {mediaItems.length > 1 && (
          <View style={counterContainerStyle} pointerEvents="none">
            <View style={counterPillStyle}>
              <Text style={counterTextStyle}>
                {`${currentIndex + 1} / ${mediaItems.length}`}
              </Text>
            </View>
          </View>
        )}

        {/* Paging ScrollView */}
        <ScrollView
          ref={scrollRef}
          horizontal
          pagingEnabled
          showsHorizontalScrollIndicator={false}
          onMomentumScrollEnd={handleMomentumScrollEnd}
          bounces={false}
          style={{ flex: 1 }}
          // Scrubber vs paging is now plain RNGH arbitration (A4 tier (i)):
          // the scrubber's Gesture.Pan calls requestDisallowInterceptTouchEvent
          // on Android, and on iOS RNGH arbitrates through recognizer delegates
          // rather than the ScrollView's UIKit touch tracking — which is why
          // the old canCancelContentTouches prop was never the lever it looked
          // like. Two pre-designed escalations if a device says otherwise:
          //   (ii) add `delaysContentTouches={false}` here;
          //   (iii) wrap this ScrollView in <GestureDetector gesture={native}>
          //         with `const native = Gesture.Native()` and pass `native` to
          //         LightboxVideoPage's scrollGesture prop (already threaded).
        >
          {/* Windowed: mount only pages within +/-1 of currentIndex.
             Placeholders keep content width so paging offset math is unaffected. */}
          {mediaItems.map((item, index) => {
            if (Math.abs(index - currentIndex) > 1) {
              return (
                <View
                  key={item.id}
                  testID={`lightbox-placeholder-${item.id}`}
                  style={{ width: screenWidth, height: screenHeight }}
                />
              );
            }

            if (item.contentType?.startsWith('video/')) {
              return (
                <LightboxVideoPage
                  key={item.id}
                  mediaId={item.id}
                  pageWidth={screenWidth}
                  pageHeight={screenHeight}
                  contentType={item.contentType}
                  thumbnailMediaId={item.thumbnailMediaId}
                  durationMs={item.duration}
                  // The `visible &&` term is what unmounts the player on the
                  // close commit — iOS Modal keeps children mounted until
                  // onDismiss, which would otherwise leave audio playing.
                  isActive={visible && index === currentIndex}
                  // Lets the Save press stamp the controls' suppression
                  // window — see the module header and handleSave.
                  registerControlStamp={registerControlStamp}
                />
              );
            }

            return (
              <LightboxPage
                key={item.id}
                mediaId={item.id}
                pageWidth={screenWidth}
                pageHeight={screenHeight}
              />
            );
          })}
        </ScrollView>

        {/* Prev button */}
        {showNav && currentIndex > 0 && (
          <TouchableOpacity
            style={[
              navButtonStyle,
              { left: theme.spacing.sm, top: navVerticalCenter },
            ]}
            onPress={goToPrev}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            accessibilityRole="button"
            accessibilityLabel={currentIsVideo ? 'Previous media' : 'Previous image'}
            testID="lightbox-prev"
          >
            <Text style={navTextStyle}>{'<'}</Text>
          </TouchableOpacity>
        )}

        {/* Next button */}
        {showNav && currentIndex < mediaItems.length - 1 && (
          <TouchableOpacity
            style={[
              navButtonStyle,
              { right: theme.spacing.sm, top: navVerticalCenter },
            ]}
            onPress={goToNext}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            accessibilityRole="button"
            accessibilityLabel={currentIsVideo ? 'Next media' : 'Next image'}
            testID="lightbox-next"
          >
            <Text style={navTextStyle}>{'>'}</Text>
          </TouchableOpacity>
        )}
      </GestureHandlerRootView>
    </Modal>
  );
}
