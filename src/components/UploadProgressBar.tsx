/**
 * UploadProgressBar -- composer upload feedback: a thin bar over a right-aligned
 * status row (MB readout + cancel X).
 *
 * LAYOUT-AGNOSTIC BY DESIGN: this is an in-flow column. Each consumer owns its
 * own positioning (ComposeThreadScreen renders it in flow under the header;
 * ReplyComposer renders it as the first child of the composer container). A
 * boolean toggling one shared component between two structural trees grows a
 * second boolean at the third consumer -- and #672 is already named.
 *
 * Cancel is NOT confirmation-gated: it is non-destructive (draft text, selected
 * media and the reply target all survive), and the Alert-confirm convention here
 * is reserved for destructive actions.
 */

import React from 'react';
import {
  Text,
  TouchableOpacity,
  View,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { useTheme } from '../theme';
import { ProgressBar } from './ProgressBar';
import { formatMBPair } from '../utils/formatBytes';
import type { UploadPhase } from '../services/mediaUploadService';

export interface UploadProgressBarProps {
  /** Batch-overall progress 0-1. */
  fraction: number;
  phase: UploadPhase;
  /** Ciphertext bytes sent for the CURRENT item (upload phase only). */
  bytesSent?: number | null;
  /** Total ciphertext bytes for the CURRENT item. */
  totalBytes?: number | null;
  /** Zero-based index of the item being uploaded. */
  itemIndex: number;
  /** Number of items in the batch. */
  itemCount: number;
  /** True once cancel has been requested but the item has not stopped yet. */
  cancelling: boolean;
  onCancel: () => void;
  /** Consumer-owned gutters for the label row (the bar itself stays full-bleed). */
  labelRowStyle?: StyleProp<ViewStyle>;
}

/** Visible label. MB pair only in the upload phase -- the other phases have no bytes yet. */
function buildLabel(
  phase: UploadPhase,
  cancelling: boolean,
  bytesSent: number | null | undefined,
  totalBytes: number | null | undefined,
  itemIndex: number,
  itemCount: number,
): string {
  if (cancelling) return 'Cancelling…';
  if (phase === 'compressing') return 'Preparing video…';
  if (phase === 'encrypting') return 'Encrypting…';
  // The MB readout is PER ITEM: a batch-wide byte total is unknowable up front
  // (ciphertext length is computed per item), so it would jump or regress.
  const prefix = itemCount > 1 ? `(${itemIndex + 1}/${itemCount}) ` : '';
  if (bytesSent == null || totalBytes == null) return `${prefix}Uploading…`;
  return `${prefix}${formatMBPair(bytesSent, totalBytes)}`;
}

/**
 * What assistive tech announces. Phase-level only, deliberately: the visible
 * label changes on every chunk, and a live region echoing each MB tick would be
 * unusable. The visible text stays the MB pair; the announced string changes
 * only when the phase does.
 */
function buildAnnouncement(phase: UploadPhase, cancelling: boolean): string {
  if (cancelling) return 'Cancelling upload';
  if (phase === 'compressing') return 'Preparing video';
  if (phase === 'encrypting') return 'Encrypting';
  return 'Uploading';
}

export function UploadProgressBar({
  fraction,
  phase,
  bytesSent,
  totalBytes,
  itemIndex,
  itemCount,
  cancelling,
  onCancel,
  labelRowStyle,
}: UploadProgressBarProps): React.JSX.Element {
  const theme = useTheme();

  const label = buildLabel(phase, cancelling, bytesSent, totalBytes, itemIndex, itemCount);

  const rowStyle: ViewStyle = {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    marginTop: theme.spacing.xs,
  };

  const labelStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.body,
    fontSize: theme.typography.fontSize.xs,
    color: theme.colors.textSecondary,
    textAlign: 'right',
  };

  const cancelButtonStyle: ViewStyle = {
    minWidth: 44,
    minHeight: 44,
    alignItems: 'flex-end',
    justifyContent: 'center',
    opacity: cancelling ? 0.5 : 1,
  };

  const cancelTextStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.bodyBold,
    fontSize: theme.typography.fontSize.base,
    color: theme.colors.textSecondary,
  };

  return (
    <View testID="upload-progress">
      <ProgressBar
        progress={fraction}
        announceProgress
        accessibilityLabel="Upload progress"
        testID="upload-progress-bar"
      />
      <View style={[rowStyle, labelRowStyle]} accessibilityLiveRegion="polite">
        <Text
          style={labelStyle}
          accessibilityLabel={buildAnnouncement(phase, cancelling)}
          numberOfLines={1}
          testID="upload-progress-label"
        >
          {label}
        </Text>
        <TouchableOpacity
          style={cancelButtonStyle}
          onPress={onCancel}
          disabled={cancelling}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          accessibilityRole="button"
          accessibilityLabel="Cancel upload"
          accessibilityState={{ disabled: cancelling }}
          testID="upload-cancel-button"
        >
          <Text style={cancelTextStyle}>{'X'}</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}
