/**
 * Tests for LinkPreviewCard — renders link preview data, handles dismiss, loading skeleton.
 */

import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { Linking } from 'react-native';
import { ThemeProvider } from '../../theme';

// Mock OrbitalSpinner to avoid Animated.timing act() warnings
jest.mock('../OrbitalSpinner', () => {
  const { View } = require('react-native');
  return {
    OrbitalSpinner: () => <View testID="orbital-spinner-mock" />,
  };
});

// Mock useLinkPreview so we control preview data directly
const mockUseLinkPreview = jest.fn();

jest.mock('../../hooks/useLinkPreview', () => ({
  useLinkPreview: (...args: unknown[]) => mockUseLinkPreview(...args),
}));

import { LinkPreviewCard } from '../LinkPreviewCard';
import type { LinkPreviewResponse } from '../../types/api';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const fakePreview: LinkPreviewResponse = {
  url: 'https://example.com/article',
  title: 'Example Article',
  description: 'A very interesting article about testing.',
  imageUrl: 'https://example.com/image.png',
  siteName: 'Example',
  type: 'article',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function renderCard(
  props?: Partial<React.ComponentProps<typeof LinkPreviewCard>>,
): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(
      React.createElement(
        ThemeProvider,
        { colorSchemeOverride: 'light' },
        React.createElement(LinkPreviewCard, {
          text: 'check https://example.com/article',
          ...props,
        }),
      ),
    );
  });
  return renderer;
}

