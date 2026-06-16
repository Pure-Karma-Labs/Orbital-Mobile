/**
 * OrbitAdminActions — reusable component for orbit ownership transfer and dissolution.
 *
 * Accepts a DecryptedGroup (must be creator) plus optional pre-loaded members list.
 * Fetches members on-demand if not provided. Exposes an onCompleted callback so the
 * parent screen can refresh state after a successful transfer or dissolve.
 *
 * Designed for reuse: ManageOrbitsScreen embeds it inline; WS3's account-deletion
 * pre-flow can render the same component for each blocking orbit.
 */

import React, { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  FlatList,
  Modal,
  Text,
  TouchableOpacity,
  View,
  type ListRenderItemInfo,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { useTheme } from '../../theme';
import { OrbitalSpinner } from '../../components/OrbitalSpinner';
import { EmojiText } from '../../components/EmojiText';
import {
  getGroupMembers,
  transferOrbitOwner,
  dissolveOrbit,
} from '../../services/api/groups';
import { AuthError, ValidationError } from '../../services/api/errors';
import { useAuth } from '../../stores';
import type { GroupMember } from '../../types/api';
import type { DecryptedGroup } from '../../services/conversationService';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface OrbitAdminActionsProps {
  /** The orbit to administer. Must have isCreator === true. */
  group: DecryptedGroup;
  /** Pre-loaded member list. If omitted, fetched on-demand when transfer is tapped. */
  members?: GroupMember[] | null;
  /** Called after a successful transfer or dissolve so the parent can refresh. */
  onCompleted?: (action: 'transfer' | 'dissolve', groupId: string) => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const OrbitAdminActions = React.memo(function OrbitAdminActions({
  group,
  members: membersProp,
  onCompleted,
}: OrbitAdminActionsProps): React.JSX.Element | null {
  const theme = useTheme();
  const { userId } = useAuth();

  // Transfer modal state
  const [transferModalVisible, setTransferModalVisible] = useState(false);
  const [modalMembers, setModalMembers] = useState<GroupMember[] | null>(
    membersProp ?? null,
  );
  const [loadingMembers, setLoadingMembers] = useState(false);
  const [transferring, setTransferring] = useState(false);
  const [transferError, setTransferError] = useState<string | null>(null);
  const [dissolving, setDissolving] = useState(false);

  // Sync prop members into local state if prop changes
  useEffect(() => {
    if (membersProp != null) {
      setModalMembers(membersProp);
    }
  }, [membersProp]);

  // ------- Transfer handlers -------

  const handleOpenTransfer = useCallback(async () => {
    setTransferError(null);
    setTransferModalVisible(true);

    // Fetch members if not already loaded
    if (modalMembers == null && !loadingMembers) {
      setLoadingMembers(true);
      try {
        const fetched = await getGroupMembers(group.groupId);
        setModalMembers(fetched);
      } catch {
        setTransferError('Failed to load members.');
      } finally {
        setLoadingMembers(false);
      }
    }
  }, [group.groupId, modalMembers, loadingMembers]);

  const handleTransferTo = useCallback(
    (member: GroupMember) => {
      Alert.alert(
        'Transfer ownership?',
        `Transfer "${group.name}" to @${member.username}? You'll no longer be the owner.`,
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Transfer',
            style: 'destructive',
            onPress: async () => {
              setTransferring(true);
              setTransferError(null);
              try {
                await transferOrbitOwner(group.groupId, member.userId);
                setTransferModalVisible(false);
                onCompleted?.('transfer', group.groupId);
              } catch (e) {
                if (e instanceof ValidationError && e.statusCode === 400) {
                  setTransferError(
                    "That member hasn't received the orbit's key yet — they can't take ownership until they've synced.",
                  );
                } else if (e instanceof AuthError && e.statusCode === 403) {
                  setTransferError('Only the orbit creator can transfer ownership.');
                } else {
                  setTransferError('Transfer failed. Please try again.');
                }
              } finally {
                setTransferring(false);
              }
            },
          },
        ],
      );
    },
    [group.groupId, group.name, onCompleted],
  );

  const handleCloseTransfer = useCallback(() => {
    setTransferModalVisible(false);
    setTransferError(null);
  }, []);

  // ------- Dissolve handler -------

  const handleDissolve = useCallback(() => {
    Alert.alert(
      `Dissolve "${group.name}"?`,
      'This will permanently delete this orbit and all its content for everyone. This cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Dissolve',
          style: 'destructive',
          onPress: async () => {
            setDissolving(true);
            try {
              await dissolveOrbit(group.groupId);
              onCompleted?.('dissolve', group.groupId);
            } catch (e) {
              if (e instanceof AuthError && e.statusCode === 403) {
                Alert.alert('Error', 'Only the orbit creator can dissolve this orbit.');
              } else {
                Alert.alert('Error', 'Failed to dissolve orbit. Please try again.');
              }
            } finally {
              setDissolving(false);
            }
          },
        },
      ],
    );
  }, [group.groupId, group.name, onCompleted]);

  // ------- Filter members: exclude self -------

  const otherMembers = (modalMembers ?? []).filter(
    (m) => m.userId !== userId,
  );

  // ------- Styles -------

  const containerStyle: ViewStyle = {
    marginTop: theme.spacing.sm,
    paddingTop: theme.spacing.sm,
    borderTopWidth: 1,
    borderTopColor: theme.colors.borderSubtle,
  };

  const sectionLabelStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.bodyBold,
    fontSize: theme.typography.fontSize.sm,
    color: theme.colors.textSecondary,
    marginBottom: theme.spacing.sm,
  };

  const buttonRowStyle: ViewStyle = {
    flexDirection: 'row',
    gap: theme.spacing.sm,
  };

  const transferButtonStyle: ViewStyle = {
    flex: 1,
    borderWidth: 1,
    borderColor: theme.colors.blue,
    borderRadius: theme.borderRadius.base,
    paddingVertical: theme.spacing.sm,
    alignItems: 'center',
  };

  const dissolveButtonStyle: ViewStyle = {
    flex: 1,
    borderWidth: 1,
    borderColor: theme.colors.error,
    borderRadius: theme.borderRadius.base,
    paddingVertical: theme.spacing.sm,
    alignItems: 'center',
  };

  const transferTextStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.bodyBold,
    fontSize: theme.typography.fontSize.sm,
    color: theme.colors.blue,
  };

  const dissolveTextStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.bodyBold,
    fontSize: theme.typography.fontSize.sm,
    color: theme.colors.error,
  };

  // ------- Modal styles -------

  const overlayStyle: ViewStyle = {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: theme.spacing.lg,
  };

  const modalBoxStyle: ViewStyle = {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.borderRadius.base,
    padding: theme.spacing.lg,
    width: '100%',
    maxWidth: 340,
    maxHeight: '60%',
  };

  const modalTitleStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.header,
    fontSize: theme.typography.fontSize.lg,
    color: theme.colors.textPrimary,
    marginBottom: theme.spacing.sm,
  };

  const modalSubtitleStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.body,
    fontSize: theme.typography.fontSize.sm,
    color: theme.colors.textSecondary,
    marginBottom: theme.spacing.md,
  };

  const errorTextStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.body,
    fontSize: theme.typography.fontSize.sm,
    color: theme.colors.error,
    marginBottom: theme.spacing.md,
  };

  const cancelButtonStyle: ViewStyle = {
    marginTop: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
    alignItems: 'center',
  };

  const cancelTextStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.body,
    fontSize: theme.typography.fontSize.base,
    color: theme.colors.textSecondary,
  };

  const emptyStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.body,
    fontSize: theme.typography.fontSize.sm,
    color: theme.colors.textTertiary,
    fontStyle: 'italic',
    textAlign: 'center',
    paddingVertical: theme.spacing.md,
  };

  // ------- Render -------

  const renderMemberItem = useCallback(
    ({ item }: ListRenderItemInfo<GroupMember>) => {
      const memberRowStyle: ViewStyle = {
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: theme.spacing.sm,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.borderSubtle,
      };
      const memberInfoStyle: ViewStyle = {
        flex: 1,
        marginRight: theme.spacing.sm,
      };
      const memberNameStyle: TextStyle = {
        fontFamily: theme.typography.fontFamily.body,
        fontSize: theme.typography.fontSize.base,
        color: theme.colors.textPrimary,
      };
      const memberHandleStyle: TextStyle = {
        fontFamily: theme.typography.fontFamily.mono,
        fontSize: theme.typography.fontSize.sm,
        color: theme.colors.textTertiary,
      };
      const selectBtnStyle: ViewStyle = {
        backgroundColor: theme.colors.blue,
        borderRadius: theme.borderRadius.base,
        paddingHorizontal: theme.spacing.md,
        paddingVertical: theme.spacing.xs,
      };
      const selectTxtStyle: TextStyle = {
        fontFamily: theme.typography.fontFamily.bodyBold,
        fontSize: theme.typography.fontSize.sm,
        color: '#FFFFFF',
      };

      return (
        <View style={memberRowStyle} testID={`transfer-member-${item.userId}`}>
          <View style={memberInfoStyle}>
            <EmojiText style={memberNameStyle} numberOfLines={1}>
              {item.displayName}
            </EmojiText>
            <Text style={memberHandleStyle} numberOfLines={1}>
              @{item.username}
            </Text>
          </View>
          <TouchableOpacity
            style={[selectBtnStyle, transferring && { opacity: 0.5 }]}
            onPress={() => handleTransferTo(item)}
            disabled={transferring}
            testID={`transfer-select-${item.userId}`}
          >
            <Text style={selectTxtStyle}>
              {transferring ? 'Transferring...' : 'Transfer'}
            </Text>
          </TouchableOpacity>
        </View>
      );
    },
    [theme, transferring, handleTransferTo],
  );

  const keyExtractor = useCallback((item: GroupMember) => item.userId, []);

  // If the current user is not the creator, render nothing.
  // Guard placed after all hooks to satisfy rules-of-hooks.
  if (!group.isCreator) return null;

  return (
    <View style={containerStyle} testID={`admin-actions-${group.groupId}`}>
      <Text style={sectionLabelStyle}>Admin Actions</Text>
      <View style={buttonRowStyle}>
        <TouchableOpacity
          style={transferButtonStyle}
          onPress={handleOpenTransfer}
          activeOpacity={0.7}
          testID={`transfer-button-${group.groupId}`}
        >
          <Text style={transferTextStyle}>Transfer Ownership</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[dissolveButtonStyle, dissolving && { opacity: 0.5 }]}
          onPress={handleDissolve}
          disabled={dissolving}
          activeOpacity={0.7}
          testID={`dissolve-button-${group.groupId}`}
        >
          <Text style={dissolveTextStyle}>
            {dissolving ? 'Dissolving...' : 'Dissolve Orbit'}
          </Text>
        </TouchableOpacity>
      </View>

      {/* Transfer member picker modal */}
      <Modal
        visible={transferModalVisible}
        transparent
        animationType="fade"
        onRequestClose={handleCloseTransfer}
      >
        <View style={overlayStyle}>
          <View style={modalBoxStyle}>
            <Text style={modalTitleStyle}>Transfer Ownership</Text>
            <EmojiText style={modalSubtitleStyle}>
              {`Choose a member to become the new owner of "${group.name}":`}
            </EmojiText>

            {transferError && (
              <Text style={errorTextStyle} testID="transfer-error">
                {transferError}
              </Text>
            )}

            {loadingMembers ? (
              <View
                style={{ alignItems: 'center', paddingVertical: theme.spacing.lg }}
                testID="transfer-loading"
              >
                <OrbitalSpinner size={24} />
              </View>
            ) : otherMembers.length === 0 && !transferError ? (
              <Text style={emptyStyle} testID="transfer-empty">
                No other members to transfer to.
              </Text>
            ) : (
              <FlatList
                data={otherMembers}
                renderItem={renderMemberItem}
                keyExtractor={keyExtractor}
                style={{ flexGrow: 0 }}
              />
            )}

            <TouchableOpacity
              style={cancelButtonStyle}
              onPress={handleCloseTransfer}
              testID="transfer-cancel"
            >
              <Text style={cancelTextStyle}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </View>
  );
});

export default OrbitAdminActions;
