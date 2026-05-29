/**
 * Identity change warning banner — shown when a DM contact's identity key
 * has changed and is not yet verified.
 */

import React from 'react';
import {
  Text,
  TouchableOpacity,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { useTheme } from '../theme';

export interface IdentityChangeBannerProps {
  contactName: string;
  onPress: () => void;
}

export function IdentityChangeBanner({
  contactName,
  onPress,
}: IdentityChangeBannerProps): React.JSX.Element {
  const theme = useTheme();

  const containerStyle: ViewStyle = {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: theme.colors.yellowTint,
    borderLeftWidth: 3,
    borderLeftColor: theme.colors.warning,
    paddingHorizontal: theme.spacing.base,
    paddingVertical: theme.spacing.sm,
    marginHorizontal: theme.spacing.base,
    marginVertical: theme.spacing.xs,
    borderRadius: theme.borderRadius.base,
  };

  const textStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.body,
    fontSize: theme.typography.fontSize.sm,
    color: theme.colors.textPrimary,
    flex: 1,
  };

  return (
    <TouchableOpacity
      style={containerStyle}
      onPress={onPress}
      activeOpacity={0.7}
      accessibilityRole="button"
      accessibilityLabel={`Safety number changed for ${contactName}. Tap to verify.`}
      testID="identity-change-banner"
    >
      <Text style={textStyle}>
        Safety number changed for {contactName} — tap to verify
      </Text>
    </TouchableOpacity>
  );
}
