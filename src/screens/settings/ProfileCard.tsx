import React from 'react';
import {
  Text,
  TouchableOpacity,
  View,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { useTheme } from '../../theme';
import { Avatar } from '../../components/Avatar';
import { EmojiText } from '../../components/EmojiText';
import { getAvatarUrl } from '../../utils/avatarUrl';

export interface ProfileCardProps {
  displayName: string;
  username: string;
  avatarUrl: string | null;
  onEdit: () => void;
}

export const ProfileCard = React.memo(function ProfileCard({
  displayName,
  username,
  avatarUrl,
  onEdit,
}: ProfileCardProps): React.JSX.Element {
  const theme = useTheme();

  const containerStyle: ViewStyle = {
    flexDirection: 'row',
    alignItems: 'center',
    padding: theme.spacing.base,
    marginHorizontal: theme.spacing.base,
    marginTop: theme.spacing.base,
    backgroundColor: theme.colors.surfaceElevated,
    borderWidth: 1,
    borderColor: theme.colors.borderSubtle,
    borderRadius: theme.borderRadius.base,
  };

  const infoStyle: ViewStyle = {
    flex: 1,
    marginLeft: theme.spacing.md,
  };

  const nameStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.bodyBold,
    fontSize: theme.typography.fontSize.md,
    color: theme.colors.textPrimary,
  };

  const handleStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.body,
    fontSize: theme.typography.fontSize.sm,
    color: theme.colors.textSecondary,
    marginTop: 2,
  };

  const editStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.body,
    fontSize: theme.typography.fontSize.base,
    color: theme.colors.blue,
  };

  return (
    <TouchableOpacity
      style={containerStyle}
      onPress={onEdit}
      activeOpacity={0.7}
      accessibilityRole="button"
      accessibilityLabel={`${displayName}, @${username}, edit profile`}
      testID="profile-card"
    >
      <Avatar name={displayName} size={48} imageUrl={getAvatarUrl(avatarUrl)} />
      <View style={infoStyle}>
        <EmojiText style={nameStyle} numberOfLines={1}>
          {displayName}
        </EmojiText>
        <Text style={handleStyle} numberOfLines={1}>
          @{username}
        </Text>
      </View>
      <Text style={editStyle}>{'Edit →'}</Text>
    </TouchableOpacity>
  );
});
