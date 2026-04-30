/**
 * Onboarding empty state — shown when the user has no active conversation.
 * Centered welcome message with buttons to create or join an orbit.
 */

import React from 'react';
import { Text, View, type TextStyle, type ViewStyle } from 'react-native';
import { useTheme } from '../../theme';
import { Button } from '../../components/Button';

export interface OnboardingEmptyStateProps {
  onCreateOrbit: () => void;
  onJoinOrbit: () => void;
}

export function OnboardingEmptyState({
  onCreateOrbit,
  onJoinOrbit,
}: OnboardingEmptyStateProps): React.JSX.Element {
  const theme = useTheme();

  const containerStyle: ViewStyle = {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: theme.spacing.xl,
  };

  const titleStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.header,
    fontSize: theme.typography.fontSize.xl,
    color: theme.colors.textPrimary,
    textAlign: 'center',
    marginBottom: theme.spacing.sm,
  };

  const subtitleStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.body,
    fontSize: theme.typography.fontSize.base,
    color: theme.colors.textSecondary,
    textAlign: 'center',
    marginBottom: theme.spacing.xl,
  };

  const buttonGapStyle: ViewStyle = {
    width: '100%',
    maxWidth: 280,
    gap: theme.spacing.md,
  };

  return (
    <View style={containerStyle} testID="onboarding-empty-state">
      <Text style={titleStyle}>Welcome to Orbital</Text>
      <Text style={subtitleStyle}>
        Create or join an orbit to get started
      </Text>
      <View style={buttonGapStyle}>
        <Button
          title="Create an Orbit"
          onPress={onCreateOrbit}
          variant="primary"
          testID="onboarding-create-orbit"
        />
        <Button
          title="Join an Orbit"
          onPress={onJoinOrbit}
          variant="secondary"
          testID="onboarding-join-orbit"
        />
      </View>
    </View>
  );
}
