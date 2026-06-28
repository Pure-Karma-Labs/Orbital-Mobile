/**
 * Colored circle with initial letter, optional image, and optional online presence dot.
 *
 * Supports both encrypted avatars (resolved via avatarService) and legacy
 * plaintext HTTPS URLs. When encrypted avatar data is present, it takes
 * precedence over the legacy imageUrl prop.
 */

import React, { useEffect, useRef, useState } from 'react';
import { Image, Text, View, type TextStyle, type ViewStyle } from 'react-native';
import { useTheme } from '../theme';

export interface AvatarProps {
  name: string;
  size?: number;
  color?: string;
  online?: boolean;
  /** Full HTTPS image URL. When provided and loadable, renders the image instead of initials. */
  imageUrl?: string | null;
  /** User ID — required for encrypted avatar resolution */
  userId?: string | null;
  /** Group ID for group key lookup — required for other users' encrypted avatars */
  groupId?: string | null;
  /** Encrypted avatar attachment key (AES-GCM ciphertext, base64) */
  encryptedAvatarKey?: string | null;
  /** IV for avatar key decryption (base64) */
  avatarKeyIv?: string | null;
  /** SHA-256 digest of encrypted avatar blob (base64) — triggers encrypted resolution */
  avatarDigest?: string | null;
}

export const Avatar = React.memo(function Avatar({
  name,
  size = 36,
  color,
  online,
  imageUrl,
  userId,
  groupId,
  encryptedAvatarKey,
  avatarKeyIv,
  avatarDigest,
}: AvatarProps): React.JSX.Element {
  const theme = useTheme();
  const bgColor = color ?? theme.colors.blue;
  const initial = (name || '?').slice(0, 1).toUpperCase();
  const [imageError, setImageError] = useState(false);
  const [localUri, setLocalUri] = useState<string | null>(null);
  const [resolving, setResolving] = useState(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  // Reset image error when image source changes
  useEffect(() => {
    setImageError(false);
  }, [imageUrl, localUri]);

  // Resolve encrypted avatar
  useEffect(() => {
    if (!avatarDigest || !userId) {
      setLocalUri(null);
      return;
    }

    let cancelled = false;
    setResolving(true);

    import('../services/avatarService')
      .then(({ resolveAvatar }) =>
        resolveAvatar(
          userId,
          avatarDigest,
          encryptedAvatarKey ?? null,
          avatarKeyIv ?? null,
          groupId ?? null,
        ),
      )
      .then((uri) => {
        if (!cancelled && mountedRef.current) {
          setLocalUri(uri);
          setResolving(false);
        }
      })
      .catch(() => {
        if (!cancelled && mountedRef.current) {
          setLocalUri(null);
          setResolving(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [userId, avatarDigest, encryptedAvatarKey, avatarKeyIv, groupId]);

  // Determine what to show:
  // 1. If encrypted avatar resolved, show localUri
  // 2. If legacy imageUrl available (and no encrypted avatar), show that
  // 3. Otherwise show initials
  const resolvedUri = localUri ?? (avatarDigest ? null : imageUrl);
  const showImage = !!resolvedUri && !imageError && !resolving;

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
          source={{ uri: resolvedUri! }}
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
});
