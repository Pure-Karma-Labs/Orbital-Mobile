/**
 * ASCII section header for settings lists — `─── Section Name ───`.
 *
 * Extracted from SettingsScreen so sub-screens (Push Notifications) render the
 * identical treatment instead of a near-copy. Spec: docs/design/SCREEN-SETTINGS.md
 * ("ASCII Section Headers") — mono font, fontSize.sm, textTertiary, centered.
 */

import React from 'react';
import { Text, View, type TextStyle, type ViewStyle } from 'react-native';
import { useTheme } from '../../theme';

export interface SectionHeaderProps {
  label: string;
}

export function SectionHeader({ label }: SectionHeaderProps): React.JSX.Element {
  const theme = useTheme();

  const containerStyle: ViewStyle = {
    paddingTop: theme.spacing.base,
    paddingBottom: theme.spacing.sm,
    paddingHorizontal: theme.spacing.base,
  };

  const textStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.mono,
    fontSize: theme.typography.fontSize.sm,
    color: theme.colors.textTertiary,
    textAlign: 'center',
  };

  return (
    <View style={containerStyle}>
      <Text style={textStyle}>{`─── ${label} ───`}</Text>
    </View>
  );
}
