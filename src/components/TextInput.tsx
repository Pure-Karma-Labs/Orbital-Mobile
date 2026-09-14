/**
 * Themed text input with a label and focus state border highlight.
 */

import React, { useState } from 'react';
import {
  View,
  Text,
  TextInput as RNTextInput,
  TouchableOpacity,
  type KeyboardTypeOptions,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import type { TextInputProps as RNTextInputProps } from 'react-native';
import { useTheme } from '../theme';

export interface TextInputProps {
  label: string;
  value: string;
  onChangeText: (text: string) => void;
  secureTextEntry?: boolean;
  autoCapitalize?: 'none' | 'sentences' | 'words' | 'characters';
  autoCorrect?: boolean;
  keyboardType?: KeyboardTypeOptions;
  textContentType?: RNTextInputProps['textContentType'];
  maxLength?: number;
  placeholder?: string;
  /** Persistent hint rendered below the input. Suppressed while `error` is set. */
  helperText?: string;
  /** Field-level validation message. Replaces `helperText` and reddens the border. */
  error?: string | null;
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
  textContentType,
  maxLength,
  placeholder,
  helperText,
  error,
  testID,
}: TextInputProps): React.JSX.Element {
  const theme = useTheme();
  const [focused, setFocused] = useState(false);
  const [hidden, setHidden] = useState(secureTextEntry);

  const hasError = error != null && error.length > 0;
  const hasSlot = hasError || (helperText != null && helperText.length > 0);

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
    borderColor: hasError
      ? theme.colors.error
      : focused
        ? theme.colors.blue
        : theme.colors.borderSubtle,
    borderRadius: theme.borderRadius.base,
    paddingHorizontal: theme.spacing.base,
    paddingVertical: theme.spacing.sm,
    flexDirection: 'row',
    alignItems: 'center',
  };

  const toggleStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.body,
    fontSize: theme.typography.fontSize.sm,
    color: theme.colors.blue,
    paddingLeft: theme.spacing.sm,
  };

  const inputStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.body,
    fontSize: theme.typography.fontSize.base,
    color: theme.colors.textPrimary,
    padding: 0,
    margin: 0,
  };

  // Inline errors / helper text: fontSize.sm (11) at lineHeight.normal (1.4),
  // 4px below the input — MOBILE-PATTERNS.md "Error States → Inline Errors".
  const subTextLineHeight =
    theme.typography.fontSize.sm * theme.typography.lineHeight.normal;

  const helperTextStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.body,
    fontSize: theme.typography.fontSize.sm,
    lineHeight: subTextLineHeight,
    // textSecondary, not textTertiary: the helper carries a load-bearing rule
    // at 11px, and textTertiary is placeholder-grade contrast.
    color: theme.colors.textSecondary,
    marginTop: theme.spacing.xs,
  };

  const errorTextStyle: TextStyle = {
    ...helperTextStyle,
    color: theme.colors.error,
  };

  // Reserve two lines when a persistent helper is present so swapping the
  // helper for a shorter error message does not reflow the fields below.
  const subTextSlotStyle: ViewStyle = {
    minHeight:
      helperText != null && helperText.length > 0
        ? theme.spacing.xs + subTextLineHeight * 2
        : undefined,
  };

  return (
    <View style={containerStyle}>
      <Text style={labelStyle}>{label}</Text>
      <View style={inputContainerStyle}>
        <RNTextInput
          style={[inputStyle, { flex: 1 }]}
          value={value}
          onChangeText={onChangeText}
          secureTextEntry={hidden}
          autoCapitalize={autoCapitalize}
          autoCorrect={autoCorrect}
          keyboardType={keyboardType}
          textContentType={textContentType}
          maxLength={maxLength}
          placeholder={placeholder}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          placeholderTextColor={theme.colors.textTertiary}
          accessibilityLabel={label}
          accessibilityHint={(hasError ? error : helperText) ?? undefined}
          testID={testID}
        />
        {secureTextEntry && (
          <TouchableOpacity
            onPress={() => setHidden(h => !h)}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            accessibilityLabel={hidden ? 'Show password' : 'Hide password'}
            accessibilityRole="button"
          >
            <Text style={toggleStyle}>{hidden ? 'Show' : 'Hide'}</Text>
          </TouchableOpacity>
        )}
      </View>
      {hasSlot && (
        <View style={subTextSlotStyle}>
          {hasError ? (
            <Text
              style={errorTextStyle}
              testID={testID != null ? `${testID}-error` : undefined}
              accessibilityLiveRegion="polite"
            >
              {error}
            </Text>
          ) : (
            <Text
              style={helperTextStyle}
              testID={testID != null ? `${testID}-helper` : undefined}
            >
              {helperText}
            </Text>
          )}
        </View>
      )}
    </View>
  );
}
