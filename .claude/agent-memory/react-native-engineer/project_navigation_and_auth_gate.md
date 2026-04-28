---
name: Navigation architecture and auth gate
description: React Navigation bottom tabs; auth gate as conditional rendering (not navigator); NavigationContainer unmounts on logout; screenListeners sync tab state to store.
type: project
---

Navigation lives at `src/navigation/`.

Key files:
- `AppNavigator.tsx` — `NavigationContainer` with theme bridge + `linking` config; renders `MainTabNavigator`
- `MainTabNavigator.tsx` — `createBottomTabNavigator<MainTabParamList>` with Threads/Chats/Settings tabs
- `linking.ts` — deep link config skeleton (scheme + screen mappings)
- `types.ts` — `MainTabParamList` and other param list types

Auth gate pattern (in `App.tsx` / `AppContent`):
- Conditional rendering: `isAuthenticated ? <AppNavigator /> : <AuthNavigator />`
- NOT a separate navigator guarding authenticated routes
- `NavigationContainer` is **inside** the auth check, so it fully unmounts on logout — prevents navigation state from leaking across sessions
- `useAppStore` auth slice drives the condition

Tab state sync:
- `screenListeners` on `Tab.Navigator` fires on `state` events and calls `useAppStore.getState().setActiveTab()` with the lowercased route name
- `initialRouteName` is derived from `useAppStore.getState().activeTab` at mount time

Deep links:
- `linking` config at `src/navigation/linking.ts` provides the skeleton; scheme is `orbital://`
- Navigation state is intended to be fully derivable from app state for deep link support

**Why:** Unmounting NavigationContainer on logout is cleaner than resetting nested stacks. Conditional rendering at the top of the tree ensures no authenticated screen is ever reachable without a valid session.

**How to apply:** Auth-gating new features means adding screens to the stack inside `AppNavigator`'s subtree, not adding conditions elsewhere. Deep links that require auth should land on authenticated screens only.
