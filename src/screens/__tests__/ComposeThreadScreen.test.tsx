/**
 * Tests for ComposeThreadScreen — title/body inputs, Post button, and thread creation.
 *
 * The Post button is a TouchableOpacity in Header's right prop — no testID is
 * assigned. We locate it via accessibilityLabel="Post thread".
 */

import React from 'react';
import { act, create, type ReactTestRenderer, type ReactTestInstance } from 'react-test-renderer';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ThemeProvider } from '../../theme';
import { findByTestId } from '../../testUtils/rtr';
import { ComposeThreadScreen } from '../ComposeThreadScreen';

// ---------------------------------------------------------------------------
// @react-navigation/native — ComposeThreadScreen mounts useDiscardUploadGuard,
// which calls useNavigation() and usePreventRemove(). Without this mock every
// render throws "Couldn't find a navigation object." The spread keeps every
// other export the screen tree pulls from the real module; the guard's
// navigation is the SAME mockNavigation the screen gets as a prop, so a
// dispatch() from Discard is observable on it.
// ---------------------------------------------------------------------------
const mockUsePreventRemove = jest.fn();
// #908: `useBlockedPeerTransition` calls `useIsFocused()`, which the real
// module can only answer from inside a navigation container. Driven from this
// flag so a test can prove the announcement — and ONLY the announcement — is
// gated on focus.
let mockIsFocused = true;
jest.mock('@react-navigation/native', () => ({
  ...jest.requireActual('@react-navigation/native'),
  usePreventRemove: (preventRemove: boolean, cb: unknown) =>
    mockUsePreventRemove(preventRemove, cb),
  useNavigation: () => mockNavigation,
  useIsFocused: () => mockIsFocused,
}));

jest.mock('@sentry/react-native', () => ({
  captureException: jest.fn(),
  addBreadcrumb: jest.fn(),
  setUser: jest.fn(),
  wrap: (c: unknown) => c,
}));

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

jest.mock('../../services/threadService', () => ({
  createNewThread: jest.fn(),
}));

const mockUploadMediaBatch = jest.fn();
/**
 * The REAL useMediaUploadProgress runs in this suite, so its #724b rollback
 * seam has to exist in the factory: an omitted export is handed to the hook as
 * `undefined`, and the fire-and-forget `.catch` would swallow the TypeError,
 * making every rollback assertion vacuously pass.
 */
const mockRollbackUploadedMedia = jest.fn();

jest.mock('../../services/mediaUploadService', () => ({
  uploadMedia: jest.fn(),
  uploadMediaBatch: (...args: unknown[]) => mockUploadMediaBatch(...args),
  rollbackUploadedMedia: (...args: unknown[]) => mockRollbackUploadedMedia(...args),
  // Real implementation — the screen's catch calls this to decide whether the
  // failure was a self-cancel (no error banner) or a real error. A jest.fn()
  // returning undefined would make every error path look like a real error and
  // every cancel path show a banner.
  isUploadCancellation: (e: unknown) =>
    require('orbital-media-transcoder').isCancellation(e) ||
    (e instanceof Error && e.message === require('../../services/media/uploadCancellation').UPLOAD_CANCELLED_MESSAGE),
}));

let mockSelectedMedia: unknown[] = [];

jest.mock('../../hooks/useMediaPicker', () => ({
  useMediaPicker: () => ({
    selectedMedia: mockSelectedMedia,
    pickMedia: jest.fn(),
    pickPhotos: jest.fn(),
    takePhoto: jest.fn(),
    removeMedia: jest.fn(),
    clearMedia: jest.fn(),
  }),
}));

jest.mock('../../stores', () => ({
  useAuth: () => ({
    isAuthenticated: true,
    userId: 'user-1',
    username: 'alice',
    displayName: 'Alice',
    avatarPath: null,
  }),
  useContactForConversation: () => null,
}));

/**
 * #908: BlockedPeerNotice -> confirmUnblock -> blockedContentRefresh reaches
 * the store singleton (MMKV), which does not load under jest. Mocked at the
 * service boundary, the same way this suite mocks threadService.
 */
jest.mock('../../services/blockedContentRefresh', () => ({
  unblockUserAndRefresh: jest.fn(),
}));

/**
 * #908: the real `useBlockedDmPeer` reaches the store singleton (MMKV), which
 * does not load under jest — hence the mock below. The store module is mocked
 * separately so `jest.requireActual` on the hooks module is safe: that spread
 * is what keeps the REAL `useBlockedPeerTransition` (the false -> true latch
 * and its focus gate) running, which the latch tests at the bottom of this file
 * depend on. Only the two store-reading exports are overridden.
 */
jest.mock('../../stores/useAppStore', () => ({
  useAppStore: Object.assign(
    jest.fn(() => null),
    { getState: jest.fn(() => ({})) },
  ),
}));

/**
 * Mutable and reset in beforeEach; a test flips it and calls `rerender` to
 * drive the unblocked -> blocked transition.
 */
let mockBlockedPeer: { peerId: string; label: string } | null = null;
jest.mock('../../hooks/useBlockedDmPeer', () => ({
  ...jest.requireActual('../../hooks/useBlockedDmPeer'),
  // Honours the id argument: the screen passes `isDm ? groupId : null`, and
  // the real hook answers null for null — an argument-blind mock would make
  // the orbit composer look blocked.
  useBlockedDmPeer: (conversationId: string | null) =>
    conversationId == null ? null : mockBlockedPeer,
  getBlockedDmPeer: (conversationId: string | null) =>
    conversationId == null ? null : mockBlockedPeer,
}));

import * as Sentry from '@sentry/react-native';
import { createNewThread } from '../../services/threadService';
import { AccessibilityInfo, Alert, Keyboard } from 'react-native';
import { LinkPreviewCard } from '../../components/LinkPreviewCard';
import {
  ConflictError,
  NetworkError,
  QuotaExceededError,
  ServerError,
  ValidationError,
} from '../../services/api/errors';
import { UPLOAD_CANCELLED_MESSAGE } from '../../services/media/uploadCancellation';
import type { BatchUploadProgressEvent } from '../../services/mediaUploadService';
const mockCreateNewThread = createNewThread as jest.Mock;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const safeAreaMetrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, right: 0, bottom: 34, left: 0 },
};

const mockNavigation = {
  navigate: jest.fn(),
  push: jest.fn(),
  goBack: jest.fn(),
  replace: jest.fn(),
  setOptions: jest.fn(),
  addListener: jest.fn(() => jest.fn()),
  removeListener: jest.fn(),
  canGoBack: jest.fn(() => true),
  dispatch: jest.fn(),
  isFocused: jest.fn(() => true),
  reset: jest.fn(),
  popToTop: jest.fn(),
  pop: jest.fn(),
  getParent: jest.fn(),
  getState: jest.fn(() => ({ routes: [], index: 0, key: 'stack', type: 'stack' })),
  getId: jest.fn(),
  setParams: jest.fn(),
};

const mockRoute = {
  key: 'ComposeThread',
  name: 'ComposeThread' as const,
  params: { groupId: 'group-1', isDm: false },
};

/**
 * Render the composer. `params` defaults to the orbit case, so the zero-arg
 * call sites read the same as before; pass `{ groupId, isDm: true }` for the
 * DM variant (no title input, "Send message" button).
 */
