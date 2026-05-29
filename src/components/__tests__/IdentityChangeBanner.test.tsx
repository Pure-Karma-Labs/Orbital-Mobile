import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { ThemeProvider } from '../../theme';
import { IdentityChangeBanner } from '../IdentityChangeBanner';

function render(contactName: string, onPress = jest.fn()): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(
      React.createElement(
        ThemeProvider,
        { colorSchemeOverride: 'light' },
        React.createElement(IdentityChangeBanner, { contactName, onPress }),
      ),
    );
  });
  return renderer;
}

describe('IdentityChangeBanner', () => {
  it('renders the contact name in the warning text', () => {
    const tree = render('Alice');
    const json = JSON.stringify(tree.toJSON());
    expect(json).toContain('Alice');
  });

  it('has the correct testID', () => {
    const tree = render('Bob');
    const banner = tree.root.findByProps({ testID: 'identity-change-banner' });
    expect(banner).toBeDefined();
  });

  it('calls onPress when tapped', () => {
    const onPress = jest.fn();
    const tree = render('Carol', onPress);
    const banner = tree.root.findByProps({ testID: 'identity-change-banner' });
    act(() => {
      banner.props.onPress();
    });
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('includes contact name in accessibility label', () => {
    const tree = render('Dave');
    const banner = tree.root.findByProps({ testID: 'identity-change-banner' });
    expect(banner.props.accessibilityLabel).toContain('Dave');
  });
});
