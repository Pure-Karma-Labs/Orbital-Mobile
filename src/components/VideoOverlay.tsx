/**
 * Video overlay components — play icon and duration badge.
 *
 * PlayIconOverlay: centered play triangle inside a semi-transparent circle.
 * DurationBadge: bottom-right pill showing formatted duration.
 *
 * Design spec: SCREEN-MEDIA-GALLERY.md
 * - Play icon: centered, 48x48pt default, white drop shadow
 * - Duration badge: bottom:4 right:4, mono fontSize.xs, white on black 60% bg
 */

import React from 'react';
import { Text, View, type TextStyle, type ViewStyle } from 'react-native';
import { useTheme } from '../theme';
import { formatDurationMs } from '../utils/formatDuration';

// ---------------------------------------------------------------------------
// PlayIconOverlay
// ---------------------------------------------------------------------------

export interface PlayIconOverlayProps {
  /** Diameter of the play circle. Default 48 for gallery cells. */
  size?: number;
  /** When true, renders the glyph without the circle background (strip variant). */
  minimal?: boolean;
}

/**
 * Centered play icon overlay for video thumbnails.
 *
 * Absolutely-positioned, pointerEvents="none". Renders a Unicode play triangle
 * inside a semi-transparent circle with a white drop shadow (per design spec).
 */
export function PlayIconOverlay({
  size = 48,
  minimal = false,
}: PlayIconOverlayProps): React.JSX.Element {
  const glyphSize = Math.round(size * 0.45);

  const containerStyle: ViewStyle = {
    ...fullCenterAbsolute,
    alignItems: 'center',
    justifyContent: 'center',
  };

  const circleStyle: ViewStyle = minimal
    ? {}
    : {
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: 'rgba(0, 0, 0, 0.5)',
        alignItems: 'center',
        justifyContent: 'center',
      };

  const textStyle: TextStyle = {
    fontSize: glyphSize,
    color: '#FFFFFF',
    textShadowColor: 'rgba(255, 255, 255, 0.6)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 3,
    // Nudge the triangle slightly right to optically center it
    marginLeft: Math.round(size * 0.06),
  };

  return (
    <View style={containerStyle} pointerEvents="none" testID="play-icon-overlay">
      <View style={circleStyle}>
        <Text style={textStyle} accessible={false}>
          {'▶'}
        </Text>
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// DurationBadge
// ---------------------------------------------------------------------------

export interface DurationBadgeProps {
  /** Duration in milliseconds. */
  durationMs: number;
}

/**
 * Bottom-right duration badge for video thumbnails.
 *
 * Design spec: white mono text on black 60% bg, fontSize.xs (10), 4px padding,
 * borderRadius.sm (2).
 */
export function DurationBadge({ durationMs }: DurationBadgeProps): React.JSX.Element {
  const theme = useTheme();

  const pillStyle: ViewStyle = {
    position: 'absolute',
    bottom: 4,
    right: 4,
    backgroundColor: 'rgba(0, 0, 0, 0.6)',
    paddingHorizontal: 4,
    paddingVertical: 2,
    borderRadius: theme.borderRadius.sm,
  };

  const textStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.mono,
    fontSize: theme.typography.fontSize.xs,
    color: '#FFFFFF',
  };

  return (
    <View style={pillStyle} pointerEvents="none" testID="duration-badge">
      <Text style={textStyle}>{formatDurationMs(durationMs)}</Text>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Shared styles
// ---------------------------------------------------------------------------

const fullCenterAbsolute: ViewStyle = {
  position: 'absolute',
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
  alignItems: 'center',
  justifyContent: 'center',
};
