/**
 * "You blocked {label}" + Unblock — shown wherever a DM composer or empty
 * state would otherwise invite the user to send to someone they blocked
 * (#908).
 *
 * TOKENS. Deliberately NEUTRAL, not `yellowTint`/`warning`: a block is a state
 * the user chose, not a warning about something that went wrong. Surface
 * `colors.surface` on a `colors.borderSubtle` hairline at
 * `borderRadius.base` (3px), label text at `fontSize.sm` in
 * `colors.textSecondary`; the Unblock control reuses the secondary-chip idiom
 * from `settings/BlockedUsersScreen` (`surfaceElevated` on `borderStrong`).
 *
 * The label is rendered with plain `Text`, matching BlockedUsersScreen: it is a
 * username, not user-authored content, and `EmojiText` is reserved for the
 * latter.
 */

import React, { useCallback } from 'react';
import {
  Text,
  TouchableOpacity,
  View,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { useTheme } from '../theme';
import { confirmUnblock } from '../utils/confirmUnblock';

export interface BlockedPeerNoticeProps {
  /** Already handle-composed (`@name` only when resolved — blockedUserLabel). */
  label: string;
  /** The blocked user's id — what Unblock acts on. */
  peerId: string;
  testID?: string;
  style?: StyleProp<ViewStyle>;
}

export function BlockedPeerNotice({
  label,
  peerId,
  testID = 'blocked-peer-notice',
  style,
}: BlockedPeerNoticeProps): React.JSX.Element {
  const theme = useTheme();

  const handleUnblock = useCallback(() => {
    confirmUnblock(peerId, label);
  }, [peerId, label]);

  // Compact row — text left, control right — so it fits exactly where a
  // composer input row sits.
  const containerStyle: ViewStyle = {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: theme.spacing.sm,
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.borderSubtle,
    borderRadius: theme.borderRadius.base,
    paddingHorizontal: theme.spacing.sm,
    paddingVertical: theme.spacing.sm,
  };

  const textStyle: TextStyle = {
    flex: 1,
    fontFamily: theme.typography.fontFamily.body,
    fontSize: theme.typography.fontSize.sm,
    color: theme.colors.textSecondary,
  };

  const buttonStyle: ViewStyle = {
    backgroundColor: theme.colors.surfaceElevated,
    borderWidth: 1,
    borderColor: theme.colors.borderStrong,
    borderRadius: theme.borderRadius.base,
    paddingHorizontal: theme.spacing.md,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
  };

  const buttonTextStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.bodyBold,
    fontSize: theme.typography.fontSize.sm,
    color: theme.colors.textPrimary,
  };

  return (
    <View style={[containerStyle, style]} testID={testID}>
      <Text style={textStyle} accessibilityLabel={`You blocked ${label}`}>
        You blocked {label}
      </Text>
      <TouchableOpacity
        style={buttonStyle}
        onPress={handleUnblock}
        activeOpacity={0.7}
        accessibilityRole="button"
        accessibilityLabel={`Unblock ${label}`}
        testID="blocked-peer-unblock"
      >
        <Text style={buttonTextStyle}>Unblock</Text>
      </TouchableOpacity>
    </View>
  );
}

export default BlockedPeerNotice;
