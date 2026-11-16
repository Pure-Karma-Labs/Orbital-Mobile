/**
 * One screen for the whole import, from preflight to summary (#928 §3.1).
 *
 * ## Why one screen and not a preflight → progress → summary chain
 *
 * The store changes phase on its OWN: a launch-time auto-resume, a pause, a
 * re-pick, the settle. A `replace` chain needs a member action to hang each
 * transition on, and there isn't one — so the chain would either miss
 * transitions or fight the back stack. This screen renders whatever
 * `deriveImportView` says the run is, and the member's Back button means the
 * same thing in every state.
 *
 * ## Busy latches
 *
 * Two actions are not instantaneous and must not look dead:
 *
 *  - **Import**: `confirmAndRunImport` opens a key session before the phase
 *    moves to `running`.
 *  - **Stop / Start over**: a cancel that arrives during a PRE-RUN pause waits
 *    for the in-flight pre-run entry to unwind first, which the transport
 *    bounds at about 15 s.
 *
 * Both latch on the run's IDENTITY — phase, job id, and whether a summary
 * exists — rather than on a timer, so the spinner clears exactly when the run
 * actually moves, and a second tap in between is a no-op.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, ScrollView, Text, View, type TextStyle, type ViewStyle } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useStore } from 'zustand';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useTheme } from '../../theme';
import { Button } from '../../components/Button';
import { Header } from '../../components/Header';
import { OrbitalSpinner } from '../../components/OrbitalSpinner';
import { ImportParseView } from './ImportParseView';
import { ImportPreflightView } from './ImportPreflightView';
import { ImportRunView } from './ImportRunView';
import { ImportSummaryView } from './ImportSummaryView';
import {
  cancelImport,
  confirmAndRunImport,
  discardImportPreflight,
  dismissImportSummary,
  importStore,
  repickArchiveParts,
  resumeImport,
  resumeImportAtLaunch,
} from '../../services/metaImport/importRunner';
import {
  CHECKING_COPY,
  DIFFERENT_ARCHIVE_CHOOSE_LABEL,
  DIFFERENT_ARCHIVE_COPY,
  DIFFERENT_ARCHIVE_DISMISS_LABEL,
  DIFFERENT_ARCHIVE_TITLE,
  DONE_LABEL,
  IMPORT_SCREEN_TITLE,
  NO_IMPORT_COPY,
  STOP_IMPORT_CONFIRM_BODY,
  STOP_IMPORT_CONFIRM_TITLE,
  STOP_IMPORT_LABEL,
  deriveImportView,
} from './importCopy';

import type { SettingsStackParamList } from '../../navigation/types';

type StatusNavigation = NativeStackNavigationProp<SettingsStackParamList, 'ImportStatus'>;

/**
 * A latch that holds until EITHER the run's identity changes OR the action
 * that set it settles.
 *
 * The identity is a STRING rather than the state object: the runner
 * republishes a new object every 250 ms while counters move, and latching on
 * that would clear the spinner on the next tick instead of on the next real
 * transition.
 *
 * The second clause is the one that matters for correctness. Several runner
 * entry points can return having published NOTHING — a call that joins an
 * in-flight pre-run entry, a `confirmAndRunImport` that returns early, a
 * cancel whose guard declines. On a signature-only latch the spinner would
 * then never clear and the member would be stuck looking at a dead button, so
 * every async action also unlatches in its own `finally`.
 */
function useRunLatch(signature: string): readonly [boolean, () => void, () => void] {
  const [latched, setLatched] = useState<string | null>(null);

  useEffect(() => {
    // Functional update, so this effect depends on the signature alone and
    // cannot loop: it clears only when the identity has actually moved on.
    setLatched((previous) => (previous === null || previous === signature ? previous : null));
  }, [signature]);

  const latch = useCallback(() => {
    setLatched(signature);
  }, [signature]);

  const unlatch = useCallback(() => {
    setLatched(null);
  }, []);

  return [latched !== null, latch, unlatch] as const;
}

