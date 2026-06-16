/**
 * Blocked Users settings screen.
 *
 * Lists all blocked users with an unblock button.
 * Uses contact store for display name fallback, blockedUserProfiles
 * for username when the user is not in contacts.
 */

import React, { useCallback, useMemo } from 'react';
import { Alert, FlatList, Text, TouchableOpacity, View, type ListRenderItemInfo, type TextStyle, type ViewStyle } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import { useTheme } from '../../theme';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../../stores/useAppStore';
import { Header } from '../../components/Header';
import { EmojiText } from '../../components/EmojiText';

interface BlockedUserRow {
  id: string;
  displayName: string;
}

function useBlockedUserRows(): BlockedUserRow[] {
  const blockedUserIds = useAppStore(useShallow((s) => s.blockedUserIds));
  const contacts = useAppStore((s) => s.contacts);
  const profiles = useAppStore((s) => s.blockedUserProfiles);

  return useMemo(
    () =>
      blockedUserIds.map((id) => ({
        id,
        displayName: contacts[id]?.username ?? profiles[id] ?? 'Unknown',
      })),
    [blockedUserIds, contacts, profiles],
  );
}

export function BlockedUsersScreen(): React.JSX.Element {
  const theme = useTheme();
  const navigation = useNavigation();
  const rows = useBlockedUserRows();

  const handleUnblock = useCallback((userId: string, displayName: string) => {
    Alert.alert(
      `Unblock @${displayName}?`,
      'You will see their posts and replies again.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Unblock',
          onPress: () => useAppStore.getState().unblockUser(userId),
        },
      ],
    );
  }, []);

  const renderItem = useCallback(
    ({ item }: ListRenderItemInfo<BlockedUserRow>) => (
      <BlockedUserItem
        userId={item.id}
        displayName={item.displayName}
        onUnblock={handleUnblock}
      />
    ),
    [handleUnblock],
  );

  const keyExtractor = useCallback((item: BlockedUserRow) => item.id, []);

  const containerStyle: ViewStyle = {
    flex: 1,
    backgroundColor: theme.colors.background,
  };

  const emptyStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.body,
    fontSize: theme.typography.fontSize.base,
    color: theme.colors.textTertiary,
    textAlign: 'center',
    marginTop: theme.spacing.xl,
  };

  return (
    <SafeAreaView style={containerStyle} edges={['top']} testID="blocked-users-screen">
      <Header title="Blocked Users" onBack={() => navigation.goBack()} />
      {rows.length === 0 ? (
        <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
          <Text style={emptyStyle}>No blocked users</Text>
        </View>
      ) : (
        <FlatList
          data={rows}
          keyExtractor={keyExtractor}
          renderItem={renderItem}
          contentContainerStyle={{ paddingBottom: theme.spacing.xl }}
        />
      )}
    </SafeAreaView>
  );
}

// ---------------------------------------------------------------------------
// BlockedUserItem
// ---------------------------------------------------------------------------

interface BlockedUserItemProps {
  userId: string;
  displayName: string;
  onUnblock: (userId: string, displayName: string) => void;
}

const BlockedUserItem = React.memo(function BlockedUserItem({
  userId,
  displayName,
  onUnblock,
}: BlockedUserItemProps): React.JSX.Element {
  const theme = useTheme();

  const handlePress = useCallback(() => {
    onUnblock(userId, displayName);
  }, [onUnblock, userId, displayName]);

  const rowStyle: ViewStyle = {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: theme.spacing.base,
    paddingVertical: theme.spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.borderSubtle,
  };

  const nameStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.body,
    fontSize: theme.typography.fontSize.base,
    color: theme.colors.textPrimary,
    flex: 1,
  };

  const buttonStyle: ViewStyle = {
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.borderSubtle,
    borderRadius: theme.borderRadius.base,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.xs,
  };

  const buttonTextStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.bodyBold,
    fontSize: theme.typography.fontSize.sm,
    color: theme.colors.textPrimary,
  };

  return (
    <View style={rowStyle} testID={`blocked-user-${userId}`}>
      <EmojiText style={nameStyle}>{`@${displayName}`}</EmojiText>
      <TouchableOpacity
        style={buttonStyle}
        onPress={handlePress}
        activeOpacity={0.7}
        accessibilityRole="button"
        accessibilityLabel={`Unblock ${displayName}`}
      >
        <Text style={buttonTextStyle}>Unblock</Text>
      </TouchableOpacity>
    </View>
  );
});

export default BlockedUsersScreen;
