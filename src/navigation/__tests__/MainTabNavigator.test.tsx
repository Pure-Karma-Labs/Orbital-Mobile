/**
 * Tests for CustomTabBar — the custom bottom tab bar component.
 *
 * Covers:
 *  1. Cross-tab press (no stale nested state): navigate to tab
 *  2. Cross-tab press (stale nested state): reset + navigate
 *  3. Same-tab re-press at root: no-op
 *  4. Same-tab re-press with nested screen: popToTop (NOT navigate — v7 pushes duplicates)
 *  5. Keyboard.dismiss() called on every tab press with initialScreen
 *  6. Prevented tabPress event: no navigate/dispatch
 *  7. TAB_INITIAL_SCREENS covers all three tabs
 */

import React from 'react';
import { TouchableOpacity, Platform, Keyboard } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import type { BottomTabBarProps } from '@react-navigation/bottom-tabs';
import type { NavigationState, PartialState, ParamListBase } from '@react-navigation/native';

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

type NestedState = NavigationState<ParamListBase> | PartialState<NavigationState<ParamListBase>>;

/** Minimal nested navigator state (e.g. a stack with ThreadDetail on top of ThreadsList). */
function makeNestedStackState(
  screens: string[],
  key = 'NestedStack-key',
): NestedState {
  return {
    key,
    index: screens.length - 1,
    routes: screens.map((name, i) => ({
      key: `${name}-key-${i}`,
      name,
      params: undefined,
    })),
    routeNames: screens,
    type: 'stack',
    stale: false as const,
  };
}

