---
name: Navigation architecture and auth gate
description: React Navigation bottom tabs; auth gate as conditional rendering (not navigator); NavigationContainer unmounts on logout; screenListeners sync tab state to store.
type: project
---

Navigation lives at `src/navigation/`.

Key files:
- `AppNavigator.tsx` — `NavigationContainer` with theme bridge + `linking` config; renders `MainTabNavigator`; passes `navigationRef` and calls `flushPendingNotificationPayload()` in `onReady`
- `MainTabNavigator.tsx` — `createBottomTabNavigator<MainTabParamList>` with Threads/Chats/Settings tabs
- `linking.ts` — deep link config skeleton (scheme + screen mappings)
- `types.ts` — `MainTabParamList`, `RootStackParamList`, and other param list types
- `navigationRef.ts` — global nav ref for programmatic navigation outside React tree (push notification taps); cold-start payload queue (setPendingNotificationPayload / flushPendingNotificationPayload / setPayloadConsumer)

Auth gate pattern (in `App.tsx` / `AppContent`):
- Uses `PreAuthScreen` union type state machine (`'login' | 'signup' | 'forgotPassword' | 'resetPassword'`) with `PreAuthParams` (`{ email?, successMessage? }`)
- Shared types in `src/navigation/preAuthTypes.ts`: `PreAuthScreen`, `PreAuthParams`, `OnPreAuthNavigate`
- All pre-auth screens receive `onNavigate: OnPreAuthNavigate` — single callback replaces per-screen `onSwitchToX` props
- Conditional rendering: `isAuthenticated ? <AppNavigator /> : <PreAuthScreen based on state>`
- NOT a separate navigator guarding authenticated routes
- `NavigationContainer` is **inside** the auth check, so it fully unmounts on logout — prevents navigation state from leaking across sessions
- `useAppStore` auth slice drives the condition

Pre-auth screens (all outside React Navigation):
- `LoginScreen` — username/password + "Forgot password?" link + optional SuccessBanner (from `preAuthParams.successMessage`)
- `SignupScreen` — new account creation
- `ForgotPasswordScreen` — email input → `requestPasswordReset()` → navigate to reset with `{ email }`
- `ResetPasswordScreen` — code + new password → `resetPassword()` → navigate to login with `{ successMessage }`

Tab state sync:
- `screenListeners` on `Tab.Navigator` fires on `state` events and calls `useAppStore.getState().setActiveTab()` with the lowercased route name
- `initialRouteName` is derived from `useAppStore.getState().activeTab` at mount time

Deep links:
- `linking` config at `src/navigation/linking.ts` provides the skeleton; scheme is `orbital://`
- Navigation state is intended to be fully derivable from app state for deep link support

**Why:** Unmounting NavigationContainer on logout is cleaner than resetting nested stacks. The PreAuthScreen state machine replaced the old `showSignup` boolean to support 4 pre-auth screens with param passing. Conditional rendering at the top of the tree ensures no authenticated screen is ever reachable without a valid session.

**How to apply:** Auth-gating new features means adding screens to the stack inside `AppNavigator`'s subtree, not adding conditions elsewhere. New pre-auth screens should be added to the `PreAuthScreen` union type in `preAuthTypes.ts` and rendered conditionally in `App.tsx`. Deep links that require auth should land on authenticated screens only.
