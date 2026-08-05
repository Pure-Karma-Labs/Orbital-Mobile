/**
 * Push Notifications settings sub-screen (#449, plan D6).
 *
 * Two layers, top to bottom:
 *   1. The MASTER push toggle — device registration itself. This logic moved
 *      here from SettingsScreen so there is exactly one bell row in the app
 *      (Settings now shows a chevron entry into this screen).
 *   2. Four per-type toggles. They are meaningless while push is off, so they
 *      render dimmed and non-pressable in that state rather than silently
 *      writing preferences the user can't observe.
 *
 * Suppression is enforced server-side (the client can't stop an APNs alert that
 * is displayed before the app runs), so these toggles are network writes, not
 * local filters. `setPref` owns that: optimistic store write, rollback on
 * rejection, no Alert for plain connectivity failures.
 *
 * Security alerts (identity key reset) are structurally exempt from the
 * per-type toggles, but not from the master toggle — master off deregisters the
 * device, so nothing arrives. The caption states whichever is true (#683).
 */

import React, { useCallback, useRef } from 'react';
import {
  ScrollView,
  Text,
  View,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import { useTheme } from '../../theme';
import { useAppStore } from '../../stores/useAppStore';
import { useNotifications } from '../../stores';
import { setPushEnabled } from '../../services/notificationService';
import { setPref } from '../../services/notificationSettingsSync';
import { Header } from '../../components/Header';
import { SettingsRow } from './SettingsRow';
import { SectionHeader } from './SectionHeader';
import type { NotificationPrefs } from '../../types/api';

interface PrefRowSpec {
  key: keyof NotificationPrefs;
  emojiUnified: string;
  label: string;
  testID: string;
}

/**
 * Order matches the backend's column order in `notification_prefs`.
 * `orbit_invite` is deliberately absent (dead push type) and
 * `identity_key_reset` is never suppressible — see plan D0.
 */
const PREF_ROWS = [
  { key: 'newThread', emojiUnified: '1F4AC', label: 'New threads', testID: 'pref-new-thread-row' },
  { key: 'newReply', emojiUnified: '21A9-FE0F', label: 'Replies', testID: 'pref-new-reply-row' },
  { key: 'newDm', emojiUnified: '2709-FE0F', label: 'Direct messages', testID: 'pref-new-dm-row' },
  { key: 'memberJoined', emojiUnified: '1F44B', label: 'Member joined', testID: 'pref-member-joined-row' },
] as const satisfies readonly PrefRowSpec[];

/**
 * Exhaustiveness (#679): every NotificationPrefs key must have a row, or a new
 * pref key silently ships with no UI. A missing row makes this alias `never`
 * and the assertion below a compile error. The reverse direction (a row for a
 * key that no longer exists) is already caught by `key: keyof NotificationPrefs`
 * on PrefRowSpec.
 *
 * Written as a bare `satisfies` statement rather than a typed const because
 * tsconfig sets noUnusedLocals — a const nothing reads is itself an error.
 */
type RowsCoverAllPrefKeys = keyof NotificationPrefs extends (typeof PREF_ROWS)[number]['key']
  ? true
  : never;
true satisfies RowsCoverAllPrefKeys;

export function PushNotificationSettingsScreen(): React.JSX.Element {
  const theme = useTheme();
  const navigation = useNavigation();

  // Primitive + stable-object selectors: never select a freshly built object.
  // pushEnabled is the single derived master-push predicate (#683) — display
  // and branch both read it, so a persisted opt-out with OS permission still
  // granted can never render On while behaving as Off.
  const { pushEnabled } = useNotifications();
  const prefs = useAppStore((s) => s.notificationPrefs);

  // --- Master push toggle (moved from SettingsScreen) ---
  // This screen must NOT own the token-refresh listener: it unmounts on Back,
  // and tearing the listener down here kills push delivery for the session
  // (PR #677 review finding). notificationService owns the listener at module
  // scope AND owns both transitions (setPushEnabled) — intent, teardown,
  // deregistration and the OS-denied alert all live next to the state they
  // order. This screen only guards against a double-tap.
  const togglingRef = useRef(false);

  const handleTogglePush = useCallback(async () => {
    if (togglingRef.current) return;
    togglingRef.current = true;
    try {
      await setPushEnabled(!pushEnabled);
    } finally {
      togglingRef.current = false;
    }
  }, [pushEnabled]);

  // --- Per-type toggles ---
  const handleTogglePref = useCallback(
    (key: keyof NotificationPrefs) => {
      // Deliberately not awaited: setPref is optimistic and never throws — the
      // store flip (and any rollback) re-renders this screen on its own.
      setPref(key, !useAppStore.getState().notificationPrefs[key]);
    },
    [],
  );

  const containerStyle: ViewStyle = {
    flex: 1,
    backgroundColor: theme.colors.background,
  };

  const captionStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.body,
    fontSize: theme.typography.fontSize.sm,
    color: theme.colors.textTertiary,
    paddingHorizontal: theme.spacing.base,
    paddingTop: theme.spacing.md,
  };

  return (
    <SafeAreaView style={containerStyle} edges={['top']} testID="push-notification-settings-screen">
      <Header title="Push Notifications" onBack={() => navigation.goBack()} />
      <ScrollView>
        <SectionHeader label="Device" />
        <SettingsRow
          emojiUnified="1F514"
          label="Push"
          value={pushEnabled ? 'On' : 'Off'}
          onPress={handleTogglePush}
          testID="push-row"
        />

        <SectionHeader label="Notify Me About" />
        {PREF_ROWS.map((row) => (
          <PrefRow
            key={row.key}
            spec={row}
            enabled={prefs[row.key]}
            disabled={!pushEnabled}
            onToggle={handleTogglePref}
          />
        ))}

        {/*
          Security alerts are exempt from the per-type toggles above, but NOT
          from the master toggle — master off means the device is deregistered,
          so nothing is delivered at all. The caption is scoped accordingly
          (#683) rather than promising delivery the app cannot make.
        */}
        <Text style={captionStyle}>
          {pushEnabled
            ? 'When push is on, security alerts are always delivered.'
            : 'Push is off, so security alerts are not delivered either. Turn push on to receive them.'}
        </Text>

        <View style={{ height: theme.spacing.xl }} />
      </ScrollView>
    </SafeAreaView>
  );
}

// ---------------------------------------------------------------------------
// PrefRow — binds one pref key to a SettingsRow
// ---------------------------------------------------------------------------

interface PrefRowProps {
  spec: PrefRowSpec;
  enabled: boolean;
  disabled: boolean;
  onToggle: (key: keyof NotificationPrefs) => void;
}

const PrefRow = React.memo(function PrefRow({
  spec,
  enabled,
  disabled,
  onToggle,
}: PrefRowProps): React.JSX.Element {
  const handlePress = useCallback(() => {
    onToggle(spec.key);
  }, [onToggle, spec.key]);

  return (
    <SettingsRow
      emojiUnified={spec.emojiUnified}
      label={spec.label}
      value={enabled ? 'On' : 'Off'}
      onPress={handlePress}
      disabled={disabled}
      testID={spec.testID}
    />
  );
});

export default PushNotificationSettingsScreen;
