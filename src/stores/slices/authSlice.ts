import type { StateCreator } from 'zustand';
import type { AppState, AuthSlice } from '../../types/store';

export const createAuthSlice: StateCreator<AppState, [['zustand/devtools', never]], [], AuthSlice> = (
  set,
) => ({
  // Initial state
  isAuthenticated: false,
  userId: null,
  username: null,
  displayName: null,
  avatarPath: null,
  avatarDigest: null,

  // Actions
  // NOTE: JWT tokens and encryption keys are intentionally NOT stored here.
  // They belong in Keychain (iOS) / Keystore (Android) via a secure storage module.
  setUser: (user) =>
    set(
      {
        isAuthenticated: true,
        userId: user.userId,
        username: user.username,
        displayName: user.displayName,
        avatarPath: user.avatarPath,
        avatarDigest: null,
      },
      false,
      'auth/setUser',
    ),

  clearAuth: () =>
    set(
      {
        isAuthenticated: false,
        userId: null,
        username: null,
        displayName: null,
        avatarPath: null,
        avatarDigest: null,
      },
      false,
      'auth/clearAuth',
    ),

  setAuthenticated: (authenticated) =>
    set({ isAuthenticated: authenticated }, false, 'auth/setAuthenticated'),

  updateProfile: (patch) =>
    set(
      (state) => ({
        displayName: patch.displayName !== undefined ? patch.displayName : state.displayName,
        avatarPath: patch.avatarPath !== undefined ? patch.avatarPath : state.avatarPath,
        avatarDigest: patch.avatarDigest !== undefined ? patch.avatarDigest : state.avatarDigest,
      }),
      false,
      'auth/updateProfile',
    ),
});
