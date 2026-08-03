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
 * Security alerts (identity key reset) are structurally exempt from every
 * toggle here — hence the caption.
 */

import React, { useCallback, useRef } from 'react';
import {
  Alert,
  Linking,
  ScrollView,
  Text,
  View,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import notifee, { AuthorizationStatus } from '@notifee/react-native';
import { useTheme } from '../../theme';
import { useAppStore } from '../../stores/useAppStore';
import {
  requestPermissionAndRegister,
  deregisterCurrentDevice,
  teardownPushRegistration,
} from '../../services/notificationService';
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
const PREF_ROWS: PrefRowSpec[] = [
  { key: 'newThread', emojiUnified: '1F4AC', label: 'New threads', testID: 'pref-new-thread-row' },
  { key: 'newReply', emojiUnified: '21A9-FE0F', label: 'Replies', testID: 'pref-new-reply-row' },
  { key: 'newDm', emojiUnified: '2709-FE0F', label: 'Direct messages', testID: 'pref-new-dm-row' },
  { key: 'memberJoined', emojiUnified: '1F44B', label: 'Member joined', testID: 'pref-member-joined-row' },
];

export function PushNotificationSettingsScreen(): React.JSX.Element {
  const theme = useTheme();
  const navigation = useNavigation();

  // Primitive + stable-object selectors: never select a freshly built object.
  const pushPermissionGranted = useAppStore((s) => s.pushPermissionGranted);
  const prefs = useAppStore((s) => s.notificationPrefs);

  // --- Master push toggle (moved from SettingsScreen) ---
  // This screen must NOT own the token-refresh listener: it unmounts on Back,
  // and tearing the listener down here kills push delivery for the session
  // (PR #677 review finding). notificationService owns the listener at module
  // scope; this screen only triggers register/teardown transitions.
  const togglingRef = useRef(false);

  const handleTogglePush = useCallback(async () => {
    if (togglingRef.current) return;
    togglingRef.current = true;
    try {
      if (pushPermissionGranted) {
        teardownPushRegistration();
        await deregisterCurrentDevice();
        useAppStore.getState().setPushPermission(false);
        useAppStore.getState().setPushToken(null);
      } else {
        const settings = await notifee.getNotificationSettings();
        if (settings.authorizationStatus === AuthorizationStatus.DENIED) {
          Alert.alert(
            'Notifications Disabled',
            'Push notifications were previously denied. Enable them in Settings.',
            [
              { text: 'Cancel', style: 'cancel' },
              { text: 'Open Settings', onPress: () => Linking.openSettings() },
            ],
          );
          return;
        }
        // Service replaces any previous listener internally; the returned
        // teardown handle is deliberately discarded — logout (App.tsx) and
        // the OFF branch above are the only legitimate teardown sites.
        await requestPermissionAndRegister();
      }
    } finally {
      togglingRef.current = false;
    }
  }, [pushPermissionGranted]);

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
          value={pushPermissionGranted ? 'On' : 'Off'}
          onPress={handleTogglePush}
          testID="push-row"
        />

        <SectionHeader label="Notify Me About" />
        {PREF_ROWS.map((row) => (
          <PrefRow
            key={row.key}
            spec={row}
            enabled={prefs[row.key]}
            disabled={!pushPermissionGranted}
            onToggle={handleTogglePref}
          />
        ))}

        <Text style={captionStyle}>Security alerts are always delivered.</Text>

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
