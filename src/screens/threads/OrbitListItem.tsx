import React, { useCallback } from 'react';
import {
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { useTheme } from '../../theme';
import { Emoji } from '../../components/Emoji';

export interface OrbitListItemProps {
  conversationId: string;
  name: string;
  memberCount: number;
  isActive: boolean;
  onPress: (conversationId: string) => void;
}

export const OrbitListItem = React.memo(function OrbitListItem({
  conversationId,
  name,
  memberCount,
  isActive,
  onPress,
}: OrbitListItemProps): React.JSX.Element {
  const theme = useTheme();

  const handlePress = useCallback(() => {
    onPress(conversationId);
  }, [onPress, conversationId]);

  const containerStyle: ViewStyle = {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 52,
    paddingHorizontal: theme.spacing.base,
    paddingVertical: theme.spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.borderSubtle,
  };

  const emojiContainerStyle: ViewStyle = {
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: theme.spacing.md,
  };

  const mainStyle: ViewStyle = {
    flex: 1,
    marginRight: theme.spacing.sm,
  };

  const nameStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.bodyBold,
    fontSize: theme.typography.fontSize.base,
    color: theme.colors.textPrimary,
  };

  const memberStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.body,
    fontSize: theme.typography.fontSize.sm,
    color: theme.colors.textSecondary,
    marginTop: 2,
  };

  const checkStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.bodyBold,
    fontSize: theme.typography.fontSize.lg,
    color: theme.colors.blue,
  };

  return (
    <TouchableOpacity
      style={containerStyle}
      onPress={handlePress}
      activeOpacity={0.7}
      accessibilityRole="button"
      accessibilityLabel={`${name}, ${memberCount} members${isActive ? ', selected' : ''}`}
      accessibilityState={{ selected: isActive }}
      testID={`orbit-list-item-${conversationId}`}
    >
      <View style={emojiContainerStyle}>
        <Emoji unified="1FA90" size={24} />
      </View>
      <View style={mainStyle}>
        <Text style={nameStyle} numberOfLines={1}>
          {name}
        </Text>
        <Text style={memberStyle} numberOfLines={1}>
          {memberCount}{' '}
          <View style={{ width: 11, height: 11 }}>
            <Emoji unified="1F465" size={11} />
          </View>
        </Text>
      </View>
      {isActive && <Text style={checkStyle}>{'✓'}</Text>}
    </TouchableOpacity>
  );
});
