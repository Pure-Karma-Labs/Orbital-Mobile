import React from 'react';
import { Text, type TextStyle, type ViewStyle } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTheme } from '../theme';

export function ChatsScreen(): React.JSX.Element {
  const theme = useTheme();

  const containerStyle: ViewStyle = {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.colors.background,
    padding: theme.spacing.lg,
  };

  const titleStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.header,
    fontSize: theme.typography.fontSize.xl,
    color: theme.colors.textPrimary,
    marginBottom: theme.spacing.sm,
  };

  const subtitleStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.body,
    fontSize: theme.typography.fontSize.base,
    color: theme.colors.textSecondary,
  };

  return (
    <SafeAreaView style={containerStyle} testID="chats-screen">
      <Text style={titleStyle}>Chats</Text>
      <Text style={subtitleStyle}>Coming soon</Text>
    </SafeAreaView>
  );
}

export default ChatsScreen;
