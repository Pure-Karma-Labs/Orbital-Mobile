/**
 * Tests for the TextInput component.
 */

import React from 'react';
import { act, create, type ReactTestRenderer, type ReactTestInstance } from 'react-test-renderer';
import { ThemeProvider } from '../../theme';
import { TextInput } from '../TextInput';

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