function renderScreen(
  params: { groupId: string; isDm: boolean } = { groupId: 'group-1', isDm: false },
): ReactTestRenderer {
  const route = { ...mockRoute, params };
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(
      React.createElement(
        SafeAreaProvider,
        { initialMetrics: safeAreaMetrics },
        React.createElement(
          ThemeProvider,
          { colorSchemeOverride: 'light' },
          React.createElement(ComposeThreadScreen, {
            navigation: mockNavigation as unknown as React.ComponentProps<typeof ComposeThreadScreen>['navigation'],
            route: route as unknown as React.ComponentProps<typeof ComposeThreadScreen>['route'],
          }),
        ),
      ),
    );
  });
  return renderer;
}

/** Find the Post button by its accessibilityLabel. */
function findPostButton(root: ReactTestInstance): ReactTestInstance {
  const found = root.findAll(
    (node) => node.props.accessibilityLabel === 'Post thread',
  );
  if (found.length === 0) throw new Error('Post button not found (accessibilityLabel="Post thread")');
  return found[0];
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  jest.clearAllMocks();
  // clearAllMocks only clears call history: an unconsumed *Once queue would
  // leak into the next test, so the create seam is reset outright.
  mockCreateNewThread.mockReset();
  mockUsePreventRemove.mockClear();
  mockSelectedMedia = [];
  mockBlockedPeer = null;
  mockIsFocused = true;
  mockUploadMediaBatch.mockResolvedValue(['media-id-1']);
  mockRollbackUploadedMedia.mockResolvedValue(undefined);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ComposeThreadScreen — rendering', () => {
  it('renders title and body inputs', () => {
    const renderer = renderScreen();
    expect(() => findByTestId(renderer.root, 'compose-title-input')).not.toThrow();
    expect(() => findByTestId(renderer.root, 'compose-body-input')).not.toThrow();
  });

  it('renders the Post button', () => {
    const renderer = renderScreen();
    expect(() => findPostButton(renderer.root)).not.toThrow();
  });
});

describe('ComposeThreadScreen — validation', () => {
  it('Post button is disabled when title and body are empty', () => {
    const renderer = renderScreen();
    const postBtn = findPostButton(renderer.root);
    expect(postBtn.props.disabled).toBe(true);
  });

  it('Post button is disabled when only title is filled', () => {
    const renderer = renderScreen();
    act(() => {
      findByTestId(renderer.root, 'compose-title-input').props.onChangeText('My Title');
    });
    expect(findPostButton(renderer.root).props.disabled).toBe(true);
  });

  it('Post button is disabled when only body is filled', () => {
    const renderer = renderScreen();
    act(() => {
      findByTestId(renderer.root, 'compose-body-input').props.onChangeText('Some body text');
    });
    expect(findPostButton(renderer.root).props.disabled).toBe(true);
  });

  it('Post button is enabled when both title and body are filled', () => {
    const renderer = renderScreen();
    act(() => {
      findByTestId(renderer.root, 'compose-title-input').props.onChangeText('My Title');
      findByTestId(renderer.root, 'compose-body-input').props.onChangeText('Some body text');
    });
    expect(findPostButton(renderer.root).props.disabled).toBe(false);
  });
});

describe('ComposeThreadScreen — submission', () => {
  const fakeThread = {
    id: 'thread-123',
    conversationId: 'group-1',
    authorId: 'user-1',
    authorUsername: 'alice',
    title: 'My Title',
    body: 'Some body text',
    contentType: 'text' as const,
    pinned: false,
    replyCount: 0,
    lastReplyAt: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    syncStatus: 'synced' as const,
  };

  it('calls createNewThread with correct params on submit', async () => {
    mockCreateNewThread.mockResolvedValue(fakeThread);
    const renderer = renderScreen();

    act(() => {
      findByTestId(renderer.root, 'compose-title-input').props.onChangeText('  My Title  ');
      findByTestId(renderer.root, 'compose-body-input').props.onChangeText('  Some body text  ');
    });

    await act(async () => {
      findPostButton(renderer.root).props.onPress();
    });

    expect(mockCreateNewThread).toHaveBeenCalledWith(
      'group-1',
      'My Title',
      'Some body text',
      { authorId: 'user-1', authorUsername: 'alice' },
      undefined,
    );
  });

  it('navigates to ThreadDetail via replace on success', async () => {
    mockCreateNewThread.mockResolvedValue(fakeThread);
    const renderer = renderScreen();

    act(() => {
      findByTestId(renderer.root, 'compose-title-input').props.onChangeText('My Title');
      findByTestId(renderer.root, 'compose-body-input').props.onChangeText('Some body text');
    });

    await act(async () => {
      findPostButton(renderer.root).props.onPress();
    });

    expect(mockNavigation.replace).toHaveBeenCalledWith('ThreadDetail', {
      threadId: 'thread-123',
      threadTitle: 'My Title',
    });
  });

  it('shows error banner on creation failure', async () => {
    mockCreateNewThread.mockRejectedValue(new Error('Failed to create thread'));
    const renderer = renderScreen();

    act(() => {
      findByTestId(renderer.root, 'compose-title-input').props.onChangeText('My Title');
      findByTestId(renderer.root, 'compose-body-input').props.onChangeText('Some body text');
    });

    await act(async () => {
      findPostButton(renderer.root).props.onPress();
    });

    const allText = renderer.root.findAllByType('Text' as unknown as React.ComponentType);
    const errorText = allText.find(
      (node) =>
        typeof node.props.children === 'string' &&
        node.props.children.toLowerCase().includes('failed'),
    );
    expect(errorText).toBeDefined();
    expect(mockNavigation.replace).not.toHaveBeenCalled();
  });
});

