/**
 * Yellow pill badge for unread counts.
 */

import React from 'react';
import { StyleSheet, Text, View, type TextStyle, type ViewStyle } from 'react-native';
import { useTheme } from '../theme';

export interface BadgeProps {
  count: number;
  testID?: string;
}

export function Badge({ count, testID }: BadgeProps): React.JSX.Element | null {
  const theme = useTheme();

  if (count <= 0) {
    return null;
  }

  const containerStyle: ViewStyle = {
    minWidth: 18,
    paddingVertical: 2,
    paddingHorizontal: 6,
    backgroundColor: theme.colors.yellow,
    borderWidth: 1,
    borderColor: theme.colors.yellowDark,
    borderRadius: 9999,
    alignItems: 'center',
    justifyContent: 'center',
  };

  const textStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.bodyBold,
    fontSize: theme.typography.fontSize.xs,
    color: theme.colors.textPrimary,
    lineHeight: 14,
  };

  return (
    <View style={containerStyle} testID={testID}>
      <Text style={textStyle} allowFontScaling={false}>
        {count > 99 ? '99+' : String(count)}
      </Text>
    </View>
  );
}

const _styles = StyleSheet.create({});
void _styles;
