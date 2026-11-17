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
import { ErrorBanner } from '../../components/ErrorBanner';
import { canStartFromPreflight } from '../../services/metaImport/importRunner';
import { OTHER_IMPORT_SOURCE } from '../../services/metaImport/types';
import {
  DONE_LABEL,
  DONT_IMPORT_LABEL,
  NOTHING_TO_IMPORT_COPY,
  SEE_UNMIGRATED_LABEL,
  describeCloseOtherLabel,
  describeFileIssueSummaryLine,
  describeHeldVideoLine,
  describeImportButton,
  describeImportOtherInsteadLabel,
  describeOtherImportOpen,
  describePreflightLines,
  describeRefusal,
  describeSkipSummaryLine,
} from './importCopy';

import type { ImportPreflight } from '../../services/metaImport/importRunner';
import type { ImportSource, SkipReason } from '../../services/metaImport/types';

export interface ImportPreflightViewProps {
  kind: 'preflight' | 'refused' | 'nothing';
  preflight: ImportPreflight;
  /** The run is starting: the Import button stays busy until the phase moves. */
  busy: boolean;
  /** A "close the other import" call is in flight (#996). */
  closing: boolean;
  /**
   * The other source's close reported something worth saying: a failure, or
   * the honest middle where the close worked but the reprice did not.
   */
  closeNotice: { readonly message: string; readonly isError: boolean } | null;
  onImport: () => void;
  onDiscard: () => void;
  onSeeUnmigrated: () => void;
  onCloseOther: () => void;
  /** Offered when this source can't be imported but the other one is there. */
  onImportOther: ((other: ImportSource) => void) | null;
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
  busy,
  closing,
  closeNotice,
  onImport,
  onDiscard,
  onSeeUnmigrated,
  onCloseOther,
  onImportOther,
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

  const noticeStyle: TextStyle = {
    ...bodyStyle,
    fontFamily: theme.typography.fontFamily.bodyBold,
  };

  const heldVideo = preflight.heldVideo;
  const skipped = countSkipsWithoutTheirOwnLine(preflight.skippedByReason);
  const fileIssues = preflight.summary?.fileIssues.length ?? 0;

  const source = preflight.source;
  const other = OTHER_IMPORT_SOURCE[source];
  const otherOpen = preflight.otherOpenImport !== null;
  /**
   * The runner's own predicate, not a second opinion. It answers "may the run
   * START", which is strictly narrower than "is this preflight runnable": a
   * foreign open session blocks the start while leaving the parsed job intact.
   */
  const canStart = canStartFromPreflight(preflight);
  // The offer only makes sense where THIS source is a dead end and the files
  // hold the other one.
  const offerOther =
    kind !== 'preflight' &&
    onImportOther !== null &&
    preflight.summary?.otherSourceDetected === true;

  const lines: string[] =
    kind === 'preflight'
      ? [...describePreflightLines(preflight)]
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
      {otherOpen && (
        <Text style={noticeStyle} testID="import-other-open-notice">
          {describeOtherImportOpen(source)}
        </Text>
      )}
      {closeNotice !== null &&
        (closeNotice.isError ? (
          <ErrorBanner message={closeNotice.message} testID="import-close-other-error" />
        ) : (
          // Not an error: the close SUCCEEDED, only the reprice didn't.
          <Text style={bodyStyle} testID="import-close-other-stale">
            {closeNotice.message}
          </Text>
        ))}

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

      {otherOpen && (
        <React.Fragment>
          <Button
            title={describeCloseOtherLabel(source)}
            onPress={onCloseOther}
            loading={closing}
            testID="import-close-other"
          />
          <View style={buttonGapStyle} />
        </React.Fragment>
      )}

      {offerOther && (
        <React.Fragment>
          <Button
            title={describeImportOtherInsteadLabel(other)}
            onPress={() => onImportOther?.(other)}
            testID="import-other-instead"
          />
          <View style={buttonGapStyle} />
        </React.Fragment>
      )}

      {kind === 'preflight' ? (
        <React.Fragment>
          <Button
            title={describeImportButton(preflight.importable)}
            onPress={onImport}
            loading={busy}
            // The other source's open session blocks the START, not the job:
            // the parsed rows and their part grant are untouched, which is why
            // Close is offered right above instead of a dead end.
            disabled={!canStart || closing}
            testID="import-confirm"
          />
          <View style={buttonGapStyle} />
          {/* Never disabled by `closing`: walking away must always work. */}
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
