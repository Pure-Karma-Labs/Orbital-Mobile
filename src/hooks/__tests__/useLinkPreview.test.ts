/**
 * Tests for useLinkPreview hook — URL extraction, caching, dedup, and fetch lifecycle.
 */

import React from 'react';
import { act, create } from 'react-test-renderer';

jest.mock('../../services/api/linkPreviews', () => ({
  getLinkPreview: jest.fn(),
}));

import { getLinkPreview } from '../../services/api/linkPreviews';
import {
  extractFirstUrl,
  clearLinkPreviewCache,
  useLinkPreview,
} from '../useLinkPreview';
import type { LinkPreviewResponse } from '../../types/api';

const mockGetLinkPreview = getLinkPreview as jest.Mock;

// ---------------------------------------------------------------------------
// extractFirstUrl — pure function tests
// ---------------------------------------------------------------------------

describe('extractFirstUrl', () => {
  it('returns null for null input', () => {
    expect(extractFirstUrl(null)).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(extractFirstUrl('')).toBeNull();
  });

  it('returns null for text with no URLs', () => {
    expect(extractFirstUrl('no urls here')).toBeNull();
  });

  it('extracts an https URL from text', () => {
    expect(extractFirstUrl('check https://example.com out')).toBe(
      'https://example.com',
    );
  });

  it('skips http URLs (insecure) and returns null if no https', () => {
    expect(extractFirstUrl('http://insecure.com')).toBeNull();
  });

  it('returns the first https URL when multiple are present', () => {
    expect(
      extractFirstUrl('visit https://a.com and https://b.com'),
    ).toBe('https://a.com');
  });

  it('includes trailing punctuation when matched by regex', () => {
    // The regex includes the trailing dot as part of the match,
    // and new URL("https://example.com.") is valid — so the dot is retained.
    const result = extractFirstUrl('see https://example.com.');
    expect(result).toBe('https://example.com.');
  });

  it('extracts URLs with paths and query strings', () => {
    expect(
      extractFirstUrl('look at https://example.com/path?q=1&r=2'),
    ).toBe('https://example.com/path?q=1&r=2');
  });
});

// ---------------------------------------------------------------------------
// useLinkPreview — hook tests
// ---------------------------------------------------------------------------

const fakeLinkPreview: LinkPreviewResponse = {
  url: 'https://example.com',
  title: 'Example',
  description: 'An example site',
  imageUrl: 'https://example.com/image.png',
  siteName: 'Example',
  type: 'website',
};

let hookResult: ReturnType<typeof useLinkPreview>;

function TestComponent({ text, debounceMs }: { text: string | null; debounceMs?: number }) {
  hookResult = useLinkPreview(text, debounceMs ? { debounceMs } : undefined);
  return null;
}

function renderHook(text: string | null, debounceMs?: number) {
  let root: ReturnType<typeof create>;
  act(() => {
    root = create(
      React.createElement(TestComponent, { text, debounceMs }),
    );
  });
  return root!;
}

describe('useLinkPreview', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockGetLinkPreview.mockReset();
    clearLinkPreviewCache();
  });

  afterEach(() => {
    jest.useRealTimers();
    clearLinkPreviewCache();
  });

  it('returns { preview: null, loading: false } when text has no URL', () => {
    renderHook('no urls here');
    expect(hookResult.preview).toBeNull();
    expect(hookResult.loading).toBe(false);
  });

  it('fetches preview for text with a URL', async () => {
    mockGetLinkPreview.mockResolvedValueOnce(fakeLinkPreview);

    renderHook('check https://example.com out');

    // Should be loading
    expect(hookResult.loading).toBe(true);

    // Flush promise
    await act(async () => {
      jest.runAllTimers();
      await Promise.resolve();
    });

    expect(mockGetLinkPreview).toHaveBeenCalledTimes(1);
    expect(mockGetLinkPreview).toHaveBeenCalledWith(
      'https://example.com',
      expect.any(Object), // AbortSignal
    );
    expect(hookResult.preview).toEqual(fakeLinkPreview);
    expect(hookResult.loading).toBe(false);
  });

  it('returns from cache on second render with same URL', async () => {
    mockGetLinkPreview.mockResolvedValueOnce(fakeLinkPreview);

    const root = renderHook('visit https://cached.test/page1');

    await act(async () => {
      jest.runAllTimers();
      await Promise.resolve();
    });

    expect(mockGetLinkPreview).toHaveBeenCalledTimes(1);

    // Re-render with same URL
    act(() => {
      root.update(
        React.createElement(TestComponent, {
          text: 'also https://cached.test/page1',
        }),
      );
    });

    // Should NOT call API again — cache hit
    expect(mockGetLinkPreview).toHaveBeenCalledTimes(1);
    expect(hookResult.preview).toEqual(fakeLinkPreview);
    expect(hookResult.loading).toBe(false);
  });

  it('returns { preview: null, loading: false } on API error', async () => {
    mockGetLinkPreview.mockRejectedValueOnce(new Error('Network error'));

    renderHook('check https://error-test.example.com out');

    await act(async () => {
      jest.runAllTimers();
      await Promise.resolve();
    });

    expect(hookResult.preview).toBeNull();
    expect(hookResult.loading).toBe(false);
  });

  it('returns null preview/loading when text becomes empty', async () => {
    mockGetLinkPreview.mockResolvedValueOnce(fakeLinkPreview);

    const root = renderHook('check https://reset-test.example.com out');

    await act(async () => {
      jest.runAllTimers();
      await Promise.resolve();
    });

    expect(hookResult.preview).toEqual(fakeLinkPreview);

    // Update to text with no URL
    act(() => {
      root.update(React.createElement(TestComponent, { text: 'no url now' }));
    });

    expect(hookResult.preview).toBeNull();
    expect(hookResult.loading).toBe(false);
  });
});
