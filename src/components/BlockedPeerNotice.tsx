/**
 * "You blocked {label}" + Unblock — shown wherever a DM composer or empty
 * state would otherwise invite the user to send to someone they blocked
 * (#908).
 *
 * TOKENS. Deliberately NEUTRAL, not `yellowTint`/`warning`: a block is a state
 * the user chose, not a warning about something that went wrong. The notice
 * takes the place of a composer input row, so it takes the INPUT surface —
 * `colors.surfaceElevated` ("input fields, top-level posts" in
 * MOBILE-DESIGN-FOUNDATION) on a `colors.borderSubtle` hairline at
 * `borderRadius.base` (3px). Label text is `fontSize.base` in
 * `colors.textPrimary`, and the Unblock control reuses the secondary-chip
 * tokens from `settings/BlockedUsersScreen` verbatim (`surface` on
 * `borderSubtle`), which is what keeps the chip legible against the elevated
 * notice instead of disappearing into it.
 *
 * The label is rendered with plain `Text` where BlockedUsersScreen uses
 * `EmojiText` — a DELIBERATE divergence. A handle is `[A-Za-z0-9_]` only
 * (`utils/validateUsername`, mirroring the backend rule) and the unresolved
 * fallback is `user-<prefix>`, so no emoji can occur; plain `Text` also lets
 * the whole sentence carry one `accessibilityLabel`, which `EmojiText` has no
 * prop for.
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
    backgroundColor: theme.colors.surfaceElevated,
    borderWidth: 1,
    borderColor: theme.colors.borderSubtle,
    borderRadius: theme.borderRadius.base,
    paddingHorizontal: theme.spacing.sm,
    paddingVertical: theme.spacing.sm,
  };

  const textStyle: TextStyle = {
    flex: 1,
    fontFamily: theme.typography.fontFamily.body,
    fontSize: theme.typography.fontSize.base,
    color: theme.colors.textPrimary,
  };

  const buttonStyle: ViewStyle = {
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.borderSubtle,
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
