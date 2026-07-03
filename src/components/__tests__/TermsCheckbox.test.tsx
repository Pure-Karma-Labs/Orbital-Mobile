/**
 * Tests for TermsCheckbox — toggle, accessibility, link opening.
 */

import React from 'react';
import { Linking } from 'react-native';
import { act, create, type ReactTestRenderer, type ReactTestInstance } from 'react-test-renderer';
import { ThemeProvider } from '../../theme';
import { TermsCheckbox } from '../TermsCheckbox';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function renderCheckbox(
  props: Partial<React.ComponentProps<typeof TermsCheckbox>> = {},
): ReactTestRenderer {
  const defaults = {
    checked: false,
    onToggle: jest.fn(),
    testID: 'signup-terms-checkbox',
  };
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(
      React.createElement(
        ThemeProvider,
        { colorSchemeOverride: 'light' },
        React.createElement(TermsCheckbox, { ...defaults, ...props }),
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

function findByRole(root: ReactTestInstance, role: string): ReactTestInstance {
  const found = root.findAll((node) => node.props.accessibilityRole === role);
  if (found.length === 0) throw new Error(`No element with accessibilityRole "${role}"`);
  return found[0];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  jest.clearAllMocks();
});

describe('TermsCheckbox — rendering', () => {
  it('renders the checkbox with correct accessibilityRole', () => {
    const renderer = renderCheckbox();
    const checkbox = findByRole(renderer.root, 'checkbox');
    expect(checkbox.props.accessibilityRole).toBe('checkbox');
  });

  it('shows unchecked accessibilityState by default', () => {
    const renderer = renderCheckbox({ checked: false });
    const checkbox = findByRole(renderer.root, 'checkbox');
    expect(checkbox.props.accessibilityState).toEqual({ checked: false });
  });

  it('shows checked accessibilityState when checked=true', () => {
    const renderer = renderCheckbox({ checked: true });
    const checkbox = findByRole(renderer.root, 'checkbox');
    expect(checkbox.props.accessibilityState).toEqual({ checked: true });
  });

  it('renders the Terms of Use link', () => {
    const renderer = renderCheckbox();
    expect(() => findByTestId(renderer.root, 'signup-terms-link')).not.toThrow();
  });

  it('renders the Privacy Policy link when includePrivacyLink is true', () => {
    const renderer = renderCheckbox({ includePrivacyLink: true });
    expect(() => findByTestId(renderer.root, 'signup-privacy-link')).not.toThrow();
  });

  it('does not render the Privacy Policy link by default', () => {
    const renderer = renderCheckbox();
    const found = renderer.root.findAll((n) => n.props.testID === 'signup-privacy-link');
    expect(found).toHaveLength(0);
  });

  it('renders zero-tolerance copy', () => {
    const renderer = renderCheckbox();
    // The text lives as a string child in the label Text, which has mixed children
    const json = JSON.stringify(renderer.toJSON());
    expect(json).toContain('zero tolerance');
  });
});

describe('TermsCheckbox — interaction', () => {
  it('calls onToggle when checkbox is pressed', () => {
    const onToggle = jest.fn();
    const renderer = renderCheckbox({ onToggle });
    const checkbox = findByRole(renderer.root, 'checkbox');

    act(() => {
      checkbox.props.onPress();
    });

    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it('does NOT call onToggle when link is pressed', () => {
    jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined as unknown as void);
    const onToggle = jest.fn();
    const renderer = renderCheckbox({ onToggle });
    const termsLink = findByTestId(renderer.root, 'signup-terms-link');

    act(() => {
      termsLink.props.onPress();
    });

    expect(onToggle).not.toHaveBeenCalled();
    (Linking.openURL as jest.Mock).mockRestore();
  });
});

describe('TermsCheckbox — links', () => {
  beforeEach(() => {
    jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined as unknown as void);
  });

  afterEach(() => {
    (Linking.openURL as jest.Mock).mockRestore();
  });

  it('opens Terms URL when Terms of Use link is pressed', () => {
    const renderer = renderCheckbox();
    const termsLink = findByTestId(renderer.root, 'signup-terms-link');

    act(() => {
      termsLink.props.onPress();
    });

    expect(Linking.openURL).toHaveBeenCalledWith('https://orbitl.org/terms');
  });

  it('opens Privacy URL when Privacy Policy link is pressed', () => {
    const renderer = renderCheckbox({ includePrivacyLink: true });
    const privacyLink = findByTestId(renderer.root, 'signup-privacy-link');

    act(() => {
      privacyLink.props.onPress();
    });

    expect(Linking.openURL).toHaveBeenCalledWith('https://orbitl.org/privacy');
  });
});

describe('TermsCheckbox — login testIDs', () => {
  it('derives login-terms-link testID from login-terms-checkbox', () => {
    const renderer = renderCheckbox({ testID: 'login-terms-checkbox' });
    expect(() => findByTestId(renderer.root, 'login-terms-link')).not.toThrow();
  });
});
