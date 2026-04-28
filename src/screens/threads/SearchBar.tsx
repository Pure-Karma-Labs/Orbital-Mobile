/**
 * Thread search bar — decorative in Phase 1, functional in later phases.
 */

import React from 'react';
import {
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { useTheme } from '../../theme';

export interface SearchBarProps {
  onPress?: () => void;
}

export function SearchBar({ onPress }: SearchBarProps): React.JSX.Element {
  const theme = useTheme();

  const wrapperStyle: ViewStyle = {
    paddingHorizontal: theme.spacing.base,
    paddingVertical: theme.spacing.sm,
  };

  const containerStyle: ViewStyle = {
    height: 36,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: theme.colors.surfaceElevated,
    borderWidth: 1,
    borderColor: theme.colors.borderSubtle,
    borderRadius: theme.borderRadius.base,
    paddingHorizontal: theme.spacing.sm,
    gap: theme.spacing.xs,
  };

  const iconStyle: TextStyle = {
    fontSize: theme.typography.fontSize.base,
    lineHeight: 20,
  };

  const placeholderStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.body,
    fontSize: theme.typography.fontSize.base,
    color: theme.colors.textTertiary,
  };

  return (
    <View style={wrapperStyle}>
      <TouchableOpacity
        style={containerStyle}
        onPress={onPress}
        activeOpacity={0.7}
        accessibilityRole="search"
        accessibilityLabel="Search threads"
      >
        <Text style={iconStyle}>🔍</Text>
        <Text style={placeholderStyle}>Search threads...</Text>
      </TouchableOpacity>
    </View>
  );
}

const _styles = StyleSheet.create({});
void _styles;
