/**
 * Create Orbit screen — simple form to create a new orbit (group).
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
import { createOrbit } from '../services/conversationService';
import type { ThreadsStackParamList } from '../navigation/types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CreateOrbitScreenProps = NativeStackScreenProps<
  ThreadsStackParamList,
  'CreateOrbit'
>;

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

export function CreateOrbitScreen({
  navigation,
}: CreateOrbitScreenProps): React.JSX.Element {
  const theme = useTheme();
  const insets = useSafeAreaInsets();

  const [name, setName] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmedName = name.trim();
  const isValid = trimmedName.length >= 1 && trimmedName.length <= 50;

  const handleCreate = useCallback(async () => {
    if (!isValid || loading) {
      return;
    }
    setError(null);
    setLoading(true);
    try {
      await createOrbit(trimmedName);
      navigation.goBack();
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Failed to create orbit';
      setError(message);
    } finally {
      setLoading(false);
    }
  }, [isValid, loading, trimmedName, navigation]);

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
    <View style={containerStyle} testID="create-orbit-screen">
      <Header
        title="Create an Orbit"
        onBack={handleBack}
        backLabel="Back"
      />
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <View style={contentStyle}>
          <TextInput
            label="Orbit Name"
            value={name}
            onChangeText={setName}
            autoCapitalize="sentences"
            autoCorrect={false}
            maxLength={50}
            testID="orbit-name-input"
          />

          {error != null && <Text style={errorStyle}>{error}</Text>}

          <Button
            title="Create"
            onPress={handleCreate}
            loading={loading}
            disabled={!isValid}
            variant="primary"
            testID="create-orbit-button"
          />
        </View>
      </KeyboardAvoidingView>
    </View>
  );
}

export default CreateOrbitScreen;
