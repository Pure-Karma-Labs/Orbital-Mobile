/**
 * Compose thread screen — title + body inputs with encrypted posting.
 */

import React, { useCallback, useState } from 'react';
import {
  Alert,
  ScrollView,
  Text,
  TextInput,
  TouchableOpacity,
  View,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useTheme } from '../theme';
import { useAuth, useContactForConversation } from '../stores';
import { VerifiedStatus } from '../types/database';
import { createNewThread } from '../services/threadService';
import { uploadMediaBatch } from '../services/mediaUploadService';
import { useMediaPicker } from '../hooks/useMediaPicker';
import { Header } from '../components/Header';
import { OrbitalKeyboardAvoidingView } from '../components/OrbitalKeyboardAvoidingView';
import { LinkPreviewCard } from '../components/LinkPreviewCard';
import { ErrorBanner } from '../components/ErrorBanner';
import { MediaThumbnailStrip } from '../components/MediaThumbnailStrip';
import type { ThreadsStackParamList } from '../navigation/types';

export type ComposeThreadScreenProps = NativeStackScreenProps<
  ThreadsStackParamList,
  'ComposeThread'
>;

export function ComposeThreadScreen({
  navigation,
  route,
}: ComposeThreadScreenProps): React.JSX.Element {
  const theme = useTheme();
  const { userId, username } = useAuth();
  const { groupId, isDm } = route.params;
  const contact = useContactForConversation(isDm ? groupId : null);

  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { selectedMedia, pickPhotos, removeMedia } = useMediaPicker();

  const busy = loading || uploading;
  const canSubmit = isDm
    ? body.trim().length > 0 && !busy
    : title.trim().length > 0 && body.trim().length > 0 && !busy;

  const doPost = useCallback(async () => {
    if (!canSubmit || !userId || !username) {
      if (__DEV__) {
        console.warn('[Compose] blocked:', { canSubmit, userId, username, groupId });
      }
      return;
    }

    setError(null);
    setLoading(true);
    try {
      let mediaIds: string[] | undefined;
      if (selectedMedia.length > 0) {
        setUploading(true);
        try {
          mediaIds = await uploadMediaBatch(selectedMedia, groupId);
        } finally {
          setUploading(false);
        }
      }

      const thread = await createNewThread(
        groupId,
        isDm ? '' : title.trim(),
        body.trim(),
        { authorId: userId, authorUsername: username },
        mediaIds ? { mediaIds } : undefined,
      );
      if (isDm) {
        navigation.goBack();
      } else {
        navigation.replace('ThreadDetail', {
          threadId: thread.id,
          threadTitle: thread.title ?? undefined,
        });
      }
    } catch (e) {
      if (__DEV__) {
        console.warn('[Compose] error:', e instanceof Error ? e.message : e);
      }
      setError('Failed to create thread. Please try again.');
    } finally {
      setLoading(false);
    }
  }, [canSubmit, userId, username, groupId, isDm, title, body, navigation, selectedMedia]);

  const handlePost = useCallback(() => {
    if (isDm && contact?.verifiedStatus === VerifiedStatus.Unverified) {
      const name = contact.displayName ?? contact.username ?? 'this contact';
      Alert.alert(
        'Safety Number Changed',
        `Safety number has changed for ${name}. Their identity key may have changed because they reinstalled the app or got a new device. Send anyway?`,
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Send', onPress: () => { doPost(); } },
        ],
      );
      return;
    }
    doPost();
  }, [isDm, contact, doPost]);

  const containerStyle: ViewStyle = {
    flex: 1,
    backgroundColor: theme.colors.background,
  };

  const scrollContentStyle: ViewStyle = {
    padding: theme.spacing.base,
    gap: theme.spacing.base,
  };

  const labelStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.bodyBold,
    fontSize: theme.typography.fontSize.sm,
    color: theme.colors.textSecondary,
    marginBottom: theme.spacing.xs,
  };

  const inputStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.body,
    fontSize: theme.typography.fontSize.base,
    color: theme.colors.textPrimary,
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.borderSubtle,
    borderRadius: theme.borderRadius.base,
    padding: theme.spacing.sm,
  };

  const bodyInputStyle: TextStyle = {
    ...inputStyle,
    minHeight: 160,
    textAlignVertical: 'top',
  };

  const postButtonStyle: ViewStyle = {
    backgroundColor: canSubmit ? theme.colors.blue : theme.colors.borderSubtle,
    paddingHorizontal: theme.spacing.base,
    paddingVertical: theme.spacing.xs,
    borderRadius: theme.borderRadius.base,
  };

  const postButtonTextStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.bodyBold,
    fontSize: theme.typography.fontSize.sm,
    color: canSubmit ? '#FFFFFF' : theme.colors.textTertiary,
  };

  return (
    <SafeAreaView style={containerStyle} edges={['top']}>
      <Header
        title={isDm ? "New Message" : "New Thread"}
        onBack={() => navigation.goBack()}
        right={
          <TouchableOpacity
            onPress={handlePost}
            disabled={!canSubmit}
            accessibilityRole="button"
            accessibilityLabel={isDm ? "Send message" : "Post thread"}
            style={postButtonStyle}
          >
            <Text style={postButtonTextStyle}>
              {uploading ? 'Uploading...' : loading ? 'Posting...' : isDm ? 'Send' : 'Post'}
            </Text>
          </TouchableOpacity>
        }
      />
      <OrbitalKeyboardAvoidingView keyboardVerticalOffset={0}>
        <ScrollView
          contentContainerStyle={scrollContentStyle}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="interactive"
        >
          {!isDm && (
            <View>
              <Text style={labelStyle}>Title</Text>
              <TextInput
                style={inputStyle}
                value={title}
                onChangeText={setTitle}
                placeholder="Thread title"
                placeholderTextColor={theme.colors.textTertiary}
                autoFocus
                maxLength={200}
                returnKeyType="next"
                editable={!busy}
                testID="compose-title-input"
              />
            </View>
          )}

          <View>
            <Text style={labelStyle}>Body</Text>
            <TextInput
              style={bodyInputStyle}
              value={body}
              onChangeText={setBody}
              placeholder="What's on your mind?"
              placeholderTextColor={theme.colors.textTertiary}
              multiline
              maxLength={10000}
              editable={!busy}
              testID="compose-body-input"
            />
          </View>

          <LinkPreviewCard text={body} debounceMs={500} dismissible />

          <MediaThumbnailStrip media={selectedMedia} onRemove={removeMedia} />

          <TouchableOpacity
            onPress={pickPhotos}
            disabled={busy}
            accessibilityRole="button"
            accessibilityLabel="Attach photos"
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: theme.spacing.xs,
              paddingVertical: theme.spacing.xs,
            }}
            testID="attach-media-button"
          >
            <Text style={{
              fontFamily: theme.typography.fontFamily.body,
              fontSize: theme.typography.fontSize.sm,
              color: busy ? theme.colors.textTertiary : theme.colors.blue,
            }}>
              + Add Photos
            </Text>
          </TouchableOpacity>

          <ErrorBanner message={error} />
        </ScrollView>
      </OrbitalKeyboardAvoidingView>
    </SafeAreaView>
  );
}
