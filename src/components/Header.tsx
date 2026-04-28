/**
 * Stack navigation header with back button, centered title, right action slot.
 */

import React from 'react';
import {
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { useTheme } from '../theme';

export interface HeaderProps {
  title?: string;
  onBack?: () => void;
  backLabel?: string;
  right?: React.ReactNode;
  border?: boolean;
}

export function Header({
  title,
  onBack,
  backLabel = 'Back',
  right,
  border = true,
}: HeaderProps): React.JSX.Element {
  const theme = useTheme();

  const containerStyle: ViewStyle = {
    height: 44,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: theme.colors.surface,
    borderBottomWidth: border ? StyleSheet.hairlineWidth : 0,
    borderBottomColor: theme.colors.borderSubtle,
  };

  const sideStyle: ViewStyle = {
    width: 88,
    alignItems: 'flex-start',
    justifyContent: 'center',
    paddingHorizontal: theme.spacing.sm,
  };

  const rightSideStyle: ViewStyle = {
    ...sideStyle,
    alignItems: 'flex-end',
  };

  const titleStyle: TextStyle = {
    flex: 1,
    fontFamily: theme.typography.fontFamily.bodyBold,
    fontSize: theme.typography.fontSize.lg,
    color: theme.colors.textPrimary,
    textAlign: 'center',
  };

  const backTextStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.body,
    fontSize: theme.typography.fontSize.base,
    color: theme.colors.blue,
  };

  return (
    <View style={containerStyle}>
      <View style={sideStyle}>
        {onBack ? (
          <TouchableOpacity
            onPress={onBack}
            style={styles.backTouchTarget}
            accessibilityRole="button"
            accessibilityLabel={`Go back${backLabel !== 'Back' ? ` to ${backLabel}` : ''}`}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <Text style={backTextStyle}>{`‹ ${backLabel}`}</Text>
          </TouchableOpacity>
        ) : null}
      </View>

      <Text style={titleStyle} numberOfLines={1}>
        {title ?? ''}
      </Text>

      <View style={rightSideStyle}>{right ?? null}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  backTouchTarget: {
    minHeight: 44,
    justifyContent: 'center',
  },
});
