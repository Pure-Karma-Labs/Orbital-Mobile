/**
 * PullToRefreshOverlay — Custom spinner for the pull-to-refresh gesture.
 *
 * iOS only. On Android, the native RefreshControl with brand colors is used
 * instead, so this renders null.
 *
 * How it works:
 * - The FlatList keeps a RefreshControl with tintColor="transparent" to hide
 *   the native spinner while retaining pull-to-refresh mechanics.
 * - This overlay is positioned absolutely at the top of the FlatList's
 *   container. When at rest (scrollY >= 0), it has opacity 0.
 * - As the user pulls down (scrollY goes negative), the overlay fades and
 *   scales in, sliding down proportionally to stay centered in the gap
 *   between the FlatList's top edge and where the content has been pulled to.
 * - During active refresh, the RefreshControl holds the content down and
 *   this component shows at full opacity.
 *
 * Place this as a sibling of the FlatList, inside a shared parent View.
 * The parent must have flex:1 so the overlay has correct bounds.
 */

import React from 'react';
import { Animated, Platform, type ViewStyle } from 'react-native';
import { OrbitalSpinner } from './OrbitalSpinner';

const PULL_DISTANCE = 60;

export interface PullToRefreshOverlayProps {
  /** Animated.Value tracking FlatList's contentOffset.y */
  scrollY: Animated.Value;
  /** Whether a refresh operation is in progress */
  refreshing: boolean;
}

export function PullToRefreshOverlay({
  scrollY,
  refreshing,
}: PullToRefreshOverlayProps): React.JSX.Element | null {
  if (Platform.OS !== 'ios') {
    return null;
  }

  // As the user pulls down, scrollY goes from 0 toward negative values.
  // The overlay translates downward by half the pull distance so it stays
  // centered in the revealed gap.
  const translateY = scrollY.interpolate({
    inputRange: [-PULL_DISTANCE * 2, -PULL_DISTANCE, 0],
    outputRange: [PULL_DISTANCE, PULL_DISTANCE / 2, 0],
    extrapolate: 'clamp',
  });

  const opacity = scrollY.interpolate({
    inputRange: [-PULL_DISTANCE, -PULL_DISTANCE / 3, 0],
    outputRange: [1, 0.3, 0],
    extrapolate: 'clamp',
  });

  const scale = scrollY.interpolate({
    inputRange: [-PULL_DISTANCE, 0],
    outputRange: [1, 0.3],
    extrapolate: 'clamp',
  });

  // During active refresh the content stays pulled down — show spinner at
  // full intensity regardless of where scrollY has settled.
  const finalOpacity = refreshing ? 1 : opacity;
  const finalScale = refreshing ? 1 : scale;
  const finalTranslateY = refreshing ? PULL_DISTANCE / 2 : translateY;

  const containerStyle: ViewStyle = {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: 0,
    alignItems: 'center',
    overflow: 'visible',
    zIndex: 10,
  };

  return (
    <Animated.View
      pointerEvents="none"
      style={[
        containerStyle,
        {
          opacity: finalOpacity,
          transform: [
            { translateY: finalTranslateY },
            { scale: finalScale },
          ],
        },
      ]}
    >
      <OrbitalSpinner size={28} />
    </Animated.View>
  );
}
