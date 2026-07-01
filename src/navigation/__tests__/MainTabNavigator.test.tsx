/**
 * Tests for CustomTabBar — the custom bottom tab bar component.
 *
 * Covers the onPress handler fix for #470:
 *  1. Non-focused tab press: navigate with initial screen params
 *  2. Focused tab re-press: navigate with initial screen params (popToTop)
 *  3. Prevented tabPress event: no navigate call
 *  4. TAB_INITIAL_SCREENS covers all three tabs
 */

import React from 'react';
import { TouchableOpacity, Platform } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import type { BottomTabBarProps } from '@react-navigation/bottom-tabs';

// ---------------------------------------------------------------------------
// Module mocks — must precede import of the module under test
// ---------------------------------------------------------------------------

// Must mock the store before MainTabNavigator is imported — it transitively
// imports react-native-mmkv which requires native NitroModules.
jest.mock('../../stores/useAppStore', () => {
  const getState = () => ({ activeTab: 'threads', setActiveTab: jest.fn() });
  const useAppStore = Object.assign(
    (selector: (s: ReturnType<typeof getState>) => unknown) => selector(getState()),
    { getState: jest.fn(getState) },
  );
  return { useAppStore };
});

jest.mock('../../theme', () => ({
  useTheme: () => ({
    colors: {
      surface: '#fff',
      borderStrong: '#ccc',
      blue: '#00f',
      textTertiary: '#999',
      background: '#fff',
    },
    spacing: { sm: 8 },
    typography: {
      fontFamily: { body: 'System' },
      fontSize: { xs: 10 },
    },
    colorScheme: 'light',
  }),
}));

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

jest.mock('../../components/Emoji', () => ({
  Emoji: () => null,
}));

// Mock the stack navigators to cut transitive native-module dependencies.
// CustomTabBar receives them via BottomTabBarProps, not direct imports,
// so these mocks only prevent the import chain from pulling in screens/services.
jest.mock('../ThreadsStackNavigator', () => ({
  ThreadsStackNavigator: () => null,
}));

jest.mock('../ChatsStackNavigator', () => ({
  ChatsStackNavigator: () => null,
}));

jest.mock('../SettingsStackNavigator', () => ({
  SettingsStackNavigator: () => null,
}));

// Import AFTER all jest.mock() calls
import { CustomTabBar, TAB_INITIAL_SCREENS } from '../MainTabNavigator';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build minimal BottomTabBarProps with overridable fields. */
function makeTabBarProps(overrides?: {
  focusedIndex?: number;
  onTabPressPreventDefault?: boolean;
}): BottomTabBarProps {
  const focusedIndex = overrides?.focusedIndex ?? 0;

  const routes = [
    { key: 'Threads-key', name: 'Threads', params: undefined },
    { key: 'Chats-key', name: 'Chats', params: undefined },
    { key: 'Settings-key', name: 'Settings', params: undefined },
  ];

  const descriptors: Record<string, { options: Record<string, unknown>; navigation: unknown; route: unknown }> = {};
  for (const route of routes) {
    descriptors[route.key] = {
      options: {},
      navigation: {},
      route,
    };
  }

  const preventDefault = overrides?.onTabPressPreventDefault ?? false;

  const navigation = {
    emit: jest.fn().mockReturnValue({ defaultPrevented: preventDefault }),
    navigate: jest.fn(),
  };

  return {
    state: {
      index: focusedIndex,
      routes,
      key: 'tab-state-key',
      routeNames: ['Threads', 'Chats', 'Settings'],
      type: 'tab',
      stale: false,
      history: [],
      preloadedRouteKeys: [],
    },
    descriptors: descriptors as unknown as BottomTabBarProps['descriptors'],
    navigation: navigation as unknown as BottomTabBarProps['navigation'],
    insets: { top: 0, bottom: 0, left: 0, right: 0 },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// Ensure keyboard useEffect doesn't run (it only fires on Android)
const originalOS = Platform.OS;
beforeAll(() => {
  (Platform as { OS: string }).OS = 'ios';
});
afterAll(() => {
  (Platform as { OS: string }).OS = originalOS;
});

describe('CustomTabBar', () => {
  describe('onPress handler (#470)', () => {
    it('navigates with initial screen params when tapping a non-focused tab', () => {
      // Focused on Threads (index 0), tap Chats (index 1)
      const props = makeTabBarProps({ focusedIndex: 0 });
      let renderer: ReactTestRenderer;
      act(() => {
        renderer = create(<CustomTabBar {...props} />);
      });

      const chatsTab = renderer!.root.findAllByType(TouchableOpacity)[1];
      act(() => {
        chatsTab.props.onPress();
      });

      const nav = props.navigation as unknown as { navigate: jest.Mock; emit: jest.Mock };
      expect(nav.emit).toHaveBeenCalledWith({
        type: 'tabPress',
        target: 'Chats-key',
        canPreventDefault: true,
      });
      expect(nav.navigate).toHaveBeenCalledWith('Chats', { screen: 'ChatsList' });

      act(() => renderer!.unmount());
    });

    it('navigates with initial screen params when re-pressing the focused tab (popToTop)', () => {
      // Focused on Threads (index 0), tap Threads again (index 0)
      const props = makeTabBarProps({ focusedIndex: 0 });
      let renderer: ReactTestRenderer;
      act(() => {
        renderer = create(<CustomTabBar {...props} />);
      });

      const threadsTab = renderer!.root.findAllByType(TouchableOpacity)[0];
      act(() => {
        threadsTab.props.onPress();
      });

      const nav = props.navigation as unknown as { navigate: jest.Mock };
      // Key assertion: navigate IS called even when isFocused === true.
      // Before the #470 fix, the !isFocused guard blocked this path entirely.
      expect(nav.navigate).toHaveBeenCalledWith('Threads', { screen: 'ThreadsList' });

      act(() => renderer!.unmount());
    });

    it('does not navigate when tabPress event is prevented', () => {
      const props = makeTabBarProps({ focusedIndex: 0, onTabPressPreventDefault: true });
      let renderer: ReactTestRenderer;
      act(() => {
        renderer = create(<CustomTabBar {...props} />);
      });

      const chatsTab = renderer!.root.findAllByType(TouchableOpacity)[1];
      act(() => {
        chatsTab.props.onPress();
      });

      const nav = props.navigation as unknown as { navigate: jest.Mock };
      expect(nav.navigate).not.toHaveBeenCalled();

      act(() => renderer!.unmount());
    });

    it('navigates Settings tab with correct initial screen', () => {
      // Focused on Threads (index 0), tap Settings (index 2)
      const props = makeTabBarProps({ focusedIndex: 0 });
      let renderer: ReactTestRenderer;
      act(() => {
        renderer = create(<CustomTabBar {...props} />);
      });

      const settingsTab = renderer!.root.findAllByType(TouchableOpacity)[2];
      act(() => {
        settingsTab.props.onPress();
      });

      const nav = props.navigation as unknown as { navigate: jest.Mock };
      expect(nav.navigate).toHaveBeenCalledWith('Settings', { screen: 'SettingsMain' });

      act(() => renderer!.unmount());
    });
  });

  describe('TAB_INITIAL_SCREENS', () => {
    it('covers all three tabs with correct initial screen names', () => {
      expect(TAB_INITIAL_SCREENS).toEqual({
        Threads: 'ThreadsList',
        Chats: 'ChatsList',
        Settings: 'SettingsMain',
      });
    });
  });
});
