import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  FlatList,
  Linking,
  ScrollView,
  Text,
  TouchableOpacity,
  View,
  type ListRenderItemInfo,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useTheme } from '../theme';
import { useAuth, useUI, useConversations, useNotifications } from '../stores';
import { logout, deleteAccount } from '../services/authService';
import type { DeleteAccountResult } from '../services/authService';
import type { BlockingOrbit } from '../services/api/errors';
import { getGroupQuota } from '../services/api/groups';
import { fetchCreatorOrbitsDecrypted } from '../services/conversationService';
import type { DecryptedGroup } from '../services/conversationService';
import { requestPermissionAndRegister, deregisterCurrentDevice } from '../services/notificationService';
import { useAppStore } from '../stores/useAppStore';
import messaging from '@react-native-firebase/messaging';
import { Header } from '../components/Header';
import { ProfileCard } from './settings/ProfileCard';
import { SettingsRow } from './settings/SettingsRow';
import { QuotaBar } from './settings/QuotaBar';
import { DeletePasswordModal } from './settings/DeletePasswordModal';
import { OrbitAdminActions } from './settings/OrbitAdminActions';
import { OrbitalSpinner } from '../components/OrbitalSpinner';
import { EmojiText } from '../components/EmojiText';
import type { GroupQuotaResponse } from '../types/api';
import type { SettingsStackParamList } from '../navigation/types';

type ColorSchemeLabel = 'Light' | 'Dark' | 'System';

const SCHEME_LABELS: Record<string, ColorSchemeLabel> = {
  light: 'Light',
  dark: 'Dark',
  system: 'System',
};

const SCHEME_EMOJI: Record<string, string> = {
  light: '2600-FE0F',
  dark: '1F319',
  system: '1F504',
};

function SectionHeader({ label }: { label: string }): React.JSX.Element {
  const theme = useTheme();

  const containerStyle: ViewStyle = {
    paddingTop: theme.spacing.base,
    paddingBottom: theme.spacing.sm,
    paddingHorizontal: theme.spacing.base,
  };

  const textStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.mono,
    fontSize: theme.typography.fontSize.sm,
    color: theme.colors.textTertiary,
    textAlign: 'center',
  };

  return (
    <View style={containerStyle}>
      <Text style={textStyle}>{`─── ${label} ───`}</Text>
    </View>
  );
}

