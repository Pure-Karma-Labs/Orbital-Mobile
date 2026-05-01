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
import { ComposeThreadScreen } from '../screens/ComposeThreadScreen';
import CreateOrbitScreen from '../screens/CreateOrbitScreen';
import JoinOrbitScreen from '../screens/JoinOrbitScreen';
import { OrbitSelectorScreen } from '../screens/threads/OrbitSelectorScreen';

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
      <Stack.Screen name="ComposeThread" component={ComposeThreadScreen} />
      <Stack.Screen
        name="CreateOrbit"
        component={CreateOrbitScreen}
        options={{ presentation: 'modal' }}
      />
      <Stack.Screen
        name="JoinOrbit"
        component={JoinOrbitScreen}
        options={{ presentation: 'modal' }}
      />
      <Stack.Screen
        name="OrbitSelector"
        component={OrbitSelectorScreen}
        options={{ presentation: 'modal' }}
      />
    </Stack.Navigator>
  );
}
