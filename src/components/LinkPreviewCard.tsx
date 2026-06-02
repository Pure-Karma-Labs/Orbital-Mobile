import React, { useState } from 'react';
import {
  Image,
  Linking,
  Text,
  TouchableOpacity,
  View,
  type ImageStyle,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { useTheme } from '../theme';
import { useLinkPreview } from '../hooks/useLinkPreview';

interface LinkPreviewCardProps {
  text: string | null;
  debounceMs?: number;
  dismissible?: boolean;
  onDismiss?: () => void;
}

export function LinkPreviewCard({
  text,
  debounceMs,
  dismissible,
  onDismiss,
}: LinkPreviewCardProps): React.JSX.Element | null {
  const theme = useTheme();
  const { preview, loading } = useLinkPreview(text, { debounceMs });
  const [dismissed, setDismissed] = useState(false);
  const [imageError, setImageError] = useState(false);

  if (dismissed) return null;
  if (!loading && !preview) return null;

  // Loading skeleton
  if (loading && !preview) {
    const skeletonStyle: ViewStyle = {
      height: 72,
      borderRadius: theme.borderRadius.base,
      backgroundColor: theme.colors.surface,
      marginTop: theme.spacing.sm,
    };
    return <View style={skeletonStyle} testID="link-preview-skeleton" />;
  }

  if (!preview) return null;

  let domain = '';
  try {
    domain = new URL(preview.url).hostname.replace(/^www\./, '');
  } catch { /* ignore */ }

  const handlePress = () => {
    Linking.openURL(preview.url).catch(() => {});
  };

  const handleDismiss = () => {
    setDismissed(true);
    onDismiss?.();
  };

  const containerStyle: ViewStyle = {
    flexDirection: 'row',
    borderWidth: 1,
    borderColor: theme.colors.borderSubtle,
    borderRadius: theme.borderRadius.base,
    overflow: 'hidden',
    marginTop: theme.spacing.sm,
  };

  const imageStyle: ImageStyle = {
    width: 80,
    height: 80,
  };

  const contentStyle: ViewStyle = {
    flex: 1,
    padding: theme.spacing.sm,
    justifyContent: 'center',
  };

  const titleStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.bodyBold,
    fontSize: theme.typography.fontSize.base,
    color: theme.colors.textPrimary,
  };

  const descriptionStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.body,
    fontSize: theme.typography.fontSize.sm,
    color: theme.colors.textSecondary,
    marginTop: 2,
  };

  const domainStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.mono,
    fontSize: theme.typography.fontSize.xs,
    color: theme.colors.textTertiary,
    marginTop: 2,
  };

  const dismissStyle: ViewStyle = {
    position: 'absolute',
    top: 4,
    right: 4,
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: theme.colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  };

  const dismissTextStyle: TextStyle = {
    fontSize: 12,
    color: theme.colors.textTertiary,
    fontFamily: theme.typography.fontFamily.mono,
  };

  return (
    <TouchableOpacity
      style={containerStyle}
      onPress={handlePress}
      activeOpacity={0.7}
      accessibilityRole="link"
      accessibilityLabel={`Link preview: ${preview.title ?? domain}`}
      testID="link-preview-card"
    >
      {preview.imageUrl && !imageError && (
        <Image
          source={{ uri: preview.imageUrl }}
          style={imageStyle}
          resizeMode="cover"
          onError={() => setImageError(true)}
          testID="link-preview-image"
        />
      )}
      <View style={contentStyle}>
        {preview.title && (
          <Text style={titleStyle} numberOfLines={1} testID="link-preview-title">
            {preview.title}
          </Text>
        )}
        {preview.description && (
          <Text style={descriptionStyle} numberOfLines={2}>
            {preview.description}
          </Text>
        )}
        {domain && (
          <Text style={domainStyle} numberOfLines={1}>
            {domain}
          </Text>
        )}
      </View>
      {dismissible && (
        <TouchableOpacity
          style={dismissStyle}
          onPress={handleDismiss}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          accessibilityLabel="Dismiss preview"
          testID="link-preview-dismiss"
        >
          <Text style={dismissTextStyle}>{'×'}</Text>
        </TouchableOpacity>
      )}
    </TouchableOpacity>
  );
}
