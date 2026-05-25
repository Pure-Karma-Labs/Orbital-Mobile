/**
 * ManageOrbitsScreen — orbit admin screen for managing members and invite codes.
 *
 * Shows orbits where the user is the creator with expandable accordion sections
 * for member management and invite code generation.
 */

import React, { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  FlatList,
  Modal,
  Share,
  Text,
  TextInput,
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
import { OrbitalSpinner } from '../components/OrbitalSpinner';
import { ErrorBanner } from '../components/ErrorBanner';
import { EmojiText } from '../components/EmojiText';
import { Emoji } from '../components/Emoji';
import { fetchCreatorOrbitsDecrypted } from '../services/conversationService';
import type { DecryptedGroup } from '../services/conversationService';
import { getGroupMembers, generateInviteCode, removeMember } from '../services/api/groups';
import { useAuth } from '../stores';
import type { GroupMember } from '../types/api';
import type { SettingsStackParamList } from '../navigation/types';

type Props = NativeStackScreenProps<SettingsStackParamList, 'ManageOrbits'>;

export function ManageOrbitsScreen({ navigation }: Props): React.JSX.Element {
  const theme = useTheme();
  const { userId } = useAuth();

  const [groups, setGroups] = useState<DecryptedGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedOrbitId, setExpandedOrbitId] = useState<string | null>(null);
  const [membersByGroupId, setMembersByGroupId] = useState<Record<string, GroupMember[]>>({});
  const [loadingMembers, setLoadingMembers] = useState<Record<string, boolean>>({});
  const [generatingCode, setGeneratingCode] = useState(false);
  const [emailModalVisible, setEmailModalVisible] = useState(false);
  const [emailModalGroupId, setEmailModalGroupId] = useState<string | null>(null);
  const [emailInput, setEmailInput] = useState('');

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const decrypted = await fetchCreatorOrbitsDecrypted();
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

  const handleToggleExpand = useCallback(async (groupId: string) => {
    const newExpanded = groupId === expandedOrbitId ? null : groupId;
    setExpandedOrbitId(newExpanded);

    // Lazy-load members on first expand
    if (newExpanded && !membersByGroupId[newExpanded] && !loadingMembers[newExpanded]) {
      setLoadingMembers((prev) => ({ ...prev, [newExpanded]: true }));
      try {
        const members = await getGroupMembers(newExpanded);
        setMembersByGroupId((prev) => ({ ...prev, [newExpanded]: members }));
      } catch {
        // Silently fail — members section will show empty
      } finally {
        setLoadingMembers((prev) => ({ ...prev, [newExpanded]: false }));
      }
    }
  }, [expandedOrbitId, membersByGroupId, loadingMembers]);

  const handleRemoveMember = useCallback((groupId: string, member: GroupMember) => {
    Alert.alert(
      'Remove Member',
      `Remove @${member.username} from this orbit?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: async () => {
            try {
              await removeMember(groupId, member.userId);
              // Remove from local membersByGroupId
              setMembersByGroupId((prev) => ({
                ...prev,
                [groupId]: (prev[groupId] ?? []).filter((m) => m.userId !== member.userId),
              }));
              // Decrement memberCount in group list
              setGroups((prev) =>
                prev.map((g) =>
                  g.groupId === groupId
                    ? { ...g, memberCount: Math.max(0, g.memberCount - 1) }
                    : g,
                ),
              );
            } catch {
              Alert.alert('Error', 'Failed to remove member. Please try again.');
            }
          },
        },
      ],
    );
  }, []);

  const handleOpenEmailModal = useCallback((groupId: string) => {
    setEmailModalGroupId(groupId);
    setEmailInput('');
    setEmailModalVisible(true);
  }, []);

  const handleGenerateCode = useCallback(async () => {
    if (!emailModalGroupId || !emailInput.trim()) return;

    setGeneratingCode(true);
    try {
      const result = await generateInviteCode(emailModalGroupId, emailInput.trim());
      // Update group's invite code in local state
      setGroups((prev) =>
        prev.map((g) =>
          g.groupId === emailModalGroupId
            ? { ...g, inviteCode: result.inviteCode }
            : g,
        ),
      );
      setEmailModalVisible(false);
    } catch {
      Alert.alert('Error', 'Failed to generate invite code. Please try again.');
    } finally {
      setGeneratingCode(false);
    }
  }, [emailModalGroupId, emailInput]);

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
  // Render
  // ---------------------------------------------------------------------------

  const renderItem = useCallback(
    ({ item }: ListRenderItemInfo<DecryptedGroup>) => (
      <OrbitRow
        group={item}
        isExpanded={item.groupId === expandedOrbitId}
        members={membersByGroupId[item.groupId] ?? null}
        loadingMembers={loadingMembers[item.groupId] ?? false}
        currentUserId={userId ?? ''}
        onToggleExpand={handleToggleExpand}
        onRemoveMember={handleRemoveMember}
        onShare={handleShare}
        onNewCode={handleOpenEmailModal}
      />
    ),
    [expandedOrbitId, membersByGroupId, loadingMembers, userId, handleToggleExpand, handleRemoveMember, handleShare, handleOpenEmailModal],
  );

  const keyExtractor = useCallback((item: DecryptedGroup) => item.groupId, []);

  if (loading) {
    return (
      <SafeAreaView style={containerStyle} edges={['top']} testID="manage-orbits-screen">
        <Header title="Manage Orbits" onBack={handleBack} />
        <View style={centerStyle}>
          <OrbitalSpinner size={32} />
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={containerStyle} edges={['top']} testID="manage-orbits-screen">
      <Header title="Manage Orbits" onBack={handleBack} />
      <ErrorBanner message={error} />
      {groups.length === 0 ? (
        <View style={centerStyle}>
          <Text style={emptyTextStyle}>You don't manage any orbits yet.</Text>
        </View>
      ) : (
        <FlatList
          data={groups}
          renderItem={renderItem}
          keyExtractor={keyExtractor}
          contentContainerStyle={{ paddingBottom: theme.spacing.xl }}
        />
      )}

      {/* Email input modal for invite code generation */}
      <Modal
        visible={emailModalVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setEmailModalVisible(false)}
      >
        <View style={{
          flex: 1,
          backgroundColor: 'rgba(0, 0, 0, 0.5)',
          alignItems: 'center',
          justifyContent: 'center',
          padding: theme.spacing.lg,
        }}>
          <View style={{
            backgroundColor: theme.colors.surface,
            borderRadius: theme.borderRadius.base,
            padding: theme.spacing.lg,
            width: '100%',
            maxWidth: 340,
          }}>
            <Text style={{
              fontFamily: theme.typography.fontFamily.header,
              fontSize: theme.typography.fontSize.lg,
              color: theme.colors.textPrimary,
              marginBottom: theme.spacing.md,
            }}>
              Generate Invite Code
            </Text>
            <Text style={{
              fontFamily: theme.typography.fontFamily.body,
              fontSize: theme.typography.fontSize.sm,
              color: theme.colors.textSecondary,
              marginBottom: theme.spacing.sm,
            }}>
              Invitee's email:
            </Text>
            <TextInput
              style={{
                borderWidth: 1,
                borderColor: theme.colors.borderSubtle,
                borderRadius: theme.borderRadius.base,
                paddingHorizontal: theme.spacing.md,
                paddingVertical: theme.spacing.sm,
                fontFamily: theme.typography.fontFamily.body,
                fontSize: theme.typography.fontSize.base,
                color: theme.colors.textPrimary,
                marginBottom: theme.spacing.lg,
              }}
              value={emailInput}
              onChangeText={setEmailInput}
              placeholder="email@example.com"
              placeholderTextColor={theme.colors.textTertiary}
              keyboardType="email-address"
              autoCapitalize="none"
              autoCorrect={false}
              testID="email-input"
            />
            <View style={{
              flexDirection: 'row',
              justifyContent: 'flex-end',
            }}>
              <TouchableOpacity
                onPress={() => setEmailModalVisible(false)}
                style={{
                  paddingHorizontal: theme.spacing.md,
                  paddingVertical: theme.spacing.sm,
                  marginRight: theme.spacing.md,
                }}
                testID="cancel-button"
              >
                <Text style={{
                  fontFamily: theme.typography.fontFamily.body,
                  fontSize: theme.typography.fontSize.base,
                  color: theme.colors.textSecondary,
                }}>
                  Cancel
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={handleGenerateCode}
                disabled={generatingCode || !emailInput.trim()}
                style={{
                  backgroundColor: theme.colors.blue,
                  borderRadius: theme.borderRadius.base,
                  paddingHorizontal: theme.spacing.md,
                  paddingVertical: theme.spacing.sm,
                  opacity: generatingCode || !emailInput.trim() ? 0.5 : 1,
                }}
                testID="generate-button"
              >
                <Text style={{
                  fontFamily: theme.typography.fontFamily.bodyBold,
                  fontSize: theme.typography.fontSize.base,
                  color: '#FFFFFF',
                }}>
                  {generatingCode ? 'Generating...' : 'Generate'}
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

// ---------------------------------------------------------------------------
// OrbitRow sub-component
// ---------------------------------------------------------------------------

interface OrbitRowProps {
  group: DecryptedGroup;
  isExpanded: boolean;
  members: GroupMember[] | null;
  loadingMembers: boolean;
  currentUserId: string;
  onToggleExpand: (groupId: string) => void;
  onRemoveMember: (groupId: string, member: GroupMember) => void;
  onShare: (name: string, code: string) => void;
  onNewCode: (groupId: string) => void;
}

const OrbitRow = React.memo(function OrbitRow({
  group,
  isExpanded,
  members,
  loadingMembers,
  currentUserId,
  onToggleExpand,
  onRemoveMember,
  onShare,
  onNewCode,
}: OrbitRowProps): React.JSX.Element {
  const theme = useTheme();

  const rowStyle: ViewStyle = {
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.borderSubtle,
  };

  const headerStyle: ViewStyle = {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: theme.spacing.base,
    paddingVertical: theme.spacing.md,
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
  };

  const badgeStyle: ViewStyle = {
    backgroundColor: theme.colors.surface,
    borderRadius: 10,
    paddingHorizontal: theme.spacing.sm,
    paddingVertical: 2,
    marginLeft: theme.spacing.sm,
  };

  const badgeTextStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.mono,
    fontSize: theme.typography.fontSize.xs,
    color: theme.colors.textSecondary,
  };

  const chevronStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.body,
    fontSize: theme.typography.fontSize.base,
    color: theme.colors.textTertiary,
    marginLeft: theme.spacing.sm,
  };

  const expandedStyle: ViewStyle = {
    paddingHorizontal: theme.spacing.base,
    paddingBottom: theme.spacing.md,
  };

  const sectionLabelStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.bodyBold,
    fontSize: theme.typography.fontSize.sm,
    color: theme.colors.textSecondary,
    marginBottom: theme.spacing.sm,
    marginTop: theme.spacing.sm,
  };

  const memberRowStyle: ViewStyle = {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: theme.spacing.xs,
  };

  const memberInfoStyle: ViewStyle = {
    flex: 1,
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

  const removeButtonStyle: ViewStyle = {
    paddingHorizontal: theme.spacing.sm,
    paddingVertical: theme.spacing.xs,
  };

  const removeTextStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.body,
    fontSize: theme.typography.fontSize.sm,
    color: theme.colors.error,
  };

  const codeContainerStyle: ViewStyle = {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: theme.spacing.xs,
  };

  const codeStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.mono,
    fontSize: theme.typography.fontSize.sm,
    color: theme.colors.textSecondary,
    flex: 1,
  };

  const actionButtonStyle: ViewStyle = {
    backgroundColor: theme.colors.blue,
    borderRadius: theme.borderRadius.base,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.xs,
    marginLeft: theme.spacing.sm,
  };

  const actionTextStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.bodyBold,
    fontSize: theme.typography.fontSize.sm,
    color: '#FFFFFF',
  };

  const newCodeButtonStyle: ViewStyle = {
    borderWidth: 1,
    borderColor: theme.colors.borderSubtle,
    borderRadius: theme.borderRadius.base,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.xs,
    marginLeft: theme.spacing.sm,
  };

  const newCodeTextStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.body,
    fontSize: theme.typography.fontSize.sm,
    color: theme.colors.textPrimary,
  };

  return (
    <View style={rowStyle} testID={`orbit-row-${group.groupId}`}>
      <TouchableOpacity
        style={headerStyle}
        onPress={() => onToggleExpand(group.groupId)}
        activeOpacity={0.7}
        testID={`orbit-header-${group.groupId}`}
      >
        <View style={iconStyle}>
          <Emoji unified="1FA90" size={18} />
        </View>
        <View style={infoStyle}>
          <EmojiText style={nameStyle} numberOfLines={1}>
            {group.name}
          </EmojiText>
        </View>
        <View style={badgeStyle}>
          <Text style={badgeTextStyle}>{group.memberCount}</Text>
        </View>
        <Text style={chevronStyle}>{isExpanded ? '▲' : '▼'}</Text>
      </TouchableOpacity>

      {isExpanded && (
        <View style={expandedStyle} testID={`orbit-expanded-${group.groupId}`}>
          {/* Members section */}
          <Text style={sectionLabelStyle}>Members</Text>
          {loadingMembers ? (
            <OrbitalSpinner size={20} />
          ) : (
            (members ?? []).map((member) => (
              <View key={member.userId} style={memberRowStyle} testID={`member-${member.userId}`}>
                <View style={memberInfoStyle}>
                  <Text style={memberNameStyle}>{member.displayName}</Text>
                  <Text style={memberHandleStyle}>@{member.username}</Text>
                </View>
                {member.userId !== currentUserId && (
                  <TouchableOpacity
                    style={removeButtonStyle}
                    onPress={() => onRemoveMember(group.groupId, member)}
                    testID={`remove-member-${member.userId}`}
                  >
                    <Text style={removeTextStyle}>Remove</Text>
                  </TouchableOpacity>
                )}
              </View>
            ))
          )}

          {/* Invite section */}
          <Text style={sectionLabelStyle}>Invite Code</Text>
          <View style={codeContainerStyle}>
            {group.inviteCode ? (
              <>
                <Text style={codeStyle} selectable testID={`invite-code-${group.groupId}`}>
                  {group.inviteCode}
                </Text>
                <TouchableOpacity
                  style={actionButtonStyle}
                  onPress={() => onShare(group.name, group.inviteCode!)}
                  activeOpacity={0.7}
                  testID={`share-button-${group.groupId}`}
                >
                  <Text style={actionTextStyle}>Share</Text>
                </TouchableOpacity>
              </>
            ) : (
              <Text style={{
                fontFamily: theme.typography.fontFamily.body,
                fontSize: theme.typography.fontSize.sm,
                color: theme.colors.textTertiary,
                fontStyle: 'italic',
                flex: 1,
              }}>
                No active invite code
              </Text>
            )}
            <TouchableOpacity
              style={newCodeButtonStyle}
              onPress={() => onNewCode(group.groupId)}
              activeOpacity={0.7}
              testID={`new-code-button-${group.groupId}`}
            >
              <Text style={newCodeTextStyle}>New Code</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}
    </View>
  );
});

export default ManageOrbitsScreen;
