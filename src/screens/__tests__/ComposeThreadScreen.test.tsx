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
// Module mocks
// ---------------------------------------------------------------------------

jest.mock('../../services/threadService', () => ({
  createNewThread: jest.fn(),
}));

jest.mock('../../services/mediaUploadService', () => ({
  uploadMedia: jest.fn(),
}));

jest.mock('../../hooks/useMediaPicker', () => ({
  useMediaPicker: () => ({
    selectedMedia: [],
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
}));

import { createNewThread } from '../../services/threadService';
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

function renderScreen(): ReactTestRenderer {
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
            route: mockRoute as unknown as React.ComponentProps<typeof ComposeThreadScreen>['route'],
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
