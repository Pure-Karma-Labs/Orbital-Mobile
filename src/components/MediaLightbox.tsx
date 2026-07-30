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
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
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
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CLOSE_BUTTON_SIZE = 40;
const NAV_BUTTON_SIZE = 44;

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
}: MediaLightboxProps): React.JSX.Element {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const scrollRef = useRef<ScrollView>(null);
  const [currentIndex, setCurrentIndex] = useState(initialIndex);
  const pendingReportRef = useRef<ReportTarget | null>(null);

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
