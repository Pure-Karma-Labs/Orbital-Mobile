/**
 * Inline success banner — shows a left-bordered alert when message is non-null.
 * Mirrors ErrorBanner structure but uses theme.colors.success.
 */

import React from 'react';
import { Text, View, type TextStyle, type ViewStyle } from 'react-native';
import { useTheme } from '../theme';

export interface SuccessBannerProps {
  message: string | null;
  testID?: string;
}

export function SuccessBanner({ message, testID }: SuccessBannerProps): React.JSX.Element | null {
  const theme = useTheme();

  if (message === null) return null;

  const containerStyle: ViewStyle = {
    borderLeftWidth: 3,
    borderLeftColor: theme.colors.success,
    backgroundColor: `${theme.colors.success}18`,
    borderRadius: theme.borderRadius.sm,
    paddingHorizontal: theme.spacing.base,
    paddingVertical: theme.spacing.sm,
    marginBottom: theme.spacing.md,
  };

  const textStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.body,
    fontSize: theme.typography.fontSize.sm,
    color: theme.colors.success,
    lineHeight: theme.typography.fontSize.sm * theme.typography.lineHeight.normal,
  };

  return (
    <View style={containerStyle} testID={testID}>
      <Text style={textStyle}>{message}</Text>
    </View>
  );
}
