/**
 * Blocked Users settings screen.
 *
 * Lists all blocked users with an unblock button.
 *
 * The label rule (contacts → blockedUserProfiles, and the `@`-prefix
 * invariant) now lives in `utils/blockedUserLabel`, and the unblock
 * confirmation in `utils/confirmUnblock`, so this screen and the in-DM
 * `BlockedPeerNotice` cannot drift apart (#908). This screen passes NO
 * username fallback, so its behaviour is unchanged.
 */

import React, { useCallback, useMemo } from 'react';
import { FlatList, Text, TouchableOpacity, View, type ListRenderItemInfo, type TextStyle, type ViewStyle } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import { useTheme } from '../../theme';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../../stores/useAppStore';
import { blockedUserLabel } from '../../utils/blockedUserLabel';
import { confirmUnblock } from '../../utils/confirmUnblock';
import { Header } from '../../components/Header';
import { EmojiText } from '../../components/EmojiText';

interface BlockedUserRow {
  id: string;
  /** Display-ready: `@name` only when resolved (see blockedUserLabel). */
  label: string;
}

function useBlockedUserRows(): BlockedUserRow[] {
  const blockedUserIds = useAppStore(useShallow((s) => s.blockedUserIds));
  const contacts = useAppStore((s) => s.contacts);
  const profiles = useAppStore((s) => s.blockedUserProfiles);

  return useMemo(
    () =>
      blockedUserIds.map((id) => ({
        id: String(id),
        label: blockedUserLabel(id, contacts, profiles).label,
      })),
    [blockedUserIds, contacts, profiles],
  );
}

export function BlockedUsersScreen(): React.JSX.Element {
  const theme = useTheme();
  const navigation = useNavigation();
  const rows = useBlockedUserRows();

  // `label` is already handle-composed by the row (`@name` only when resolved).
  const handleUnblock = useCallback((userId: string, label: string) => {
    confirmUnblock(userId, label);
  }, []);

  const renderItem = useCallback(
    ({ item }: ListRenderItemInfo<BlockedUserRow>) => (
      <BlockedUserItem userId={item.id} label={item.label} onUnblock={handleUnblock} />
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
  /** Display-ready: `@name` only when resolved (see blockedUserLabel). */
  label: string;
  onUnblock: (userId: string, label: string) => void;
}

const BlockedUserItem = React.memo(function BlockedUserItem({
  userId,
  label,
  onUnblock,
}: BlockedUserItemProps): React.JSX.Element {
  const theme = useTheme();

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
        accessibilityLabel={`Unblock ${label}`}
      >
        <Text style={buttonTextStyle}>Unblock</Text>
      </TouchableOpacity>
    </View>
  );
});

export default BlockedUsersScreen;
