/**
 * ASCII-styled separators for day groups and section boundaries.
 *
 * AsciiDay:     ─── {label} ───
 * AsciiSection: ·  ·  ·  ✦  ·  ·  ·
 */

import React from 'react';
import { StyleSheet, Text, View, type TextStyle, type ViewStyle } from 'react-native';
import { useTheme } from '../theme';

// ---------------------------------------------------------------------------
// AsciiDay
// ---------------------------------------------------------------------------

export interface AsciiDayProps {
  label: string;
}

export function AsciiDay({ label }: AsciiDayProps): React.JSX.Element {
  const theme = useTheme();

  const containerStyle: ViewStyle = {
    alignItems: 'center',
    paddingVertical: 12,
  };

  const textStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.mono,
    fontSize: theme.typography.fontSize.sm,
    color: theme.colors.textTertiary,
  };

  return (
    <View style={containerStyle}>
      <Text style={textStyle}>{`─── ${label} ───`}</Text>
    </View>
  );
}

// ---------------------------------------------------------------------------
// AsciiSection
// ---------------------------------------------------------------------------

export function AsciiSection(): React.JSX.Element {
  const theme = useTheme();

  const containerStyle: ViewStyle = {
    alignItems: 'center',
    paddingVertical: 8,
  };

  const textStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.mono,
    fontSize: theme.typography.fontSize.sm,
    color: theme.colors.textTertiary,
    letterSpacing: theme.typography.letterSpacing.wider,
  };

  return (
    <View style={containerStyle}>
      <Text style={textStyle}>{'·  ·  ·  ✦  ·  ·  ·'}</Text>
    </View>
  );
}

// Suppress StyleSheet unused warning — styles are inline for theme dependency
const _styles = StyleSheet.create({});
void _styles;
