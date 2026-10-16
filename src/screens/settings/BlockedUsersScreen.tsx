/**
 * Blocked Users settings screen.
 *
 * Lists all blocked users with an unblock button.
 * Uses contact store for display name fallback, blockedUserProfiles
 * for username when the user is not in contacts. Ids hydrated from the
 * server (#896) carry no username, so they render as a disambiguating
 * `user-<first 8 of id>` label rather than a shared placeholder handle.
 * That fallback is not only a pre-hydration state: a user blocked from an
 * orbit the viewer has since left has no contact row to resolve against and
 * stays id-labelled permanently. Unresolved labels render WITHOUT the `@`
 * prefix so they can never be mistaken for a real handle.
 */

import React, { useCallback, useMemo } from 'react';
import { Alert, FlatList, Text, TouchableOpacity, View, type ListRenderItemInfo, type TextStyle, type ViewStyle } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import { useTheme } from '../../theme';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../../stores/useAppStore';
import { unblockUserAndRefresh } from '../../services/blockedContentRefresh';
import { Header } from '../../components/Header';
import { EmojiText } from '../../components/EmojiText';

interface BlockedUserRow {
  id: string;
  displayName: string;
  /** False when displayName is id-derived — never prefix it with `@`. */
  resolved: boolean;
}

function useBlockedUserRows(): BlockedUserRow[] {
  const blockedUserIds = useAppStore(useShallow((s) => s.blockedUserIds));
  const contacts = useAppStore((s) => s.contacts);
  const profiles = useAppStore((s) => s.blockedUserProfiles);

  return useMemo(
    () =>
      blockedUserIds.map((id) => {
        // A corrupt persisted entry (non-string) must not throw in .slice —
        // this screen is the user's only way to undo a block.
        if (typeof id !== 'string') {
          return { id: String(id), displayName: 'Unknown user', resolved: false };
        }
        const username = contacts[id]?.username ?? profiles[id];
        return username !== undefined
          ? { id, displayName: username, resolved: true }
          : { id, displayName: `user-${id.slice(0, 8)}`, resolved: false };
      }),
    [blockedUserIds, contacts, profiles],
  );
}

export function BlockedUsersScreen(): React.JSX.Element {
  const theme = useTheme();
  const navigation = useNavigation();
  const rows = useBlockedUserRows();

  // `label` is already handle-composed by the row (`@name` only when resolved).
  const handleUnblock = useCallback((userId: string, label: string) => {
    Alert.alert(
      `Unblock ${label}?`,
      'You will see their posts and replies again.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Unblock',
          // #897: unblocking changes the server's per-viewer answer for every
          // list, so the lists are re-pulled once the DELETE settles.
          onPress: () => void unblockUserAndRefresh(userId),
        },
      ],
    );
  }, []);

  const renderItem = useCallback(
    ({ item }: ListRenderItemInfo<BlockedUserRow>) => (
      <BlockedUserItem
        userId={item.id}
        displayName={item.displayName}
        resolved={item.resolved}
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
  resolved: boolean;
  onUnblock: (userId: string, label: string) => void;
}

const BlockedUserItem = React.memo(function BlockedUserItem({
  userId,
  displayName,
  resolved,
  onUnblock,
}: BlockedUserItemProps): React.JSX.Element {
  const theme = useTheme();

  // Only a resolved username is a handle; an id-derived label is not.
  const label = resolved ? `@${displayName}` : displayName;

  const handlePress = useCallback(() => {
    onUnblock(userId, label);
  }, [onUnblock, userId, label]);

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
      <EmojiText style={nameStyle}>{label}</EmojiText>
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
