/**
 * Tests for CustomTabBar — the custom bottom tab bar component.
 *
 * Covers:
 *  1. Non-focused tab press: navigate with initial screen params (#470)
 *  2. Focused tab re-press at root: no-op (already at root)
 *  3. Focused tab re-press with nested screen, no keyboard: animated navigate
 *  4. Focused tab re-press with nested screen + keyboard: reset without animation
 *  5. Keyboard.dismiss() called on all tab presses (keyboard → navigate path)
 *  6. Prevented tabPress event: no navigate call
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
// Keyboard mock helpers
// ---------------------------------------------------------------------------

let keyboardShowCb: (() => void) | null = null;
let keyboardHideCb: (() => void) | null = null;

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

const originalOS = Platform.OS;
beforeAll(() => {
  (Platform as { OS: string }).OS = 'ios';
});
afterAll(() => {
  (Platform as { OS: string }).OS = originalOS;
});

beforeEach(() => {
  keyboardShowCb = null;
  keyboardHideCb = null;

  // Capture keyboard listener callbacks so tests can simulate show/hide.
  jest.spyOn(Keyboard, 'addListener').mockImplementation(((
    event: string,
    callback: () => void,
  ) => {
    if (event === 'keyboardWillShow') keyboardShowCb = callback;
    else if (event === 'keyboardWillHide') keyboardHideCb = callback;
    return { remove: jest.fn() };
  }) as unknown as typeof Keyboard.addListener);

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
      expect(Keyboard.dismiss).toHaveBeenCalled();

      act(() => renderer!.unmount());
    });

    it('does nothing when re-pressing focused tab already at root screen', () => {
      // Focused on Threads (index 0), no nested state (at ThreadsList root)
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
      // Already at root — no navigation needed.
      expect(nav.navigate).not.toHaveBeenCalled();
      expect(nav.dispatch).not.toHaveBeenCalled();

      act(() => renderer!.unmount());
    });

    it('navigates with animation when re-pressing focused tab with nested screen and no keyboard', () => {
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

      // Keyboard is NOT visible (default state)
      const threadsTab = renderer!.root.findAllByType(TouchableOpacity)[0];
      act(() => {
        threadsTab.props.onPress();
      });

      const nav = props.navigation as unknown as { navigate: jest.Mock; dispatch: jest.Mock };
      // Standard animated pop to root via navigate
      expect(nav.navigate).toHaveBeenCalledWith('Threads', { screen: 'ThreadsList' });
      expect(nav.dispatch).not.toHaveBeenCalled();
      expect(Keyboard.dismiss).toHaveBeenCalled();

      act(() => renderer!.unmount());
    });

    it('dispatches reset (no animation) when re-pressing focused tab with keyboard visible', () => {
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

      // Simulate keyboard becoming visible
      act(() => {
        keyboardShowCb?.();
      });

      const threadsTab = renderer!.root.findAllByType(TouchableOpacity)[0];
      act(() => {
        threadsTab.props.onPress();
      });

      const nav = props.navigation as unknown as { navigate: jest.Mock; dispatch: jest.Mock };
      // Should NOT use navigate (which would produce an animated pop with KAV glitch)
      expect(nav.navigate).not.toHaveBeenCalled();
      // Should dispatch a RESET action targeting the nested stack
      expect(nav.dispatch).toHaveBeenCalledTimes(1);
      const dispatchedAction = nav.dispatch.mock.calls[0][0];
      expect(dispatchedAction.type).toBe('RESET');
      expect(dispatchedAction.payload).toEqual({
        index: 0,
        routes: [{ name: 'ThreadsList' }],
      });
      expect(dispatchedAction.target).toBe('ThreadsStack-key');
      // Keyboard.dismiss should still be called
      expect(Keyboard.dismiss).toHaveBeenCalled();

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

      const nav = props.navigation as unknown as { navigate: jest.Mock; dispatch: jest.Mock };
      expect(nav.navigate).not.toHaveBeenCalled();
      expect(nav.dispatch).not.toHaveBeenCalled();

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

    it('uses animated navigate for same-tab re-press after keyboard hides', () => {
      // Keyboard was visible, then hides — should use standard animated navigate
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

      // Show then hide keyboard
      act(() => {
        keyboardShowCb?.();
      });
      act(() => {
        keyboardHideCb?.();
      });

      const threadsTab = renderer!.root.findAllByType(TouchableOpacity)[0];
      act(() => {
        threadsTab.props.onPress();
      });

      const nav = props.navigation as unknown as { navigate: jest.Mock; dispatch: jest.Mock };
      // Keyboard is no longer visible — should use animated navigate, not reset
      expect(nav.navigate).toHaveBeenCalledWith('Threads', { screen: 'ThreadsList' });
      expect(nav.dispatch).not.toHaveBeenCalled();

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