function findByTestId(
  renderer: ReactTestRenderer,
  testID: string,
): ReturnType<typeof renderer.root.findByProps> | null {
  try {
    return renderer.root.findByProps({ testID });
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('LinkPreviewCard', () => {
  beforeEach(() => {
    mockUseLinkPreview.mockReset();
  });

  it('renders null when no preview and not loading', () => {
    mockUseLinkPreview.mockReturnValue({ preview: null, loading: false });
    const renderer = renderCard();
    expect(renderer.toJSON()).toBeNull();
  });

  it('renders null when preview has no title and no description', () => {
    mockUseLinkPreview.mockReturnValue({
      preview: { ...fakePreview, title: null, description: null },
      loading: false,
    });
    const renderer = renderCard();
    expect(renderer.toJSON()).toBeNull();
  });

  it('renders card when preview has title but no description', () => {
    mockUseLinkPreview.mockReturnValue({
      preview: { ...fakePreview, description: null },
      loading: false,
    });
    const renderer = renderCard();
    expect(findByTestId(renderer, 'link-preview-card')).not.toBeNull();
  });

  it('renders card when preview has description but no title', () => {
    mockUseLinkPreview.mockReturnValue({
      preview: { ...fakePreview, title: null },
      loading: false,
    });
    const renderer = renderCard();
    expect(findByTestId(renderer, 'link-preview-card')).not.toBeNull();
  });

  it('renders a loading skeleton when loading', () => {
    mockUseLinkPreview.mockReturnValue({ preview: null, loading: true });
    const renderer = renderCard();
    const skeleton = findByTestId(renderer, 'link-preview-skeleton');
    expect(skeleton).not.toBeNull();
  });

  it('renders title, description, and domain when preview is available', () => {
    mockUseLinkPreview.mockReturnValue({ preview: fakePreview, loading: false });
    const renderer = renderCard();

    const card = findByTestId(renderer, 'link-preview-card');
    expect(card).not.toBeNull();

    const title = findByTestId(renderer, 'link-preview-title');
    expect(title).not.toBeNull();
    expect(title!.props.children).toBe('Example Article');

    // Check domain text exists
    const allText = renderer.root.findAllByType('Text' as unknown as React.ComponentType);
    const domainNode = allText.find(
      (node) => typeof node.props.children === 'string' && node.props.children === 'example.com',
    );
    expect(domainNode).toBeDefined();
  });

  it('renders an Image when imageUrl is present', () => {
    mockUseLinkPreview.mockReturnValue({ preview: fakePreview, loading: false });
    const renderer = renderCard();
    const img = findByTestId(renderer, 'link-preview-image');
    expect(img).not.toBeNull();
  });

  it('does not render an Image when imageUrl is null', () => {
    const noImagePreview = { ...fakePreview, imageUrl: null };
    mockUseLinkPreview.mockReturnValue({ preview: noImagePreview, loading: false });
    const renderer = renderCard();
    const img = findByTestId(renderer, 'link-preview-image');
    expect(img).toBeNull();
  });

  it('opens URL on press via Linking.openURL', () => {
    mockUseLinkPreview.mockReturnValue({ preview: fakePreview, loading: false });
    const spy = jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined as never);

    const renderer = renderCard();
    const card = findByTestId(renderer, 'link-preview-card');
    act(() => {
      card!.props.onPress();
    });
    expect(spy).toHaveBeenCalledWith('https://example.com/article');
    spy.mockRestore();
  });

  it('shows dismiss button when dismissible and hides card on press', () => {
    mockUseLinkPreview.mockReturnValue({ preview: fakePreview, loading: false });
    const onDismiss = jest.fn();
    const renderer = renderCard({ dismissible: true, onDismiss });

    const dismissBtn = findByTestId(renderer, 'link-preview-dismiss');
    expect(dismissBtn).not.toBeNull();

    act(() => {
      dismissBtn!.props.onPress();
    });

    // After dismiss, the card should render null
    expect(renderer.toJSON()).toBeNull();
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('does not show dismiss button when not dismissible', () => {
    mockUseLinkPreview.mockReturnValue({ preview: fakePreview, loading: false });
    const renderer = renderCard({ dismissible: false });
    const dismissBtn = findByTestId(renderer, 'link-preview-dismiss');
    expect(dismissBtn).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Image loading state tests
  // -------------------------------------------------------------------------

  it('shows loading spinner when image URL is present', () => {
    mockUseLinkPreview.mockReturnValue({ preview: fakePreview, loading: false });
    const renderer = renderCard();

    const loadingOverlay = findByTestId(renderer, 'link-preview-image-loading');
    expect(loadingOverlay).not.toBeNull();

    const img = findByTestId(renderer, 'link-preview-image');
    expect(img).not.toBeNull();
  });

  it('hides loading spinner after image loads', () => {
    mockUseLinkPreview.mockReturnValue({ preview: fakePreview, loading: false });
    const renderer = renderCard();

    const img = findByTestId(renderer, 'link-preview-image');
    expect(img).not.toBeNull();

    act(() => {
      img!.props.onLoad();
    });

    const loadingOverlay = findByTestId(renderer, 'link-preview-image-loading');
    expect(loadingOverlay).toBeNull();

    // Image should still be visible
    const imgAfter = findByTestId(renderer, 'link-preview-image');
    expect(imgAfter).not.toBeNull();
  });

  it('collapses image area on error', () => {
    mockUseLinkPreview.mockReturnValue({ preview: fakePreview, loading: false });
    const renderer = renderCard();

    const img = findByTestId(renderer, 'link-preview-image');
    expect(img).not.toBeNull();

    act(() => {
      img!.props.onError();
    });

    // Everything image-related should be gone
    expect(findByTestId(renderer, 'link-preview-image-container')).toBeNull();
    expect(findByTestId(renderer, 'link-preview-image-loading')).toBeNull();
    expect(findByTestId(renderer, 'link-preview-image')).toBeNull();

    // Content should still render
    const title = findByTestId(renderer, 'link-preview-title');
    expect(title).not.toBeNull();
  });

  it('does not show image container when imageUrl is null', () => {
    const noImagePreview = { ...fakePreview, imageUrl: null };
    mockUseLinkPreview.mockReturnValue({ preview: noImagePreview, loading: false });
    const renderer = renderCard();

    expect(findByTestId(renderer, 'link-preview-image-container')).toBeNull();

    // Title/description still render
    const title = findByTestId(renderer, 'link-preview-title');
    expect(title).not.toBeNull();
  });

  it('resets to fresh loading state on URL change', () => {
    const previewA = { ...fakePreview, imageUrl: 'https://example.com/a.png' };
    mockUseLinkPreview.mockReturnValue({ preview: previewA, loading: false });
    const renderer = renderCard();

    // Trigger error to collapse the image for URL A
    const imgA = findByTestId(renderer, 'link-preview-image');
    expect(imgA).not.toBeNull();
    act(() => {
      imgA!.props.onError();
    });

    // Image area should be collapsed
    expect(findByTestId(renderer, 'link-preview-image-container')).toBeNull();

    // Change to URL B — the key={url} forces fresh mount with loading state
    const previewB = { ...fakePreview, imageUrl: 'https://example.com/b.png' };
    mockUseLinkPreview.mockReturnValue({ preview: previewB, loading: false });
    act(() => {
      renderer.update(
        React.createElement(
          ThemeProvider,
          { colorSchemeOverride: 'light' },
          React.createElement(LinkPreviewCard, {
            text: 'check https://example.com/article',
          }),
        ),
      );
    });

    // Fresh mount: container and loading overlay should exist
    expect(findByTestId(renderer, 'link-preview-image-container')).not.toBeNull();
    expect(findByTestId(renderer, 'link-preview-image-loading')).not.toBeNull();
  });
});
