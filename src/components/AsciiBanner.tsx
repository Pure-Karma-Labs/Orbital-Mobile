import React from 'react';
import { Text, View, type TextStyle, type ViewStyle } from 'react-native';
import { useTheme } from '../theme';

export interface AsciiBannerProps {
  text?: string;
}

export function AsciiBanner({ text = 'Welcome to Orbital!' }: AsciiBannerProps): React.JSX.Element {
  const theme = useTheme();

  const pad = 2;
  const inner = text.length + pad * 2;
  const top = `╔${'═'.repeat(inner)}╗`;
  const mid = `║${' '.repeat(pad)}${text}${' '.repeat(pad)}║`;
  const bot = `╚${'═'.repeat(inner)}╝`;

  const containerStyle: ViewStyle = {
    alignItems: 'center',
    paddingVertical: theme.spacing.sm,
  };

  const textStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.mono,
    fontSize: theme.typography.fontSize.sm,
    color: theme.colors.blue,
    lineHeight: theme.typography.fontSize.sm * theme.typography.lineHeight.normal,
  };

  return (
    <View style={containerStyle}>
      <Text style={textStyle}>{top}</Text>
      <Text style={textStyle}>{mid}</Text>
      <Text style={textStyle}>{bot}</Text>
    </View>
  );
}
