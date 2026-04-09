import React from 'react';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import type { MainTabParamList } from './types';
import { useTheme } from '../theme';
import { useAppStore } from '../stores/useAppStore';
import ThreadsScreen from '../screens/ThreadsScreen';
import ChatsScreen from '../screens/ChatsScreen';
import SettingsScreen from '../screens/SettingsScreen';

const Tab = createBottomTabNavigator<MainTabParamList>();

function capitalizeFirst(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function MainTabNavigator(): React.JSX.Element {
  const theme = useTheme();
  const initialTab = useAppStore.getState().activeTab;

  return (
    <Tab.Navigator
      initialRouteName={capitalizeFirst(initialTab) as keyof MainTabParamList}
      screenListeners={{
        state: (e) => {
          const state = e.data.state;
          if (state) {
            const route = state.routes[state.index];
            if (route) {
              useAppStore.getState().setActiveTab(
                route.name.toLowerCase() as 'threads' | 'chats' | 'settings',
              );
            }
          }
        },
      }}
      screenOptions={{
        tabBarStyle: {
          backgroundColor: theme.colors.surface,
          borderTopColor: theme.colors.borderSubtle,
        },
        tabBarActiveTintColor: theme.colors.blue,
        tabBarInactiveTintColor: theme.colors.textTertiary,
        tabBarLabelStyle: {
          fontFamily: theme.typography.fontFamily.body,
          fontSize: theme.typography.fontSize.xs,
        },
        headerShown: false,
      }}
    >
      <Tab.Screen name="Threads" component={ThreadsScreen} />
      <Tab.Screen name="Chats" component={ChatsScreen} />
      <Tab.Screen name="Settings" component={SettingsScreen} />
    </Tab.Navigator>
  );
}
