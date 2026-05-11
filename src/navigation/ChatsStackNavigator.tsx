/**
 * Stack navigator for the Chats tab.
 * ChatsList -> ChatDetail -> ThreadDetail
 */

import React from 'react';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import type { ChatsStackParamList } from './types';
import { useTheme } from '../theme';
import ChatsListScreen from '../screens/ChatsListScreen';
import { ChatDetailScreen } from '../screens/ChatDetailScreen';
import { ComposeThreadScreen } from '../screens/ComposeThreadScreen';
import ThreadDetailScreen from '../screens/ThreadDetailScreen';
import { NewChatScreen } from '../screens/NewChatScreen';

const Stack = createNativeStackNavigator<ChatsStackParamList>();

export function ChatsStackNavigator(): React.JSX.Element {
  const theme = useTheme();

  return (
    <Stack.Navigator
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: theme.colors.background },
        animation: 'slide_from_right',
      }}
    >
      <Stack.Screen name="ChatsList" component={ChatsListScreen} />
      <Stack.Screen name="ChatDetail" component={ChatDetailScreen} />
      <Stack.Screen
        name="ComposeChatThread"
        component={ComposeThreadScreen as React.ComponentType<unknown>}
      />
      <Stack.Screen
        name="ThreadDetail"
        component={ThreadDetailScreen as React.ComponentType<unknown>}
      />
      <Stack.Screen
        name="NewChat"
        component={NewChatScreen}
        options={{ presentation: 'modal' }}
      />
    </Stack.Navigator>
  );
}
