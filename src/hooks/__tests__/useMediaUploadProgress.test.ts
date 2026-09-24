/**
 * Tests for useMediaUploadProgress — reuse cache hit/miss, hasUnsentUpload
 * lifecycle, and filtered-id caching.
 *
 * The hook owns the one-session reuse cache (#749): a send whose media upload
 * succeeded but whose create call failed keeps its media ids, so pressing
 * Send again attaches the SAME ids instead of re-uploading. These tests pin
 * the cache key conditions and the hasUnsentUpload state transitions.
 */

import React from 'react';
import { act, create } from 'react-test-renderer';

const mockUploadMediaBatch = jest.fn();

// jest.requireActual('../../services/mediaUploadService') cannot be spread here:
// the actual module transitively imports react-native-mmkv (via
// contentCrypto → useAppStore → persistence.ts) which requires nitro native
// modules unavailable in Jest. The hook only consumes `uploadMediaBatch` and
// the `UploadPhase` type (erased at compile time), so a targeted mock is
// sufficient. `isUploadCancellation` is used only inside the service itself;
// the hook never references it, so no sentinel forwarding is needed here.
jest.mock('../../services/mediaUploadService', () => ({
  uploadMediaBatch: (...args: unknown[]) => mockUploadMediaBatch(...args),
}));

import { useMediaUploadProgress } from '../useMediaUploadProgress';
import type { UseMediaUploadProgressResult } from '../useMediaUploadProgress';
import type { PickedMedia } from '../useMediaPicker';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeItem(uri: string, type = 'image/jpeg'): PickedMedia {
  return { uri, type, fileName: 'photo.jpg', fileSize: 1000 };
}

// ---------------------------------------------------------------------------
// Test harness — probe component captures hook result at module scope so test
// bodies can call uploadBatch / clearUploadCache between acts.
// ---------------------------------------------------------------------------

let hookResult: UseMediaUploadProgressResult;

function Probe(): null {
  hookResult = useMediaUploadProgress();
  return null;
}

function renderHook(): ReturnType<typeof create> {
  let root!: ReturnType<typeof create>;
  act(() => {
    root = create(React.createElement(Probe));
  });
  return root;
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  jest.clearAllMocks();
  // Default: two ids so positional filter tests can drop the second.
  mockUploadMediaBatch.mockResolvedValue(['id-1', 'id-2']);
});

// ---------------------------------------------------------------------------
// Cache hit
// ---------------------------------------------------------------------------

describe('useMediaUploadProgress — cache hit', () => {
  it('same array ref, uris, groupId, scopeKey: uploadMediaBatch called once; both calls return the same ids', async () => {
    renderHook();
    const items = [makeItem('file://a.jpg'), makeItem('file://b.jpg')];

    let ids1: string[] = [];
    await act(async () => {
      ids1 = await hookResult.uploadBatch(items, 'group-1', undefined, 'scope-A');
    });

    let ids2: string[] = [];
    await act(async () => {
      ids2 = await hookResult.uploadBatch(items, 'group-1', undefined, 'scope-A');
    });

    expect(mockUploadMediaBatch).toHaveBeenCalledTimes(1);
    expect(ids1).toEqual(['id-1', 'id-2']);
    expect(ids2).toEqual(['id-1', 'id-2']);
  });
});

// ---------------------------------------------------------------------------
// Cache misses
// ---------------------------------------------------------------------------

