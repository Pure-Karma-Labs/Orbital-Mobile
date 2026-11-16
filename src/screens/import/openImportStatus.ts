/**
 * Take the member to the import status screen from the tab-bar strip (#928 §3.4).
 *
 * Cross-tab navigation to a nested route is three different dispatches, and
 * picking the wrong one is visible:
 *
 *  1. **Settings is focused.** `popTo` if the route is already on the stack,
 *     `push` otherwise, targeted at the NESTED key. Never `navigate`: in v7
 *     `navigate` inside a stack only matches the CURRENT route by name, so a
 *     target sitting lower in the stack is PUSHED as a duplicate
 *     (`MainTabNavigator.tsx:137-172` carries the same note). This keeps the
 *     member's existing Settings depth and gives the normal slide.
 *  2. **Settings is not focused but has depth.** A `reset` to
 *     `[SettingsMain, ImportStatus]`, then switch tabs. The reset is instant,
 *     which is only acceptable because the tab is not on screen yet — and it
 *     is what stops the member landing in some unrelated Settings sub-screen
 *     they left open an hour ago.
 *  3. **No nested state at all** (the tab has never been opened, so the
 *     navigator has not mounted). There is no key to target, so the nested
 *     route is named through the parent with `initial: false`, which leaves
 *     `SettingsMain` underneath it for Back.
 *
 * `StackActions.popTo` is verified present in `@react-navigation/routers`
 * 7.x (`StackRouter.d.ts`), which is what this project resolves.
 */

import { CommonActions, StackActions } from '@react-navigation/native';

import type { BottomTabBarProps } from '@react-navigation/bottom-tabs';

/** The tab that owns the import routes. */
const SETTINGS_TAB = 'Settings';
const STATUS_ROUTE = 'ImportStatus';
const SETTINGS_ROOT = 'SettingsMain';

export function openImportStatus(
  state: BottomTabBarProps['state'],
  navigation: BottomTabBarProps['navigation'],
): void {
  const index = state.routes.findIndex((route) => route.name === SETTINGS_TAB);
  if (index < 0) return;

  const nested = state.routes[index].state;
  const nestedKey = nested?.key;

  // 3. The Settings navigator has never mounted.
  if (nested === undefined || nestedKey === undefined) {
    navigation.navigate(SETTINGS_TAB, { screen: STATUS_ROUTE, initial: false });
    return;
  }

  // 1. Settings is the focused tab.
  if (state.index === index) {
    const onStack = (nested.routes ?? []).some((route) => route.name === STATUS_ROUTE);
    navigation.dispatch({
      ...(onStack ? StackActions.popTo(STATUS_ROUTE) : StackActions.push(STATUS_ROUTE)),
      target: nestedKey,
    });
    return;
  }

  // 2. Settings is mounted but not focused.
  navigation.dispatch({
    ...CommonActions.reset({
      index: 1,
      routes: [{ name: SETTINGS_ROOT }, { name: STATUS_ROUTE }],
    }),
    target: nestedKey,
  });
  navigation.navigate(SETTINGS_TAB);
}
