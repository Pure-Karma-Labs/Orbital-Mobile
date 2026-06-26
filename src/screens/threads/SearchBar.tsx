/**
 * Thread/DM search bar — functional TextInput with debounced filtering.
 * Shared by ThreadsScreen and ChatsListScreen.
 */

import React, { useState } from 'react';
import {
  Keyboard,
  Text,
  TextInput,
  TouchableOpacity,
  View,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { useTheme } from '../../theme';
import { Emoji } from '../../components/Emoji';

export interface SearchBarProps {
  value: string;
  onChangeText: (text: string) => void;
  placeholder?: string;
  onClear?: () => void;
  testID?: string;
}

export function SearchBar({
  value,
  onChangeText,
  placeholder = 'Search...',
  onClear,
  testID,
}: SearchBarProps): React.JSX.Element {
  const theme = useTheme();
  const [focused, setFocused] = useState(false);

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
    borderColor: focused ? theme.colors.blue : theme.colors.borderSubtle,
    borderRadius: theme.borderRadius.base,
    paddingHorizontal: theme.spacing.sm,
    gap: theme.spacing.xs,
  };

  const inputStyle: TextStyle = {
    flex: 1,
    fontFamily: theme.typography.fontFamily.body,
    fontSize: theme.typography.fontSize.base,
    color: theme.colors.textPrimary,
    padding: 0,
  };

  const clearTextStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.body,
    fontSize: theme.typography.fontSize.base,
    color: theme.colors.textTertiary,
    lineHeight: 20,
  };

  return (
    <View style={wrapperStyle} accessibilityRole="search" testID={testID}>
      <View style={containerStyle}>
        <Emoji unified="1F50D" size={16} />
        <TextInput
          style={inputStyle}
          value={value}
          onChangeText={onChangeText}
          placeholder={placeholder}
          placeholderTextColor={theme.colors.textTertiary}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          autoCorrect={false}
          autoCapitalize="none"
          autoComplete="off"
          spellCheck={false}
          textContentType="none"
          importantForAutofill="no"
          returnKeyType="search"
          maxLength={200}
          onSubmitEditing={() => Keyboard.dismiss()}
          testID={testID ? `${testID}-input` : undefined}
        />
        {value.length > 0 && (
          <TouchableOpacity
            onPress={onClear}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            accessibilityLabel="Clear search"
          >
            <Text style={clearTextStyle}>{'✕'}</Text>
          </TouchableOpacity>
        )}
      </View>
    </View>
  );
}