/** Build minimal BottomTabBarProps with overridable fields. */
function makeTabBarProps(overrides?: {
  focusedIndex?: number;
  onTabPressPreventDefault?: boolean;
  /** Nested navigator state for each tab index. */
  nestedStates?: Record<number, NestedState>;
}): BottomTabBarProps {
  const focusedIndex = overrides?.focusedIndex ?? 0;

  const routes = [
    { key: 'Threads-key', name: 'Threads', params: undefined, state: overrides?.nestedStates?.[0] },
    { key: 'Chats-key', name: 'Chats', params: undefined, state: overrides?.nestedStates?.[1] },
    { key: 'Settings-key', name: 'Settings', params: undefined, state: overrides?.nestedStates?.[2] },
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
    dispatch: jest.fn(),
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
// Setup
// ---------------------------------------------------------------------------

// Ensure keyboard useEffect doesn't run (it only fires on Android)
const originalOS = Platform.OS;
beforeAll(() => {
  (Platform as { OS: string }).OS = 'ios';
});
afterAll(() => {
  (Platform as { OS: string }).OS = originalOS;
});

beforeEach(() => {
  jest.spyOn(Keyboard, 'dismiss').mockImplementation(jest.fn());
});

afterEach(() => {
  jest.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CustomTabBar', () => {
  describe('onPress handler', () => {
    // ------------------------------------------------------------------
    // Cross-tab: target tab at root (no stale nested state)
    // ------------------------------------------------------------------
    it('navigates to tab when tapping a non-focused tab at root', () => {
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

      const nav = props.navigation as unknown as { navigate: jest.Mock; emit: jest.Mock; dispatch: jest.Mock };
      expect(nav.emit).toHaveBeenCalledWith({
        type: 'tabPress',
        target: 'Chats-key',
        canPreventDefault: true,
      });
      // Cross-tab without stale state: just navigate to the tab
      expect(nav.navigate).toHaveBeenCalledWith('Chats');
      expect(nav.dispatch).not.toHaveBeenCalled();
      expect(Keyboard.dismiss).toHaveBeenCalled();

      act(() => renderer!.unmount());
    });

    // ------------------------------------------------------------------
    // Cross-tab: target tab has stale nested state from previous visit
    // ------------------------------------------------------------------
    it('resets target stack and navigates when cross-tab target has stale nested screens', () => {
      // Focused on Threads (index 0), Chats tab (index 1) has stale ChatDetail
      const props = makeTabBarProps({
        focusedIndex: 0,
        nestedStates: {
          1: makeNestedStackState(['ChatsList', 'ChatDetail'], 'ChatsStack-key'),
        },
      });
      let renderer: ReactTestRenderer;
      act(() => {
        renderer = create(<CustomTabBar {...props} />);
      });

      const chatsTab = renderer!.root.findAllByType(TouchableOpacity)[1];
      act(() => {
        chatsTab.props.onPress();
      });

      const nav = props.navigation as unknown as { navigate: jest.Mock; dispatch: jest.Mock };
      // Should dispatch a RESET to the target tab's nested stack (instant, no animation)
      expect(nav.dispatch).toHaveBeenCalledTimes(1);
      const resetAction = nav.dispatch.mock.calls[0][0];
      expect(resetAction.type).toBe('RESET');
      expect(resetAction.payload).toEqual({
        index: 0,
        routes: [{ name: 'ChatsList' }],
      });
      expect(resetAction.target).toBe('ChatsStack-key');
      // Should also navigate to switch to the tab
      expect(nav.navigate).toHaveBeenCalledWith('Chats');

      act(() => renderer!.unmount());
    });

    // ------------------------------------------------------------------
    // Same-tab re-press: already at root — no-op
    // ------------------------------------------------------------------
    it('does nothing when re-pressing focused tab already at root screen', () => {
      const props = makeTabBarProps({ focusedIndex: 0 });
      let renderer: ReactTestRenderer;
      act(() => {
        renderer = create(<CustomTabBar {...props} />);
      });

      const threadsTab = renderer!.root.findAllByType(TouchableOpacity)[0];
      act(() => {
        threadsTab.props.onPress();
      });

      const nav = props.navigation as unknown as { navigate: jest.Mock; dispatch: jest.Mock };
      expect(nav.navigate).not.toHaveBeenCalled();
      expect(nav.dispatch).not.toHaveBeenCalled();

      act(() => renderer!.unmount());
    });

    // ------------------------------------------------------------------
    // Same-tab re-press: nested screen — must popToTop, NOT navigate
    // ------------------------------------------------------------------
    it('dispatches popToTop when re-pressing focused tab with nested screen', () => {
      // Focused on Threads (index 0), ThreadDetail is on the stack
      const props = makeTabBarProps({
        focusedIndex: 0,
        nestedStates: {
          0: makeNestedStackState(['ThreadsList', 'ThreadDetail'], 'ThreadsStack-key'),
        },
      });
      let renderer: ReactTestRenderer;
      act(() => {
        renderer = create(<CustomTabBar {...props} />);
      });

      const threadsTab = renderer!.root.findAllByType(TouchableOpacity)[0];
      act(() => {
        threadsTab.props.onPress();
      });

      const nav = props.navigation as unknown as { navigate: jest.Mock; dispatch: jest.Mock };
      // CRITICAL: must NOT call navigate (which would push a duplicate in v7)
      expect(nav.navigate).not.toHaveBeenCalled();
      // Must dispatch POP_TO_TOP targeted at the nested stack
      expect(nav.dispatch).toHaveBeenCalledTimes(1);
      const popAction = nav.dispatch.mock.calls[0][0];
      expect(popAction.type).toBe('POP_TO_TOP');
      expect(popAction.target).toBe('ThreadsStack-key');
      expect(Keyboard.dismiss).toHaveBeenCalled();

      act(() => renderer!.unmount());
    });

    // ------------------------------------------------------------------
    // Regression: navigate must NEVER be called for same-tab with depth
    // (v7 would push a duplicate, causing slide-from-right + inset flash)
    // ------------------------------------------------------------------
    it('never calls navigate when same-tab re-press has nested screens (v7 regression guard)', () => {
      // Deep stack: ThreadsList → ThreadDetail → ComposeThread
      const props = makeTabBarProps({
        focusedIndex: 0,
        nestedStates: {
          0: makeNestedStackState(
            ['ThreadsList', 'ThreadDetail', 'ComposeThread'],
            'ThreadsStack-key',
          ),
        },
      });
      let renderer: ReactTestRenderer;
      act(() => {
        renderer = create(<CustomTabBar {...props} />);
      });

      const threadsTab = renderer!.root.findAllByType(TouchableOpacity)[0];
      act(() => {
        threadsTab.props.onPress();
      });

      const nav = props.navigation as unknown as { navigate: jest.Mock; dispatch: jest.Mock };
      // navigate() must not be called — it would push ThreadsList on top
      expect(nav.navigate).not.toHaveBeenCalled();
      // popToTop must be dispatched
      expect(nav.dispatch).toHaveBeenCalledTimes(1);
      expect(nav.dispatch.mock.calls[0][0].type).toBe('POP_TO_TOP');

      act(() => renderer!.unmount());
    });

    // ------------------------------------------------------------------
    // Prevented tabPress event
    // ------------------------------------------------------------------
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

      const nav = props.navigation as unknown as { navigate: jest.Mock; dispatch: jest.Mock };
      expect(nav.navigate).not.toHaveBeenCalled();
      expect(nav.dispatch).not.toHaveBeenCalled();

      act(() => renderer!.unmount());
    });

    // ------------------------------------------------------------------
    // Settings tab cross-tab
    // ------------------------------------------------------------------
    it('navigates to Settings tab with correct behavior', () => {
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
      expect(nav.navigate).toHaveBeenCalledWith('Settings');

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