describe('ComposeThreadScreen — loading state', () => {
  it('calls createNewThread once and replaces to ThreadDetail on success', async () => {
    const fakeThread = {
      id: 'thread-xyz',
      conversationId: 'group-1',
      authorId: 'user-1',
      authorUsername: 'alice',
      title: 'Hello',
      body: 'World',
      contentType: 'text' as const,
      pinned: false,
      replyCount: 0,
      lastReplyAt: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      syncStatus: 'synced' as const,
    };
    mockCreateNewThread.mockResolvedValue(fakeThread);
    const renderer = renderScreen();

    act(() => {
      findByTestId(renderer.root, 'compose-title-input').props.onChangeText('Hello');
      findByTestId(renderer.root, 'compose-body-input').props.onChangeText('World');
    });

    await act(async () => {
      findPostButton(renderer.root).props.onPress();
    });

    expect(mockCreateNewThread).toHaveBeenCalledTimes(1);
    expect(mockNavigation.replace).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// QuotaExceededError handling
// ---------------------------------------------------------------------------

describe('ComposeThreadScreen — quota error', () => {
  it('shows quota message instead of generic error on QuotaExceededError', async () => {
    mockSelectedMedia = [
      {
        uri: 'file:///photo1.jpg',
        type: 'image/jpeg',
        fileName: 'photo1.jpg',
        fileSize: 100,
        width: 50,
        height: 50,
      },
    ];
    const quotaBody = JSON.stringify({
      error: 'QUOTA_EXCEEDED',
      details: {
        quota: {
          storage_bytes: 500 * 1024 * 1024,
          max_bytes: 500 * 1024 * 1024,
          file_count: 42,
          max_files: 1000,
          storage_percent: 100,
          files_percent: 4.2,
          evictable_bytes: 0,
        },
      },
    });
    mockUploadMediaBatch.mockRejectedValue(new QuotaExceededError(quotaBody));
    const renderer = renderScreen();

    act(() => {
      findByTestId(renderer.root, 'compose-title-input').props.onChangeText('My Title');
      findByTestId(renderer.root, 'compose-body-input').props.onChangeText('Some body text');
    });

    await act(async () => {
      findPostButton(renderer.root).props.onPress();
    });

    const allText = renderer.root.findAllByType('Text' as unknown as React.ComponentType);
    const quotaText = allText.find(
      (node) =>
        typeof node.props.children === 'string' &&
        node.props.children.includes('Delete old photos or videos'),
    );
    expect(quotaText).toBeDefined();

    // The generic "Failed to create thread" should NOT appear
    const genericText = allText.find(
      (node) =>
        typeof node.props.children === 'string' &&
        node.props.children === 'Failed to create thread. Please try again.',
    );
    expect(genericText).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Sentry reporting for post failures (#738)
// ---------------------------------------------------------------------------

describe('ComposeThreadScreen — failure reporting', () => {
  const mockCaptureException = Sentry.captureException as unknown as jest.Mock;

  const oneImage = [
    {
      uri: 'file:///photo1.jpg',
      type: 'image/jpeg',
      fileName: 'photo1.jpg',
      fileSize: 100,
      width: 50,
      height: 50,
    },
  ];

  async function post(): Promise<void> {
    const renderer = renderScreen();
    act(() => {
      findByTestId(renderer.root, 'compose-title-input').props.onChangeText('My Title');
      findByTestId(renderer.root, 'compose-body-input').props.onChangeText('Some body text');
    });
    await act(async () => {
      findPostButton(renderer.root).props.onPress();
    });
  }

  /**
   * Post from the DM variant: no title input exists (`{!isDm && (`), and the
   * send control is labelled "Send message" rather than "Post thread".
   */
  async function postDm(): Promise<void> {
    const renderer = renderScreen({ groupId: 'group-1', isDm: true });
    act(() => {
      findByTestId(renderer.root, 'compose-body-input').props.onChangeText('Some body text');
    });
    const sendBtn = renderer.root.findAll(
      (node) => node.props.accessibilityLabel === 'Send message',
    );
    if (sendBtn.length === 0) throw new Error('Send button not found (accessibilityLabel="Send message")');
    await act(async () => {
      sendBtn[0].props.onPress();
    });
  }

  /** Tags of the first Sentry capture. */
  function captureTags(): Record<string, string> {
    return (mockCaptureException.mock.calls[0][1] as { tags: Record<string, string> }).tags;
  }

  it('reports a thread-create failure with the thread-create stage', async () => {
    // A typed ApiError, so the status/api_code tags are exercised alongside the
    // stage — #747 made this catch rethrow the original service error.
    mockCreateNewThread.mockRejectedValue(new ServerError(500));

    await post();

    expect(mockCaptureException).toHaveBeenCalledTimes(1);
    expect(captureTags()).toMatchObject({
      feature: 'media-upload',
      stage: 'thread-create',
      surface: 'compose-thread',
      status: '500',
      api_code: 'SERVER_ERROR',
      dm: 'false',
    });
  });

  it('tags a DM post failure with dm:true', async () => {
    mockCreateNewThread.mockRejectedValue(new ServerError(500));

    await postDm();

    expect(mockCaptureException).toHaveBeenCalledTimes(1);
    expect(captureTags().dm).toBe('true');
  });

  it('reports an upload failure with the media-upload stage', async () => {
    mockSelectedMedia = oneImage;
    mockUploadMediaBatch.mockRejectedValue(new NetworkError());

    await post();

    expect(captureTags()).toMatchObject({ stage: 'media-upload', surface: 'compose-thread' });
    expect(mockCreateNewThread).not.toHaveBeenCalled();
  });

  it('scrubs the picker path out of the reported message', async () => {
    mockSelectedMedia = oneImage;
    mockUploadMediaBatch.mockRejectedValue(
      new Error('sanitize failed: file:///var/mobile/tmp/photo1.jpg'),
    );

    await post();

    const reported = mockCaptureException.mock.calls[0][0] as Error;
    expect(reported.message).toBe('sanitize failed: <uri>');
    expect(reported.message).not.toContain('photo1');
  });

  it('reports nothing when the user cancels their own upload', async () => {
    mockSelectedMedia = oneImage;
    mockUploadMediaBatch.mockRejectedValue(new Error(UPLOAD_CANCELLED_MESSAGE));

    await post();

    expect(mockCaptureException).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Upload progress (#645) — deferred-promise mock so the batch is held open
// mid-upload, letting the test drive onProgress/signal by hand.
// ---------------------------------------------------------------------------

describe('ComposeThreadScreen — upload progress', () => {
  const fakeMedia = [
    {
      uri: 'file:///photo1.jpg',
      type: 'image/jpeg',
      fileName: 'photo1.jpg',
      fileSize: 100,
      width: 50,
      height: 50,
    },
  ];

  function fillAndArmMedia(): void {
    mockSelectedMedia = fakeMedia;
  }

  /**
   * Arms mockUploadMediaBatch to capture the batch's onProgress/signal and
   * return a promise this test controls, mirroring the deferred-promise shape
   * real code gets back from the service.
   */
  function armDeferredUpload(): {
    getOnProgress: () => ((e: BatchUploadProgressEvent) => void) | undefined;
    getSignal: () => AbortSignal | undefined;
    reject: (e: unknown) => void;
  } {
    let capturedOnProgress: ((e: BatchUploadProgressEvent) => void) | undefined;
    let capturedSignal: AbortSignal | undefined;
    let doReject: (e: unknown) => void = () => {};
    mockUploadMediaBatch.mockImplementation(
      (
        _items: unknown,
        _groupId: unknown,
        opts: { signal: AbortSignal; onProgress: (e: BatchUploadProgressEvent) => void },
      ) => {
        capturedOnProgress = opts.onProgress;
        capturedSignal = opts.signal;
        return new Promise((_resolve, reject) => {
          doReject = reject;
        });
      },
    );
    return {
      getOnProgress: () => capturedOnProgress,
      getSignal: () => capturedSignal,
      reject: (e: unknown) => doReject(e),
    };
  }

  function fillTitleAndBody(renderer: ReactTestRenderer): void {
    act(() => {
      findByTestId(renderer.root, 'compose-title-input').props.onChangeText('My Title');
      findByTestId(renderer.root, 'compose-body-input').props.onChangeText('Some body text');
    });
  }

  it('renders the fill width and MB label for an in-flight uploading progress event', () => {
    fillAndArmMedia();
    const { getOnProgress } = armDeferredUpload();
    const renderer = renderScreen();
    fillTitleAndBody(renderer);

    act(() => {
      findPostButton(renderer.root).props.onPress();
    });

    act(() => {
      getOnProgress()!({
        fraction: 0.5,
        phase: 'uploading',
        bytesSent: 14 * 1024 * 1024,
        totalBytes: 32 * 1024 * 1024,
        itemIndex: 0,
        itemCount: 1,
      });
    });

    const fill = findByTestId(renderer.root, 'upload-progress-bar-fill');
    expect(fill.props.style.width).toBe('50%');

    const label = findByTestId(renderer.root, 'upload-progress-label');
    expect(label.props.children).toBe('14 MB / 32 MB');
  });

  it('keeps the cancel button tappable while inputs are frozen mid-upload', () => {
    fillAndArmMedia();
    armDeferredUpload();
    const renderer = renderScreen();
    fillTitleAndBody(renderer);

    act(() => {
      findPostButton(renderer.root).props.onPress();
    });

    expect(findByTestId(renderer.root, 'compose-title-input').props.editable).toBe(false);
    expect(findByTestId(renderer.root, 'compose-body-input').props.editable).toBe(false);
    expect(findByTestId(renderer.root, 'upload-cancel-button').props.disabled).toBeFalsy();
  });

  it('aborts the signal and shows "Cancelling…" when the cancel button is pressed', () => {
    fillAndArmMedia();
    const { getSignal } = armDeferredUpload();
    const renderer = renderScreen();
    fillTitleAndBody(renderer);

    act(() => {
      findPostButton(renderer.root).props.onPress();
    });

    act(() => {
      findByTestId(renderer.root, 'upload-cancel-button').props.onPress();
    });

    expect(getSignal()!.aborted).toBe(true);
    expect(findByTestId(renderer.root, 'upload-progress-label').props.children).toBe('Cancelling…');
  });

  it('shows no error banner and preserves the draft body on a self-cancelled upload', async () => {
    fillAndArmMedia();
    const { reject } = armDeferredUpload();
    const renderer = renderScreen();
    fillTitleAndBody(renderer);

    act(() => {
      findPostButton(renderer.root).props.onPress();
    });

    await act(async () => {
      reject(new Error(UPLOAD_CANCELLED_MESSAGE));
      await Promise.resolve();
      await Promise.resolve();
    });

    const allText = renderer.root.findAllByType('Text' as unknown as React.ComponentType);
    const errorText = allText.find(
      (node) =>
        typeof node.props.children === 'string' &&
        node.props.children.toLowerCase().includes('failed'),
    );
    expect(errorText).toBeUndefined();

    expect(findByTestId(renderer.root, 'compose-body-input').props.value).toBe('Some body text');
  });
});

// ---------------------------------------------------------------------------
// Upload reuse cache, ConflictError copy and the unmount guards (#749/#722)
// ---------------------------------------------------------------------------

describe('ComposeThreadScreen — upload reuse cache and unmount safety', () => {
  const oneImage = [
    {
      uri: 'file:///photo1.jpg',
      type: 'image/jpeg',
      fileName: 'photo1.jpg',
      fileSize: 100,
      width: 50,
      height: 50,
    },
  ];

  const fakeThread = {
    id: 'thread-123',
    conversationId: 'group-1',
    authorId: 'user-1',
    authorUsername: 'alice',
    title: 'My Title',
    body: 'Some body text',
    contentType: 'text' as const,
    pinned: false,
    replyCount: 0,
    lastReplyAt: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    syncStatus: 'synced' as const,
  };

  /** Fill both inputs and press Post, flushing the async handler. */
  async function fillAndPost(renderer: ReactTestRenderer): Promise<void> {
    act(() => {
      findByTestId(renderer.root, 'compose-title-input').props.onChangeText('My Title');
      findByTestId(renderer.root, 'compose-body-input').props.onChangeText('Some body text');
    });
    await act(async () => {
      findPostButton(renderer.root).props.onPress();
    });
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
  }

  /** Every string rendered inside a <Text>, for banner assertions. */
  function textContents(renderer: ReactTestRenderer): string[] {
    return renderer.root
      .findAllByType('Text' as unknown as React.ComponentType)
      .map((node) => node.props.children)
      .filter((c): c is string => typeof c === 'string');
  }

  it('reuses the uploaded media ids on a second post after a create failure', async () => {
    // mockSelectedMedia is a module-level array and useMediaPicker returns that
    // same reference every render, so the cache's `source === items` identity
    // check holds across the two presses — exactly the device case where the
    // user just presses Post again after a failure.
    mockSelectedMedia = oneImage;
    mockCreateNewThread
      .mockRejectedValueOnce(new ServerError(500))
      .mockResolvedValueOnce(fakeThread);

    const renderer = renderScreen();
    await fillAndPost(renderer);
    expect(mockUploadMediaBatch).toHaveBeenCalledTimes(1);

    await fillAndPost(renderer);
    // Second press: cache hit, so no second upload, and the same ids are posted.
    expect(mockUploadMediaBatch).toHaveBeenCalledTimes(1);
    expect(mockCreateNewThread.mock.calls[1][4]).toEqual({ mediaIds: ['media-id-1'] });
    expect(mockCreateNewThread.mock.calls[1][4]).toEqual(mockCreateNewThread.mock.calls[0][4]);
  });

  it('shows the orbit conflict copy on a ConflictError and keeps the cache', async () => {
    mockSelectedMedia = oneImage;
    mockCreateNewThread.mockRejectedValue(new ConflictError());

    const renderer = renderScreen();
    await fillAndPost(renderer);

    expect(textContents(renderer)).toContain(
      'This may already have been posted. Check the orbit before posting again.',
    );
    expect(textContents(renderer)).not.toContain('Failed to create thread. Please try again.');
    expect(mockUploadMediaBatch).toHaveBeenCalledTimes(1);

    // A 409 deliberately does NOT drop the cache: re-pressing must draw another
    // 409 rather than upload a duplicate set behind a post that already exists.
    await fillAndPost(renderer);
    expect(mockUploadMediaBatch).toHaveBeenCalledTimes(1);
  });

  it('says "chat" instead of "orbit" in the DM conflict copy', async () => {
    mockCreateNewThread.mockRejectedValue(new ConflictError());

    const renderer = renderScreen({ groupId: 'group-1', isDm: true });
    act(() => {
      findByTestId(renderer.root, 'compose-body-input').props.onChangeText('Some body text');
    });
    const sendBtn = renderer.root.findAll(
      (node) => node.props.accessibilityLabel === 'Send message',
    );
    await act(async () => {
      sendBtn[0].props.onPress();
    });

    expect(textContents(renderer)).toContain(
      'This may already have been posted. Check the chat before posting again.',
    );
  });

  it('aborts the in-flight upload when the screen unmounts', async () => {
    mockSelectedMedia = oneImage;
    let capturedSignal: AbortSignal | undefined;
    mockUploadMediaBatch.mockImplementation(
      (_items: unknown, _groupId: unknown, opts: { signal: AbortSignal }) => {
        capturedSignal = opts.signal;
        return new Promise(() => {});
      },
    );

    const renderer = renderScreen();
    act(() => {
      findByTestId(renderer.root, 'compose-title-input').props.onChangeText('My Title');
      findByTestId(renderer.root, 'compose-body-input').props.onChangeText('Some body text');
    });
    act(() => {
      findPostButton(renderer.root).props.onPress();
    });

    expect(capturedSignal!.aborted).toBe(false);
    act(() => {
      renderer.unmount();
    });
    expect(capturedSignal!.aborted).toBe(true);
  });

  it('does not navigate or set state when createNewThread resolves after unmount', async () => {
    let resolveCreate: (t: unknown) => void = () => {};
    mockCreateNewThread.mockImplementation(
      () => new Promise((resolve) => { resolveCreate = resolve; }),
    );

    const renderer = renderScreen();
    act(() => {
      findByTestId(renderer.root, 'compose-title-input').props.onChangeText('My Title');
      findByTestId(renderer.root, 'compose-body-input').props.onChangeText('Some body text');
    });
    act(() => {
      findPostButton(renderer.root).props.onPress();
    });

    act(() => {
      renderer.unmount();
    });

    // postReply's compose twin is not abortable, so the create resolves on a
    // dead screen — the mountedRef gate must swallow the navigation.
    await act(async () => {
      resolveCreate(fakeThread);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });

    expect(mockNavigation.replace).not.toHaveBeenCalled();
    expect(mockNavigation.goBack).not.toHaveBeenCalled();
  });

  it('does not navigate when createNewThread rejects after unmount', async () => {
    let rejectCreate: (e: unknown) => void = () => {};
    mockCreateNewThread.mockImplementation(
      () => new Promise((_resolve, reject) => { rejectCreate = reject; }),
    );

    const renderer = renderScreen();
    act(() => {
      findByTestId(renderer.root, 'compose-title-input').props.onChangeText('My Title');
      findByTestId(renderer.root, 'compose-body-input').props.onChangeText('Some body text');
    });
    act(() => {
      findPostButton(renderer.root).props.onPress();
    });

    act(() => {
      renderer.unmount();
    });

    await act(async () => {
      rejectCreate(new ServerError(500));
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });

    // Telemetry still fires (it is not mount-gated); only screen state is.
    expect(Sentry.captureException as unknown as jest.Mock).toHaveBeenCalledTimes(1);
    expect(mockNavigation.replace).not.toHaveBeenCalled();
  });

  it('arms the discard guard while an upload is in flight and disarms it after', async () => {
    mockSelectedMedia = oneImage;
    let resolveUpload: (ids: string[]) => void = () => {};
    mockUploadMediaBatch.mockImplementation(
      () => new Promise((resolve) => { resolveUpload = resolve; }),
    );
    mockCreateNewThread.mockResolvedValue(fakeThread);

    const renderer = renderScreen();
    act(() => {
      findByTestId(renderer.root, 'compose-title-input').props.onChangeText('My Title');
      findByTestId(renderer.root, 'compose-body-input').props.onChangeText('Some body text');
    });
    act(() => {
      findPostButton(renderer.root).props.onPress();
    });

    // usePreventRemove is called on every render; the latest call reflects the
    // current arm state.
    const armedDuring = mockUsePreventRemove.mock.calls.at(-1)?.[0];
    expect(armedDuring).toBe(true);

    await act(async () => {
      resolveUpload(['media-id-1']);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });

    // Success clears the reuse cache, so neither arm is live any more.
    expect(mockUsePreventRemove.mock.calls.at(-1)?.[0]).toBe(false);
  });

  it('keeps the guard off the success navigation while the create is in flight (PR #839 review)', async () => {
    // usePreventRemove reads the last COMMITTED render. With a slow create, a
    // render commits after the upload lands (hasUnsentUpload=true) and before
    // replace() dispatches -- the guard must not be armed on that frame, or a
    // successful post gets intercepted by "Discard unsent post?".
    mockSelectedMedia = oneImage;
    mockUploadMediaBatch.mockResolvedValue(['media-id-1']);
    let resolveCreate: (t: unknown) => void = () => {};
    mockCreateNewThread.mockImplementation(
      () => new Promise((resolve) => { resolveCreate = resolve; }),
    );
    let armedAtReplace: unknown = 'not-called';
    mockNavigation.replace.mockImplementation(() => {
      armedAtReplace = mockUsePreventRemove.mock.calls.at(-1)?.[0];
    });

    const renderer = renderScreen();
    act(() => {
      findByTestId(renderer.root, 'compose-title-input').props.onChangeText('My Title');
      findByTestId(renderer.root, 'compose-body-input').props.onChangeText('Some body text');
    });
    await act(async () => {
      findPostButton(renderer.root).props.onPress();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
    // Upload landed, create still pending: not armed.
    expect(mockUsePreventRemove.mock.calls.at(-1)?.[0]).toBe(false);

    await act(async () => {
      resolveCreate(fakeThread);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
    expect(mockNavigation.replace).toHaveBeenCalled();
    expect(armedAtReplace).toBe(false);
  });

  it('arms the unsent guard after a failed create with media selected, and disarms when the strip is cleared', async () => {
    mockSelectedMedia = oneImage;
    mockUploadMediaBatch.mockResolvedValue(['media-id-1']);
    mockCreateNewThread.mockRejectedValue(new Error('network down'));

    const renderer = renderScreen();
    act(() => {
      findByTestId(renderer.root, 'compose-title-input').props.onChangeText('My Title');
      findByTestId(renderer.root, 'compose-body-input').props.onChangeText('Some body text');
    });
    await act(async () => {
      findPostButton(renderer.root).props.onPress();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
    expect(mockUsePreventRemove.mock.calls.at(-1)?.[0]).toBe(true);

    // useMediaPicker hands back a new (empty) array when the strip is cleared.
    mockSelectedMedia = [];
    act(() => {
      findByTestId(renderer.root, 'compose-body-input').props.onChangeText('Some body text!');
    });
    expect(mockUsePreventRemove.mock.calls.at(-1)?.[0]).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Uploaded-media rollback (#724b)
  // -------------------------------------------------------------------------

  /** Drive the discard guard: trigger the prevented-remove callback, press Discard. */
  async function confirmDiscard(): Promise<void> {
    const onPrevented = mockUsePreventRemove.mock.calls.at(-1)?.[1] as (
      e: { data: { action: unknown } },
    ) => void;
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    act(() => {
      onPrevented({ data: { action: { type: 'POP' } } });
    });
    const buttons = alertSpy.mock.calls[0][2] as { text: string; onPress?: () => void }[];
    const discard = buttons.find((b) => b.text === 'Discard');
    await act(async () => {
      discard?.onPress?.();
      // The rollback is scheduled on a microtask, so it has to be flushed
      // before the assertion.
      await Promise.resolve();
      await Promise.resolve();
    });
    alertSpy.mockRestore();
  }

  it('rolls the held media ids back when the user confirms Discard', async () => {
    mockSelectedMedia = oneImage;
    // 400 is a definitely-not-committed failure, so the cache stays
    // rollback-eligible.
    mockCreateNewThread.mockRejectedValue(new ValidationError(400));

    const renderer = renderScreen();
    await fillAndPost(renderer);
    expect(mockUsePreventRemove.mock.calls.at(-1)?.[0]).toBe(true);

    await confirmDiscard();

    expect(mockRollbackUploadedMedia).toHaveBeenCalledWith(['media-id-1']);
    expect(mockNavigation.dispatch).toHaveBeenCalled();
  });

  it('rolls nothing back on a successful post', async () => {
    mockSelectedMedia = oneImage;
    mockCreateNewThread.mockResolvedValue(fakeThread);

    const renderer = renderScreen();
    await fillAndPost(renderer);

    expect(mockNavigation.replace).toHaveBeenCalled();
    expect(mockRollbackUploadedMedia).not.toHaveBeenCalled();
  });

  it('after a 409 leaves the guard disarmed and never rolls the ids back', async () => {
    mockSelectedMedia = oneImage;
    mockCreateNewThread.mockRejectedValue(new ConflictError());

    const renderer = renderScreen();
    await fillAndPost(renderer);

    // The post probably committed, so there is nothing left to protect: Back
    // must navigate straight through with no "Discard unsent post?" prompt.
    expect(mockUsePreventRemove.mock.calls.at(-1)?.[0]).toBe(false);

    // And a Discard that arrives anyway (the guard's other arm, e.g. a later
    // in-flight upload) must not delete media that is on a post.
    await confirmDiscard();
    expect(mockRollbackUploadedMedia).not.toHaveBeenCalled();
  });

  it('after a create-stage network failure KEEPS the guard armed but still rolls nothing back', async () => {
    mockSelectedMedia = oneImage;
    mockCreateNewThread.mockRejectedValue(new NetworkError());

    const renderer = renderScreen();
    await fillAndPost(renderer);

    // Unlike a 409, a network failure leaves it genuinely unknown whether the
    // post exists, so the user may still be holding unattached media: the
    // "Discard unsent post?" prompt has to survive (Alex, PR #840 review).
    expect(mockUsePreventRemove.mock.calls.at(-1)?.[0]).toBe(true);
    // ...but the ids are flagged, so discarding must not delete media that may
    // be on a post.
    await confirmDiscard();
    expect(mockRollbackUploadedMedia).not.toHaveBeenCalled();
  });

  it('after a 5xx keeps the guard armed and rolls nothing back', async () => {
    mockSelectedMedia = oneImage;
    mockCreateNewThread.mockRejectedValue(new ServerError(500));

    const renderer = renderScreen();
    await fillAndPost(renderer);

    expect(mockUsePreventRemove.mock.calls.at(-1)?.[0]).toBe(true);
    await confirmDiscard();
    expect(mockRollbackUploadedMedia).not.toHaveBeenCalled();
  });

  it('shows the "may already have been posted" banner for a network failure, not just a 409', async () => {
    mockSelectedMedia = oneImage;
    mockCreateNewThread.mockRejectedValue(new NetworkError());

    const renderer = renderScreen();
    await fillAndPost(renderer);

    expect(textContents(renderer)).toContain(
      'This may already have been posted. Check the orbit before posting again.',
    );
    expect(textContents(renderer)).not.toContain('Failed to create thread. Please try again.');
  });

  it('keeps the generic banner for a failure that provably never committed', async () => {
    mockSelectedMedia = oneImage;
    mockCreateNewThread.mockRejectedValue(new ValidationError(400));

    const renderer = renderScreen();
    await fillAndPost(renderer);

    expect(textContents(renderer)).toContain('Failed to create thread. Please try again.');
  });

  it('keeps the generic banner when the rate-limit backoff abort never left the device', async () => {
    mockSelectedMedia = oneImage;
    // neverSent: the retry was abandoned before it was issued, so nothing can
    // have been posted and the media is still rollback-eligible.
    mockCreateNewThread.mockRejectedValue(
      new NetworkError('Request aborted during rate-limit backoff', true),
    );

    const renderer = renderScreen();
    await fillAndPost(renderer);

    expect(textContents(renderer)).toContain('Failed to create thread. Please try again.');
    await confirmDiscard();
    expect(mockRollbackUploadedMedia).toHaveBeenCalledWith(['media-id-1']);
  });

  it('marks the cache from an unmounted screen when the 409 lands late', async () => {
    // The mark sits OUTSIDE the `if (mountedRef.current)` UI block, so it runs
    // on a dead screen. Nothing observable survives that screen, so what this
    // pins is the negative: a post-unmount 409 neither rolls media back nor
    // throws through the unguarded call.
    mockSelectedMedia = oneImage;
    let rejectCreate: (e: unknown) => void = () => {};
    mockCreateNewThread.mockImplementation(
      () => new Promise((_resolve, reject) => { rejectCreate = reject; }),
    );

    const renderer = renderScreen();
    act(() => {
      findByTestId(renderer.root, 'compose-title-input').props.onChangeText('My Title');
      findByTestId(renderer.root, 'compose-body-input').props.onChangeText('Some body text');
    });
    await act(async () => {
      findPostButton(renderer.root).props.onPress();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
    act(() => {
      renderer.unmount();
    });

    await act(async () => {
      rejectCreate(new ConflictError());
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });

    expect(mockRollbackUploadedMedia).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Blocked DM peer (#908)
// ---------------------------------------------------------------------------

describe('ComposeThreadScreen — blocked DM peer', () => {
  const dmParams = { groupId: 'dm-1', isDm: true };
  const blocked = { peerId: 'u-bob', label: '@bob' };

  const oneImage = [
    {
      uri: 'file:///photo1.jpg',
      type: 'image/jpeg',
      fileName: 'photo1.jpg',
      fileSize: 100,
      width: 50,
      height: 50,
    },
  ];

  /** Re-render the same tree so a flipped mockBlockedPeer is picked up. */
  function rerender(
    renderer: ReactTestRenderer,
    params: { groupId: string; isDm: boolean },
  ): void {
    act(() => {
      renderer.update(
        React.createElement(
          SafeAreaProvider,
          { initialMetrics: safeAreaMetrics },
          React.createElement(
            ThemeProvider,
            { colorSchemeOverride: 'light' },
            React.createElement(ComposeThreadScreen, {
              navigation: mockNavigation as unknown as React.ComponentProps<typeof ComposeThreadScreen>['navigation'],
              route: { ...mockRoute, params } as unknown as React.ComponentProps<typeof ComposeThreadScreen>['route'],
            }),
          ),
        ),
      );
    });
  }

  function findSendButton(renderer: ReactTestRenderer): ReactTestInstance {
    const found = renderer.root.findAll(
      (node) => node.props.accessibilityLabel === 'Send message',
    );
    if (found.length === 0) throw new Error('Send button not found');
    return found[0];
  }

  it('replaces the body input with the notice, keeps the media strip, and disables Send', () => {
    mockBlockedPeer = blocked;
    mockSelectedMedia = oneImage;
    const renderer = renderScreen(dmParams);

    expect(() => findByTestId(renderer.root, 'blocked-peer-notice')).not.toThrow();
    expect(() => findByTestId(renderer.root, 'compose-body-input')).toThrow();
    expect(() => findByTestId(renderer.root, 'attach-media-button')).toThrow();
    // The strip stays mounted so attachments remain visible and removable.
    expect(() => findByTestId(renderer.root, 'media-thumbnail-strip')).not.toThrow();
    expect(findSendButton(renderer).props.disabled).toBe(true);
  });

  it('keeps the draft body, so it comes back after an unblock', () => {
    const renderer = renderScreen(dmParams);
    act(() => {
      findByTestId(renderer.root, 'compose-body-input').props.onChangeText('draft text');
    });

    mockBlockedPeer = blocked;
    rerender(renderer, dmParams);
    expect(() => findByTestId(renderer.root, 'compose-body-input')).toThrow();

    mockBlockedPeer = null;
    rerender(renderer, dmParams);
    expect(findByTestId(renderer.root, 'compose-body-input').props.value).toBe('draft text');
  });

  it('keeps the discard guard armed when the block lands on held media', async () => {
    // The armed state is the post-failure one: the batch landed, the create
    // failed, and the screen is holding ids only this session can attach
    // (#724b). Selecting media is NOT enough on its own — `usePreventRemove`
    // is called on every render, so the old `toHaveBeenCalled()` here could
    // never fail; the last call's arm flag is the only thing that says
    // anything.
    mockSelectedMedia = oneImage;
    mockUploadMediaBatch.mockResolvedValue(['media-id-1']);
    mockCreateNewThread.mockRejectedValue(new Error('boom'));

    const renderer = renderScreen(dmParams);
    act(() => {
      findByTestId(renderer.root, 'compose-body-input').props.onChangeText('Some body text');
    });
    await act(async () => {
      findSendButton(renderer).props.onPress();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
    // Positive control: armed BEFORE the block, so a `false` below is the
    // block's doing and not the fixture's.
    expect(mockUsePreventRemove.mock.calls.at(-1)?.[0]).toBe(true);

    mockBlockedPeer = blocked;
    rerender(renderer, dmParams);

    // Still armed — blocking must not strand the uploaded ids as FileLibrary
    // ghosts — and the strip gives the prompt something to refer to.
    expect(mockUsePreventRemove.mock.calls.at(-1)?.[0]).toBe(true);
    expect(() => findByTestId(renderer.root, 'media-thumbnail-strip')).not.toThrow();
  });

  it('hides the link preview card while blocked', () => {
    const renderer = renderScreen(dmParams);
    act(() => {
      findByTestId(renderer.root, 'compose-body-input').props.onChangeText('see https://x.test');
    });
    // Positive control: the card IS mounted for the same draft when the peer
    // is not blocked. (It renders null until a preview resolves, so only the
    // component's presence in the tree is observable.)
    expect(renderer.root.findAllByType(LinkPreviewCard).length).toBeGreaterThan(0);

    mockBlockedPeer = blocked;
    rerender(renderer, dmParams);

    // Moved inside the non-blocked branch: the card must not preview — or keep
    // fetching metadata for — a draft the user can no longer see.
    expect(renderer.root.findAllByType(LinkPreviewCard).length).toBe(0);
  });

  it('dismisses the keyboard on the false -> true block transition', () => {
    const dismissSpy = jest.spyOn(Keyboard, 'dismiss').mockImplementation(() => {});
    try {
      const renderer = renderScreen(dmParams);
      act(() => {
        findByTestId(renderer.root, 'compose-body-input').props.onChangeText('Some body text');
      });
      expect(dismissSpy).not.toHaveBeenCalled();

      mockBlockedPeer = blocked;
      rerender(renderer, dmParams);

      // The body input unmounts under the keyboard and Android does not
      // guarantee it drops on its own.
      expect(dismissSpy).toHaveBeenCalledTimes(1);
    } finally {
      dismissSpy.mockRestore();
    }
  });

  it('announces the block exactly once, however many renders follow', () => {
    const announceSpy = jest
      .spyOn(AccessibilityInfo, 'announceForAccessibility')
      .mockImplementation(() => {});
    try {
      const renderer = renderScreen(dmParams);
      expect(announceSpy).not.toHaveBeenCalled();

      mockBlockedPeer = blocked;
      rerender(renderer, dmParams);
      expect(announceSpy).toHaveBeenCalledTimes(1);
      expect(announceSpy).toHaveBeenCalledWith('You blocked @bob. Sending is turned off.');

      // Three more committed renders while still blocked, including the
      // identity churn a contacts/conversations upsert produces and a label
      // change. The `wasBlockedRef` latch has to swallow all of them — without
      // it VoiceOver repeats the sentence on every store write.
      rerender(renderer, dmParams);
      mockBlockedPeer = { ...blocked };
      rerender(renderer, dmParams);
      mockBlockedPeer = { peerId: 'u-bob', label: 'user-u-bob' };
      rerender(renderer, dmParams);

      expect(announceSpy).toHaveBeenCalledTimes(1);
    } finally {
      announceSpy.mockRestore();
    }
  });

  it('re-announces after an unblock and a re-block', () => {
    const announceSpy = jest
      .spyOn(AccessibilityInfo, 'announceForAccessibility')
      .mockImplementation(() => {});
    try {
      const renderer = renderScreen(dmParams);
      mockBlockedPeer = blocked;
      rerender(renderer, dmParams);
      mockBlockedPeer = null;
      rerender(renderer, dmParams);
      mockBlockedPeer = blocked;
      rerender(renderer, dmParams);

      // The latch resets on true -> false, so the second block is a real edge.
      expect(announceSpy).toHaveBeenCalledTimes(2);
    } finally {
      announceSpy.mockRestore();
    }
  });

  it('skips the announcement while unfocused but still runs the screen resets', () => {
    // ThreadDetail, ChatDetail and this composer can all be mounted on the
    // same stack: only the focused one speaks, but every one of them still has
    // to cancel its upload and drop its keyboard.
    mockIsFocused = false;
    const announceSpy = jest
      .spyOn(AccessibilityInfo, 'announceForAccessibility')
      .mockImplementation(() => {});
    const dismissSpy = jest.spyOn(Keyboard, 'dismiss').mockImplementation(() => {});
    try {
      mockSelectedMedia = oneImage;
      let capturedSignal: AbortSignal | undefined;
      mockUploadMediaBatch.mockImplementation(
        (_items: unknown, _groupId: unknown, opts: { signal: AbortSignal }) => {
          capturedSignal = opts.signal;
          return new Promise(() => {});
        },
      );

      const renderer = renderScreen(dmParams);
      act(() => {
        findByTestId(renderer.root, 'compose-body-input').props.onChangeText('Some body text');
      });
      act(() => {
        findSendButton(renderer).props.onPress();
      });
      expect(capturedSignal!.aborted).toBe(false);

      mockBlockedPeer = blocked;
      rerender(renderer, dmParams);

      expect(announceSpy).not.toHaveBeenCalled();
      // The resets are NOT focus-gated.
      expect(capturedSignal!.aborted).toBe(true);
      expect(dismissSpy).toHaveBeenCalled();
    } finally {
      announceSpy.mockRestore();
      dismissSpy.mockRestore();
    }
  });

  it('starts no upload and no create from a press queued before the block', async () => {
    // The composer's Send is `disabled` while blocked, but a test press (and a
    // real press already in the event queue) bypasses that — so the refusal
    // has to live inside `doPost`.
    mockSelectedMedia = oneImage;
    mockCreateNewThread.mockResolvedValue({ id: 'thread-1', title: null });

    const renderer = renderScreen(dmParams);
    act(() => {
      findByTestId(renderer.root, 'compose-body-input').props.onChangeText('Some body text');
    });
    // Positive control: with the same draft and media, an unblocked press DOES
    // start the upload — so the zero counts below are the guard's doing.
    expect(findSendButton(renderer).props.disabled).toBe(false);

    mockBlockedPeer = blocked;
    rerender(renderer, dmParams);
    mockUploadMediaBatch.mockClear();
    mockCreateNewThread.mockClear();

    await act(async () => {
      findSendButton(renderer).props.onPress();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });

    expect(mockUploadMediaBatch).not.toHaveBeenCalled();
    expect(mockCreateNewThread).not.toHaveBeenCalled();
    expect(mockNavigation.goBack).not.toHaveBeenCalled();
    expect(mockNavigation.replace).not.toHaveBeenCalled();
  });

  it('cancels an in-flight upload when the block lands mid-send', () => {
    mockSelectedMedia = oneImage;
    let capturedSignal: AbortSignal | undefined;
    mockUploadMediaBatch.mockImplementation(
      (_items: unknown, _groupId: unknown, opts: { signal: AbortSignal }) => {
        capturedSignal = opts.signal;
        return new Promise(() => {});
      },
    );

    const renderer = renderScreen(dmParams);
    act(() => {
      findByTestId(renderer.root, 'compose-body-input').props.onChangeText('Some body text');
    });
    act(() => {
      findSendButton(renderer).props.onPress();
    });
    expect(capturedSignal!.aborted).toBe(false);

    mockBlockedPeer = blocked;
    rerender(renderer, dmParams);

    expect(capturedSignal!.aborted).toBe(true);
  });

  it('does not re-cancel when an unrelated store write churns the blocked object', () => {
    mockSelectedMedia = oneImage;
    let abortCount = 0;
    mockUploadMediaBatch.mockImplementation(
      (_items: unknown, _groupId: unknown, opts: { signal: AbortSignal }) => {
        opts.signal.addEventListener('abort', () => { abortCount++; });
        return new Promise(() => {});
      },
    );

    const renderer = renderScreen(dmParams);
    act(() => {
      findByTestId(renderer.root, 'compose-body-input').props.onChangeText('Some body text');
    });
    act(() => {
      findSendButton(renderer).props.onPress();
    });

    mockBlockedPeer = blocked;
    rerender(renderer, dmParams);
    expect(abortCount).toBe(1);

    // A fresh object with identical content — what a contacts/conversations
    // upsert produces. The wasBlockedRef latch must swallow it (R3-4).
    mockBlockedPeer = { ...blocked };
    rerender(renderer, dmParams);
    expect(abortCount).toBe(1);
  });

  it('shows blocked-specific copy and reports nothing when createNewThread refuses', async () => {
    const mockCaptureException = Sentry.captureException as unknown as jest.Mock;
    const err = new Error('You blocked this person.');
    err.name = 'BlockedRecipientError';
    mockCreateNewThread.mockRejectedValue(err);

    // The realistic shape: the press happened while the composer still
    // believed it could send, and the block landed before the service ran.
    // The service is the enforcement point, so the screen only has to explain
    // the refusal.
    const renderer = renderScreen(dmParams);
    act(() => {
      findByTestId(renderer.root, 'compose-body-input').props.onChangeText('Some body text');
    });
    await act(async () => {
      findSendButton(renderer).props.onPress();
    });

    const allText = renderer.root.findAllByType('Text' as unknown as React.ComponentType);
    const errorText = allText.find(
      (node) =>
        typeof node.props.children === 'string' &&
        node.props.children.startsWith('Not sent —'),
    );
    expect(errorText).toBeDefined();
    // Not the generic retry banner.
    expect(
      allText.some(
        (node) =>
          typeof node.props.children === 'string' &&
          node.props.children === 'Failed to create thread. Please try again.',
      ),
    ).toBe(false);
    // R3-3: no telemetry on a refusal the client made on purpose, so the
    // blocked peer's id never reaches Sentry.
    expect(mockCaptureException).not.toHaveBeenCalled();
  });

  it('leaves the orbit composer (isDm: false) untouched', () => {
    mockBlockedPeer = blocked;
    const renderer = renderScreen({ groupId: 'group-1', isDm: false });
    expect(() => findByTestId(renderer.root, 'blocked-peer-notice')).toThrow();
    expect(() => findByTestId(renderer.root, 'compose-body-input')).not.toThrow();
    expect(() => findByTestId(renderer.root, 'attach-media-button')).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Group-key failures (#912)
//
// In THIS suite, not a new file, so the cases inherit the suite's warm module
// registry and mock plumbing (#731).
// ---------------------------------------------------------------------------

describe('ComposeThreadScreen — group key (#912)', () => {
  const mockCaptureException = Sentry.captureException as unknown as jest.Mock;

  // The exact strings the user sees, pinned as literals (not imported from
  // utils/errorMessages) so a wording change shows up as a diff here.
  const RESENDING =
    "This conversation's encryption key is being re-sent by another member. Please try again in a moment.";
  const UNREADABLE =
    "This device can't open this conversation's encryption key. Another member needs to open Orbital to re-send it.";
  const RETRY_LATER =
    "Couldn't recover this conversation's encryption key right now. Please try again in a few minutes.";
  const DEVICE_KEY =
    "This device's encryption keys need to be restored before this conversation can be opened.";
  const GENERIC = 'Failed to create thread. Please try again.';

  /** `contentCrypto.PendingWrapError`: only the `name` is load-bearing. */
  function pendingWrap(): Error {
    const e = new Error('Group key not yet available (pending wrap)');
    e.name = 'PendingWrapError';
    return e;
  }

  /**
   * `crypto/groupKeyErrors.GroupKeyUnwrapError` — built by hand rather than
   * imported, for the same reason the screen matches on `name`: the class is
   * not reachable from a suite that factory-mocks the service modules.
   */
  function unwrapFailure(selfHeal: string): Error {
    const e = new Error(`Group key unwrap failed: recipient_mismatch / ${selfHeal}`);
    e.name = 'GroupKeyUnwrapError';
    (e as unknown as { selfHeal: string }).selfHeal = selfHeal;
    return e;
  }

  /** Every rendered string in the tree. */
  function texts(renderer: ReactTestRenderer): string[] {
    return renderer.root
      .findAllByType('Text' as unknown as React.ComponentType)
      .map((node) => node.props.children)
      .filter((c): c is string => typeof c === 'string');
  }

  async function post(): Promise<ReactTestRenderer> {
    const renderer = renderScreen();
    act(() => {
      findByTestId(renderer.root, 'compose-title-input').props.onChangeText('My Title');
      findByTestId(renderer.root, 'compose-body-input').props.onChangeText('Some body text');
    });
    await act(async () => {
      findPostButton(renderer.root).props.onPress();
    });
    return renderer;
  }

  it('shows the RESENDING copy, not the generic one, on a pending wrap', async () => {
    mockCreateNewThread.mockRejectedValue(pendingWrap());

    const renderer = await post();

    const rendered = texts(renderer);
    expect(rendered).toContain(RESENDING);
    // The D5 regression this test exists for: the most common #912 outcome
    // used to render as a generic "try again".
    expect(rendered).not.toContain(GENERIC);
    // The budgeted group-key reporter is the only emitter, so
    // captureUploadFailure (which forwards to Sentry) must not run.
    expect(mockCaptureException).not.toHaveBeenCalled();
    expect(mockNavigation.replace).not.toHaveBeenCalled();
  });

  it.each([
    ['refused', UNREADABLE],
    ['unsupported', UNREADABLE],
    ['cooldown', RETRY_LATER],
    ['rate_limited', RETRY_LATER],
    ['blocked_local_key', DEVICE_KEY],
  ])('routes a %s unwrap failure to its own copy, with no capture', async (outcome, message) => {
    mockCreateNewThread.mockRejectedValue(unwrapFailure(outcome));

    const renderer = await post();

    const rendered = texts(renderer);
    expect(rendered).toContain(message);
    expect(rendered).not.toContain(GENERIC);
    expect(mockCaptureException).not.toHaveBeenCalled();
  });

  it('still reports and shows the generic copy for a failure that is not a key failure', async () => {
    mockCreateNewThread.mockRejectedValue(new Error('network down'));

    const renderer = await post();

    const rendered = texts(renderer);
    expect(rendered).toContain(GENERIC);
    expect(rendered).not.toContain(RESENDING);
    expect(mockCaptureException).toHaveBeenCalledTimes(1);
  });
});
