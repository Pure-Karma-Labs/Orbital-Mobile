/**
 * Reply composer — fixed at the bottom of the thread detail screen.
 *
 * Shows a text input with a send button and an emoji toggle. When replying
 * to a specific reply, a context bar appears above the input showing
 * "Replying to @username". Tapping the X on the context bar clears the
 * reply-to target.
 *
 * Text state is controlled by the parent (ThreadDetailScreen) so the parent
 * can insert emoji characters from the EmojiPicker.
 */

import React, { useCallback } from 'react';
import {
  Text,
  TextInput as RNTextInput,
  TouchableOpacity,
  View,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { useTheme } from '../../theme';
import { Emoji } from '../../components/Emoji';

export interface ReplyTarget {
  replyId: string;
  authorUsername: string;
  depth: number;
}

export interface ReplyComposerProps {
  /** The reply being responded to, or null for a top-level reply */
  replyTarget: ReplyTarget | null;
  /** Called to clear the reply-to target */
  onClearReplyTarget: () => void;
  /** Called when the user sends a reply */
  onSend: (body: string) => void;
  /** Whether a send is currently in progress */
  sending: boolean;
  /** Controlled text value */
  text: string;
  /** Called when text changes */
  onChangeText: (text: string) => void;
  /** Whether the emoji picker is currently visible */
  showEmojiPicker?: boolean;
  /** Called to toggle the emoji picker */
  onToggleEmojiPicker?: () => void;
  /** Called when the text input receives focus */
  onInputFocus?: () => void;
}

export const ReplyComposer = React.memo(function ReplyComposer({
  replyTarget,
  onClearReplyTarget,
  onSend,
  sending,
  text,
  onChangeText,
  showEmojiPicker,
  onToggleEmojiPicker,
  onInputFocus,
}: ReplyComposerProps): React.JSX.Element {
  const theme = useTheme();

  const canSend = text.trim().length > 0 && !sending;

  const handleSend = useCallback(() => {
    if (!canSend) return;
    const body = text.trim();
    onChangeText('');
    onSend(body);
  }, [canSend, text, onSend, onChangeText]);

  const handleFocus = useCallback(() => {
    onInputFocus?.();
  }, [onInputFocus]);

  const containerStyle: ViewStyle = {
    backgroundColor: theme.colors.surface,
    borderTopWidth: 1,
    borderTopColor: theme.colors.borderSubtle,
    paddingHorizontal: theme.spacing.sm,
    paddingVertical: theme.spacing.sm,
  };

  const replyContextStyle: ViewStyle = {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: theme.colors.blueTintLight,
    borderRadius: theme.borderRadius.base,
    paddingHorizontal: theme.spacing.sm,
    paddingVertical: theme.spacing.xs,
    marginBottom: theme.spacing.xs,
  };

  const replyContextTextStyle: TextStyle = {
    flex: 1,
    fontFamily: theme.typography.fontFamily.mono,
    fontSize: theme.typography.fontSize.sm,
    color: theme.colors.textSecondary,
  };

  const clearButtonStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.body,
    fontSize: theme.typography.fontSize.base,
    color: theme.colors.textSecondary,
    paddingHorizontal: theme.spacing.xs,
  };

  const inputRowStyle: ViewStyle = {
    flexDirection: 'row',
    alignItems: 'flex-end',
  };

  const inputStyle: TextStyle = {
    flex: 1,
    fontFamily: theme.typography.fontFamily.body,
    fontSize: theme.typography.fontSize.base,
    color: theme.colors.textPrimary,
    backgroundColor: theme.colors.surfaceElevated,
    borderWidth: 1,
    borderColor: theme.colors.borderSubtle,
    borderRadius: theme.borderRadius.base,
    paddingHorizontal: theme.spacing.sm,
    paddingVertical: theme.spacing.sm,
    maxHeight: 100,
    minHeight: 40,
  };

  const sendButtonStyle: ViewStyle = {
    minWidth: 44,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: theme.spacing.xs,
  };

  const emojiButtonStyle: ViewStyle = {
    minWidth: 36,
    minHeight: 40,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: theme.spacing.xs,
  };

  const sendTextStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.bodyBold,
    fontSize: theme.typography.fontSize.base,
    color: canSend ? theme.colors.blue : theme.colors.textTertiary,
  };

  return (
    <View style={containerStyle} testID="reply-composer">
      {replyTarget != null && (
        <View style={replyContextStyle} testID="reply-context">
          <Text style={replyContextTextStyle} numberOfLines={1}>
            Replying to @{replyTarget.authorUsername}
          </Text>
          <TouchableOpacity
            onPress={onClearReplyTarget}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            accessibilityRole="button"
            accessibilityLabel="Clear reply target"
          >
            <Text style={clearButtonStyle}>{'X'}</Text>
          </TouchableOpacity>
        </View>
      )}
      <View style={inputRowStyle}>
        {onToggleEmojiPicker != null && (
          <TouchableOpacity
            style={emojiButtonStyle}
            onPress={onToggleEmojiPicker}
            accessibilityRole="button"
            accessibilityLabel={showEmojiPicker ? 'Hide emoji picker' : 'Show emoji picker'}
            testID="emoji-toggle-button"
          >
            <Emoji unified={showEmojiPicker ? '2328-FE0F' : '1F60A'} size={22} />
          </TouchableOpacity>
        )}
        <RNTextInput
          style={inputStyle}
          value={text}
          onChangeText={onChangeText}
          onFocus={handleFocus}
          placeholder="Type a reply..."
          placeholderTextColor={theme.colors.textTertiary}
          multiline
          maxLength={4000}
          editable={!sending}
          testID="reply-input"
        />
        <TouchableOpacity
          style={sendButtonStyle}
          onPress={handleSend}
          disabled={!canSend}
          accessibilityRole="button"
          accessibilityLabel="Send reply"
          testID="send-button"
        >
          <Text style={sendTextStyle}>Send</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
});
