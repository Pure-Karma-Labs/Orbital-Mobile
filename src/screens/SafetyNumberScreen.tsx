/**
 * Safety Number screen — modal displaying the safety number fingerprint
 * for identity verification between two users.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Text,
  TouchableOpacity,
  View,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useTheme } from '../theme';
import { useAuth } from '../stores';
import type { ChatsStackParamList } from '../navigation/types';
import { VerifiedStatus } from '../types/database';
import { getIdentityKeyPair } from '../services/crypto/identityKeyAccess';
import { getIdentityKey } from '../database/repositories/signalIdentityKeyRepository';
import { computeSafetyNumber } from '../services/crypto/safetyNumber';
import { markContactVerified } from '../services/verificationService';
import { Header } from '../components/Header';

export type SafetyNumberScreenProps = NativeStackScreenProps<
  ChatsStackParamList,
  'SafetyNumber'
>;

export function SafetyNumberScreen({
  route,
  navigation,
}: SafetyNumberScreenProps): React.JSX.Element {
  const theme = useTheme();
  const { contactId, contactName } = route.params;
  const { userId } = useAuth();
  const [verified, setVerified] = useState(false);

  // Compute safety number
  const safetyNumber = useMemo((): string | null => {
    if (!userId) return null;
    try {
      const { publicKey } = getIdentityKeyPair();
      const localKey = new Uint8Array(publicKey);

      const remoteRow = getIdentityKey(contactId);
      if (!remoteRow) return null;
      const remoteKey = new Uint8Array(remoteRow.identity_key);

      return computeSafetyNumber(userId, localKey, contactId, remoteKey);
    } catch {
      return null;
    }
  }, [userId, contactId]);

  // Check current verified status
  useEffect(() => {
    const row = getIdentityKey(contactId);
    if (row && row.verified === VerifiedStatus.Verified) {
      setVerified(true);
    }
  }, [contactId]);

  const handleVerify = useCallback(() => {
    markContactVerified(contactId);
    setVerified(true);
  }, [contactId]);

  const handleDismiss = useCallback(() => {
    navigation.goBack();
  }, [navigation]);

  const containerStyle: ViewStyle = {
    flex: 1,
    backgroundColor: theme.colors.background,
  };

  const contentStyle: ViewStyle = {
    flex: 1,
    padding: theme.spacing.xl,
    alignItems: 'center',
    justifyContent: 'center',
  };

  const labelStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.body,
    fontSize: theme.typography.fontSize.base,
    color: theme.colors.textSecondary,
    textAlign: 'center',
    marginBottom: theme.spacing.lg,
  };

  const safetyNumberStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.mono,
    fontSize: theme.typography.fontSize.xl,
    color: theme.colors.textPrimary,
    textAlign: 'center',
    letterSpacing: 2,
    lineHeight: 32,
    marginBottom: theme.spacing.xl,
  };

  const noKeyStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.body,
    fontSize: theme.typography.fontSize.base,
    color: theme.colors.textTertiary,
    textAlign: 'center',
  };

  const verifiedBadgeStyle: ViewStyle = {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(72, 187, 120, 0.12)',
    paddingHorizontal: theme.spacing.base,
    paddingVertical: theme.spacing.sm,
    borderRadius: theme.borderRadius.base,
    marginBottom: theme.spacing.base,
  };

  const verifiedTextStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.bodyBold,
    fontSize: theme.typography.fontSize.sm,
    color: theme.colors.success,
  };

  const verifyButtonStyle: ViewStyle = {
    backgroundColor: theme.colors.blue,
    paddingHorizontal: theme.spacing.xl,
    paddingVertical: theme.spacing.sm,
    borderRadius: theme.borderRadius.base,
    marginBottom: theme.spacing.base,
    width: '100%',
    alignItems: 'center',
  };

  const verifyButtonTextStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.bodyBold,
    fontSize: theme.typography.fontSize.base,
    color: '#FFFFFF',
  };

  const dismissButtonStyle: ViewStyle = {
    paddingHorizontal: theme.spacing.xl,
    paddingVertical: theme.spacing.sm,
    width: '100%',
    alignItems: 'center',
  };

  const dismissButtonTextStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.body,
    fontSize: theme.typography.fontSize.base,
    color: theme.colors.textSecondary,
  };

  return (
    <SafeAreaView style={containerStyle} edges={['top', 'bottom']} testID="safety-number-screen">
      <Header
        title="Safety Number"
        onBack={handleDismiss}
      />
      <View style={contentStyle}>
        <Text style={labelStyle}>
          Verify the safety number with {contactName} to confirm the security
          of your end-to-end encrypted conversation.
        </Text>

        {safetyNumber ? (
          <Text style={safetyNumberStyle} testID="safety-number-display" selectable>
            {safetyNumber}
          </Text>
        ) : (
          <Text style={noKeyStyle}>
            No identity key available for this contact.
          </Text>
        )}

        {verified ? (
          <View style={verifiedBadgeStyle} testID="verified-badge">
            <Text style={verifiedTextStyle}>Verified</Text>
          </View>
        ) : safetyNumber ? (
          <TouchableOpacity
            style={verifyButtonStyle}
            onPress={handleVerify}
            accessibilityRole="button"
            accessibilityLabel="Mark as verified"
            testID="verify-button"
          >
            <Text style={verifyButtonTextStyle}>Mark as Verified</Text>
          </TouchableOpacity>
        ) : null}

        <TouchableOpacity
          style={dismissButtonStyle}
          onPress={handleDismiss}
          accessibilityRole="button"
          accessibilityLabel="Dismiss"
          testID="dismiss-button"
        >
          <Text style={dismissButtonTextStyle}>Dismiss</Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}
