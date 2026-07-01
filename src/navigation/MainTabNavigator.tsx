import React, { useEffect, useState } from 'react';
import {
  Keyboard,
  Platform,
  Text,
  TouchableOpacity,
  View,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { CommonActions } from '@react-navigation/native';
import { StackActions } from '@react-navigation/routers';
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

/**
 * Maps each tab name to the initial (root) screen of its nested stack navigator.
 * Used by the tab press handler to reset nested navigation state when switching
 * tabs or re-pressing the active tab, matching the default BottomTabBar behavior
 * that the custom tab bar was missing. See #470.
 * @internal Exported for testing only.
 */
export const TAB_INITIAL_SCREENS: Record<string, string> = {
  Threads: 'ThreadsList',
  Chats: 'ChatsList',
  Settings: 'SettingsMain',
};

const Tab = createBottomTabNavigator<MainTabParamList>();

function capitalizeFirst(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** @internal Exported for testing only. */
export function CustomTabBar({ state, descriptors, navigation }: BottomTabBarProps): React.JSX.Element | null {
  const theme = useTheme();
  const insets = useSafeAreaInsets();

  // On Android, adjustResize pushes the tab bar above the keyboard, eating
  // into the screen content area and breaking KeyboardAvoidingView layout.
  // Hide the tab bar while the keyboard is open (same as tabBarHideOnKeyboard
  // for the default tab bar, which doesn't apply to custom tabBar renders).
  const [keyboardVisible, setKeyboardVisible] = useState(false);
  useEffect(() => {
    if (Platform.OS !== 'android') return;
    const showSub = Keyboard.addListener('keyboardDidShow', () => setKeyboardVisible(true));
    const hideSub = Keyboard.addListener('keyboardDidHide', () => setKeyboardVisible(false));
    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, []);

  if (keyboardVisible) return null;

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
          if (!event.defaultPrevented) {
            const initialScreen = TAB_INITIAL_SCREENS[route.name];
            if (!initialScreen) {
              navigation.navigate(route.name);
              return;
            }

            // Always dismiss keyboard on tab press for clean transitions.
            Keyboard.dismiss();

            if (isFocused) {
              // Same-tab re-press: pop nested stack to its root screen.
              //
              // IMPORTANT: Must use StackActions.popToTop(), NOT navigate().
              // In React Navigation v7, navigate() inside a stack only matches
              // the CURRENT route by name — if the target is a different screen
              // lower in the stack, it PUSHES a duplicate instead of popping.
              // popToTop produces a proper leftward-slide (pop) animation and
              // reveals the already-mounted root screen (no fresh mount / no
              // SafeAreaView inset resolution flash).
              const nestedState = state.routes[index].state;
              const nestedRouteCount = nestedState?.routes?.length ?? 1;

              if (nestedRouteCount > 1 && nestedState?.key) {
                navigation.dispatch({
                  ...StackActions.popToTop(),
                  target: nestedState.key,
                });
              }
              // else: already at root — nothing to pop.
            } else {
              // Cross-tab: switch to the target tab and reset its nested stack
              // to root if it has depth from a previous session.
              //
              // The reset must happen WITHOUT animation (the target tab isn't
              // visible yet, so an animated pop would flash the deep screen).
              // navigate(tabName) handles the tab switch; the reset targets
              // the nested stack directly via CommonActions.reset.
              const targetNestedState = state.routes[index].state;
              const targetNestedRouteCount = targetNestedState?.routes?.length ?? 1;

              if (targetNestedRouteCount > 1 && targetNestedState?.key) {
                // Reset target tab's stack to root (instant, no animation).
                navigation.dispatch({
                  ...CommonActions.reset({
                    index: 0,
                    routes: [{ name: initialScreen }],
                  }),
                  target: targetNestedState.key,
                });
              }
              // Switch to the target tab.
              navigation.navigate(route.name);
            }
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
