/**
 * The two read-surface states of a group key this device cannot open (#912),
 * shared by ThreadsScreen, ChatDetailScreen and ThreadDetailScreen so the same
 * failure cannot look like three different things.
 *
 * TOKENS.
 * - {@link GroupKeyPendingBanner} reuses ThreadsScreen's ConnectionStatusBanner
 *   shape verbatim — `colors.warning` fill, full-bleed under the header,
 *   `fontFamily.mono` at `fontSize.xs` — because it means the same kind of
 *   thing: a transient, self-resolving condition the user cannot act on. One
 *   shape for "we are waiting on the network" keeps it recognisable, and it
 *   follows MOBILE-PATTERNS' "Position: top of screen, below header".
 * - {@link GroupKeyFailureNotice} takes the EMPTY-STATE shape it replaces (the
 *   ASCII-bordered centred box, `fontSize.base` in `colors.textSecondary`) and
 *   drops the CTA. MOBILE-PATTERNS' retry state is "message centred in the
 *   content area", and the ASCII box is what the surrounding screens use; a
 *   `colors.error` banner would overstate a condition that is usually someone
 *   else's device being offline.
 *
 * Neither is dismissible: both describe the state of the content on screen, so
 * dismissing one would leave an empty conversation with no explanation — the
 * #912 bug itself.
 */

import React from 'react';
import { Text, View, type TextStyle, type ViewStyle } from 'react-native';
import { useTheme } from '../theme';

/**
 * Pinned here rather than in `utils/errorMessages.ts`: this component is the
 * only renderer, so there is nothing for it to drift against. Exported for the
 * screen tests, which assert the notice REPLACED the empty state.
 */
export const GROUP_KEY_PENDING_NOTICE = 'Re-sending encryption key…';

export interface GroupKeyPendingBannerProps {
  testID?: string;
}

/**
 * "A peer is re-wrapping this key." Transient by construction: the load effect
 * re-runs when the key is delivered (`groupKeyGeneration`), which clears the
 * flag that renders this.
 */
export function GroupKeyPendingBanner({
  testID = 'group-key-pending-banner',
}: GroupKeyPendingBannerProps): React.JSX.Element {
  const theme = useTheme();

  const bannerStyle: ViewStyle = {
    backgroundColor: theme.colors.warning,
    paddingVertical: theme.spacing.xs,
    paddingHorizontal: theme.spacing.base,
    alignItems: 'center',
  };

  const textStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.mono,
    fontSize: theme.typography.fontSize.xs,
    color: theme.colors.textPrimary,
  };

  return (
    <View style={bannerStyle} testID={testID}>
      {/* No EmojiText: this is fixed app copy with no emoji, and the ellipsis
          is U+2026, not an emoji sequence. */}
      <Text style={textStyle} accessibilityRole="alert">
        {GROUP_KEY_PENDING_NOTICE}
      </Text>
    </View>
  );
}

export interface GroupKeyFailureNoticeProps {
  /** Already selected by `utils/groupKeyErrorCopy.groupKeyFailureCopy`. */
  message: string;
  testID?: string;
}

/**
 * The non-transient outcomes, in place of the "No threads yet / Create your
 * first!" box. Shows no CTA: every message it can carry explains that the next
 * move is not the user's.
 */
export function GroupKeyFailureNotice({
  message,
  testID = 'group-key-failure-notice',
}: GroupKeyFailureNoticeProps): React.JSX.Element {
  const theme = useTheme();

  const containerStyle: ViewStyle = {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: theme.spacing.xl,
  };

  const boxStyle: ViewStyle = {
    borderWidth: 1,
    borderColor: theme.colors.borderSubtle,
    borderRadius: theme.borderRadius.base,
    padding: theme.spacing.lg,
    alignItems: 'center',
    width: '100%',
    maxWidth: 300,
  };

  const borderStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.mono,
    fontSize: theme.typography.fontSize.sm,
    color: theme.colors.textTertiary,
    marginBottom: theme.spacing.md,
  };

  const messageStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.body,
    fontSize: theme.typography.fontSize.base,
    color: theme.colors.textSecondary,
    textAlign: 'center',
    marginBottom: theme.spacing.md,
    lineHeight: theme.typography.fontSize.base * theme.typography.lineHeight.relaxed,
  };

  return (
    <View style={containerStyle} testID={testID}>
      <View style={boxStyle}>
        <Text style={borderStyle}>{'┌─────────────────────┐'}</Text>
        <Text style={messageStyle} accessibilityRole="alert">
          {message}
        </Text>
        <Text style={borderStyle}>{'└─────────────────────┘'}</Text>
      </View>
    </View>
  );
}
