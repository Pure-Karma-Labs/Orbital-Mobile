/**
 * Themed text input with a label and focus state border highlight.
 */

import React, { useState } from 'react';
import {
  View,
  Text,
  TextInput as RNTextInput,
  type KeyboardTypeOptions,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { useTheme } from '../theme';

export interface TextInputProps {
  label: string;
  value: string;
  onChangeText: (text: string) => void;
  secureTextEntry?: boolean;
  autoCapitalize?: 'none' | 'sentences' | 'words' | 'characters';
  autoCorrect?: boolean;
  keyboardType?: KeyboardTypeOptions;
  maxLength?: number;
  testID?: string;
}

export function TextInput({
  label,
  value,
  onChangeText,
  secureTextEntry = false,
  autoCapitalize = 'sentences',
  autoCorrect = true,
  keyboardType = 'default',
  maxLength,
  testID,
}: TextInputProps): React.JSX.Element {
  const theme = useTheme();
  const [focused, setFocused] = useState(false);

  const containerStyle: ViewStyle = {
    marginBottom: theme.spacing.md,
  };

  const labelStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.bodyBold,
    fontSize: theme.typography.fontSize.sm,
    color: theme.colors.textSecondary,
    marginBottom: theme.spacing.xs,
  };

  const inputContainerStyle: ViewStyle = {
    backgroundColor: theme.colors.surfaceElevated,
    borderWidth: 1,
    borderColor: focused ? theme.colors.blue : theme.colors.borderSubtle,
    borderRadius: theme.borderRadius.base,
    paddingHorizontal: theme.spacing.base,
    paddingVertical: theme.spacing.sm,
  };

  const inputStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.body,
    fontSize: theme.typography.fontSize.base,
    color: theme.colors.textPrimary,
    padding: 0,
    margin: 0,
  };

  return (
    <View style={containerStyle}>
      <Text style={labelStyle}>{label}</Text>
      <View style={inputContainerStyle}>
        <RNTextInput
          style={inputStyle}
          value={value}
          onChangeText={onChangeText}
          secureTextEntry={secureTextEntry}
          autoCapitalize={autoCapitalize}
          autoCorrect={autoCorrect}
          keyboardType={keyboardType}
          maxLength={maxLength}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          placeholderTextColor={theme.colors.textTertiary}
          testID={testID}
        />
      </View>
    </View>
  );
}