describe('useMediaUploadProgress — cache misses', () => {
  it('new array with identical contents (identity miss) forces re-upload', async () => {
    renderHook();
    const uris = ['file://a.jpg'];
    // Two arrays with the same uri — different object references.
    const items1 = uris.map((u) => makeItem(u));
    const items2 = uris.map((u) => makeItem(u));

    await act(async () => { await hookResult.uploadBatch(items1, 'group-1'); });
    await act(async () => { await hookResult.uploadBatch(items2, 'group-1'); });

    expect(mockUploadMediaBatch).toHaveBeenCalledTimes(2);
  });

  it('changed uri in a new array forces re-upload', async () => {
    renderHook();
    const items1 = [makeItem('file://a.jpg')];
    const items2 = [makeItem('file://x.jpg')]; // different uri

    await act(async () => { await hookResult.uploadBatch(items1, 'group-1'); });
    await act(async () => { await hookResult.uploadBatch(items2, 'group-1'); });

    expect(mockUploadMediaBatch).toHaveBeenCalledTimes(2);
  });

  it('changed scopeKey forces re-upload (same array reference)', async () => {
    renderHook();
    // Same reference — only the scopeKey differs.
    const items = [makeItem('file://a.jpg')];

    await act(async () => { await hookResult.uploadBatch(items, 'group-1', undefined, 'scope-A'); });
    await act(async () => { await hookResult.uploadBatch(items, 'group-1', undefined, 'scope-B'); });

    expect(mockUploadMediaBatch).toHaveBeenCalledTimes(2);
  });

  it('changed groupId forces re-upload (same array reference)', async () => {
    renderHook();
    const items = [makeItem('file://a.jpg')];

    await act(async () => { await hookResult.uploadBatch(items, 'group-1'); });
    await act(async () => { await hookResult.uploadBatch(items, 'group-2'); });

    expect(mockUploadMediaBatch).toHaveBeenCalledTimes(2);
  });

  it('clearUploadCache drops the cache so the next call re-uploads', async () => {
    renderHook();
    const items = [makeItem('file://a.jpg')];

    await act(async () => { await hookResult.uploadBatch(items, 'group-1'); });

    act(() => { hookResult.clearUploadCache(); });

    await act(async () => { await hookResult.uploadBatch(items, 'group-1'); });

    expect(mockUploadMediaBatch).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// hasUnsentUpload
// ---------------------------------------------------------------------------

describe('useMediaUploadProgress — hasUnsentUpload', () => {
  it('is false initially', () => {
    renderHook();
    expect(hookResult.hasUnsentUpload).toBe(false);
  });

  it('flips true after a successful batch that yields at least one id', async () => {
    renderHook();
    mockUploadMediaBatch.mockResolvedValueOnce(['id-1']);
    const items = [makeItem('file://a.jpg')];

    await act(async () => { await hookResult.uploadBatch(items, 'group-1'); });

    expect(hookResult.hasUnsentUpload).toBe(true);
  });

  it('stays true across a cache hit (no re-upload required)', async () => {
    renderHook();
    const items = [makeItem('file://a.jpg')];

    await act(async () => { await hookResult.uploadBatch(items, 'group-1'); });
    expect(hookResult.hasUnsentUpload).toBe(true);

    // Cache hit — no upload runs, state must not flip back.
    await act(async () => { await hookResult.uploadBatch(items, 'group-1'); });
    expect(hookResult.hasUnsentUpload).toBe(true);
  });

  it('returns to false after clearUploadCache()', async () => {
    renderHook();
    const items = [makeItem('file://a.jpg')];

    await act(async () => { await hookResult.uploadBatch(items, 'group-1'); });
    expect(hookResult.hasUnsentUpload).toBe(true);

    act(() => { hookResult.clearUploadCache(); });

    expect(hookResult.hasUnsentUpload).toBe(false);
  });

  it('stays false when getSelectedItems filter drops every uploaded id', async () => {
    renderHook();
    mockUploadMediaBatch.mockResolvedValueOnce(['id-1', 'id-2']);
    const items = [makeItem('file://a.jpg'), makeItem('file://b.jpg')];

    // All items deselected mid-upload: the filter returns an empty array.
    await act(async () => {
      await hookResult.uploadBatch(items, 'group-1', () => []);
    });

    // Nothing left to attach, so there is nothing to strand.
    expect(hookResult.hasUnsentUpload).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Filtered ids are what gets cached
// ---------------------------------------------------------------------------

describe('useMediaUploadProgress — filtered ids cached', () => {
  it('cache stores POST-FILTER ids: subsequent hit returns the same 1 id without re-uploading', async () => {
    renderHook();
    mockUploadMediaBatch.mockResolvedValue(['id-1', 'id-2']);
    const items = [makeItem('file://a.jpg'), makeItem('file://b.jpg')];
    // Only the first item remains selected after the upload completes.
    const selectedFirst = items.slice(0, 1);

    let ids1: string[] = [];
    await act(async () => {
      ids1 = await hookResult.uploadBatch(items, 'group-1', () => selectedFirst);
    });

    // Filter kept only the first id.
    expect(ids1).toEqual(['id-1']);

    // Cache hit: same items ref, groupId, scopeKey — resolves from cache.
    let ids2: string[] = [];
    await act(async () => {
      ids2 = await hookResult.uploadBatch(items, 'group-1', () => selectedFirst);
    });

    // uploadMediaBatch called only once total.
    expect(mockUploadMediaBatch).toHaveBeenCalledTimes(1);
    // The cached (filtered) ids are returned on the second call.
    expect(ids2).toEqual(['id-1']);
  });
});
