/**
 * KeyConflictScreen — post-auth blocking gate for identity key conflicts.
 *
 * Shown when identityKeyConflict is true in the auth store (409 from key upload
 * or identity_key_reset push). The screen never manually navigates — the gate
 * unmounts reactively when recoverIdentityKeys() clears the conflict flag on
 * successful recovery.
 *
 * Copy is conflictSource-aware (SEC-H2):
 * - 'push': "Your encryption keys were reset from another device..."
 * - 'local': "Enter your password to reset your encryption keys."
 */

import React, { useCallback, useState } from 'react';
import {
  ScrollView,
  Text,
  TouchableOpacity,
  View,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../theme';
import { Button, ErrorBanner, OrbitalLoader, AsciiBanner } from '../components';
import { PasswordConfirmModal } from './settings/PasswordConfirmModal';
import { recoverIdentityKeys } from '../services/keyRecoveryService';
import { logout } from '../services/authService';
import { useAuth } from '../stores';

export function KeyConflictScreen(): React.JSX.Element {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { conflictSource } = useAuth();

  const [passwordModalVisible, setPasswordModalVisible] = useState(false);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [logoutLoading, setLogoutLoading] = useState(false);

  const isPush = conflictSource === 'push';
  const skipServerReset = isPush;

  const handleRecover = useCallback(() => {
    setPasswordError(null);
    setError(null);
    setPasswordModalVisible(true);
  }, []);

  const handlePasswordSubmit = useCallback(async (password: string) => {
    setPasswordError(null);
    setError(null);

    const result = await recoverIdentityKeys(password, skipServerReset);

    switch (result.status) {
      case 'success':
        // Gate unmounts reactively — no manual navigation.
        setPasswordModalVisible(false);
        break;
      case 'incorrect_password':
        setPasswordError('Incorrect password');
        break;
      case 'rate_limited':
        setPasswordError('Too many attempts — please wait a few minutes');
        break;
      case 'error':
        setPasswordModalVisible(false);
        setError(result.message);
        break;
    }
  }, [skipServerReset]);

  const handlePasswordCancel = useCallback(() => {
    setPasswordModalVisible(false);
    setPasswordError(null);
  }, []);

  const handleLogout = useCallback(async () => {
    setLogoutLoading(true);
    try {
      await logout();
    } catch {
      // Best-effort
    } finally {
      setLogoutLoading(false);
    }
  }, []);

  const outerStyle: ViewStyle = {
    flex: 1,
    backgroundColor: theme.colors.background,
  };

  const scrollContentStyle: ViewStyle = {
    flexGrow: 1,
    justifyContent: 'center',
    paddingHorizontal: theme.spacing.lg,
    paddingTop: Math.max(insets.top, theme.spacing.xl),
    paddingBottom: 300,
  };

  const titleStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.header,
    fontSize: theme.typography.fontSize['2xl'],
    color: theme.colors.blue,
    textAlign: 'center',
    marginBottom: theme.spacing.xs,
  };

  const bodyStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.body,
    fontSize: theme.typography.fontSize.base,
    color: theme.colors.textSecondary,
    textAlign: 'center',
    lineHeight: theme.typography.fontSize.base * theme.typography.lineHeight.relaxed,
    marginTop: theme.spacing.md,
    marginBottom: theme.spacing.base,
  };

  const logoutLinkStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.body,
    fontSize: theme.typography.fontSize.base,
    color: theme.colors.textSecondary,
    textAlign: 'center',
    textDecorationLine: 'underline',
    marginTop: theme.spacing.base,
  };

  // SEC-H2: conflictSource-aware copy
  const description = isPush
    ? 'Your encryption keys were reset from another device. Enter your password to re-establish your session.'
    : 'Enter your password to reset your encryption keys.';

  return (
    <View style={outerStyle} testID="key-conflict-screen">
      <ScrollView
        contentContainerStyle={scrollContentStyle}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
      >
        <View style={{ marginBottom: theme.spacing.lg }}>
          <OrbitalLoader size={64} />
        </View>
        <Text style={titleStyle}>Orbital</Text>
        <AsciiBanner text="Encryption key conflict" />

        <Text style={bodyStyle}>{description}</Text>

        <View>
          <ErrorBanner message={error} />

          <Button
            title="Recover my encryption keys"
            onPress={handleRecover}
            testID="key-conflict-recover-button"
          />
        </View>

        <TouchableOpacity
          onPress={handleLogout}
          disabled={logoutLoading}
          accessibilityRole="button"
          accessibilityLabel="Log out"
          testID="key-conflict-logout"
        >
          <Text style={logoutLinkStyle}>
            {logoutLoading ? 'Logging out...' : 'Log out'}
          </Text>
        </TouchableOpacity>
      </ScrollView>

      <PasswordConfirmModal
        visible={passwordModalVisible}
        onCancel={handlePasswordCancel}
        onSubmit={handlePasswordSubmit}
        errorMessage={passwordError}
        title="Recover Encryption Keys"
        description={description}
        submitLabel="Recover"
        testIDPrefix="key-recovery-password"
      />
    </View>
  );
}
