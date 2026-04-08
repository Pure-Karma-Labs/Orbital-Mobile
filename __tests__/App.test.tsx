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

// Mock bootstrap so it doesn't run the real secure-storage init
jest.mock('../src/bootstrap', () => ({
  bootstrap: jest.fn(() => Promise.resolve()),
}));

// Mock authService — restoreSession returns false (no saved session)
jest.mock('../src/services/authService', () => ({
  restoreSession: jest.fn(() => Promise.resolve(false)),
  logout: jest.fn(() => Promise.resolve()),
}));

import App from '../src/App';

test('renders correctly', async () => {
  await act(async () => {
    create(<App />);
  });
});
