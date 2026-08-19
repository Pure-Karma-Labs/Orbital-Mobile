/**
 * Compose thread screen — title + body inputs with encrypted posting.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
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
import { isUploadCancellation } from '../services/mediaUploadService';
import { captureUploadFailure, type PostPipelineStage } from '../services/uploadTelemetry';
import { QuotaExceededError } from '../services/api/errors';
import { updateMediaParent } from '../database/repositories/mediaRepository';
import { useMediaPicker } from '../hooks/useMediaPicker';
import { useMediaUploadProgress } from '../hooks/useMediaUploadProgress';
import { Header } from '../components/Header';
import { OrbitalKeyboardAvoidingView } from '../components/OrbitalKeyboardAvoidingView';
import { LinkPreviewCard } from '../components/LinkPreviewCard';
import { ErrorBanner } from '../components/ErrorBanner';
import { MediaThumbnailStrip } from '../components/MediaThumbnailStrip';
import { UploadProgressBar } from '../components/UploadProgressBar';
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
  const [error, setError] = useState<string | null>(null);
  const { selectedMedia, pickMedia, removeMedia } = useMediaPicker();
  const { progress: uploadProgress, cancel: cancelUpload, uploadBatch } = useMediaUploadProgress();

  const uploading = uploadProgress != null;

  // Live view of the selection for the hook's post-batch id filter (see
  // useMediaUploadProgress: the batch holds the array captured at call time).
  const selectedMediaRef = useRef(selectedMedia);
  useEffect(() => {
    selectedMediaRef.current = selectedMedia;
  }, [selectedMedia]);

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
    // Which half of the post failed. Media first, then the thread call — the
    // catch reports this as the Sentry `stage` tag, since an unsymbolicated
    // release stack cannot tell the two apart (#738).
    let stage: PostPipelineStage = 'media-upload';
    try {
      let mediaIds: string[] | undefined;
      if (selectedMedia.length > 0) {
        mediaIds = await uploadBatch(selectedMedia, groupId, () => selectedMediaRef.current);
      }

      stage = 'thread-create';
      const thread = await createNewThread(
        groupId,
        isDm ? '' : title.trim(),
        body.trim(),
        { authorId: userId, authorUsername: username },
        mediaIds ? { mediaIds } : undefined,
      );

      // Update local media rows with the confirmed thread ID
      // so the file library orbit filter can resolve conversation_id
      if (mediaIds && mediaIds.length > 0) {
        for (const mid of mediaIds) {
          try {
            updateMediaParent(mid, thread.id, null);
          } catch (e) {
            captureUploadFailure(e, { stage: 'local-commit', surface: 'compose-thread', level: 'warning' });
          }
        }
      }

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
      // The user cancelled their own upload — no error banner. The draft, the
      // selected media and the thread stay exactly as they were; the finally
      // below still re-arms the composer.
      if (isUploadCancellation(e)) return;
      // Everything below this line is a real failure the user just watched
      // happen. Before #738 it existed only in a __DEV__ console.warn, which is
      // why the S24 sanitizer bug (#732) was invisible in release builds.
      captureUploadFailure(e, { stage, surface: 'compose-thread' });
      // instanceof applies to the upload path; createNewThread is JSON-only and never 413s
      setError(e instanceof QuotaExceededError ? e.message : 'Failed to create thread. Please try again.');
    } finally {
      setLoading(false);
    }
  }, [canSubmit, userId, username, groupId, isDm, title, body, navigation, selectedMedia, uploadBatch]);

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
      {uploadProgress != null && (
        // In flow, full-bleed: the bar spans the screen, only its label row is
        // inset. The cancel X lives here, OUTSIDE every disabled={busy} gate —
        // it is the one control that must stay tappable while inputs are frozen.
        <UploadProgressBar
          fraction={uploadProgress.fraction}
          phase={uploadProgress.phase}
          bytesSent={uploadProgress.bytesSent}
          totalBytes={uploadProgress.totalBytes}
          itemIndex={uploadProgress.itemIndex}
          itemCount={uploadProgress.itemCount}
          cancelling={uploadProgress.cancelling}
          onCancel={cancelUpload}
          labelRowStyle={{ paddingHorizontal: theme.spacing.base }}
        />
      )}
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

          <MediaThumbnailStrip
            media={selectedMedia}
            onRemove={removeMedia}
            disabled={uploading}
          />

          <TouchableOpacity
            onPress={pickMedia}
            disabled={busy}
            accessibilityRole="button"
            accessibilityLabel="Attach media"
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
              + Add Media
            </Text>
          </TouchableOpacity>

          <ErrorBanner message={error} />
        </ScrollView>
      </OrbitalKeyboardAvoidingView>
    </SafeAreaView>
  );
}
