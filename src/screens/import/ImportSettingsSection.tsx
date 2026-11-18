/**
 * The Meta-import entry point, in Settings, for the ACTIVE orbit (#928 §3.3).
 *
 * Settings is where this lives because there is no per-orbit settings screen,
 * and Manage Orbits is limited to the orbit's creator — while ANY member may
 * import (Alex, 2026-11-16).
 *
 * ## Why this is a component and not a block of SettingsScreen
 *
 * It subscribes to the import runner, which emits every 250 ms while a run is
 * draining. Keeping that subscription inside this component is what stops the
 * whole Settings screen — profile card, quota bar, fourteen rows — from
 * re-rendering four times a second. Two rules hold that line:
 *
 *  - **Bare single-field selectors only.** An object selector would build a
 *    fresh object per emission and re-render on every tick under zustand 5.
 *  - **The status label is COUNT-FREE.** "Importing…", never "12 of 300". The
 *    counters move on every tick; the phase does not. The counts live in the
 *    status strip and on the status screen.
 */

import React, { useCallback, useMemo } from 'react';
import { type TextStyle } from 'react-native';
import { useStore } from 'zustand';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useTheme } from '../../theme';
import { useAppStore } from '../../stores/useAppStore';
import { EmojiText } from '../../components/EmojiText';
import { SectionHeader } from '../settings/SectionHeader';
import { SettingsRow } from '../settings/SettingsRow';
import { useImportAvailability } from './useImportAvailability';
import { importStore } from '../../services/metaImport/importRunner';
import {
  IMPORT_GLYPH,
  IMPORT_SECTION_HEADER,
  OTHER_ORBIT_STATUS_LABEL,
  deriveImportView,
  describeIntoCaption,
  IMPORT_START_ROW_LABEL,
  describeOtherOrbitCaption,
  describeStripLine,
} from './importCopy';

import type { SettingsStackParamList } from '../../navigation/types';
import type { ImportViewKind } from './importCopy';

// The neutral inbox tray on these rows is the same glyph an imported thread
// now carries (#927), so it lives in `importCopy` beside the label that goes
// with it. SCREEN-SETTINGS.md puts an OpenMoji on every Settings row and all
// other call sites comply, so `SettingsRow.emojiUnified` stays required.

/**
 * Views in which a job already exists on this device. There is one import per
 * device, so the start rows are suppressed for all of them — including
 * `blocked`, whose job is real even though its preflight could not be rebuilt.
 *
 * An exhaustive `Record`, so a new view kind is a compile error here rather
 * than a second import quietly becoming startable.
 */
const JOB_ACTIVE: Readonly<Record<ImportViewKind, boolean>> = {
  checking: false,
  none: false,
  blocked: true,
  parsing: true,
  nothing: false,
  refused: false,
  preflight: true,
  running: true,
  stalled: true,
  repick: true,
  paused: true,
  completed: false,
  cancelled: false,
  failed: false,
};

export function ImportSettingsSection(): React.JSX.Element | null {
  const theme = useTheme();
  const navigation = useNavigation<NativeStackNavigationProp<SettingsStackParamList>>();

  const activeConversationId = useAppStore((s) => s.activeConversationId);
  const activeConversation = useAppStore((s) =>
    activeConversationId === null ? undefined : s.conversations[activeConversationId],
  );

  // Bare single-field selectors — see the header note.
  const phase = useStore(importStore, (s) => s.phase);
  const jobId = useStore(importStore, (s) => s.jobId);
  const jobConversationId = useStore(importStore, (s) => s.conversationId);
  const preflight = useStore(importStore, (s) => s.preflight);
  const pauseCauses = useStore(importStore, (s) => s.pauseCauses);
  const autoRetryExhausted = useStore(importStore, (s) => s.autoRetryExhausted);
  const summary = useStore(importStore, (s) => s.summary);

  const jobOrbitName = useAppStore((s) =>
    jobConversationId === null ? undefined : s.conversations[jobConversationId]?.name,
  );

  const availability = useImportAvailability(activeConversationId);

  const view = useMemo(
    () => deriveImportView({ phase, jobId, preflight, pauseCauses, autoRetryExhausted, summary }),
    [phase, jobId, preflight, pauseCauses, autoRetryExhausted, summary],
  );

  const handleStatusPress = useCallback(() => {
    navigation.navigate('ImportStatus');
  }, [navigation]);

  const handleStart = useCallback(() => {
    if (activeConversationId === null) return;
    // No source: the archive decides, and the how-to asks only if it holds
    // both (#996).
    navigation.navigate('ImportHowTo', { conversationId: activeConversationId });
  }, [navigation, activeConversationId]);

  const captionStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.body,
    fontSize: theme.typography.fontSize.sm,
    color: theme.colors.textTertiary,
    paddingHorizontal: theme.spacing.base,
    paddingBottom: theme.spacing.sm,
  };

  // --- Gating (§3.3). Every hook above runs unconditionally. ---
  if (activeConversationId === null) return null;
  if (activeConversation?.type !== 'group') return null;
  // `hydrating`: the runner has not finished asking SQLite whether a job
  // exists. Start rows now could offer a second import.
  if (phase === 'hydrating') return null;
  if (availability.status !== 'available') return null;

  // A line and a status row are the same predicate: `describeStripLine`
  // returns null for exactly the views §3.3 shows no status row for.
  const stripLine = describeStripLine(view);
  const inAnotherOrbit = jobConversationId !== null && jobConversationId !== activeConversationId;
  // Another orbit replaces the LABEL, it never creates a row: a view with no
  // line (a parsed-but-unstartable job, say) stays silent here, and the member
  // meets it through the refusal path instead.
  const statusLabel =
    stripLine === null ? null : inAnotherOrbit ? OTHER_ORBIT_STATUS_LABEL : stripLine;

  return (
    <React.Fragment>
      <SectionHeader label={IMPORT_SECTION_HEADER} />
      {/*
        The orbit's NAME only ever reaches the screen through EmojiText — a
        name with an emoji in it would render the system glyph inside a plain
        SettingsRow label. That is why the rows below stay generic.
      */}
      <EmojiText style={captionStyle} testID="import-into-caption">
        {describeIntoCaption(activeConversation.name)}
      </EmojiText>

      {statusLabel !== null && (
        <React.Fragment>
          <SettingsRow
            emojiUnified={IMPORT_GLYPH}
            label={statusLabel}
            chevron
            onPress={handleStatusPress}
            testID="import-status-row"
          />
          {inAnotherOrbit && (
            <EmojiText style={captionStyle} testID="import-other-orbit-caption">
              {describeOtherOrbitCaption(jobOrbitName ?? null)}
            </EmojiText>
          )}
        </React.Fragment>
      )}

      {!JOB_ACTIVE[view.kind] && (
        <SettingsRow
          emojiUnified={IMPORT_GLYPH}
          label={IMPORT_START_ROW_LABEL}
          chevron
          onPress={handleStart}
          testID="import-start-row"
        />
      )}
    </React.Fragment>
  );
}
