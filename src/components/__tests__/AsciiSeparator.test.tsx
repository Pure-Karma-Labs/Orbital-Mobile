/**
 * Tests for AsciiDay and AsciiSection separators.
 */

import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { ThemeProvider } from '../../theme';
import { AsciiDay, AsciiSection } from '../AsciiSeparator';

function renderWithTheme(element: React.ReactElement): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(
      React.createElement(
        ThemeProvider,
        { colorSchemeOverride: 'light' },
        element,
      ),
    );
  });
  return renderer;
}

describe('AsciiDay', () => {
  it('renders the label in ascii day format', () => {
    const renderer = renderWithTheme(
      React.createElement(AsciiDay, { label: 'Today' }),
    );
    const allText = renderer.root.findAllByType('Text' as unknown as React.ComponentType);
    const labelNode = allText.find(
      (node) =>
        typeof node.props.children === 'string' &&
        node.props.children === '─── Today ───',
    );
    expect(labelNode).toBeDefined();
  });

  it('renders with a custom label', () => {
    const renderer = renderWithTheme(
      React.createElement(AsciiDay, { label: 'Apr 24' }),
    );
    const allText = renderer.root.findAllByType('Text' as unknown as React.ComponentType);
    const labelNode = allText.find(
      (node) =>
        typeof node.props.children === 'string' &&
        node.props.children === '─── Apr 24 ───',
    );
    expect(labelNode).toBeDefined();
  });
});

describe('AsciiSection', () => {
  it('renders the section separator string', () => {
    const renderer = renderWithTheme(React.createElement(AsciiSection, null));
    const allText = renderer.root.findAllByType('Text' as unknown as React.ComponentType);
    const sectionNode = allText.find(
      (node) =>
        typeof node.props.children === 'string' &&
        node.props.children === '·  ·  ·  ✦  ·  ·  ·',
    );
    expect(sectionNode).toBeDefined();
  });
});
