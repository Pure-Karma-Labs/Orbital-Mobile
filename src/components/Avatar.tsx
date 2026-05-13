/**
 * Colored circle with initial letter, optional image, and optional online presence dot.
 */

import React, { useEffect, useState } from 'react';
import { Image, StyleSheet, Text, View, type TextStyle, type ViewStyle } from 'react-native';
import { useTheme } from '../theme';

export interface AvatarProps {
  name: string;
  size?: number;
  color?: string;
  online?: boolean;
  /** Full HTTPS image URL. When provided and loadable, renders the image instead of initials. */
  imageUrl?: string | null;
}

export function Avatar({
  name,
  size = 36,
  color,
  online,
  imageUrl,
}: AvatarProps): React.JSX.Element {
  const theme = useTheme();
  const bgColor = color ?? theme.colors.blue;
  const initial = (name || '?').slice(0, 1).toUpperCase();
  const [imageError, setImageError] = useState(false);

  useEffect(() => {
    setImageError(false);
  }, [imageUrl]);

  const showImage = !!imageUrl && !imageError;

  const containerStyle: ViewStyle = {
    width: size,
    height: size,
    borderRadius: 9999,
    backgroundColor: bgColor,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  };

  const initialStyle: TextStyle = {
    fontSize: Math.round(size * 0.42),
    color: '#FFFFFF',
    fontFamily: theme.typography.fontFamily.bodyBold,
    lineHeight: size,
    textAlign: 'center',
  };

  const dotSize = 8;
  const presenceDotStyle: ViewStyle = {
    position: 'absolute',
    bottom: 0,
    right: 0,
    width: dotSize,
    height: dotSize,
    borderRadius: 9999,
    backgroundColor: online ? theme.colors.yellow : theme.colors.textTertiary,
    borderWidth: 1,
    borderColor: theme.colors.surfaceElevated,
  };

  return (
    <View style={containerStyle}>
      {showImage ? (
        <Image
          source={{ uri: imageUrl }}
          style={{ width: size, height: size }}
          onError={() => setImageError(true)}
          accessibilityLabel={`${name} avatar`}
        />
      ) : (
        <Text style={initialStyle} allowFontScaling={false}>
          {initial}
        </Text>
      )}
      {online != null && <View style={presenceDotStyle} />}
    </View>
  );
}

const _styles = StyleSheet.create({});
void _styles;
