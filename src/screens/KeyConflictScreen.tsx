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
 *
 * EMAIL RULING tier 3: when the service cannot resolve the email automatically,
 * the screen shows an editable email field for manual entry.
 */

import React, { useCallback, useEffect, useState } from 'react';
import {
  ScrollView,
  Text,
  TextInput,
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
  const { conflictSource, email: sliceEmail, keyRecoveryError } = useAuth();

  const [passwordModalVisible, setPasswordModalVisible] = useState(false);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [logoutLoading, setLogoutLoading] = useState(false);
  // EMAIL RULING tier 3: editable email field shown when auto-resolution fails
  const [needsManualEmail, setNeedsManualEmail] = useState(false);
  const [manualEmail, setManualEmail] = useState(sliceEmail ?? '');

  // Seed error UI from the store on mount — handles the case where the screen
  // was unmounted during recovery (LoadingView) and remounts with a stale error.
  useEffect(() => {
    if (!keyRecoveryError) return;
    switch (keyRecoveryError.status) {
      case 'incorrect_password':
        setError('Incorrect password — please try again');
        break;
      case 'rate_limited':
        setError('Too many attempts — please wait about 15 minutes and try again');
        break;
      case 'needs_email':
        // Panel amendment: also initialize needsManualEmail so the TextInput renders.
        setNeedsManualEmail(true);
        setError(keyRecoveryError.message ?? 'Unable to determine account email for re-login');
        break;
      case 'error':
        setError(keyRecoveryError.message ?? 'Recovery failed');
        break;
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps — mount-only seed

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

    const emailOverride = needsManualEmail ? manualEmail.trim() : undefined;
    const result = await recoverIdentityKeys(password, skipServerReset, emailOverride);

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
      case 'needs_email':
        // Auto-resolution failed — show editable email field
        setPasswordModalVisible(false);
        setNeedsManualEmail(true);
        break;
      case 'error':
        setPasswordModalVisible(false);
        setError(result.message);
        break;
    }
  }, [skipServerReset, needsManualEmail, manualEmail]);

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

  const emailInputStyle: TextStyle = {
    borderWidth: 1,
    borderColor: theme.colors.borderSubtle,
    borderRadius: theme.borderRadius.base,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
    fontFamily: theme.typography.fontFamily.body,
    fontSize: theme.typography.fontSize.base,
    color: theme.colors.textPrimary,
    marginBottom: theme.spacing.md,
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

        <Text style={bodyStyle} testID="key-conflict-description">{description}</Text>

        <View>
          <ErrorBanner message={error} />

          {needsManualEmail && (
            <TextInput
              style={emailInputStyle}
              value={manualEmail}
              onChangeText={setManualEmail}
              placeholder="Email address"
              placeholderTextColor={theme.colors.textTertiary}
              keyboardType="email-address"
              autoCapitalize="none"
              autoCorrect={false}
              testID="key-conflict-email-input"
            />
          )}

          <Button
            title="Recover my encryption keys"
            onPress={handleRecover}
            disabled={needsManualEmail && !manualEmail.trim()}
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
