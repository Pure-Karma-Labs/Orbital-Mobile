/**
 * Tests for the ErrorBanner component.
 */

import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { ThemeProvider } from '../../theme';
import { ErrorBanner } from '../ErrorBanner';

function renderErrorBanner(message: string | null): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(
      React.createElement(
        ThemeProvider,
        { colorSchemeOverride: 'light' },
        React.createElement(ErrorBanner, { message }),
      ),
    );
  });
  return renderer;
}

describe('ErrorBanner — rendering', () => {
  it('renders null when message is null', () => {
    const renderer = renderErrorBanner(null);
    // When the component returns null, toJSON() returns null
    expect(renderer.toJSON()).toBeNull();
  });

  it('renders the error message when message is provided', () => {
    const renderer = renderErrorBanner('Something went wrong');
    const allText = renderer.root.findAllByType('Text' as unknown as React.ComponentType);
    const errorNode = allText.find(
      (node) =>
        typeof node.props.children === 'string' &&
        node.props.children === 'Something went wrong',
    );
    expect(errorNode).toBeDefined();
  });

  it('renders a View container when message is non-null', () => {
    const renderer = renderErrorBanner('Error occurred');
    // toJSON should return a non-null tree (not null)
    expect(renderer.toJSON()).not.toBeNull();
  });

  it('shows different messages correctly', () => {
    const renderer = renderErrorBanner('Network error — please check your connection');
    const allText = renderer.root.findAllByType('Text' as unknown as React.ComponentType);
    const found = allText.find(
      (node) =>
        typeof node.props.children === 'string' &&
        node.props.children.includes('Network error'),
    );
    expect(found).toBeDefined();
  });
});
