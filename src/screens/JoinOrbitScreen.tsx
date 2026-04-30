/**
 * Join Orbit screen — enter an invite code to join an existing orbit.
 * Presented as a modal from the Threads tab.
 */

import React, { useCallback, useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Text,
  View,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useTheme } from '../theme';
import { TextInput } from '../components/TextInput';
import { Button } from '../components/Button';
import { Header } from '../components/Header';
import { joinOrbit } from '../services/conversationService';
import type { ThreadsStackParamList } from '../navigation/types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type JoinOrbitScreenProps = NativeStackScreenProps<
  ThreadsStackParamList,
  'JoinOrbit'
>;

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

export function JoinOrbitScreen({
  navigation,
}: JoinOrbitScreenProps): React.JSX.Element {
  const theme = useTheme();
  const insets = useSafeAreaInsets();

  const [code, setCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmedCode = code.trim();
  const isValid = trimmedCode.length > 0;

  const handleJoin = useCallback(async () => {
    if (!isValid || loading) {
      return;
    }
    setError(null);
    setLoading(true);
    try {
      await joinOrbit(trimmedCode);
      navigation.goBack();
    } catch {
      setError('Invalid or expired invite code');
    } finally {
      setLoading(false);
    }
  }, [isValid, loading, trimmedCode, navigation]);

  const handleBack = useCallback(() => {
    navigation.goBack();
  }, [navigation]);

  // ---------------------------------------------------------------------------
  // Styles
  // ---------------------------------------------------------------------------

  const containerStyle: ViewStyle = {
    flex: 1,
    backgroundColor: theme.colors.background,
    paddingTop: insets.top,
  };

  const contentStyle: ViewStyle = {
    flex: 1,
    paddingHorizontal: theme.spacing.base,
    paddingTop: theme.spacing.lg,
  };

  const errorStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.body,
    fontSize: theme.typography.fontSize.sm,
    color: theme.colors.error,
    marginBottom: theme.spacing.md,
  };

  return (
    <View style={containerStyle} testID="join-orbit-screen">
      <Header
        title="Join an Orbit"
        onBack={handleBack}
        backLabel="Back"
      />
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <View style={contentStyle}>
          <TextInput
            label="Invite Code"
            value={code}
            onChangeText={setCode}
            autoCapitalize="characters"
            autoCorrect={false}
            maxLength={8}
            testID="invite-code-input"
          />

          {error != null && <Text style={errorStyle}>{error}</Text>}

          <Button
            title="Join"
            onPress={handleJoin}
            loading={loading}
            disabled={!isValid}
            variant="primary"
            testID="join-orbit-button"
          />
        </View>
      </KeyboardAvoidingView>
    </View>
  );
}

export default JoinOrbitScreen;
