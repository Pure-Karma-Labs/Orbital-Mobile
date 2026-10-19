/**
 * @format
 *
 * Smoke test — verifies App renders without crashing.
 *
 * Native modules (MMKV, Keychain, bootstrap) are mocked here because they
 * cannot run in a JS-only Jest environment.
 */

import React from 'react';
import { act, create } from 'react-test-renderer';

// Mock native modules before importing App
jest.mock('react-native-gesture-handler', () => {
  const { View } = require('react-native');
  return {
    Gesture: { Tap: () => ({ onEnd: () => ({ runOnJS: () => ({}) }) }) },
    GestureDetector: ({ children }: { children: React.ReactNode }) => children,
    GestureHandlerRootView: View,
  };
});

jest.mock('react-native-mmkv', () => ({
  createMMKV: jest.fn(() => ({
    getString: jest.fn(() => null),
    set: jest.fn(),
    remove: jest.fn(),
    clearAll: jest.fn(),
  })),
}));

jest.mock('react-native-keychain', () => ({
  setGenericPassword: jest.fn(() => Promise.resolve(true)),
  getGenericPassword: jest.fn(() => Promise.resolve(false)),
  resetGenericPassword: jest.fn(() => Promise.resolve(true)),
  ACCESSIBLE: { AFTER_FIRST_UNLOCK: 'AfterFirstUnlock' },
  ACCESS_CONTROL: {},
  AUTHENTICATION_TYPE: {},
}));

jest.mock('react-native-image-picker', () => ({
  launchImageLibrary: jest.fn(),
  launchCamera: jest.fn(),
}));

jest.mock('@dr.pogodin/react-native-fs');

// Mock orbital-signal TurboModule — not available in JS-only Jest
jest.mock('orbital-signal', () => ({
  aesGcmEncrypt: jest.fn(),
  aesGcmDecrypt: jest.fn(),
}));

jest.mock('@sentry/react-native', () => ({
  captureException: jest.fn(),
  setUser: jest.fn(),
  wrap: jest.fn((component: unknown) => component),
}));

jest.mock('react-native-bootsplash', () => ({
  hide: jest.fn(() => Promise.resolve()),
  isVisible: jest.fn(() => Promise.resolve(false)),
  useHideAnimation: jest.fn(),
}));

// Mock bootstrap so it doesn't run the real secure-storage init
jest.mock('../src/bootstrap', () => ({
  bootstrap: jest.fn(() => Promise.resolve()),
}));

// Mock authService — restoreSession returns false (no saved session)
jest.mock('../src/services/authService', () => ({
  restoreSession: jest.fn(() => Promise.resolve(false)),
  logout: jest.fn(() => Promise.resolve()),
}));

// Without this, SafeAreaProvider renders `null` until it receives layout
// metrics, so AppContent (and its cold-start effect) never mounts under
// react-test-renderer.
jest.mock('react-native-safe-area-context', () => {
  const { View } = require('react-native');
  const insets = { top: 0, left: 0, right: 0, bottom: 0 };
  const frame = { x: 0, y: 0, width: 390, height: 844 };
  return {
    SafeAreaProvider: ({ children }: { children: React.ReactNode }) => children,
    SafeAreaView: View,
    SafeAreaInsetsContext: { Consumer: ({ children }: { children: (i: typeof insets) => React.ReactNode }) => children(insets) },
    useSafeAreaInsets: () => insets,
    useSafeAreaFrame: () => frame,
    initialWindowMetrics: { insets, frame },
  };
});

// The authenticated branch of the tree is not under test here — stub the
// heavy subtrees and the connection/push lifecycle it starts.
jest.mock('../src/navigation', () => {
  const ReactModule = require('react');
  const { View } = require('react-native');
  return {
    AppNavigator: () => ReactModule.createElement(View, { testID: 'app-navigator' }),
  };
});

jest.mock('../src/components/ReportContentSheet', () => ({
  ReportContentSheet: () => null,
}));

jest.mock('../src/components/IdentityRestoreBanner', () => ({
  IdentityRestoreBanner: () => null,
}));

jest.mock('../src/services/websocket', () => ({
  websocketManager: { connect: jest.fn(), disconnect: jest.fn() },
}));

jest.mock('../src/services/notificationService', () => ({
  initNotifications: jest.fn(() => Promise.resolve()),
  registerIfEnabled: jest.fn(() => Promise.resolve()),
  setupForegroundHandler: jest.fn(() => jest.fn()),
  setupNotificationTapHandler: jest.fn(() => jest.fn()),
  teardownPushRegistration: jest.fn(),
}));

import * as Sentry from '@sentry/react-native';

import App from '../src/App';
import { bootstrap } from '../src/bootstrap';
import { restoreSession } from '../src/services/authService';
import { useAppStore } from '../src/stores/useAppStore';

test('renders correctly', async () => {
  // Unmounted before the next test runs: a mounted tree stays subscribed to
  // the app store, and a later test's store write would re-render it after the
  // Jest environment has been torn down.
  let tree: ReturnType<typeof create> | undefined;
  await act(async () => {
    tree = create(<App />);
  });
  await act(async () => {
    tree?.unmount();
  });
});

// #746: `Sentry.wrap` installs the TouchEventBoundary, whose breadcrumbs carry
// the pressed element's rendered text / accessibilityLabel — and a dozen of
// ours interpolate DECRYPTED content. The boundary props below are the
// secondary defence (the primary one is the category drop in filterBreadcrumb),
// so pin the exact options the default export is wrapped with.
test('wraps App with the touch breadcrumb sources disabled', () => {
  expect(Sentry.wrap).toHaveBeenCalledWith(expect.any(Function), {
    touchEventBoundaryProps: {
      extractTextFromChildren: false,
      enableRageTapDetection: false,
    },
  });
});

// #914: on Android an activity re-create remounts the tree and re-runs the
// cold-start effect. Auth is never persisted, so a remount that already sees
// isAuthenticated can only be a remount — the session is live and restoring it
// again would bounce the user through the login screen.
test('an authenticated remount skips restoreSession', async () => {
  jest.mocked(bootstrap).mockClear();
  jest.mocked(restoreSession).mockClear();
  useAppStore.getState().setAuthenticated(true);

  let tree: ReturnType<typeof create> | undefined;
  try {
    await act(async () => {
      tree = create(<App />);
    });

    expect(bootstrap).toHaveBeenCalledTimes(1);
    expect(restoreSession).not.toHaveBeenCalled();
  } finally {
    await act(async () => {
      tree?.unmount();
    });
    useAppStore.getState().clearAuth();
  }
});
