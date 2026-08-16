/**
 * ProgressBar -- a thin determinate progress track with a percentage fill.
 *
 * Deliberately unanimated: `useNativeDriver: true` cannot animate width, no
 * Reanimated/SVG dependency exists in this app, and the repo precedent
 * (QuotaBar) is a plain percent-width View. Emission cadence upstream is
 * naturally chunky anyway (native transcode progress is throttled to ~0.5s,
 * chunk upload steps 5 MiB at a time), so interpolation would be fiction.
 *
 * Colors resolve from the theme INSIDE the component -- there is no static
 * palette export, and a default parameter would pin light-mode colors into
 * dark mode.
 *
 * Used by UploadProgressBar (composer upload); the download-side progress UI
 * reuses this bar without the cancel/MB row.
 */

import React from 'react';
import { View, type ViewStyle } from 'react-native';
import { useTheme } from '../theme';

export interface ProgressBarProps {
  /** Progress 0-1. Clamped; NaN/Infinity render as 0 rather than a broken fill. */
  progress: number;
  /** Track/fill height in px. Default 3. */
  height?: number;
  /** Fill color. Defaults to the theme's blue. */
  color?: string;
  /** Track color. Defaults to the theme's subtle border. */
  trackColor?: string;
  /**
   * Expose the bar to assistive tech as a progressbar with a live value.
   * Off by default: most bars sit next to a label that already announces
   * state, and a per-tick value announcement is noise.
   */
  announceProgress?: boolean;
  accessibilityLabel?: string;
  testID?: string;
}

export function ProgressBar({
  progress,
  height = 3,
  color,
  trackColor,
  announceProgress = false,
  accessibilityLabel,
  testID,
}: ProgressBarProps): React.JSX.Element {
  const theme = useTheme();

  const clamped = Number.isFinite(progress) ? Math.min(1, Math.max(0, progress)) : 0;
  const percent = Math.round(clamped * 100);

  const trackStyle: ViewStyle = {
    height,
    backgroundColor: trackColor ?? theme.colors.borderSubtle,
    borderRadius: 9999,
    overflow: 'hidden',
  };

  const fillStyle: ViewStyle = {
    height,
    width: `${percent}%`,
    backgroundColor: color ?? theme.colors.blue,
    borderRadius: 9999,
  };

  // A11y is keyed on the explicit boolean, never on the presence of a label --
  // one prop must not secretly control two things.
  const a11yProps = announceProgress
    ? {
        accessibilityRole: 'progressbar' as const,
        accessibilityValue: { min: 0, max: 100, now: percent },
      }
    : {};

  return (
    <View
      style={trackStyle}
      accessibilityLabel={accessibilityLabel}
      testID={testID}
      {...a11yProps}
    >
      <View style={fillStyle} testID={testID ? `${testID}-fill` : undefined} />
    </View>
  );
}
