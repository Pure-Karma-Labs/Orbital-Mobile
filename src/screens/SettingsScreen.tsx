import React, { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  ScrollView,
  Text,
  View,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useTheme } from '../theme';
import { useAuth, useUI, useConversations } from '../stores';
import { logout } from '../services/authService';
import { getGroupQuota } from '../services/api/groups';
import { Header } from '../components/Header';
import { ProfileCard } from './settings/ProfileCard';
import { SettingsRow } from './settings/SettingsRow';
import { QuotaBar } from './settings/QuotaBar';
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

  const [quota, setQuota] = useState<GroupQuotaResponse | null>(null);

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

  const handleInviteFriends = useCallback(() => {
    navigation.navigate('InviteFriends');
  }, [navigation]);

  const containerStyle: ViewStyle = {
    flex: 1,
    backgroundColor: theme.colors.background,
  };

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
        <SettingsRow emojiUnified="1F514" label="Push" value="On" chevron disabled />
        <SettingsRow
          emojiUnified="1F4F3"
          label="Sounds"
          value={soundEnabled ? 'On' : 'Off'}
          onPress={handleToggleSound}
          testID="sounds-row"
        />

        <SectionHeader label="Privacy" />
        <SettingsRow emojiUnified="1F512" label="Safety Numbers" chevron disabled />
        <SettingsRow emojiUnified="1F441-FE0F" label="Read Receipts" value="On" chevron disabled />

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
          emojiUnified="1F4E4"
          label="Invite Friends"
          chevron
          onPress={handleInviteFriends}
          testID="invite-friends-row"
        />
        <SettingsRow
          emojiUnified="1F6AA"
          label="Log Out"
          destructive
          onPress={handleLogout}
          testID="logout-button"
        />

        <View style={{ height: theme.spacing.xl }} />
      </ScrollView>
    </SafeAreaView>
  );
}

export default SettingsScreen;
