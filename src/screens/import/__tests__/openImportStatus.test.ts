/**
 * Cross-tab navigation from the status strip (#928 §3.4). Pure — nothing renders.
 *
 * Three dispatches and a plain navigate, and picking the wrong one is visible
 * to the member: a duplicate ImportStatus pushed on top of itself, a landing in
 * some unrelated Settings sub-screen, or no navigation at all. Each branch is
 * asserted on the ACTION — type, payload and `target` — because the target key
 * is what decides whether the action reaches the nested stack or the tab
 * navigator.
 */

import { openImportStatus } from '../openImportStatus';

import type { BottomTabBarProps } from '@react-navigation/bottom-tabs';
import type { NavigationState, ParamListBase, PartialState } from '@react-navigation/native';

type NestedState = NavigationState<ParamListBase> | PartialState<NavigationState<ParamListBase>>;

type TabState = BottomTabBarProps['state'];

interface FakeNavigation {
  dispatch: jest.Mock;
  navigate: jest.Mock;
}

/** A Settings stack holding `screens`, focused on the last one. */
function nestedStack(screens: string[], key = 'SettingsStack-key'): NestedState {
  return {
    key,
    index: screens.length - 1,
    routes: screens.map((name, index) => ({
      key: `${name}-key-${index}`,
      name,
      params: undefined,
    })),
    routeNames: screens,
    type: 'stack',
    stale: false as const,
  };
}

/**
 * A three-tab state. `settingsNested` undefined ⇒ the Settings navigator has
 * never mounted, which is the branch with no key to target.
 */
function tabState(options: {
  focusedIndex: number;
  settingsNested?: NestedState;
  withSettings?: boolean;
}): TabState {
  const routes = [
    { key: 'Threads-key', name: 'Threads', params: undefined, state: undefined },
    { key: 'Chats-key', name: 'Chats', params: undefined, state: undefined },
    ...(options.withSettings === false
      ? []
      : [
          {
            key: 'Settings-key',
            name: 'Settings',
            params: undefined,
            state: options.settingsNested,
          },
        ]),
  ];

  return {
    index: options.focusedIndex,
    routes,
    key: 'tab-state-key',
    routeNames: routes.map((route) => route.name),
    type: 'tab',
    stale: false,
    history: [],
    preloadedRouteKeys: [],
  } as unknown as TabState;
}

function fakeNavigation(): FakeNavigation {
  return { dispatch: jest.fn(), navigate: jest.fn() };
}

function open(state: TabState, navigation: FakeNavigation): void {
  openImportStatus(state, navigation as unknown as BottomTabBarProps['navigation']);
}

interface DispatchedAction {
  type: string;
  payload?: Record<string, unknown>;
  target?: string;
}

function dispatched(navigation: FakeNavigation, index = 0): DispatchedAction {
  return navigation.dispatch.mock.calls[index][0] as DispatchedAction;
}

// ---------------------------------------------------------------------------
// 1. Settings focused
// ---------------------------------------------------------------------------

describe('openImportStatus — Settings is the focused tab', () => {
  it('pops back to an ImportStatus already on the nested stack', () => {
    const navigation = fakeNavigation();
    const state = tabState({
      focusedIndex: 2,
      settingsNested: nestedStack(['SettingsMain', 'ImportStatus', 'ImportUnmigrated']),
    });

    open(state, navigation);

    expect(navigation.dispatch).toHaveBeenCalledTimes(1);
    const action = dispatched(navigation);
    expect(action.type).toBe('POP_TO');
    expect(action.payload?.name).toBe('ImportStatus');
    expect(action.target).toBe('SettingsStack-key');
    // navigate() inside a stack would PUSH a duplicate in v7.
    expect(navigation.navigate).not.toHaveBeenCalled();
  });

  it('pushes ImportStatus when it is not on the stack', () => {
    const navigation = fakeNavigation();
    const state = tabState({
      focusedIndex: 2,
      settingsNested: nestedStack(['SettingsMain', 'FileLibrary']),
    });

    open(state, navigation);

    expect(navigation.dispatch).toHaveBeenCalledTimes(1);
    const action = dispatched(navigation);
    expect(action.type).toBe('PUSH');
    expect(action.payload?.name).toBe('ImportStatus');
    // The member's existing Settings depth is kept.
    expect(action.target).toBe('SettingsStack-key');
    expect(navigation.navigate).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 2. Settings mounted but not focused
// ---------------------------------------------------------------------------

describe('openImportStatus — Settings is mounted but not focused', () => {
  it('resets the nested stack to [SettingsMain, ImportStatus], then switches tab', () => {
    const navigation = fakeNavigation();
    const state = tabState({
      focusedIndex: 0,
      settingsNested: nestedStack(['SettingsMain', 'BlockedUsers']),
    });

    open(state, navigation);

    expect(navigation.dispatch).toHaveBeenCalledTimes(1);
    const action = dispatched(navigation);
    expect(action.type).toBe('RESET');
    expect(action.payload).toEqual({
      index: 1,
      routes: [{ name: 'SettingsMain' }, { name: 'ImportStatus' }],
    });
    expect(action.target).toBe('SettingsStack-key');

    expect(navigation.navigate).toHaveBeenCalledTimes(1);
    expect(navigation.navigate).toHaveBeenCalledWith('Settings');
    // The reset must land before the tab is on screen, or the member sees the
    // stale sub-screen flash past.
    expect(navigation.dispatch.mock.invocationCallOrder[0]).toBeLessThan(
      navigation.navigate.mock.invocationCallOrder[0],
    );
  });
});

// ---------------------------------------------------------------------------
// 3. The Settings navigator has never mounted
// ---------------------------------------------------------------------------

describe('openImportStatus — no nested state', () => {
  it('names the nested route through the parent, leaving SettingsMain underneath', () => {
    const navigation = fakeNavigation();
    const state = tabState({ focusedIndex: 0 });

    open(state, navigation);

    expect(navigation.dispatch).not.toHaveBeenCalled();
    expect(navigation.navigate).toHaveBeenCalledTimes(1);
    expect(navigation.navigate).toHaveBeenCalledWith('Settings', {
      screen: 'ImportStatus',
      initial: false,
    });
  });

  it('takes the same branch for a nested state with no key to target', () => {
    const navigation = fakeNavigation();
    const state = tabState({
      focusedIndex: 2,
      settingsNested: { routes: [{ name: 'SettingsMain' }] } as NestedState,
    });

    open(state, navigation);

    expect(navigation.dispatch).not.toHaveBeenCalled();
    expect(navigation.navigate).toHaveBeenCalledWith('Settings', {
      screen: 'ImportStatus',
      initial: false,
    });
  });
});

// ---------------------------------------------------------------------------
// No Settings tab at all
// ---------------------------------------------------------------------------

describe('openImportStatus — no Settings tab', () => {
  it('does nothing at all', () => {
    const navigation = fakeNavigation();
    const state = tabState({ focusedIndex: 0, withSettings: false });

    open(state, navigation);

    expect(navigation.dispatch).not.toHaveBeenCalled();
    expect(navigation.navigate).not.toHaveBeenCalled();
  });
});
