/**
 * EditProfileScreen — edit display name and avatar.
 *
 * Local state is used for edits; only committed to the store via profileService
 * on save. Navigation.goBack() is called on success.
 */

import React, { useCallback, useMemo, useState } from 'react';
import {
  ActionSheetIOS,
  Alert,
  Platform,
  ScrollView,
  Text,
  TouchableOpacity,
  View,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import {
  launchLibraryOnce,
  pickerErrorCopy,
  reportPickerError,
  usePickerInFlight,
} from '../hooks/useMediaPicker';
import { useTheme } from '../theme';
import { useAuth } from '../stores';
import { Header } from '../components/Header';
import { Avatar } from '../components/Avatar';
import { TextInput } from '../components/TextInput';
import { Button } from '../components/Button';
import { ErrorBanner } from '../components/ErrorBanner';

import {
  updateUserDisplayName,
  updateUserAvatar,
  removeUserAvatar,
} from '../services/profileService';
import type { SettingsStackParamList } from '../navigation/types';

type Props = NativeStackScreenProps<SettingsStackParamList, 'EditProfile'>;

/** Only alphanumeric, spaces, and underscores */
const DISPLAY_NAME_REGEX = /^[a-zA-Z0-9_ ]*$/;
const MAX_NAME_LENGTH = 15;

export function EditProfileScreen({ navigation }: Props): React.JSX.Element {
  const theme = useTheme();
  const { displayName, username, userId, avatarDigest } = useAuth();

  // Local edit state — not committed until save
  const [editedName, setEditedName] = useState(displayName ?? '');
  const [editedAvatarUri, setEditedAvatarUri] = useState<string | null>(null);
  const [editedAvatarType, setEditedAvatarType] = useState<string | null>(null);
  const [avatarRemoved, setAvatarRemoved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // #971: the app-wide pick lock, shared with the composer surfaces.
  const pickerInFlight = usePickerInFlight();

  // Validation
  const nameValid = DISPLAY_NAME_REGEX.test(editedName) && editedName.trim().length > 0;
  const nameChanged = editedName !== (displayName ?? '');
  const avatarChanged = editedAvatarUri !== null || avatarRemoved;
  const hasChanges = nameChanged || avatarChanged;
  const canSave = hasChanges && nameValid && !saving;

  // During editing, show the local picker URI; otherwise let Avatar resolve via encrypted path
  const previewAvatarUrl = useMemo(() => {
    if (avatarRemoved) return null;
    if (editedAvatarUri) return editedAvatarUri;
    return null;
  }, [avatarRemoved, editedAvatarUri]);

  const handleNameChange = useCallback((text: string) => {
    // Only allow valid characters
    if (DISPLAY_NAME_REGEX.test(text)) {
      setEditedName(text);
    }
  }, []);

  const handleChoosePhoto = useCallback(async () => {
    try {
      // NOTE: maxWidth/maxHeight/quality do NOT reliably strip EXIF/GPS metadata --
      // Android's react-native-image-picker skips the re-encode for images <= 2048px.
      // The authoritative EXIF/GPS strip is in avatarService via sanitizeStillImage.
      const result = await launchLibraryOnce({
        mediaType: 'photo',
        maxWidth: 800,
        maxHeight: 800,
        quality: 0.8,
        assetRepresentationMode: 'compatible',
      });

      // Another surface already has a pick in flight (#971). Avatar options are
      // 800px/q0.8 against the composer's 2048px/q0.9, so sharing a launch is
      // not an option: we wait our turn rather than take theirs.
      if (result === null) return;

      if (result.errorCode !== undefined) {
        reportPickerError(result.errorCode);
        // One home for picker copy (useMediaPicker.pickerErrorCopy); the banner
        // carries the body only, since the ErrorBanner has no title slot.
        setError(pickerErrorCopy(result.errorCode).body);
        return;
      }

      if (result.didCancel || !result.assets || result.assets.length === 0) return;

      const asset = result.assets[0];
      if (asset.uri && asset.type) {
        setEditedAvatarUri(asset.uri);
        setEditedAvatarType(asset.type);
        setAvatarRemoved(false);
        setError(null);
      }
    } catch {
      setError('Failed to open photo library');
    }
  }, []);

  const handleRemovePhoto = useCallback(() => {
    setEditedAvatarUri(null);
    setEditedAvatarType(null);
    setAvatarRemoved(true);
    setError(null);
  }, []);

  const handleAvatarPress = useCallback(() => {
    // #971: a pick is already loading somewhere, so "Choose Photo" would be
    // swallowed by the lock. Both touchables are disabled and dimmed while that
    // is true, so this is the belt to that suspenders -- it also covers the
    // press that races the re-render. "Remove Photo" waits with it; a pick
    // resolves in seconds and the lock is released in `finally`.
    if (pickerInFlight) return;

    const hasAvatar = !!previewAvatarUrl;

    if (Platform.OS === 'ios') {
      const options = hasAvatar
        ? ['Choose Photo', 'Remove Photo', 'Cancel']
        : ['Choose Photo', 'Cancel'];
      const cancelIndex = hasAvatar ? 2 : 1;
      const destructiveIndex = hasAvatar ? 1 : undefined;

      ActionSheetIOS.showActionSheetWithOptions(
        { options, cancelButtonIndex: cancelIndex, destructiveButtonIndex: destructiveIndex },
        (buttonIndex) => {
          if (buttonIndex === 0) handleChoosePhoto();
          else if (hasAvatar && buttonIndex === 1) handleRemovePhoto();
        },
      );
    } else {
      const buttons = [
        { text: 'Choose Photo', onPress: () => handleChoosePhoto() },
        ...(hasAvatar ? [{ text: 'Remove Photo', onPress: () => handleRemovePhoto(), style: 'destructive' as const }] : []),
        { text: 'Cancel', style: 'cancel' as const },
      ];
      Alert.alert('Profile Photo', undefined, buttons);
    }
  }, [pickerInFlight, previewAvatarUrl, handleChoosePhoto, handleRemovePhoto]);

  const handleSave = useCallback(async () => {
    if (!canSave) return;
    setSaving(true);
    setError(null);

    try {
      if (nameChanged) {
        await updateUserDisplayName(editedName.trim());
      }
      if (editedAvatarUri && editedAvatarType) {
        await updateUserAvatar(editedAvatarUri, editedAvatarType);
      } else if (avatarRemoved) {
        await removeUserAvatar();
      }
      navigation.goBack();
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Failed to save profile';
      setError(message);
    } finally {
      setSaving(false);
    }
  }, [
    canSave,
    nameChanged,
    editedName,
    editedAvatarUri,
    editedAvatarType,
    avatarRemoved,
    navigation,
  ]);

  const handleBack = useCallback(() => {
    navigation.goBack();
  }, [navigation]);

  // ---------------------------------------------------------------------------
  // Styles
  // ---------------------------------------------------------------------------

  const containerStyle: ViewStyle = {
    flex: 1,
    backgroundColor: theme.colors.background,
  };

  const contentStyle: ViewStyle = {
    padding: theme.spacing.base,
  };

  const avatarSectionStyle: ViewStyle = {
    alignItems: 'center',
    marginBottom: theme.spacing.lg,
  };

  const avatarTouchStyle: ViewStyle = {
    marginBottom: theme.spacing.sm,
    // #971: dimmed while a pick is in flight, the same signal the composer
    // surfaces give. Both avatar touchables are also `disabled`.
    opacity: pickerInFlight ? 0.5 : 1,
  };

  const changePhotoStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.body,
    fontSize: theme.typography.fontSize.sm,
    // ComposeThreadScreen's idiom for a gated label.
    color: pickerInFlight ? theme.colors.textTertiary : theme.colors.blue,
  };

  const counterStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.mono,
    fontSize: theme.typography.fontSize.sm,
    color: theme.colors.textTertiary,
    textAlign: 'right',
    marginTop: -theme.spacing.sm,
    marginBottom: theme.spacing.md,
  };

  const usernameContainerStyle: ViewStyle = {
    marginBottom: theme.spacing.lg,
  };

  const usernameLabelStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.bodyBold,
    fontSize: theme.typography.fontSize.sm,
    color: theme.colors.textSecondary,
    marginBottom: theme.spacing.xs,
  };

  const usernameValueStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.body,
    fontSize: theme.typography.fontSize.base,
    color: theme.colors.textTertiary,
  };

  return (
    <SafeAreaView style={containerStyle} edges={['top']} testID="edit-profile-screen">
      <Header title="Edit Profile" onBack={handleBack} />
      <ScrollView keyboardShouldPersistTaps="handled">
        <View style={contentStyle}>
          <ErrorBanner message={error} />

          {/* Avatar section */}
          <View style={avatarSectionStyle}>
            <TouchableOpacity
              style={avatarTouchStyle}
              onPress={handleAvatarPress}
              disabled={pickerInFlight}
              activeOpacity={0.7}
              accessibilityRole="button"
              accessibilityLabel="Change profile photo"
              testID="avatar-button"
            >
              <Avatar
                name={editedName || username || 'U'}
                size={80}
                imageUrl={previewAvatarUrl}
                userId={editedAvatarUri ? null : userId}
                groupId={null}
                avatarDigest={editedAvatarUri || avatarRemoved ? null : avatarDigest}
              />
            </TouchableOpacity>
            <TouchableOpacity
              onPress={handleAvatarPress}
              disabled={pickerInFlight}
              activeOpacity={0.7}
              testID="change-photo-button"
            >
              <Text style={changePhotoStyle}>Change Photo</Text>
            </TouchableOpacity>
          </View>

          {/* Display Name */}
          <TextInput
            label="Display Name"
            value={editedName}
            onChangeText={handleNameChange}
            maxLength={MAX_NAME_LENGTH}
            autoCapitalize="words"
            autoCorrect={false}
            testID="display-name-input"
          />
          <Text style={counterStyle} testID="char-counter">
            {editedName.length}/{MAX_NAME_LENGTH}
          </Text>

          {/* Username (read-only) */}
          <View style={usernameContainerStyle}>
            <Text style={usernameLabelStyle}>Username</Text>
            <Text style={usernameValueStyle} testID="username-display">
              @{username ?? 'user'}
            </Text>
          </View>

          {/* Save button */}
          <Button
            title="Save"
            onPress={handleSave}
            disabled={!canSave}
            loading={saving}
            testID="save-button"
          />
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

export default EditProfileScreen;
