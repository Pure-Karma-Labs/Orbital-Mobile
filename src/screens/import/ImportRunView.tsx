/**
 * The run itself, and every way it can stop moving (#928 §3.1, §4.3).
 *
 * Five view kinds share this component because they are one screen with one
 * sentence and one or two buttons: `running`, `paused`, `repick`, `stalled`
 * and `blocked`.
 *
 * ## Progress
 *
 * `(created + duplicate + failed + heldVideo) / total` reaches 100 %: `total`
 * is `declared_posts`, which already excludes the posts held at PARSE time, so
 * the `heldVideo` counter here is the extract-time set and belongs in the
 * numerator. The ProgressBar is `announceProgress={false}` with a label — the
 * line above it already says the same thing, and a value announcement per item
 * would talk over everything else.
 *
 * ## The countdown
 *
 * Only the two SCHEDULED waits have one (`rate_limited`, `allowance_wait`),
 * and only while their deadline is in the future. Every other cause clears on
 * an event, so a ticking number next to it would be a promise we cannot keep.
 * It is not announced live, for the same reason the progress is not.
 */

import React, { useEffect, useState } from 'react';
import { Text, View, type TextStyle, type ViewStyle } from 'react-native';
import { useTheme } from '../../theme';
import { Button } from '../../components/Button';
import { ProgressBar } from '../../components/ProgressBar';
import {
  BLOCKED_COPY,
  BLOCKED_RETRY_LABEL,
  PAUSE_COPY,
  START_OVER_LABEL,
  STALLED_ACTION_LABEL,
  STOP_IMPORT_LABEL,
  describeMediaProgress,
  describePauseTitle,
  describeRunProgress,
  describeStalled,
} from './importCopy';

import type { ImportView } from './importCopy';

/** The counters this view reads. A subset of the published state. */
export interface ImportRunProgress {
  readonly total: number;
  readonly created: number;
  readonly duplicate: number;
  readonly failed: number;
  readonly heldVideo: number;
  readonly mediaDone: number;
  readonly resumeAtMs: number | null;
}

export interface ImportRunViewProps {
  view: ImportView;
  progress: ImportRunProgress;
  /**
   * A stop or start-over has been asked for and the run has not settled yet.
   *
   * A cancel that arrives during a PRE-RUN pause waits for any in-flight
   * pre-run entry to unwind first, which the transport bounds at ~15 s. The
   * button therefore stays busy until the phase, the job or the summary
   * actually moves, rather than leaving a dead-looking screen the member taps
   * again.
   */
  busy: boolean;
  /** Stop: confirmed by the caller, which owns the Alert. */
  onStop: () => void;
  /** "Retry now" (paused), "Retry" (stalled) and "Retry" (blocked). */
  onRetry: () => void;
  onRepick: () => void;
  onStartOver: () => void;
}

/**
 * A once-a-second clock, running ONLY while something on screen counts down.
 *
 * Called unconditionally so the hook order never changes with the view kind.
 */
function useNow(enabled: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return undefined;
    // Re-read on the way IN, not only on the tick: a countdown that switches
    // on minutes after mount would otherwise render its first `m:ss` against
    // the mount-time clock until the first interval fires.
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [enabled]);
  return now;
}

export function ImportRunView({
  view,
  progress,
  busy,
  onStop,
  onRetry,
  onRepick,
  onStartOver,
}: ImportRunViewProps): React.JSX.Element {
  const theme = useTheme();

  const cause = view.cause;
  const wantsCountdown = view.kind === 'paused' && cause !== null && PAUSE_COPY[cause].countdown;
  const now = useNow(wantsCountdown);
  const msRemaining =
    wantsCountdown && progress.resumeAtMs !== null && progress.resumeAtMs > now
      ? progress.resumeAtMs - now
      : null;

  const titleStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.body,
    fontSize: theme.typography.fontSize.base,
    color: theme.colors.textPrimary,
    lineHeight: theme.typography.fontSize.base * theme.typography.lineHeight.normal,
    marginBottom: theme.spacing.md,
  };

  const subLineStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.body,
    fontSize: theme.typography.fontSize.sm,
    color: theme.colors.textSecondary,
    marginTop: theme.spacing.sm,
  };

  const barWrapStyle: ViewStyle = { marginBottom: theme.spacing.md };
  const buttonGapStyle: ViewStyle = { height: theme.spacing.md };

  const done = progress.created + progress.duplicate + progress.failed + progress.heldVideo;
  const progressLabel = describeRunProgress(done, progress.total);
  const showBar = progress.total > 0;

  // The sentence. One per kind, and `paused` defers to its cause's copy.
  const title =
    view.kind === 'running'
      ? progressLabel
      : view.kind === 'repick'
        ? PAUSE_COPY.needs_repick.title
        : view.kind === 'stalled'
          ? describeStalled(cause)
          : view.kind === 'blocked'
            ? BLOCKED_COPY
            : cause === null
              ? progressLabel
              : describePauseTitle(cause, msRemaining);

  // "Retry now" is offered only for the causes that a tap can actually clear:
  // network, archive_retry and key_pending. The two scheduled waits have no
  // action at all, and needs_repick is its own view.
  const pausedAction =
    view.kind === 'paused' && cause !== null && cause !== 'needs_repick'
      ? PAUSE_COPY[cause].action
      : null;

  return (
    <View testID={`import-run-view-${view.kind}`}>
      <Text style={titleStyle} testID="import-run-title">
        {title}
      </Text>

      {showBar && view.kind !== 'blocked' && (
        <View style={barWrapStyle}>
          <ProgressBar
            progress={done / progress.total}
            announceProgress={false}
            accessibilityLabel={progressLabel}
            testID="import-progress-bar"
          />
        </View>
      )}

      {view.kind === 'running' && progress.mediaDone > 0 && (
        <Text style={subLineStyle} testID="import-media-sub-line">
          {describeMediaProgress(progress.mediaDone)}
        </Text>
      )}

      <View style={buttonGapStyle} />

      {view.kind === 'blocked' ? (
        <React.Fragment>
          <Button
            title={BLOCKED_RETRY_LABEL}
            onPress={onRetry}
            disabled={busy}
            testID="import-retry"
          />
          <View style={buttonGapStyle} />
          <Button
            title={START_OVER_LABEL}
            variant="secondary"
            onPress={onStartOver}
            loading={busy}
            testID="import-start-over"
          />
        </React.Fragment>
      ) : (
        <React.Fragment>
          {view.kind === 'repick' && (
            <React.Fragment>
              <Button
                title={PAUSE_COPY.needs_repick.action ?? STALLED_ACTION_LABEL}
                onPress={onRepick}
                disabled={busy}
                testID="import-repick"
              />
              <View style={buttonGapStyle} />
            </React.Fragment>
          )}
          {view.kind === 'stalled' && (
            <React.Fragment>
              <Button
                title={STALLED_ACTION_LABEL}
                onPress={onRetry}
                disabled={busy}
                testID="import-retry"
              />
              <View style={buttonGapStyle} />
            </React.Fragment>
          )}
          {pausedAction !== null && (
            <React.Fragment>
              <Button
                title={pausedAction}
                onPress={onRetry}
                disabled={busy}
                testID="import-retry"
              />
              <View style={buttonGapStyle} />
            </React.Fragment>
          )}
          <Button
            title={STOP_IMPORT_LABEL}
            variant="secondary"
            onPress={onStop}
            loading={busy}
            testID="import-stop"
          />
        </React.Fragment>
      )}
    </View>
  );
}
