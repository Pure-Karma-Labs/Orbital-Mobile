/**
 * Themed button with primary/secondary variants and loading state.
 */

import React from 'react';
import {
  Text,
  TouchableOpacity,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { useTheme } from '../theme';
import { OrbitalSpinner } from './OrbitalSpinner';

export interface ButtonProps {
  title: string;
  onPress: () => void;
  loading?: boolean;
  disabled?: boolean;
  variant?: 'primary' | 'secondary';
  testID?: string;
}

export function Button({
  title,
  onPress,
  loading = false,
  disabled = false,
  variant = 'primary',
  testID,
}: ButtonProps): React.JSX.Element {
  const theme = useTheme();

  const isPrimary = variant === 'primary';
  const isDisabled = disabled || loading;

  const containerStyle: ViewStyle = {
    backgroundColor: isPrimary ? theme.colors.blue : 'transparent',
    borderWidth: isPrimary ? 0 : 1,
    borderColor: isPrimary ? undefined : theme.colors.borderStrong,
    borderRadius: theme.borderRadius.base,
    paddingVertical: theme.spacing.sm + 2,
    paddingHorizontal: theme.spacing.base,
    alignItems: 'center',
    justifyContent: 'center',
    opacity: isDisabled ? 0.5 : 1,
    minHeight: 44,
  };

  const textStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.bodyBold,
    fontSize: theme.typography.fontSize.base,
    color: isPrimary ? '#FFFFFF' : theme.colors.textPrimary,
  };

  return (
    <TouchableOpacity
      style={containerStyle}
      onPress={onPress}
      disabled={isDisabled}
      activeOpacity={0.75}
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={title}
      accessibilityState={{ disabled: isDisabled, busy: loading }}
    >
      {loading ? (
        <OrbitalSpinner size={20} />
      ) : (
        <Text style={textStyle}>{title}</Text>
      )}
    </TouchableOpacity>
  );
}
