/**
 * Inline error banner — shows a left-bordered alert when message is non-null.
 */

import React from 'react';
import { Text, View, type TextStyle, type ViewStyle } from 'react-native';
import { useTheme } from '../theme';

export interface ErrorBannerProps {
  message: string | null;
  /**
   * Optional hook for tests that must assert the banner is *absent* — a query
   * by text can only prove one string is gone, not that the banner cleared.
   */
  testID?: string;
}

export function ErrorBanner({ message, testID }: ErrorBannerProps): React.JSX.Element | null {
  const theme = useTheme();

  if (message === null) return null;

  const containerStyle: ViewStyle = {
    borderLeftWidth: 3,
    borderLeftColor: theme.colors.error,
    backgroundColor: `${theme.colors.error}18`,
    borderRadius: theme.borderRadius.sm,
    paddingHorizontal: theme.spacing.base,
    paddingVertical: theme.spacing.sm,
    marginBottom: theme.spacing.md,
  };

  const textStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.body,
    fontSize: theme.typography.fontSize.sm,
    color: theme.colors.error,
    lineHeight: theme.typography.fontSize.sm * theme.typography.lineHeight.normal,
  };

  return (
    <View style={containerStyle} testID={testID}>
      <Text style={textStyle}>{message}</Text>
    </View>
  );
}