export function ImportStatusScreen(): React.JSX.Element {
  const theme = useTheme();
  const navigation = useNavigation<StatusNavigation>();
  const state = useStore(importStore);
  const view = deriveImportView(state);

  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const signature = `${state.phase}|${state.jobId ?? '-'}|${state.summary === null ? '-' : 'S'}`;
  const [starting, latchStart, unlatchStart] = useRunLatch(signature);
  const [stopping, latchStop, unlatchStop] = useRunLatch(signature);
  /**
   * The blocked view's Retry, which is `resumeImportAtLaunch` — a network
   * round trip that can take as long as the transport allows. It gets its own
   * latch so the spinner lands on the button that is actually working, and the
   * two latches read each other: Start over must not be tappable mid-retry,
   * and Retry must not be tappable mid-discard.
   */
  const [retrying, latchRetry, unlatchRetry] = useRunLatch(signature);

  /**
   * The live value of {@link stopping}, for the one guard that runs OUTSIDE a
   * render: an Alert button closes over the state from the render that opened
   * the alert, which is not the value that decides whether a second cancel is
   * already on its way.
   */
  const stoppingRef = useRef(stopping);
  useEffect(() => {
    stoppingRef.current = stopping;
  }, [stopping]);

  /**
   * The two one-shot actions that are NOT covered by a latch, because neither
   * leaves a button on screen to spin: a discard pops the screen, and a
   * re-pick opens the OS picker. Two taps would pop twice (two screens off the
   * Settings stack) or open two pickers.
   */
  const discarding = useRef(false);
  const repicking = useRef(false);

  const handleBack = useCallback(() => {
    navigation.goBack();
  }, [navigation]);

  const handleSeeUnmigrated = useCallback(() => {
    navigation.navigate('ImportUnmigrated');
  }, [navigation]);

  const handleImport = useCallback(() => {
    if (starting) return;
    latchStart();
    // The phase normally ends the busy state long before this settles. The
    // `finally` is for the other case: a `confirmAndRunImport` that returns
    // having published nothing at all.
    confirmAndRunImport()
      .catch(() => {})
      .finally(() => {
        if (mounted.current) unlatchStart();
      });
  }, [starting, latchStart, unlatchStart]);

  const handleDiscard = useCallback(() => {
    // A ref, not `mounted`: both `.finally` callbacks of a double tap run
    // before the unmount commits, so the mount guard cannot stop the second
    // goBack — and two goBacks pop two screens.
    if (discarding.current) return;
    discarding.current = true;
    discardImportPreflight()
      .catch(() => {})
      .finally(() => {
        if (mounted.current) navigation.goBack();
      });
  }, [navigation]);

  const handleStartOver = useCallback(() => {
    // Mutually exclusive with Retry: both drive the same job through the
    // runner's pre-run gate, and a discard that queues behind a retry must not
    // be racing a second tap as well.
    if (stopping || retrying) return;
    latchStop();
    discardImportPreflight()
      .catch(() => {})
      .finally(() => {
        // A discard that reaches a ready job publishes idle and the signature
        // moves; one that finds nothing to do publishes nothing, and THIS is
        // what clears the spinner.
        if (mounted.current) unlatchStop();
      });
  }, [stopping, retrying, latchStop, unlatchStop]);

  const handleStop = useCallback(() => {
    if (stopping) return;
    Alert.alert(STOP_IMPORT_CONFIRM_TITLE, STOP_IMPORT_CONFIRM_BODY, [
      { text: 'Keep importing', style: 'cancel' },
      {
        text: STOP_IMPORT_LABEL,
        style: 'destructive',
        onPress: () => {
          if (!mounted.current || stoppingRef.current) return;
          latchStop();
          cancelImport();
        },
      },
    ]);
  }, [stopping, latchStop]);

  const handleRetry = useCallback(() => {
    if (view.kind === 'blocked') {
      // The preflight could not be rebuilt (offline, or an orbit the member
      // has left). This re-enters through the runner's pre-run gate, which can
      // take as long as a network round trip — so it latches, and Start over
      // is held off until it settles.
      if (retrying || stopping) return;
      latchRetry();
      resumeImportAtLaunch()
        .catch(() => {})
        .finally(() => {
          if (mounted.current) unlatchRetry();
        });
      return;
    }
    // `resumeImport` is synchronous and publishes before it returns, so there
    // is nothing to wait on and nothing to spin.
    resumeImport();
  }, [view.kind, retrying, stopping, latchRetry, unlatchRetry]);

  const handleRepick = useCallback(() => {
    if (repicking.current) return;
    repicking.current = true;
    // Captured BEFORE the call: a different archive resets the store to idle,
    // so reading either of these afterwards would read null.
    const source = state.source;
    const conversationId = state.conversationId;

    repickArchiveParts()
      .then((result) => {
        if (!mounted.current || result !== 'different-archive') return;
        Alert.alert(DIFFERENT_ARCHIVE_TITLE, DIFFERENT_ARCHIVE_COPY, [
          { text: DIFFERENT_ARCHIVE_DISMISS_LABEL, style: 'cancel', onPress: handleBack },
          {
            text: DIFFERENT_ARCHIVE_CHOOSE_LABEL,
            onPress: () => {
              if (!mounted.current || source === null || conversationId === null) return;
              navigation.replace('ImportHowTo', { source, conversationId });
            },
          },
        ]);
      })
      .catch(() => {})
      .finally(() => {
        // Released whatever the answer was: 'resumed' and 'cancelled' both
        // leave the member on this screen, able to try again.
        repicking.current = false;
      });
  }, [state.source, state.conversationId, navigation, handleBack]);

  const handleDone = useCallback(() => {
    dismissImportSummary();
    navigation.goBack();
  }, [navigation]);

  const handleCancelParse = useCallback(() => {
    cancelImport();
  }, []);

  const containerStyle: ViewStyle = {
    flex: 1,
    backgroundColor: theme.colors.background,
  };

  const contentStyle: ViewStyle = {
    paddingHorizontal: theme.spacing.base,
    paddingTop: theme.spacing.base,
    paddingBottom: theme.spacing.xl,
  };

  const bodyStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.body,
    fontSize: theme.typography.fontSize.base,
    color: theme.colors.textPrimary,
    marginBottom: theme.spacing.md,
  };

  const centreStyle: ViewStyle = {
    alignItems: 'center',
    paddingVertical: theme.spacing.xl,
  };

  return (
    <SafeAreaView style={containerStyle} edges={['top']} testID="import-status-screen">
      <Header title={IMPORT_SCREEN_TITLE} onBack={handleBack} />
      <ScrollView contentContainerStyle={contentStyle}>{renderBody()}</ScrollView>
    </SafeAreaView>
  );

  function renderBody(): React.JSX.Element {
    switch (view.kind) {
      case 'checking':
        return (
          <View style={centreStyle} testID="import-checking-view">
            <OrbitalSpinner size={32} />
            <Text style={[bodyStyle, { marginTop: theme.spacing.base }]}>{CHECKING_COPY}</Text>
          </View>
        );

      case 'parsing':
        return <ImportParseView progress={state.parseProgress} onCancel={handleCancelParse} />;

      case 'preflight':
      case 'refused':
      case 'nothing':
        // `preflight` is non-null in every `ready` state the runner publishes;
        // the null branch is `deriveImportView`'s own defensive `none`.
        return state.preflight === null ? (
          renderNone()
        ) : (
          <ImportPreflightView
            kind={view.kind}
            preflight={state.preflight}
            source={state.source ?? 'facebook'}
            busy={starting}
            onImport={handleImport}
            onDiscard={handleDiscard}
            onSeeUnmigrated={handleSeeUnmigrated}
          />
        );

      case 'running':
      case 'paused':
      case 'stalled':
      case 'repick':
      case 'blocked':
        return (
          <ImportRunView
            view={view}
            progress={state}
            busy={stopping}
            retrying={retrying}
            onStop={handleStop}
            onRetry={handleRetry}
            onRepick={handleRepick}
            onStartOver={handleStartOver}
          />
        );

      case 'completed':
      case 'cancelled':
      case 'failed':
        return state.summary === null ? (
          renderNone()
        ) : (
          <ImportSummaryView
            summary={state.summary}
            preflight={state.preflight}
            onSeeUnmigrated={handleSeeUnmigrated}
            onDone={handleDone}
          />
        );

      case 'none':
        return renderNone();
    }
  }

  function renderNone(): React.JSX.Element {
    return (
      <View testID="import-none-view">
        <Text style={bodyStyle}>{NO_IMPORT_COPY}</Text>
        <Button title={DONE_LABEL} onPress={handleBack} testID="import-none-done" />
      </View>
    );
  }
}

export default ImportStatusScreen;
