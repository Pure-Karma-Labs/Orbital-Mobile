/**
 * The footer `useThreadListPaging` renders under a thread list (#923).
 *
 * Three states, and only three: a spinner while a walk page is in flight, a
 * TAPPABLE "Load more" row when the walk stopped short of the end, and nothing
 * at all when there is nothing to say.
 *
 * Why a tappable row at all, when ThreadDetail's reply pagination just stops:
 * a thread list's end is where imported posts live, so a walk that gives up
 * silently is indistinguishable from "there is nothing older" — the exact
 * failure #923 exists to fix. The row is the member's way back in.
 */

import React from 'react';
import { Text, TouchableOpacity, View, type TextStyle, type ViewStyle } from 'react-native';
import { useTheme } from '../theme';
import { OrbitalSpinner } from './OrbitalSpinner';

/**
 * Minimum tappable height, from Apple's HIG and Material's 48dp.
 *
 * A real FRAME, not `hitSlop`: this row's parent is the list's footer view,
 * and slop that escapes a short parent is clipped — the same thing that made
 * the reply author handle untappable in #888. So the row is 44pt tall on its
 * own, and the label is centred inside it.
 */
const MIN_TAP_SIZE = 44;

export interface ThreadListFooterProps {
  /** A page is in flight (or the hook's follow-up loop is still running). */
  loading: boolean;
  /** The walk stopped short: offer the tap. Ignored while `loading`. */
  stalled: boolean;
  onRetry: () => void;
  testID?: string;
}

export function ThreadListFooter({
  loading,
  stalled,
  onRetry,
  testID = 'thread-list-footer',
}: ThreadListFooterProps): React.JSX.Element | null {
  const theme = useTheme();

  const spinnerStyle: ViewStyle = {
    paddingVertical: theme.spacing.base,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: MIN_TAP_SIZE,
  };

  const rowStyle: ViewStyle = {
    minHeight: MIN_TAP_SIZE,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: theme.spacing.base,
    paddingVertical: theme.spacing.sm,
  };

  const labelStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.mono,
    fontSize: theme.typography.fontSize.sm,
    color: theme.colors.blue,
  };

  if (loading) {
    return (
      <View style={spinnerStyle} testID={`${testID}-loading`}>
        <OrbitalSpinner size={20} />
      </View>
    );
  }

  if (!stalled) return null;

  return (
    <TouchableOpacity
      style={rowStyle}
      onPress={onRetry}
      accessibilityRole="button"
      accessibilityLabel="Load more"
      accessibilityHint="Loads older threads"
      testID={`${testID}-retry`}
    >
      <Text style={labelStyle}>Load more</Text>
    </TouchableOpacity>
  );
}

export default ThreadListFooter;
