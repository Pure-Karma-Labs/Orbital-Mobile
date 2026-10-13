/**
 * The two cards File Library shows while (and after) a "Save all" run (#878).
 *
 * Presentational only: every string is computed by `bulkExportRunner`'s
 * `describeBulk*` helpers, so the copy is asserted once, in that module's own
 * suite, and this file has nothing to keep in step.
 *
 * `announceProgress` is deliberately left off the bar. A progressbar role with
 * a live value announces on every tick, and a batch of 400 items would talk
 * over the user for minutes; the screen announces once on start, once on pause
 * and once at the end instead.
 */

import React from 'react';
import {
  Pressable,
  Text,
  View,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { useTheme } from '../../theme';
import { ProgressBar } from '../../components/ProgressBar';

export interface BulkExportPanelProps {
  /** "12 of 37 items", from `describeBulkProgress`. */
  label: string;
  /** 0-1. The bar clamps, so an empty run cannot render a broken fill. */
  progress: number;
  paused: boolean;
  onCancel: () => void;
}

export function BulkExportPanel({
  label,
  progress,
  paused,
  onCancel,
}: BulkExportPanelProps): React.JSX.Element {
  const theme = useTheme();

  const containerStyle: ViewStyle = {
    paddingHorizontal: theme.spacing.base,
    paddingVertical: theme.spacing.sm,
    backgroundColor: theme.colors.surface,
  };

  const rowStyle: ViewStyle = {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: theme.spacing.xs,
  };

  const labelStyle: TextStyle = {
    flex: 1,
    fontFamily: theme.typography.fontFamily.body,
    fontSize: theme.typography.fontSize.sm,
    color: theme.colors.textPrimary,
  };

  const pausedStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.bodyBold,
    fontSize: theme.typography.fontSize.sm,
    color: theme.colors.textSecondary,
    marginRight: theme.spacing.sm,
  };

  // Matches UploadProgressBar's cancel: bodyBold at fontSize.base in
  // textSecondary, inside a 44pt-high target (MOBILE-PATTERNS: every control
  // keeps a 44pt touch target however small its glyph).
  const cancelStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.bodyBold,
    fontSize: theme.typography.fontSize.base,
    color: theme.colors.textSecondary,
  };

  const touchTargetStyle: ViewStyle = {
    minHeight: 44,
    justifyContent: 'center',
  };

  return (
    <View style={containerStyle} testID="bulk-export-panel">
      <View style={rowStyle}>
        <Text style={labelStyle} testID="bulk-export-label">
          {label}
        </Text>
        {paused ? (
          <Text style={pausedStyle} testID="bulk-export-paused">
            {'Paused'}
          </Text>
        ) : null}
        <Pressable
          onPress={onCancel}
          style={touchTargetStyle}
          testID="bulk-export-cancel"
          accessibilityRole="button"
          accessibilityLabel="Stop saving"
          hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
        >
          <Text style={cancelStyle}>{'✕'}</Text>
        </Pressable>
      </View>
      <ProgressBar
        progress={progress}
        announceProgress={false}
        testID="bulk-export-bar"
      />
    </View>
  );
}

export interface BulkExportSummaryCardProps {
  /** One sentence per fact, from `describeBulkSummary`. */
  message: string;
  onDismiss: () => void;
}

export function BulkExportSummaryCard({
  message,
  onDismiss,
}: BulkExportSummaryCardProps): React.JSX.Element {
  const theme = useTheme();

  const containerStyle: ViewStyle = {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: theme.spacing.base,
    paddingVertical: theme.spacing.sm,
    backgroundColor: theme.colors.surface,
  };

  const messageStyle: TextStyle = {
    flex: 1,
    fontFamily: theme.typography.fontFamily.body,
    fontSize: theme.typography.fontSize.sm,
    color: theme.colors.textPrimary,
  };

  const dismissStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.bodyBold,
    fontSize: theme.typography.fontSize.base,
    color: theme.colors.blue,
    marginLeft: theme.spacing.base,
  };

  const touchTargetStyle: ViewStyle = {
    minHeight: 44,
    justifyContent: 'center',
  };

  return (
    <View style={containerStyle} testID="bulk-export-summary">
      <Text style={messageStyle} testID="bulk-export-summary-message">
        {message}
      </Text>
      <Pressable
        onPress={onDismiss}
        style={touchTargetStyle}
        testID="bulk-export-dismiss"
        accessibilityRole="button"
        accessibilityLabel="Dismiss"
        hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
      >
        <Text style={dismissStyle}>{'Dismiss'}</Text>
      </Pressable>
    </View>
  );
}
