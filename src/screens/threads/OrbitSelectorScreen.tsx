import React, { useCallback, useMemo } from 'react';
import {
  FlatList,
  View,
  type ListRenderItemInfo,
  type ViewStyle,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useTheme } from '../../theme';
import { useConversations } from '../../stores';
import type { Conversation } from '../../types/store';
import type { ThreadsStackParamList } from '../../navigation/types';
import { Header } from '../../components/Header';
import { Button } from '../../components/Button';
import { AsciiDay, AsciiSection } from '../../components/AsciiSeparator';
import { OrbitListItem } from './OrbitListItem';

type OrbitSelectorScreenProps = NativeStackScreenProps<
  ThreadsStackParamList,
  'OrbitSelector'
>;

export function OrbitSelectorScreen({
  navigation,
}: OrbitSelectorScreenProps): React.JSX.Element {
  const theme = useTheme();
  const {
    conversations,
    conversationIds,
    activeConversationId,
    setActiveConversation,
  } = useConversations();

  const orbitList = useMemo(
    () =>
      conversationIds
        .map((id) => conversations[id])
        .filter((c): c is Conversation => c != null && c.type === 'group'),
    [conversationIds, conversations],
  );

  const handleSelectOrbit = useCallback(
    (id: string) => {
      setActiveConversation(id);
      navigation.goBack();
    },
    [setActiveConversation, navigation],
  );

  const handleCreateOrbit = useCallback(() => {
    navigation.navigate('CreateOrbit');
  }, [navigation]);

  const handleJoinOrbit = useCallback(() => {
    navigation.navigate('JoinOrbit');
  }, [navigation]);

  const handleDismiss = useCallback(() => {
    navigation.goBack();
  }, [navigation]);

  const renderItem = useCallback(
    ({ item }: ListRenderItemInfo<Conversation>) => (
      <OrbitListItem
        conversationId={item.id}
        name={item.name ?? '(unnamed)'}
        memberCount={item.memberCount}
        isActive={item.id === activeConversationId}
        onPress={handleSelectOrbit}
        unreadCount={item.unreadCount}
      />
    ),
    [activeConversationId, handleSelectOrbit],
  );

  const keyExtractor = useCallback((item: Conversation) => item.id, []);

  const containerStyle: ViewStyle = {
    flex: 1,
    backgroundColor: theme.colors.background,
  };

  const footerStyle: ViewStyle = {
    paddingHorizontal: theme.spacing.base,
    paddingTop: theme.spacing.md,
    paddingBottom: theme.spacing.lg,
    gap: theme.spacing.md,
  };

  const footer = (
    <>
      <AsciiSection />
      <View style={footerStyle}>
        <Button
          title="Create Orbit"
          onPress={handleCreateOrbit}
          variant="primary"
          testID="orbit-selector-create"
        />
        <Button
          title="Join with Code"
          onPress={handleJoinOrbit}
          variant="secondary"
          testID="orbit-selector-join"
        />
      </View>
    </>
  );

  return (
    <SafeAreaView
      style={containerStyle}
      edges={['top', 'bottom']}
      testID="orbit-selector-screen"
    >
      <Header title="Switch Orbit" onBack={handleDismiss} backLabel="Close" />
      <AsciiDay label="Your Orbits" />
      <FlatList<Conversation>
        data={orbitList}
        keyExtractor={keyExtractor}
        renderItem={renderItem}
        ListFooterComponent={footer}
        contentContainerStyle={{ flexGrow: 1 }}
      />
    </SafeAreaView>
  );
}

export default OrbitSelectorScreen;
