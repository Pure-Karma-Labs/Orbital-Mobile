/**
 * Thread detail screen — placeholder for Phase 1.
 * Shows the thread title; full implementation comes in a later phase.
 */

import React from 'react';
import { Text, type TextStyle, type ViewStyle } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useTheme } from '../theme';
import type { ThreadsStackParamList } from '../navigation/types';

export type ThreadDetailScreenProps = NativeStackScreenProps<
  ThreadsStackParamList,
  'ThreadDetail'
>;

export function ThreadDetailScreen({
  route,
}: ThreadDetailScreenProps): React.JSX.Element {
  const theme = useTheme();

  const containerStyle: ViewStyle = {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.colors.background,
    padding: theme.spacing.lg,
  };

  const titleStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.header,
    fontSize: theme.typography.fontSize.xl,
    color: theme.colors.textPrimary,
    marginBottom: theme.spacing.sm,
  };

  const subtitleStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.body,
    fontSize: theme.typography.fontSize.base,
    color: theme.colors.textSecondary,
  };

  return (
    <SafeAreaView style={containerStyle} testID="thread-detail-screen">
      <Text style={titleStyle}>Thread</Text>
      <Text style={subtitleStyle}>{route.params.threadId}</Text>
    </SafeAreaView>
  );
}

export default ThreadDetailScreen;
