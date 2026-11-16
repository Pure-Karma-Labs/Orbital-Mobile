/**
 * What the run achieved, once it has settled (#928 §3.1, §4.4).
 *
 * One view for all three terminal kinds — completed, cancelled and failed —
 * because the difference is a headline and a trailer, not a layout.
 *
 * Done DISMISSES the summary. That is the only way out: the summary is not
 * rehydrated on the next launch, so the list of what did not migrate lives
 * exactly as long as this screen does. "See what wasn't imported" and Share
 * are how a member keeps it.
 */

import React from 'react';
import { Text, View, type TextStyle, type ViewStyle } from 'react-native';
import { useTheme } from '../../theme';
import { Button } from '../../components/Button';
import {
  DONE_LABEL,
  SEE_UNMIGRATED_PAST_LABEL,
  describeSummaryHeadline,
  describeSummaryLines,
} from './importCopy';

import type { ImportPreflight, ImportSummary } from '../../services/metaImport/importRunner';

export interface ImportSummaryViewProps {
  summary: ImportSummary;
  /** The run's own preflight, when it is still in hand: it carries retention. */
  preflight: ImportPreflight | null;
  onSeeUnmigrated: () => void;
  onDone: () => void;
}

export function ImportSummaryView({
  summary,
  preflight,
  onSeeUnmigrated,
  onDone,
}: ImportSummaryViewProps): React.JSX.Element {
  const theme = useTheme();

  const headlineStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.header,
    fontSize: theme.typography.fontSize.xl,
    color: theme.colors.textPrimary,
    marginBottom: theme.spacing.md,
  };

  const bodyStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.body,
    fontSize: theme.typography.fontSize.base,
    color: theme.colors.textPrimary,
    lineHeight: theme.typography.fontSize.base * theme.typography.lineHeight.normal,
    marginBottom: theme.spacing.md,
  };

  const linkStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.body,
    fontSize: theme.typography.fontSize.base,
    color: theme.colors.blue,
    minHeight: 44,
    paddingTop: theme.spacing.md,
    marginBottom: theme.spacing.sm,
  };

  const gapStyle: ViewStyle = { height: theme.spacing.md };

  const lines = describeSummaryLines(summary, preflight);
  // Anything the member might want the detail of: a skip, a failure, or a post
  // the run never reached.
  const hasUnmigrated =
    summary.failed > 0 ||
    summary.notSubmitted > 0 ||
    summary.heldVideo > 0 ||
    Object.values(summary.skippedByReason).some((count) => count > 0);

  return (
    <View testID="import-summary-view">
      <Text style={headlineStyle} accessibilityRole="header" testID="import-summary-headline">
        {describeSummaryHeadline(summary)}
      </Text>

      {lines.map((line) => (
        <Text key={line} style={bodyStyle}>
          {line}
        </Text>
      ))}

      {hasUnmigrated && (
        <Text
          style={linkStyle}
          onPress={onSeeUnmigrated}
          accessibilityRole="button"
          accessibilityLabel={SEE_UNMIGRATED_PAST_LABEL}
          testID="import-see-unmigrated"
        >
          {SEE_UNMIGRATED_PAST_LABEL}
        </Text>
      )}

      <View style={gapStyle} />
      <Button title={DONE_LABEL} onPress={onDone} testID="import-summary-done" />
    </View>
  );
}
