import React from 'react';
import { KeyboardAvoidingView, type KeyboardAvoidingViewProps } from 'react-native';

type Props = Omit<KeyboardAvoidingViewProps, 'behavior'> & {
  children: React.ReactNode;
};

/**
 * Platform-consistent KeyboardAvoidingView wrapper.
 *
 * Uses `behavior="padding"` on both iOS and Android.
 * On Android, `adjustResize` in AndroidManifest handles the window resize,
 * while KAV padding ensures the composer stays above the keyboard even when
 * dynamic content (images, media) is present in the thread.
 *
 * Defaults to `{ flex: 1 }` style but can be overridden via the `style` prop.
 */
export function OrbitalKeyboardAvoidingView({ style, children, ...rest }: Props): React.JSX.Element {
  return (
    <KeyboardAvoidingView
      style={[{ flex: 1 }, style]}
      behavior="padding"
      {...rest}
    >
      {children}
    </KeyboardAvoidingView>
  );
}
