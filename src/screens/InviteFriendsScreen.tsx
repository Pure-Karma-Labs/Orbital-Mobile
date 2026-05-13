/**
 * InviteFriendsScreen — shows active invite codes per orbit with share functionality.
 *
 * Fetches groups from the API on mount and displays each orbit's invite code.
 * Uses the native Share sheet for sharing invite codes.
 */

import React, { useCallback, useEffect, useState } from 'react';
import {
  FlatList,
  Share,
  Text,
  TouchableOpacity,
  View,
  type ListRenderItemInfo,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useTheme } from '../theme';
import { Header } from '../components/Header';
import { Emoji } from '../components/Emoji';
import { OrbitalSpinner } from '../components/OrbitalSpinner';
import { ErrorBanner } from '../components/ErrorBanner';
import { EmojiText } from '../components/EmojiText';
import { fetchGroupsWithInviteCodes } from '../services/conversationService';
import { decryptGroupName, getOrFetchGroupKey } from '../services/crypto/contentCrypto';
import type { SettingsStackParamList } from '../navigation/types';

type Props = NativeStackScreenProps<SettingsStackParamList, 'InviteFriends'>;

interface DecryptedGroup {
  groupId: string;
  name: string;
  inviteCode: string | null;
}

export function InviteFriendsScreen({ navigation }: Props): React.JSX.Element {
  const theme = useTheme();
  const [groups, setGroups] = useState<DecryptedGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const rawGroups = await fetchGroupsWithInviteCodes();
        const decrypted: DecryptedGroup[] = [];

        for (const group of rawGroups) {
          let name = group.encryptedName ?? group.groupId;
          if (group.encryptedName) {
            try {
              const groupKey = await getOrFetchGroupKey(group.groupId);
              name = decryptGroupName(group.encryptedName, groupKey);
            } catch {
              name = '(encrypted)';
            }
          }
          decrypted.push({
            groupId: group.groupId,
            name,
            inviteCode: group.activeInviteCode,
          });
        }

        if (!cancelled) {
          setGroups(decrypted);
          setError(null);
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : 'Failed to load orbits');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => { cancelled = true; };
  }, []);

  const handleShare = useCallback(async (groupName: string, inviteCode: string) => {
    try {
      await Share.share({
        message: `Join my orbit "${groupName}" on Orbital! Use invite code: ${inviteCode}`,
      });
    } catch {
      // User cancelled share
    }
  }, []);

  const handleBack = useCallback(() => {
    navigation.goBack();
  }, [navigation]);

  // ---------------------------------------------------------------------------
  // Styles
  // ---------------------------------------------------------------------------

  const containerStyle: ViewStyle = {
    flex: 1,
    backgroundColor: theme.colors.background,
  };

  const centerStyle: ViewStyle = {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: theme.spacing.lg,
  };

  const emptyTextStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.body,
    fontSize: theme.typography.fontSize.base,
    color: theme.colors.textSecondary,
    textAlign: 'center',
  };

  // ---------------------------------------------------------------------------
  // Render helpers
  // ---------------------------------------------------------------------------

  const renderItem = useCallback(
    ({ item }: ListRenderItemInfo<DecryptedGroup>) => (
      <InviteGroupRow
        group={item}
        onShare={handleShare}
      />
    ),
    [handleShare],
  );

  const keyExtractor = useCallback((item: DecryptedGroup) => item.groupId, []);

  if (loading) {
    return (
      <SafeAreaView style={containerStyle} edges={['top']} testID="invite-friends-screen">
        <Header title="Invite Friends" onBack={handleBack} />
        <View style={centerStyle}>
          <OrbitalSpinner size={32} />
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={containerStyle} edges={['top']} testID="invite-friends-screen">
      <Header title="Invite Friends" onBack={handleBack} />
      <ErrorBanner message={error} />
      {groups.length === 0 ? (
        <View style={centerStyle}>
          <Text style={emptyTextStyle}>No orbits with active invite codes.</Text>
        </View>
      ) : (
        <FlatList
          data={groups}
          renderItem={renderItem}
          keyExtractor={keyExtractor}
          contentContainerStyle={{ paddingBottom: theme.spacing.xl }}
        />
      )}
    </SafeAreaView>
  );
}

// ---------------------------------------------------------------------------
// InviteGroupRow sub-component
// ---------------------------------------------------------------------------

interface InviteGroupRowProps {
  group: DecryptedGroup;
  onShare: (name: string, code: string) => void;
}

const InviteGroupRow = React.memo(function InviteGroupRow({
  group,
  onShare,
}: InviteGroupRowProps): React.JSX.Element {
  const theme = useTheme();

  const rowStyle: ViewStyle = {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: theme.spacing.base,
    paddingVertical: theme.spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.borderSubtle,
  };

  const iconStyle: ViewStyle = {
    width: 28,
    height: 28,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: theme.spacing.md,
  };

  const infoStyle: ViewStyle = {
    flex: 1,
  };

  const nameStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.bodyBold,
    fontSize: theme.typography.fontSize.base,
    color: theme.colors.textPrimary,
    marginBottom: 2,
  };

  const codeStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.mono,
    fontSize: theme.typography.fontSize.sm,
    color: theme.colors.textSecondary,
  };

  const noCodeStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.body,
    fontSize: theme.typography.fontSize.sm,
    color: theme.colors.textTertiary,
    fontStyle: 'italic',
  };

  const shareButtonStyle: ViewStyle = {
    backgroundColor: theme.colors.blue,
    borderRadius: theme.borderRadius.base,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.xs,
    marginLeft: theme.spacing.sm,
  };

  const shareTextStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.bodyBold,
    fontSize: theme.typography.fontSize.sm,
    color: '#FFFFFF',
  };

  return (
    <View style={rowStyle} testID={`invite-group-${group.groupId}`}>
      <View style={iconStyle}>
        <Emoji unified="1FA90" size={18} />
      </View>
      <View style={infoStyle}>
        <EmojiText style={nameStyle} numberOfLines={1}>
          {group.name}
        </EmojiText>
        {group.inviteCode ? (
          <Text style={codeStyle} selectable testID={`invite-code-${group.groupId}`}>
            {group.inviteCode}
          </Text>
        ) : (
          <Text style={noCodeStyle}>No active invite code</Text>
        )}
      </View>
      {group.inviteCode && (
        <TouchableOpacity
          style={shareButtonStyle}
          onPress={() => onShare(group.name, group.inviteCode!)}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityLabel={`Share invite code for ${group.name}`}
          testID={`share-button-${group.groupId}`}
        >
          <Text style={shareTextStyle}>Share</Text>
        </TouchableOpacity>
      )}
    </View>
  );
});

export default InviteFriendsScreen;
