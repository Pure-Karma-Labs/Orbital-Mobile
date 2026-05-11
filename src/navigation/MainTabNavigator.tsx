import React from 'react';
import {
  Text,
  TouchableOpacity,
  View,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { BottomTabBarProps } from '@react-navigation/bottom-tabs';
import type { MainTabParamList } from './types';
import { useTheme } from '../theme';
import { useAppStore } from '../stores/useAppStore';
import { ThreadsStackNavigator } from './ThreadsStackNavigator';
import { ChatsStackNavigator } from './ChatsStackNavigator';
import { SettingsStackNavigator } from './SettingsStackNavigator';
import { Emoji } from '../components/Emoji';

const TAB_EMOJI: Record<string, string> = {
  Threads: '1F4AC',
  Chats: '1F4E8',
  Settings: '2699-FE0F',
};

const Tab = createBottomTabNavigator<MainTabParamList>();

function capitalizeFirst(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function CustomTabBar({ state, descriptors, navigation }: BottomTabBarProps): React.JSX.Element {
  const theme = useTheme();
  const insets = useSafeAreaInsets();

  const barStyle: ViewStyle = {
    flexDirection: 'row',
    backgroundColor: theme.colors.surface,
    borderTopWidth: 1,
    borderTopColor: theme.colors.borderStrong,
    paddingBottom: insets.bottom,
  };

  return (
    <View style={barStyle}>
      {state.routes.map((route, index) => {
        const { options } = descriptors[route.key];
        const isFocused = state.index === index;
        const isLast = index === state.routes.length - 1;
        const color = isFocused ? theme.colors.blue : theme.colors.textTertiary;

        const onPress = () => {
          const event = navigation.emit({ type: 'tabPress', target: route.key, canPreventDefault: true });
          if (!isFocused && !event.defaultPrevented) {
            navigation.navigate(route.name);
          }
        };

        const itemStyle: ViewStyle = {
          flex: 1,
          alignItems: 'center',
          justifyContent: 'center',
          paddingVertical: theme.spacing.sm,
          borderRightWidth: isLast ? 0 : 1,
          borderRightColor: theme.colors.borderStrong,
        };

        const labelStyle: TextStyle = {
          fontFamily: theme.typography.fontFamily.body,
          fontSize: theme.typography.fontSize.xs,
          color,
          marginTop: 2,
        };

        return (
          <TouchableOpacity
            key={route.key}
            style={itemStyle}
            onPress={onPress}
            accessibilityRole="tab"
            accessibilityState={{ selected: isFocused }}
            accessibilityLabel={options.tabBarAccessibilityLabel ?? route.name}
          >
            <Emoji unified={TAB_EMOJI[route.name] ?? '2753'} size={20} />
            <Text style={labelStyle}>{route.name}</Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

export function MainTabNavigator(): React.JSX.Element {
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
      tabBar={(props) => <CustomTabBar {...props} />}
      screenOptions={{
        headerShown: false,
      }}
    >
      <Tab.Screen name="Threads" component={ThreadsStackNavigator} />
      <Tab.Screen name="Chats" component={ChatsStackNavigator} />
      <Tab.Screen name="Settings" component={SettingsStackNavigator} />
    </Tab.Navigator>
  );
}
