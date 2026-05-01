import React from 'react';
import { Text, View, type TextStyle, type ViewStyle } from 'react-native';
import { useTheme } from '../../theme';

export interface QuotaBarProps {
  usedBytes: number;
  limitBytes: number;
  percentage: number;
}

function formatMB(bytes: number): number {
  return Math.round(bytes / (1024 * 1024));
}

export const QuotaBar = React.memo(function QuotaBar({
  usedBytes,
  limitBytes,
  percentage,
}: QuotaBarProps): React.JSX.Element {
  const theme = useTheme();

  const clampedPct = Math.min(Math.max(percentage, 0), 100);
  let fillColor = theme.colors.blue;
  if (percentage > 90) fillColor = theme.colors.error;
  else if (percentage > 75) fillColor = theme.colors.warning;

  const containerStyle: ViewStyle = {
    paddingHorizontal: theme.spacing.base,
    paddingVertical: theme.spacing.sm,
  };

  const trackStyle: ViewStyle = {
    height: 6,
    backgroundColor: theme.colors.borderSubtle,
    borderRadius: 9999,
    overflow: 'hidden',
  };

  const fillStyle: ViewStyle = {
    height: 6,
    width: `${clampedPct}%`,
    backgroundColor: fillColor,
    borderRadius: 9999,
  };

  const labelStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.body,
    fontSize: theme.typography.fontSize.sm,
    color: theme.colors.textSecondary,
    marginTop: theme.spacing.xs,
  };

  return (
    <View
      style={containerStyle}
      accessibilityRole="progressbar"
      accessibilityValue={{ min: 0, max: limitBytes, now: usedBytes }}
      testID="quota-bar"
    >
      <View style={trackStyle}>
        <View style={fillStyle} />
      </View>
      <Text style={labelStyle}>
        {formatMB(usedBytes)}/{formatMB(limitBytes)} MB
      </Text>
    </View>
  );
});
