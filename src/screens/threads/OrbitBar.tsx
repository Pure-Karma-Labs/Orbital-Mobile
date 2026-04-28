/**
 * Orbit selector bar — shows the current orbit name with a dropdown indicator
 * and a compose button on the right.
 */

import React from 'react';
import {
  StyleSheet,
  Text,
  TouchableOpacity,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { useTheme } from '../../theme';

export interface OrbitBarProps {
  orbitName: string;
  onOpenOrbits: () => void;
  onCompose: () => void;
}

export function OrbitBar({
  orbitName,
  onOpenOrbits,
  onCompose,
}: OrbitBarProps): React.JSX.Element {
  const theme = useTheme();

  const containerStyle: ViewStyle = {
    flexDirection: 'row',
    alignItems: 'center',
    height: 44,
    backgroundColor: theme.colors.surface,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.borderSubtle,
    paddingHorizontal: theme.spacing.base,
  };

  const orbitNameStyle: TextStyle = {
    flex: 1,
    fontFamily: theme.typography.fontFamily.bodyBold,
    fontSize: theme.typography.fontSize.base,
    color: theme.colors.textPrimary,
  };

  const composeBtnStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.body,
    fontSize: theme.typography.fontSize.xl,
    color: theme.colors.blue,
    lineHeight: 44,
    minWidth: 44,
    textAlign: 'right',
  };

  return (
    <TouchableOpacity
      style={containerStyle}
      onPress={onOpenOrbits}
      activeOpacity={0.7}
      accessibilityRole="button"
      accessibilityLabel="Open orbit selector"
    >
      <Text style={orbitNameStyle}>{`${orbitName} ▾`}</Text>
      <TouchableOpacity
        onPress={onCompose}
        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        accessibilityRole="button"
        accessibilityLabel="New thread"
      >
        <Text style={composeBtnStyle}>+</Text>
      </TouchableOpacity>
    </TouchableOpacity>
  );
}
