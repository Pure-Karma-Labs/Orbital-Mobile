/**
 * Tests for the TextInput component.
 */

import React from 'react';
import { act, create, type ReactTestRenderer, type ReactTestInstance } from 'react-test-renderer';
import { ThemeProvider, lightColors } from '../../theme';
import { TextInput } from '../TextInput';

function flattenStyle(style: unknown): Record<string, unknown> {
  if (Array.isArray(style)) {
    return style.reduce(
      (acc: Record<string, unknown>, s) => ({ ...acc, ...flattenStyle(s) }),
      {},
    );
  }
  return (style ?? {}) as Record<string, unknown>;
}

function renderTextInput(
  props: Partial<React.ComponentProps<typeof TextInput>> = {},
): ReactTestRenderer {
  const defaults = {
    label: 'Username',
    value: '',
    onChangeText: jest.fn(),
  };
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(
      React.createElement(
        ThemeProvider,
        { colorSchemeOverride: 'light' },
        React.createElement(TextInput, { ...defaults, ...props }),
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

describe('TextInput — rendering', () => {
  it('renders the label text', () => {
    const renderer = renderTextInput({ label: 'Email' });
    const allText = renderer.root.findAllByType('Text' as unknown as React.ComponentType);
    const labelNode = allText.find(
      (node) => typeof node.props.children === 'string' && node.props.children === 'Email',
    );
    expect(labelNode).toBeDefined();
  });

  it('renders the text input with the provided testID', () => {
    const renderer = renderTextInput({ testID: 'my-input' });
    expect(() => findByTestId(renderer.root, 'my-input')).not.toThrow();
  });

  it('passes value to the native input', () => {
    const renderer = renderTextInput({ value: 'hello', testID: 'val-input' });
    const input = findByTestId(renderer.root, 'val-input');
    expect(input.props.value).toBe('hello');
  });

  it('passes maxLength to the native input', () => {
    const renderer = renderTextInput({ maxLength: 64, testID: 'maxlen-input' });
    const input = findByTestId(renderer.root, 'maxlen-input');
    expect(input.props.maxLength).toBe(64);
  });

  it('passes secureTextEntry when set', () => {
    const renderer = renderTextInput({ secureTextEntry: true, testID: 'secure-input' });
    const input = findByTestId(renderer.root, 'secure-input');
    expect(input.props.secureTextEntry).toBe(true);
  });
});

describe('TextInput — interaction', () => {
  it('calls onChangeText when text changes', () => {
    const onChangeText = jest.fn();
    const renderer = renderTextInput({ onChangeText, testID: 'change-input' });
    const input = findByTestId(renderer.root, 'change-input');

    act(() => {
      input.props.onChangeText('new value');
    });

    expect(onChangeText).toHaveBeenCalledWith('new value');
  });

  it('passes autoCapitalize to the native input', () => {
    const renderer = renderTextInput({ autoCapitalize: 'none', testID: 'cap-input' });
    const input = findByTestId(renderer.root, 'cap-input');
    expect(input.props.autoCapitalize).toBe('none');
  });
});

describe('TextInput — helper text and error', () => {
  it('renders the helper node with the helper text', () => {
    const renderer = renderTextInput({
      helperText: 'Pick something memorable',
      testID: 'helper-input',
    });
    const helper = findByTestId(renderer.root, 'helper-input-helper');
    expect(helper.props.children).toBe('Pick something memorable');
  });

  it('renders the error node with the error text', () => {
    const renderer = renderTextInput({
      error: 'This field is required',
      testID: 'error-input',
    });
    const error = findByTestId(renderer.root, 'error-input-error');
    expect(error.props.children).toBe('This field is required');
  });

  it('suppresses the helper node when a non-empty error is set', () => {
    const renderer = renderTextInput({
      helperText: 'Pick something memorable',
      error: 'This field is required',
      testID: 'both-input',
    });
    expect(() => findByTestId(renderer.root, 'both-input-helper')).toThrow();
    expect(findByTestId(renderer.root, 'both-input-error').props.children).toBe(
      'This field is required',
    );
  });

  it('renders neither node when helperText and error are both absent', () => {
    const renderer = renderTextInput({ testID: 'plain-input' });
    expect(() => findByTestId(renderer.root, 'plain-input-helper')).toThrow();
    expect(() => findByTestId(renderer.root, 'plain-input-error')).toThrow();
  });

  it('reddens the input container border when error is set', () => {
    // Assert on the rendered border colours rather than a fixed tree position:
    // the host node carrying testID is RN's TextInput, whose parent chain is an
    // implementation detail of the platform component.
    const borderColors = (renderer: ReactTestRenderer): unknown[] =>
      renderer.root
        .findAll((node) => node.props.style != null)
        .map((node) => flattenStyle(node.props.style).borderColor)
        .filter((color) => color !== undefined);

    const withError = renderTextInput({
      error: 'This field is required',
      testID: 'border-input',
    });
    expect(borderColors(withError)).toContain(lightColors.error);

    const withoutError = renderTextInput({ testID: 'border-input' });
    expect(borderColors(withoutError)).not.toContain(lightColors.error);
  });
});
