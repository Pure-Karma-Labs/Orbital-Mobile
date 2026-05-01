import React, { useCallback } from 'react';
import {
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { useTheme } from '../../theme';
import { Emoji } from '../../components/Emoji';

export interface SettingsRowProps {
  emojiUnified: string;
  label: string;
  value?: string;
  chevron?: boolean;
  destructive?: boolean;
  disabled?: boolean;
  onPress?: () => void;
  testID?: string;
}

export const SettingsRow = React.memo(function SettingsRow({
  emojiUnified,
  label,
  value,
  chevron = false,
  destructive = false,
  disabled = false,
  onPress,
  testID,
}: SettingsRowProps): React.JSX.Element {
  const theme = useTheme();

  const handlePress = useCallback(() => {
    if (!disabled) onPress?.();
  }, [disabled, onPress]);

  const containerStyle: ViewStyle = {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 52,
    paddingHorizontal: theme.spacing.base,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.borderSubtle,
    opacity: disabled ? 0.5 : 1,
  };

  const emojiContainerStyle: ViewStyle = {
    width: 24,
    height: 24,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: theme.spacing.md,
  };

  const labelStyle: TextStyle = {
    flex: 1,
    fontFamily: theme.typography.fontFamily.body,
    fontSize: theme.typography.fontSize.base,
    color: destructive ? theme.colors.error : theme.colors.textPrimary,
  };

  const valueStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.body,
    fontSize: theme.typography.fontSize.sm,
    color: theme.colors.textSecondary,
    marginRight: chevron ? theme.spacing.xs : 0,
  };

  const chevronStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.body,
    fontSize: theme.typography.fontSize.base,
    color: theme.colors.textTertiary,
  };

  return (
    <TouchableOpacity
      style={containerStyle}
      onPress={handlePress}
      disabled={disabled || !onPress}
      activeOpacity={0.7}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      testID={testID}
    >
      <View style={emojiContainerStyle}>
        <Emoji unified={emojiUnified} size={14} />
      </View>
      <Text style={labelStyle}>{label}</Text>
      {value != null && <Text style={valueStyle}>{value}</Text>}
      {chevron && <Text style={chevronStyle}>{'▸'}</Text>}
    </TouchableOpacity>
  );
});
