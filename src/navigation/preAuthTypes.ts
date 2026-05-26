/**
 * Shared types for pre-auth screen navigation.
 *
 * Pre-auth screens (login, signup, forgotPassword, resetPassword) live
 * outside React Navigation and use a simple state-machine in App.tsx.
 */

export type PreAuthScreen = 'login' | 'signup' | 'forgotPassword' | 'resetPassword';

export type PreAuthParams = {
  email?: string;
  successMessage?: string;
};

export type OnPreAuthNavigate = (screen: PreAuthScreen, params?: PreAuthParams) => void;
