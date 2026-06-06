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
import { OrbitalSpinner } from './OrbitalSpinner';

interface LinkPreviewCardProps {
  text: string | null;
  debounceMs?: number;
  dismissible?: boolean;
  onDismiss?: () => void;
}


// ---------------------------------------------------------------------------
// Private child component — keyed by URI so React resets state on URL change
// ---------------------------------------------------------------------------

function LinkPreviewImage({ uri, theme }: { uri: string; theme: ReturnType<typeof useTheme> }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  if (error) return null; // collapse — parent layout adapts via flex

  const containerStyle: ViewStyle = {
    width: 80,
    height: 80,
  };

  const overlayStyle: ViewStyle = {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: theme.colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  };

  const imgStyle: ImageStyle = {
    width: 80,
    height: 80,
  };

  return (
    <View style={containerStyle} testID="link-preview-image-container">
      <Image
        source={{ uri }}
        style={imgStyle}
        resizeMode="cover"
        onLoad={() => setLoading(false)}
        onError={() => { setLoading(false); setError(true); }}
        testID="link-preview-image"
      />
      {loading && (
        <View style={overlayStyle} testID="link-preview-image-loading">
          <OrbitalSpinner size={24} />
        </View>
      )}
    </View>
  );
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
      {preview.imageUrl && (
        <LinkPreviewImage key={preview.imageUrl} uri={preview.imageUrl} theme={theme} />
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