export function SettingsScreen(): React.JSX.Element {
  const theme = useTheme();
  const navigation = useNavigation<NativeStackNavigationProp<SettingsStackParamList>>();
  const { displayName, username, avatarPath } = useAuth();
  const { colorScheme, setColorScheme, soundEnabled, setSoundEnabled } = useUI();
  const { activeConversationId, conversations } = useConversations();
  const { pushPermissionGranted } = useNotifications();

  const [quota, setQuota] = useState<GroupQuotaResponse | null>(null);

  // --- Delete account state ---
  const [deleteModalVisible, setDeleteModalVisible] = useState(false);
  const [deletePasswordError, setDeletePasswordError] = useState<string | null>(null);
  const [blockingOrbits, setBlockingOrbits] = useState<DecryptedGroup[] | null>(null);
  const [loadingBlockingOrbits, setLoadingBlockingOrbits] = useState(false);

  useEffect(() => {
    if (!activeConversationId) return;
    const activeConv = conversations[activeConversationId];
    if (activeConv?.type !== 'group') return;
    getGroupQuota(activeConversationId)
      .then(setQuota)
      .catch(() => {});
  }, [activeConversationId, conversations]);

  const name = displayName ?? username ?? 'User';

  const handleThemePicker = useCallback(() => {
    Alert.alert('Theme', 'Choose appearance', [
      { text: 'Light', onPress: () => setColorScheme('light') },
      { text: 'Dark', onPress: () => setColorScheme('dark') },
      { text: 'System', onPress: () => setColorScheme('system') },
    ]);
  }, [setColorScheme]);

  const handleLogout = useCallback(() => {
    Alert.alert('Log out of Orbital?', undefined, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Log Out', style: 'destructive', onPress: () => logout() },
    ]);
  }, []);

  const handleEditProfile = useCallback(() => {
    navigation.navigate('EditProfile');
  }, [navigation]);

  const handleToggleSound = useCallback(() => {
    setSoundEnabled(!soundEnabled);
  }, [soundEnabled, setSoundEnabled]);

  const unsubRef = useRef<(() => void) | null>(null);
  const togglingRef = useRef(false);

  const handleTogglePush = useCallback(async () => {
    if (togglingRef.current) return;
    togglingRef.current = true;
    try {
      if (pushPermissionGranted) {
        unsubRef.current?.();
        unsubRef.current = null;
        await deregisterCurrentDevice();
        useAppStore.getState().setPushPermission(false);
        useAppStore.getState().setPushToken(null);
      } else {
        const authStatus = await messaging().hasPermission();
        if (authStatus === messaging.AuthorizationStatus.DENIED) {
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
        unsubRef.current?.();
        const unsub = await requestPermissionAndRegister();
        unsubRef.current = unsub;
      }
    } finally {
      togglingRef.current = false;
    }
  }, [pushPermissionGranted]);

  const handleManageOrbits = useCallback(() => {
    navigation.navigate('ManageOrbits');
  }, [navigation]);

  // --- Delete account handlers ---

  const handleDeleteAccountPress = useCallback(() => {
    Alert.alert(
      'Delete your account?',
      'This permanently deletes your account, all your messages, and removes you from all orbits. This cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => {
            setDeletePasswordError(null);
            setDeleteModalVisible(true);
          },
        },
      ],
    );
  }, []);

  const handleDeletePasswordSubmit = useCallback(async (password: string) => {
    setDeletePasswordError(null);
    const result: DeleteAccountResult = await deleteAccount(password);

    switch (result.status) {
      case 'success':
        // App auto-navigates to login via clearAuth → auth store
        setDeleteModalVisible(false);
        break;
      case 'incorrect_password':
        setDeletePasswordError('Incorrect password');
        break;
      case 'blocking_orbits':
        // Close the password modal and show the blocking orbits gate.
        // Use the AUTHORITATIVE list from the 409 response — this excludes DMs
        // and any other orbits the backend doesn't consider blocking.
        setDeleteModalVisible(false);
        setLoadingBlockingOrbits(true);
        try {
          const authoritativeIds = new Set(result.blockingOrbits.map((o: BlockingOrbit) => o.id));
          const orbits = await fetchCreatorOrbitsDecrypted();
          // Keep only orbits whose id is in the backend's authoritative blocking list
          setBlockingOrbits(orbits.filter((o) => authoritativeIds.has(o.groupId)));
        } catch {
          setBlockingOrbits([]);
        } finally {
          setLoadingBlockingOrbits(false);
        }
        break;
      case 'error':
        setDeletePasswordError(result.message);
        break;
    }
  }, []);

  const handleDeletePasswordCancel = useCallback(() => {
    setDeleteModalVisible(false);
    setDeletePasswordError(null);
  }, []);

  const handleBlockingOrbitCompleted = useCallback(
    (_action: 'transfer' | 'dissolve', groupId: string) => {
      setBlockingOrbits((prev) => {
        if (!prev) return prev;
        const updated = prev.filter((o) => o.groupId !== groupId);
        return updated;
      });
    },
    [],
  );

  const handleBlockingGateDismiss = useCallback(() => {
    setBlockingOrbits(null);
  }, []);

  const handleRetryDeleteAfterGate = useCallback(() => {
    setBlockingOrbits(null);
    setDeletePasswordError(null);
    setDeleteModalVisible(true);
  }, []);

  const containerStyle: ViewStyle = {
    flex: 1,
    backgroundColor: theme.colors.background,
  };

  // --- Blocking orbits gate view ---
  if (blockingOrbits !== null || loadingBlockingOrbits) {
    return (
      <SafeAreaView style={containerStyle} edges={['top']} testID="settings-screen">
        <Header title="Transfer or Dissolve" />
        {loadingBlockingOrbits ? (
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
            <OrbitalSpinner size={32} />
          </View>
        ) : blockingOrbits && blockingOrbits.length > 0 ? (
          <FlatList
            data={blockingOrbits}
            keyExtractor={(item: DecryptedGroup) => item.groupId}
            renderItem={({ item }: ListRenderItemInfo<DecryptedGroup>) => (
              <BlockingOrbitRow
                group={item}
                onCompleted={handleBlockingOrbitCompleted}
              />
            )}
            ListHeaderComponent={
              <View style={{ padding: theme.spacing.base }}>
                <Text style={{
                  fontFamily: theme.typography.fontFamily.body,
                  fontSize: theme.typography.fontSize.base,
                  color: theme.colors.textSecondary,
                  marginBottom: theme.spacing.md,
                }}>
                  You must transfer ownership or dissolve these orbits before deleting your account:
                </Text>
              </View>
            }
            ListFooterComponent={
              <View style={{ padding: theme.spacing.base }}>
                <TouchableOpacityButton
                  label="Cancel"
                  onPress={handleBlockingGateDismiss}
                  testID="blocking-gate-cancel"
                  theme={theme}
                />
              </View>
            }
            contentContainerStyle={{ paddingBottom: theme.spacing.xl }}
            testID="blocking-orbits-list"
          />
        ) : (
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: theme.spacing.base }}>
            <Text style={{
              fontFamily: theme.typography.fontFamily.body,
              fontSize: theme.typography.fontSize.base,
              color: theme.colors.textSecondary,
              textAlign: 'center',
              marginBottom: theme.spacing.lg,
            }}>
              All blocking orbits resolved. You can now delete your account.
            </Text>
            <TouchableOpacityButton
              label="Continue with Deletion"
              destructive
              onPress={handleRetryDeleteAfterGate}
              testID="retry-delete-button"
              theme={theme}
            />
            <View style={{ height: theme.spacing.md }} />
            <TouchableOpacityButton
              label="Cancel"
              onPress={handleBlockingGateDismiss}
              testID="blocking-gate-cancel"
              theme={theme}
            />
          </View>
        )}
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={containerStyle} edges={['top']} testID="settings-screen">
      <Header title="Settings" />
      <ScrollView>
        <ProfileCard
          displayName={name}
          username={username ?? 'user'}
          avatarUrl={avatarPath ?? null}
          onEdit={handleEditProfile}
        />

        <SectionHeader label="Appearance" />
        <SettingsRow
          emojiUnified={SCHEME_EMOJI[colorScheme] ?? '1F504'}
          label="Theme"
          value={`${SCHEME_LABELS[colorScheme] ?? 'System'} ▾`}
          onPress={handleThemePicker}
          testID="theme-row"
        />

        <SectionHeader label="Notifications" />
        <SettingsRow
          emojiUnified="1F514"
          label="Push"
          value={pushPermissionGranted ? 'On' : 'Off'}
          onPress={handleTogglePush}
          testID="push-row"
        />
        <SettingsRow
          emojiUnified="1F4F3"
          label="Sounds"
          value={soundEnabled ? 'On' : 'Off'}
          onPress={handleToggleSound}
          testID="sounds-row"
        />

        <SectionHeader label="Privacy" />
        <SettingsRow emojiUnified="1F512" label="Safety Numbers" chevron disabled />
        <SettingsRow
          emojiUnified="1F6AB"
          label="Blocked Users"
          chevron
          onPress={() => navigation.navigate('BlockedUsers')}
          testID="blocked-users-row"
        />
        <SettingsRow emojiUnified="1F441-FE0F" label="Read Receipts" value="On" chevron disabled />

        <SectionHeader label="Legal" />
        <SettingsRow
          emojiUnified="1F4DC"
          label="Privacy Policy"
          chevron
          onPress={() => Linking.openURL('https://orbitl.org/privacy')}
          testID="privacy-policy-row"
        />
        <SettingsRow
          emojiUnified="1F4CB"
          label="Terms of Service"
          chevron
          onPress={() => Linking.openURL('https://orbitl.org/terms')}
          testID="terms-of-service-row"
        />
        <SettingsRow
          emojiUnified="1F4BB"
          label="Source Code"
          chevron
          onPress={() => Linking.openURL('https://github.com/Pure-Karma-Labs/Orbital-Mobile')}
          testID="source-code-row"
        />

        <SectionHeader label="Storage" />
        <SettingsRow
          emojiUnified="1F4C1"
          label="File Library"
          chevron
          onPress={() => navigation.navigate('FileLibrary')}
          testID="file-library-row"
        />
        {quota && (
          <QuotaBar
            usedBytes={quota.storage.used}
            limitBytes={quota.storage.limit}
            percentage={quota.storage.percentage}
          />
        )}

        <SectionHeader label="Account" />
        <SettingsRow
          emojiUnified="1FA90"
          label="Manage Orbits"
          chevron
          onPress={handleManageOrbits}
          testID="manage-orbits-row"
        />
        <SettingsRow
          emojiUnified="1F6AA"
          label="Log Out"
          destructive
          onPress={handleLogout}
          testID="logout-button"
        />
        <SettingsRow
          emojiUnified="1F5D1-FE0F"
          label="Delete Account"
          destructive
          onPress={handleDeleteAccountPress}
          testID="delete-account-button"
        />

        <View style={{ height: theme.spacing.xl }} />
      </ScrollView>

      <DeletePasswordModal
        visible={deleteModalVisible}
        onCancel={handleDeletePasswordCancel}
        onSubmit={handleDeletePasswordSubmit}
        errorMessage={deletePasswordError}
      />
    </SafeAreaView>
  );
}

