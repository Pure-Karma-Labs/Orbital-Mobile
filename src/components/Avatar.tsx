/**
 * Colored circle with initial letter and optional online presence dot.
 */

import React from 'react';
import { StyleSheet, Text, View, type TextStyle, type ViewStyle } from 'react-native';
import { useTheme } from '../theme';

export interface AvatarProps {
  name: string;
  size?: number;
  color?: string;
  online?: boolean;
}

export function Avatar({
  name,
  size = 36,
  color,
  online,
}: AvatarProps): React.JSX.Element {
  const theme = useTheme();
  const bgColor = color ?? theme.colors.blue;
  const initial = (name || '?').slice(0, 1).toUpperCase();

  const containerStyle: ViewStyle = {
    width: size,
    height: size,
    borderRadius: 9999,
    backgroundColor: bgColor,
    alignItems: 'center',
    justifyContent: 'center',
  };

  const initialStyle: TextStyle = {
    fontSize: Math.round(size * 0.42),
    color: '#FFFFFF',
    fontFamily: theme.typography.fontFamily.bodyBold,
    lineHeight: size,
    textAlign: 'center',
  };

  const dotSize = 8;
  const presenceDotStyle: ViewStyle = {
    position: 'absolute',
    bottom: 0,
    right: 0,
    width: dotSize,
    height: dotSize,
    borderRadius: 9999,
    backgroundColor: online ? theme.colors.yellow : theme.colors.textTertiary,
    borderWidth: 1,
    borderColor: theme.colors.surfaceElevated,
  };

  return (
    <View style={containerStyle}>
      <Text style={initialStyle} allowFontScaling={false}>
        {initial}
      </Text>
      {online != null && <View style={presenceDotStyle} />}
    </View>
  );
}

const _styles = StyleSheet.create({});
void _styles;
