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
jest.mock('@react-navigation/native', () => ({
  ...jest.requireActual('@react-navigation/native'),
  usePreventRemove: (preventRemove: boolean, cb: unknown) =>
    mockUsePreventRemove(preventRemove, cb),
  useNavigation: () => mockNavigation,
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

jest.mock('../../services/mediaUploadService', () => ({
  uploadMedia: jest.fn(),
  uploadMediaBatch: (...args: unknown[]) => mockUploadMediaBatch(...args),
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

import * as Sentry from '@sentry/react-native';
import { createNewThread } from '../../services/threadService';
import { ConflictError, NetworkError, QuotaExceededError, ServerError } from '../../services/api/errors';
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
  params: { groupId: 'group-1' },
};

/**
 * Render the composer. `params` defaults to the orbit case, so the zero-arg
 * call sites read the same as before; pass `{ groupId, isDm: true }` for the
 * DM variant (no title input, "Send message" button).
 */
function renderScreen(
  params: { groupId: string; isDm?: boolean } = { groupId: 'group-1' },
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

function findByTestId(root: ReactTestInstance, testID: string): ReactTestInstance {
  const found = root.findAll((node) => node.props.testID === testID);
  if (found.length === 0) throw new Error(`No element with testID "${testID}"`);
  return found[0];
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
  mockUploadMediaBatch.mockResolvedValue(['media-id-1']);
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
});
