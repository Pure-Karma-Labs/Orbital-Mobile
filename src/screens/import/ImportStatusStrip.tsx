/**
 * One line above the tab bar while an import is live (#928 §3.4).
 *
 * ## Visual only
 *
 * It announces nothing. `CustomTabBar` returns null while the Android
 * keyboard is open, so anything mounted here disappears mid-import — which is
 * fine for a strip and fatal for an announcer. The announcer is therefore a
 * separate, render-null component mounted in `App.tsx`
 * ({@link ImportStatusAnnouncer}).
 *
 * ## Fixed height, one line
 *
 * The strip adds a fixed line above the bar and takes it away again, so tab
 * screens shrink by a known amount and restore. A wrapping line would resize
 * every screen by an amount that depends on the copy, which is how a list's
 * scroll position gets lost. `numberOfLines={1}` enforces it.
 *
 * ## Hiding affects JSX only
 *
 * While the member is already looking at an import route, the strip is
 * pointless. It returns null AFTER every hook has run — never an early return
 * before one — so the hook order cannot change with the focused route.
 */

import React, { useCallback } from 'react';
import { Text, TouchableOpacity, type TextStyle, type ViewStyle } from 'react-native';
import { useStore } from 'zustand';
import { getFocusedRouteNameFromRoute } from '@react-navigation/native';
import { useTheme } from '../../theme';
import { useAppStore } from '../../stores/useAppStore';
import { EmojiText } from '../../components/EmojiText';
import { importStore } from '../../services/metaImport/importRunner';
import { openImportStatus } from './openImportStatus';
import { deriveImportView, describeRunProgress, describeStripLine } from './importCopy';

import type { BottomTabBarProps } from '@react-navigation/bottom-tabs';

export interface ImportStatusStripProps {
  tabState: BottomTabBarProps['state'];
  navigation: BottomTabBarProps['navigation'];
}

/** While one of these is focused, the strip would only repeat the screen. */
const IMPORT_ROUTES = new Set(['ImportStatus', 'ImportHowTo', 'ImportUnmigrated']);

export function ImportStatusStrip({
  tabState,
  navigation,
}: ImportStatusStripProps): React.JSX.Element | null {
  const theme = useTheme();

  // Bare single-field selectors, as in the Settings section: an object
  // selector would rebuild on every 250 ms emission.
  const phase = useStore(importStore, (s) => s.phase);
  const jobId = useStore(importStore, (s) => s.jobId);
  const jobConversationId = useStore(importStore, (s) => s.conversationId);
  const preflight = useStore(importStore, (s) => s.preflight);
  const pauseCauses = useStore(importStore, (s) => s.pauseCauses);
  const autoRetryExhausted = useStore(importStore, (s) => s.autoRetryExhausted);
  const summary = useStore(importStore, (s) => s.summary);
  const total = useStore(importStore, (s) => s.total);
  const created = useStore(importStore, (s) => s.created);
  const duplicate = useStore(importStore, (s) => s.duplicate);
  const failed = useStore(importStore, (s) => s.failed);
  const heldVideo = useStore(importStore, (s) => s.heldVideo);

  const orbitName = useAppStore((s) =>
    jobConversationId === null ? undefined : s.conversations[jobConversationId]?.name,
  );

  const handlePress = useCallback(() => {
    openImportStatus(tabState, navigation);
  }, [tabState, navigation]);

  const view = deriveImportView({
    phase,
    jobId,
    preflight,
    pauseCauses,
    autoRetryExhausted,
    summary,
  });

  // The strip is the ONE place counts belong: the Settings row is count-free
  // precisely so that screen stays off this stream.
  const line =
    view.kind === 'running' && total > 0
      ? describeRunProgress(created + duplicate + failed + heldVideo, total)
      : describeStripLine(view);

  const settingsIndex = tabState.routes.findIndex((route) => route.name === 'Settings');
  const settingsRoute = settingsIndex < 0 ? undefined : tabState.routes[settingsIndex];
  const focusedNested =
    settingsRoute === undefined ? undefined : getFocusedRouteNameFromRoute(settingsRoute);
  const onImportRoute =
    settingsIndex >= 0 &&
    tabState.index === settingsIndex &&
    focusedNested !== undefined &&
    IMPORT_ROUTES.has(focusedNested);

  const containerStyle: ViewStyle = {
    height: theme.spacing.lg,
    justifyContent: 'center',
    paddingHorizontal: theme.spacing.base,
    backgroundColor: theme.colors.surface,
    borderTopWidth: 1,
    borderTopColor: theme.colors.borderSubtle,
  };

  const textStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.body,
    fontSize: theme.typography.fontSize.sm,
    color: theme.colors.textSecondary,
  };

  if (line === null || onImportRoute) return null;

  // The orbit name goes through EmojiText; a plain Text would render a system
  // glyph for a name with an emoji in it.
  const label = orbitName === undefined || orbitName === null ? line : `${line} · ${orbitName}`;

  return (
    <TouchableOpacity
      style={containerStyle}
      onPress={handlePress}
      activeOpacity={0.7}
      accessibilityRole="button"
      accessibilityLabel={label}
      testID="import-status-strip"
    >
      {/*
        The strip is ONE fixed-height line by design, so its text cannot be
        allowed to grow without bound at large Dynamic Type — it would simply
        be clipped (`FileLibraryScreen`'s header label is capped for the same
        reason). `EmojiText` takes no such prop and belongs to another owner,
        so the cap rides on a wrapping Text: RN's font-scaling props are
        inherited by nested Text, and the emoji images are sized from the
        style's own fontSize rather than from the OS scale.
      */}
      <Text style={textStyle} numberOfLines={1} maxFontSizeMultiplier={1.3}>
        <EmojiText style={textStyle} numberOfLines={1} testID="import-status-strip-label">
          {label}
        </EmojiText>
      </Text>
    </TouchableOpacity>
  );
}
