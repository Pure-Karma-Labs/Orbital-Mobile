/**
 * What the archive holds, before anything is uploaded (#928 §3.1, §4.2).
 *
 * Three states share this view because they are the same screen with a
 * different verdict and a different button:
 *
 *  - `preflight` — runnable. Import / Don't import.
 *  - `refused`   — over the orbit's allowance. Done (which discards the job).
 *  - `nothing`   — the export holds nothing importable. Done.
 *
 * A preflight REBUILT at launch carries `summary === null`, so it has no date
 * range, no file issues and no location line. `describePreflightLines` is what
 * knows that; this view never invents the missing facts.
 */

import React from 'react';
import { Text, View, type TextStyle, type ViewStyle } from 'react-native';
import { useTheme } from '../../theme';
import { Button } from '../../components/Button';
import {
  DONE_LABEL,
  DONT_IMPORT_LABEL,
  NOTHING_TO_IMPORT_COPY,
  SEE_UNMIGRATED_LABEL,
  describeFileIssueSummaryLine,
  describeHeldVideoLine,
  describeImportButton,
  describePreflightLines,
  describeRefusal,
  describeSkipSummaryLine,
} from './importCopy';

import type { ImportPreflight } from '../../services/metaImport/importRunner';
import type { ImportSource, SkipReason } from '../../services/metaImport/types';

export interface ImportPreflightViewProps {
  kind: 'preflight' | 'refused' | 'nothing';
  preflight: ImportPreflight;
  source: ImportSource;
  /** The run is starting: the Import button stays busy until the phase moves. */
  busy: boolean;
  onImport: () => void;
  onDiscard: () => void;
  onSeeUnmigrated: () => void;
}

/**
 * Posts that will not be imported and do NOT already have a line of their own.
 *
 * `held_video` is excluded for the same reason it is excluded from the
 * summary's equivalent: it is named directly above, and counting it twice
 * makes the two lines contradict each other.
 */
function countSkipsWithoutTheirOwnLine(
  skippedByReason: Readonly<Record<SkipReason, number>>,
): number {
  let total = 0;
  for (const reason of Object.keys(skippedByReason) as SkipReason[]) {
    if (reason === 'held_video') continue;
    total += skippedByReason[reason];
  }
  return total;
}

export function ImportPreflightView({
  kind,
  preflight,
  source,
  busy,
  onImport,
  onDiscard,
  onSeeUnmigrated,
}: ImportPreflightViewProps): React.JSX.Element {
  const theme = useTheme();

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

  const buttonGapStyle: ViewStyle = { height: theme.spacing.md };

  const heldVideo = preflight.heldVideo;
  const skipped = countSkipsWithoutTheirOwnLine(preflight.skippedByReason);
  const fileIssues = preflight.summary?.fileIssues.length ?? 0;

  const lines: string[] =
    kind === 'preflight'
      ? [...describePreflightLines(preflight, source)]
      : kind === 'refused'
        ? [describeRefusal(preflight)]
        : [NOTHING_TO_IMPORT_COPY];

  // The runnable view already carries the held-video line inside
  // describePreflightLines; the two refusals do not.
  if (kind !== 'preflight' && heldVideo > 0) lines.push(describeHeldVideoLine(heldVideo));
  if (skipped > 0) lines.push(describeSkipSummaryLine(skipped));
  if (fileIssues > 0) lines.push(describeFileIssueSummaryLine(fileIssues));

  return (
    <View testID="import-preflight-view">
      {lines.map((line) => (
        <Text key={line} style={bodyStyle}>
          {line}
        </Text>
      ))}

      {(skipped > 0 || heldVideo > 0 || fileIssues > 0) && (
        <Text
          style={linkStyle}
          onPress={onSeeUnmigrated}
          accessibilityRole="button"
          accessibilityLabel={SEE_UNMIGRATED_LABEL}
          testID="import-see-unmigrated"
        >
          {SEE_UNMIGRATED_LABEL}
        </Text>
      )}

      {kind === 'preflight' ? (
        <React.Fragment>
          <Button
            title={describeImportButton(preflight.importable)}
            onPress={onImport}
            loading={busy}
            testID="import-confirm"
          />
          <View style={buttonGapStyle} />
          <Button
            title={DONT_IMPORT_LABEL}
            variant="secondary"
            onPress={onDiscard}
            disabled={busy}
            testID="import-discard"
          />
        </React.Fragment>
      ) : (
        <Button
          title={DONE_LABEL}
          variant="secondary"
          onPress={onDiscard}
          testID="import-discard"
        />
      )}
    </View>
  );
}
