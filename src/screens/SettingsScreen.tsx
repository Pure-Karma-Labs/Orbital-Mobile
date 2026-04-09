import React from 'react';
import {
  Text,
  TouchableOpacity,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTheme } from '../theme';
import { useAuth } from '../stores';
import { logout } from '../services/authService';

export function SettingsScreen(): React.JSX.Element {
  const theme = useTheme();
  const { displayName, username } = useAuth();
  const name = displayName ?? username ?? 'there';

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

  const userStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.body,
    fontSize: theme.typography.fontSize.base,
    color: theme.colors.textSecondary,
    marginBottom: theme.spacing.lg,
  };

  const logoutStyle: ViewStyle = {
    backgroundColor: theme.colors.blue,
    paddingVertical: theme.spacing.sm,
    paddingHorizontal: theme.spacing.lg,
    borderRadius: theme.borderRadius.base,
  };

  const logoutTextStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.bodyBold,
    fontSize: theme.typography.fontSize.base,
    color: '#FFFFFF',
  };

  async function handleLogout(): Promise<void> {
    await logout();
  }

  return (
    <SafeAreaView style={containerStyle} testID="settings-screen">
      <Text style={titleStyle}>Settings</Text>
      <Text style={userStyle}>{name}</Text>
      <TouchableOpacity
        style={logoutStyle}
        onPress={handleLogout}
        accessibilityRole="button"
        accessibilityLabel="Log out"
        testID="logout-button"
      >
        <Text style={logoutTextStyle}>Log Out</Text>
      </TouchableOpacity>
    </SafeAreaView>
  );
}

export default SettingsScreen;
