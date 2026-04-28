import React from 'react';
import { Text } from 'react-native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import type { MainTabParamList } from './types';
import { useTheme } from '../theme';
import { useAppStore } from '../stores/useAppStore';
import { ThreadsStackNavigator } from './ThreadsStackNavigator';
import ChatsScreen from '../screens/ChatsScreen';
import SettingsScreen from '../screens/SettingsScreen';
import { Emoji } from '../components/Emoji';

const TAB_ICONS: Record<string, string> = {
  Threads: '💬',
  Chats: '📨',
  Settings: '⚙️',
};

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
      screenOptions={({ route }) => ({
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
        tabBarIcon: () => (
          <Text style={{ fontSize: 20 }}>{TAB_ICONS[route.name] ?? ''}</Text>
        ),
      })}
    >
      <Tab.Screen
        name="Threads"
        component={ThreadsStackNavigator}
        options={{
          tabBarIcon: () => <Emoji unified="1F4AC" size={20} />,
        }}
      />
      <Tab.Screen
        name="Chats"
        component={ChatsScreen}
        options={{
          tabBarIcon: () => <Emoji unified="1F4E8" size={20} />,
        }}
      />
      <Tab.Screen
        name="Settings"
        component={SettingsScreen}
        options={{
          tabBarIcon: () => <Emoji unified="2699-FE0F" size={20} />,
        }}
      />
    </Tab.Navigator>
  );
}
