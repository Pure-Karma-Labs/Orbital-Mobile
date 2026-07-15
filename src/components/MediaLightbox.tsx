/**
 * MediaLightbox — Full-screen modal viewer for media items.
 *
 * Opens over the current screen with a dark background. Supports horizontal
 * swiping between images via a paging ScrollView. Shows close button, image
 * counter, and prev/next navigation arrows.
 *
 * Uses React Native Modal with fade animation. Status bar is hidden when
 * the lightbox is visible.
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
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../theme';
import { useMediaDownload } from '../hooks/useMediaDownload';
import { OrbitalSpinner } from './OrbitalSpinner';
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
// Single page component — isolates useMediaDownload per item
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
  const { downloadState, localPath } = useMediaDownload(mediaId, {
    cancelOnUnmount: true,
  });

  if (downloadState === 'downloaded' && localPath) {
    return (
      <View
        testID={`lightbox-page-${mediaId}`}
        style={{
          width: pageWidth,
          height: pageHeight,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Image
          source={{ uri: `file://${localPath}` }}
          style={{ width: pageWidth, height: pageHeight }}
          resizeMode="contain"
        />
      </View>
    );
  }

  // Not yet downloaded — show spinner
  return (
    <View
      testID={`lightbox-page-${mediaId}`}
      style={{
        width: pageWidth,
        height: pageHeight,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
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
      <View style={backdropStyle}>
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
          accessibilityLabel="Report photo"
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
        >
          {/* Windowed: mount only pages within +/-1 of currentIndex.
             Placeholders keep content width so paging offset math is unaffected. */}
          {mediaItems.map((item, index) =>
            Math.abs(index - currentIndex) <= 1 ? (
              <LightboxPage
                key={item.id}
                mediaId={item.id}
                pageWidth={screenWidth}
                pageHeight={screenHeight}
              />
            ) : (
              <View
                key={item.id}
                testID={`lightbox-placeholder-${item.id}`}
                style={{ width: screenWidth, height: screenHeight }}
              />
            ),
          )}
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
            accessibilityLabel="Previous image"
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
            accessibilityLabel="Next image"
            testID="lightbox-next"
          >
            <Text style={navTextStyle}>{'>'}</Text>
          </TouchableOpacity>
        )}
      </View>
    </Modal>
  );
}
