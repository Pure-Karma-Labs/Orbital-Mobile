/**
 * TermsAcceptanceScreen — post-auth blocking gate for ToS acceptance.
 *
 * Shown when the server signals that the user has not yet accepted the
 * current terms version (needsTermsAcceptance flag in the auth store).
 * The screen never manually navigates — the gate unmounts reactively
 * when acceptCurrentTerms() clears the store flag on a 2xx response.
 *
 * Copy is deliberately generic ("Terms of Use updated") so it works for
 * both the initial gate and future version bumps.
 */

import React, { useState } from 'react';
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
import { TermsCheckbox } from '../components/TermsCheckbox';
import { acceptCurrentTerms, logout } from '../services/authService';
import { AuthError, NetworkError } from '../services/api/errors';

export function TermsAcceptanceScreen(): React.JSX.Element {
  const theme = useTheme();
  const insets = useSafeAreaInsets();

  const [checked, setChecked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [acceptLoading, setAcceptLoading] = useState(false);
  const [logoutLoading, setLogoutLoading] = useState(false);

  async function handleAccept(): Promise<void> {
    setError(null);
    setAcceptLoading(true);
    try {
      await acceptCurrentTerms();
      // Gate unmounts reactively — no manual navigation.
    } catch (e) {
      if (e instanceof AuthError) {
        // Token expired/revoked — auto-logout to prevent tokenless trap.
        try { await logout(); } catch { /* best-effort */ }
        return;
      }
      if (e instanceof NetworkError) {
        setError('Unable to connect — please check your connection and try again.');
      } else {
        setError('Something went wrong — please try again.');
      }
    } finally {
      setAcceptLoading(false);
    }
  }

  async function handleLogout(): Promise<void> {
    setLogoutLoading(true);
    try {
      await logout();
    } catch {
      // Best-effort — clearAuth/clearTokens should always succeed.
    } finally {
      setLogoutLoading(false);
    }
  }

  // ---------------------------------------------------------------------------
  // Styles — match LoginScreen conventions
  // ---------------------------------------------------------------------------

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

  return (
    <View style={outerStyle}>
      <ScrollView
        contentContainerStyle={scrollContentStyle}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
      >
        <View style={{ marginBottom: theme.spacing.lg }}>
          <OrbitalLoader size={64} />
        </View>
        <Text style={titleStyle}>Orbital</Text>
        <AsciiBanner text="Terms of Use updated" />

        <Text style={bodyStyle}>
          Please review and accept the updated Terms of Use to continue using Orbital.
        </Text>

        <View>
          <ErrorBanner message={error} />

          <TermsCheckbox
            checked={checked}
            onToggle={() => setChecked((v) => !v)}
            includePrivacyLink
            testID="gate-terms-checkbox"
          />

          <Button
            title="Accept & Continue"
            onPress={handleAccept}
            loading={acceptLoading}
            disabled={!checked}
            testID="terms-gate-accept-button"
          />
        </View>

        <TouchableOpacity
          onPress={handleLogout}
          disabled={logoutLoading}
          accessibilityRole="button"
          accessibilityLabel="Log out"
          testID="terms-gate-logout"
        >
          <Text style={logoutLinkStyle}>
            {logoutLoading ? 'Logging out...' : 'Log out'}
          </Text>
        </TouchableOpacity>
      </ScrollView>
    </View>
  );
}
