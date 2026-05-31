/**
 * Tests for DeletePasswordModal — password input, submit, cancel, error display, loading state.
 */

import React from 'react';
import { act, create, type ReactTestRenderer, type ReactTestInstance } from 'react-test-renderer';
import { ThemeProvider } from '../../../theme';
import { DeletePasswordModal } from '../DeletePasswordModal';

function renderModal(props: Partial<React.ComponentProps<typeof DeletePasswordModal>> = {}): ReactTestRenderer {
  const defaultProps: React.ComponentProps<typeof DeletePasswordModal> = {
    visible: true,
    onCancel: jest.fn(),
    onSubmit: jest.fn().mockResolvedValue(undefined),
    errorMessage: null,
    ...props,
  };

  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(
      React.createElement(
        ThemeProvider,
        { colorSchemeOverride: 'light' },
        React.createElement(DeletePasswordModal, defaultProps),
      ),
    );
  });
  return renderer;
}

function findByTestId(root: ReactTestInstance, testID: string): ReactTestInstance {
  const found = root.findAll((node) => node.props.testID === testID);
  if (found.length === 0) throw new Error(`No element with testID "${testID}"`);
  return found[0];
}

describe('DeletePasswordModal', () => {
  it('renders the modal with input and buttons', () => {
    const renderer = renderModal();
    expect(() => findByTestId(renderer.root, 'delete-password-modal')).not.toThrow();
    expect(() => findByTestId(renderer.root, 'delete-password-input')).not.toThrow();
    expect(() => findByTestId(renderer.root, 'delete-password-submit')).not.toThrow();
    expect(() => findByTestId(renderer.root, 'delete-password-cancel')).not.toThrow();
  });

  it('entering a password and tapping Delete invokes onSubmit with the password', async () => {
    const onSubmit = jest.fn().mockResolvedValue(undefined);
    const renderer = renderModal({ onSubmit });

    const input = findByTestId(renderer.root, 'delete-password-input');
    act(() => {
      input.props.onChangeText('my-secret-password');
    });

    const submitButton = findByTestId(renderer.root, 'delete-password-submit');
    await act(async () => {
      await submitButton.props.onPress();
    });

    expect(onSubmit).toHaveBeenCalledWith('my-secret-password');
  });

  it('shows the inline error message when errorMessage prop is set', () => {
    const renderer = renderModal({ errorMessage: 'Incorrect password' });
    const errorText = findByTestId(renderer.root, 'delete-password-error');
    expect(errorText.props.children).toBe('Incorrect password');
  });

  it('shows empty error text when errorMessage is null', () => {
    const renderer = renderModal({ errorMessage: null });
    const errorText = findByTestId(renderer.root, 'delete-password-error');
    expect(errorText.props.children).toBe('');
  });

  it('Cancel calls onCancel', () => {
    const onCancel = jest.fn();
    const renderer = renderModal({ onCancel });

    const cancelButton = findByTestId(renderer.root, 'delete-password-cancel');
    act(() => {
      cancelButton.props.onPress();
    });

    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('Delete button is disabled when password is empty', () => {
    const renderer = renderModal();
    const submitButton = findByTestId(renderer.root, 'delete-password-submit');
    expect(submitButton.props.disabled).toBe(true);
  });

  it('Delete button is disabled while loading (onSubmit pending)', async () => {
    let resolveSubmit!: () => void;
    const onSubmit = jest.fn(
      () => new Promise<void>((resolve) => { resolveSubmit = resolve; }),
    );
    const renderer = renderModal({ onSubmit });

    // Type password
    const input = findByTestId(renderer.root, 'delete-password-input');
    act(() => {
      input.props.onChangeText('password123');
    });

    // Press submit (do NOT await — we want to observe the loading state)
    let submitPromise: Promise<void>;
    act(() => {
      const submitButton = findByTestId(renderer.root, 'delete-password-submit');
      submitPromise = submitButton.props.onPress();
    });

    // While submitting, button should be disabled
    const submitButton = findByTestId(renderer.root, 'delete-password-submit');
    expect(submitButton.props.disabled).toBe(true);

    // Resolve and flush
    await act(async () => {
      resolveSubmit();
      await submitPromise!;
    });
  });

  it('does not call onSubmit when password is whitespace-only', async () => {
    const onSubmit = jest.fn().mockResolvedValue(undefined);
    const renderer = renderModal({ onSubmit });

    const input = findByTestId(renderer.root, 'delete-password-input');
    act(() => {
      input.props.onChangeText('   ');
    });

    const submitButton = findByTestId(renderer.root, 'delete-password-submit');
    // Button should be disabled for whitespace-only
    expect(submitButton.props.disabled).toBe(true);
  });
});