// ---------------------------------------------------------------------------
// BlockingOrbitRow — renders OrbitAdminActions for a single blocking orbit
// ---------------------------------------------------------------------------

interface BlockingOrbitRowProps {
  group: DecryptedGroup;
  onCompleted: (action: 'transfer' | 'dissolve', groupId: string) => void;
}

const BlockingOrbitRow = React.memo(function BlockingOrbitRow({
  group,
  onCompleted,
}: BlockingOrbitRowProps): React.JSX.Element {
  const theme = useTheme();

  const rowStyle: ViewStyle = {
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.borderSubtle,
    paddingHorizontal: theme.spacing.base,
    paddingVertical: theme.spacing.md,
  };

  const nameStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.bodyBold,
    fontSize: theme.typography.fontSize.base,
    color: theme.colors.textPrimary,
    marginBottom: theme.spacing.sm,
  };

  return (
    <View style={rowStyle} testID={`blocking-orbit-${group.groupId}`}>
      <EmojiText style={nameStyle}>{group.name}</EmojiText>
      <OrbitAdminActions group={group} onCompleted={onCompleted} />
    </View>
  );
});

// ---------------------------------------------------------------------------
// TouchableOpacityButton — simple inline button helper
// ---------------------------------------------------------------------------

interface TouchableOpacityButtonProps {
  label: string;
  onPress: () => void;
  destructive?: boolean;
  testID?: string;
  theme: ReturnType<typeof useTheme>;
}

function TouchableOpacityButton({
  label,
  onPress,
  destructive = false,
  testID,
  theme,
}: TouchableOpacityButtonProps): React.JSX.Element {
  const buttonStyle: ViewStyle = {
    backgroundColor: destructive ? theme.colors.error : theme.colors.surface,
    borderRadius: theme.borderRadius.base,
    paddingHorizontal: theme.spacing.lg,
    paddingVertical: theme.spacing.sm,
    borderWidth: destructive ? 0 : 1,
    borderColor: theme.colors.borderSubtle,
    alignSelf: 'center',
  };

  const textStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.bodyBold,
    fontSize: theme.typography.fontSize.base,
    color: destructive ? '#FFFFFF' : theme.colors.textPrimary,
    textAlign: 'center',
  };

  return (
    <TouchableOpacity onPress={onPress} style={buttonStyle} activeOpacity={0.7} testID={testID}>
      <Text style={textStyle}>{label}</Text>
    </TouchableOpacity>
  );
}

export default SettingsScreen;
