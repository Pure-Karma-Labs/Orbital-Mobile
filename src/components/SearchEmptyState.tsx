/**
 * Search empty state — displayed when a fuzzy search returns no results.
 * Matches the existing empty-state style (ASCII box borders, mono font).
 */

import React from 'react';
import { Text, View, type TextStyle, type ViewStyle } from 'react-native';
import { useTheme } from '../theme';

export interface SearchEmptyStateProps {
  searchText: string;
  testID?: string;
}

export function SearchEmptyState({
  searchText,
  testID,
}: SearchEmptyStateProps): React.JSX.Element {
  const theme = useTheme();

  const containerStyle: ViewStyle = {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: theme.spacing.xl,
  };

  const boxStyle: ViewStyle = {
    borderWidth: 1,
    borderColor: theme.colors.borderSubtle,
    borderRadius: theme.borderRadius.base,
    padding: theme.spacing.lg,
    alignItems: 'center',
    width: '100%',
    maxWidth: 300,
  };

  const borderTextStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.mono,
    fontSize: theme.typography.fontSize.sm,
    color: theme.colors.textTertiary,
    marginBottom: theme.spacing.md,
  };

  const messageStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.body,
    fontSize: theme.typography.fontSize.base,
    color: theme.colors.textSecondary,
    textAlign: 'center',
  };

  // Truncate search text with ellipsis if > 30 characters
  const displayText =
    searchText.length > 30 ? `${searchText.slice(0, 30)}...` : searchText;

  return (
    <View style={containerStyle} testID={testID}>
      <View style={boxStyle}>
        <Text style={borderTextStyle}>{'┌─────────────────────┐'}</Text>
        <Text style={messageStyle}>{`No results for\n"${displayText}"`}</Text>
        <Text style={[borderTextStyle, { marginBottom: 0, marginTop: theme.spacing.md }]}>
          {'└─────────────────────┘'}
        </Text>
      </View>
    </View>
  );
}
