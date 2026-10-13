/**
 * The "Save all" status UI for File Library (#878).
 *
 * `BulkExportStatus` is the ONLY component subscribed to the whole run state,
 * and that is the point (#889 review): the run emits up to four times a second
 * for its whole duration, and FileLibraryScreen subscribing to all of it
 * re-rendered the 3-column grid and the unmemoized `MediaLightbox` on every
 * tick. The screen now watches `phase` alone — which changes a handful of
 * times per run — and this child absorbs the progress churn.
 *
 * The two cards below it stay presentational: every string is computed by
 * `bulkExportRunner`'s `describeBulk*` helpers, so the copy is asserted once,
 * in that module's own suite, and this file has nothing to keep in step.
 *
 * `announceProgress` is deliberately left off the bar. A progressbar role with
 * a live value announces on every tick, and a batch of 400 items would talk
 * over the user for minutes; the announcements below go out on start, pause,
 * resume and finish only.
 */

import React, { useEffect, useRef } from 'react';
import {
  AccessibilityInfo,
  Pressable,
  Text,
  View,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { useStore } from 'zustand';
import { useTheme } from '../../theme';
import { ProgressBar } from '../../components/ProgressBar';
import {
  bulkExportStore,
  cancelBulkExport,
  describeBulkProgress,
  describeBulkSummary,
  dismissBulkExportSummary,
  pluralItems,
  type BulkExportPhase,
} from '../../services/media/bulkExportRunner';

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

/**
 * The run's whole state, in one place.
 *
 * Renders nothing while idle, but stays MOUNTED so the announcements below
 * fire for a run the user started and then navigated away from and back to.
 */
export function BulkExportStatus(): React.JSX.Element | null {
  const state = useStore(bulkExportStore);

  /**
   * The phase we last announced.
   *
   * Initialised from the store's CURRENT phase, not from 'idle': coming back
   * to File Library mid-run would otherwise re-announce "Saving 37 items"
   * every time the screen mounted (#889 review).
   */
  const announcedPhaseRef = useRef<BulkExportPhase>(bulkExportStore.getState().phase);

  useEffect(() => {
    const previous = announcedPhaseRef.current;
    if (previous === state.phase) return;
    announcedPhaseRef.current = state.phase;

    if (state.phase === 'running') {
      // Start vs resume: 'idle' -> 'running' is a new run, 'paused' ->
      // 'running' is the app coming back to the foreground.
      AccessibilityInfo.announceForAccessibility(
        previous === 'paused' ? 'Saving resumed' : `Saving ${pluralItems(state.total)}`,
      );
    } else if (state.phase === 'paused') {
      AccessibilityInfo.announceForAccessibility('Saving paused');
    } else if (state.phase === 'done' && state.summary !== null) {
      AccessibilityInfo.announceForAccessibility(describeBulkSummary(state.summary));
    }
  }, [state.phase, state.total, state.summary]);

  if (state.phase === 'running' || state.phase === 'paused') {
    return (
      <BulkExportPanel
        label={describeBulkProgress(state)}
        progress={state.total > 0 ? state.completed / state.total : 0}
        paused={state.phase === 'paused'}
        onCancel={cancelBulkExport}
      />
    );
  }

  if (state.phase === 'done' && state.summary !== null) {
    return (
      <BulkExportSummaryCard
        message={describeBulkSummary(state.summary)}
        onDismiss={dismissBulkExportSummary}
      />
    );
  }

  return null;
}
