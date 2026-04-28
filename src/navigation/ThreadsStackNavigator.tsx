/**
 * Stack navigator for the Threads tab.
 * ThreadsList → ThreadDetail
 */

import React from 'react';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import type { ThreadsStackParamList } from './types';
import { useTheme } from '../theme';
import ThreadsScreen from '../screens/ThreadsScreen';
import ThreadDetailScreen from '../screens/ThreadDetailScreen';

const Stack = createNativeStackNavigator<ThreadsStackParamList>();

export function ThreadsStackNavigator(): React.JSX.Element {
  const theme = useTheme();

  return (
    <Stack.Navigator
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: theme.colors.background },
        animation: 'slide_from_right',
      }}
    >
      <Stack.Screen name="ThreadsList" component={ThreadsScreen} />
      <Stack.Screen name="ThreadDetail" component={ThreadDetailScreen} />
    </Stack.Navigator>
  );
}
