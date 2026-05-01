/**
 * usePullToRefresh — Tracks scroll offset for custom pull-to-refresh visuals.
 *
 * Returns an Animated.Value (scrollY) that drives the PullToRefreshOverlay
 * component, plus an onScroll handler to spread onto the FlatList.
 *
 * The actual refresh mechanics still use RefreshControl (with hidden native
 * spinner on iOS via tintColor="transparent"). This hook only adds the
 * scroll tracking needed for the custom overlay animation.
 */

import { useRef } from 'react';
import { Animated } from 'react-native';

export interface UsePullToRefreshResult {
  /** Animated value tracking contentOffset.y — pass to PullToRefreshOverlay */
  scrollY: Animated.Value;
  /** Spread onto FlatList: onScroll + scrollEventThrottle */
  scrollProps: {
    onScroll: (...args: unknown[]) => void;
    scrollEventThrottle: number;
  };
}

export function usePullToRefresh(): UsePullToRefreshResult {
  const scrollY = useRef(new Animated.Value(0)).current;

  const onScroll = Animated.event(
    [{ nativeEvent: { contentOffset: { y: scrollY } } }],
    { useNativeDriver: true },
  );

  return {
    scrollY,
    scrollProps: {
      onScroll,
      scrollEventThrottle: 16,
    },
  };
}
