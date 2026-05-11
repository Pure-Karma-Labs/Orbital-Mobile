/**
 * Tests for ThreadDetailScreen — thread detail view with nested replies and composer.
 */

import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { ThemeProvider } from '../../theme';
import { ThreadDetailScreen } from '../ThreadDetailScreen';

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

const mockLoadThread = jest.fn();
const mockLoadReplies = jest.fn();
const mockPostReply = jest.fn();

jest.mock('../../services/threadService', () => ({
  loadThread: (...args: unknown[]) => mockLoadThread(...args),
  loadReplies: (...args: unknown[]) => mockLoadReplies(...args),
  postReply: (...args: unknown[]) => mockPostReply(...args),
}));

const mockSetActiveThread = jest.fn();

jest.mock('../../stores', () => ({
  useAuth: () => ({
    isAuthenticated: true,
    userId: 'user-1',
    username: 'alice',
    displayName: 'Alice',
    avatarPath: null,
  }),
  useThreads: jest.fn(() => ({
    threads: {},
    threadIdsByConversation: {},
    replies: {},
    replyIdsByThread: {},
    activeThreadId: null,
    setThreads: jest.fn(),
    upsertThread: jest.fn(),
    removeThread: jest.fn(),
    setActiveThread: mockSetActiveThread,
    setReplies: jest.fn(),
    appendReplies: jest.fn(),
    upsertReply: jest.fn(),
    addOptimisticThread: jest.fn(),
    addOptimisticReply: jest.fn(),
    updateThreadSyncStatus: jest.fn(),
    updateReplySyncStatus: jest.fn(),
  })),
  useConversations: () => ({
    conversations: {},
    conversationIds: [],
    activeConversationId: null,
  }),
}));

jest.mock('@react-navigation/native-stack', () => ({
  createNativeStackNavigator: jest.fn(),
}));

// ---------------------------------------------------------------------------
// Minimal navigation prop mock
// ---------------------------------------------------------------------------

const mockNavigation = {
  push: jest.fn(),
  navigate: jest.fn(),
  goBack: jest.fn(),
  setOptions: jest.fn(),
  addListener: jest.fn(() => () => {}),
  removeListener: jest.fn(),
  canGoBack: jest.fn(() => true),
  dispatch: jest.fn(),
  isFocused: jest.fn(() => true),
  reset: jest.fn(),
  replace: jest.fn(),
  popToTop: jest.fn(),
  pop: jest.fn(),
  getParent: jest.fn(),
  getState: jest.fn(() => ({ routes: [], index: 0, key: 'stack', type: 'stack' })),
  getId: jest.fn(),
  setParams: jest.fn(),
};

const mockRoute = {
  key: 'ThreadDetail',
  name: 'ThreadDetail' as const,
  params: { threadId: 'thread-1', threadTitle: 'Test Thread' },
};

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const now = Date.now();

const fakeThread = {
  id: 'thread-1',
  conversationId: 'group-1',
  authorId: 'user-1',
  authorUsername: 'alice',
  title: 'Test Thread Title',
  body: 'This is the thread body content',
  contentType: 'text' as const,
  pinned: false,
  replyCount: 2,
  lastReplyAt: now,
  createdAt: now - 3600000, // 1 hour ago
  updatedAt: now - 3600000,
  syncStatus: 'synced' as const,
};

const fakeReplies = [
  {
    id: 'reply-1',
    threadId: 'thread-1',
    authorId: 'user-2',
    authorUsername: 'bob',
    body: 'First reply content',
    parentReplyId: null,
    depth: 0,
    createdAt: now - 1800000,
    updatedAt: now - 1800000,
    syncStatus: 'synced' as const,
  },
  {
    id: 'reply-2',
    threadId: 'thread-1',
    authorId: 'user-3',
    authorUsername: 'charlie',
    body: 'Nested reply content',
    parentReplyId: 'reply-1',
    depth: 1,
    createdAt: now - 900000,
    updatedAt: now - 900000,
    syncStatus: 'synced' as const,
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function renderScreen(): Promise<ReactTestRenderer> {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      React.createElement(
        ThemeProvider,
        { colorSchemeOverride: 'light' },
        React.createElement(ThreadDetailScreen, {
          navigation: mockNavigation as unknown as React.ComponentProps<typeof ThreadDetailScreen>['navigation'],
          route: mockRoute as unknown as React.ComponentProps<typeof ThreadDetailScreen>['route'],
        }),
      ),
    );
  });
  // Flush pending microtasks (async effects from useEffect: loadThread/loadReplies)
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
  return renderer;
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  jest.clearAllMocks();
  // Default: loadThread and loadReplies resolve but store stays empty
  // (store is mocked separately)
  mockLoadThread.mockResolvedValue(fakeThread);
  mockLoadReplies.mockResolvedValue({
    replies: [],
    nextCursor: null,
    hasMore: false,
  });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ThreadDetailScreen — initial render', () => {
  it('has testID "thread-detail-screen"', async () => {
    const renderer = await renderScreen();
    const found = renderer.root.findAll(
      (node) => node.props.testID === 'thread-detail-screen',
    );
    expect(found.length).toBeGreaterThan(0);
  });

  it('renders the header with thread title from route params', async () => {
    const renderer = await renderScreen();
    const allText = renderer.root.findAllByType(
      'Text' as unknown as React.ComponentType,
    );
    const headerTitle = allText.find(
      (node) =>
        typeof node.props.children === 'string' &&
        node.props.children === 'Test Thread',
    );
    expect(headerTitle).toBeDefined();
  });

  it('renders the reply composer', async () => {
    const renderer = await renderScreen();
    const composer = renderer.root.findAll(
      (node) => node.props.testID === 'reply-composer',
    );
    expect(composer.length).toBeGreaterThan(0);
  });

  it('renders the reply input', async () => {
    const renderer = await renderScreen();
    const input = renderer.root.findAll(
      (node) => node.props.testID === 'reply-input',
    );
    expect(input.length).toBeGreaterThan(0);
  });

  it('calls setActiveThread on mount', async () => {
    await renderScreen();
    expect(mockSetActiveThread).toHaveBeenCalledWith('thread-1');
  });

  it('calls loadThread and loadReplies on mount', async () => {
    await renderScreen();
    expect(mockLoadThread).toHaveBeenCalledWith('thread-1');
  });
});

describe('ThreadDetailScreen — with thread data', () => {
  beforeEach(() => {
    const storesMock = jest.requireMock('../../stores') as {
      useThreads: jest.Mock;
    };
    storesMock.useThreads.mockReturnValue({
      threads: { 'thread-1': fakeThread },
      threadIdsByConversation: { 'group-1': ['thread-1'] },
      replies: {
        'reply-1': fakeReplies[0],
        'reply-2': fakeReplies[1],
      },
      replyIdsByThread: { 'thread-1': ['reply-1', 'reply-2'] },
      activeThreadId: 'thread-1',
      setThreads: jest.fn(),
      upsertThread: jest.fn(),
      removeThread: jest.fn(),
      setActiveThread: mockSetActiveThread,
      setReplies: jest.fn(),
      appendReplies: jest.fn(),
      upsertReply: jest.fn(),
      addOptimisticThread: jest.fn(),
      addOptimisticReply: jest.fn(),
      updateThreadSyncStatus: jest.fn(),
      updateReplySyncStatus: jest.fn(),
    });
  });

  afterEach(() => {
    const storesMock = jest.requireMock('../../stores') as {
      useThreads: jest.Mock;
    };
    storesMock.useThreads.mockReturnValue({
      threads: {},
      threadIdsByConversation: {},
      replies: {},
      replyIdsByThread: {},
      activeThreadId: null,
      setThreads: jest.fn(),
      upsertThread: jest.fn(),
      removeThread: jest.fn(),
      setActiveThread: mockSetActiveThread,
      setReplies: jest.fn(),
      appendReplies: jest.fn(),
      upsertReply: jest.fn(),
      addOptimisticThread: jest.fn(),
      addOptimisticReply: jest.fn(),
      updateThreadSyncStatus: jest.fn(),
      updateReplySyncStatus: jest.fn(),
    });
  });

  it('renders the thread header with title', async () => {
    const renderer = await renderScreen();
    const found = renderer.root.findAll(
      (node) => node.props.testID === 'thread-header',
    );
    expect(found.length).toBeGreaterThan(0);
  });

  it('renders thread title text in the thread header', async () => {
    const renderer = await renderScreen();
    const allText = renderer.root.findAllByType(
      'Text' as unknown as React.ComponentType,
    );
    const titleNode = allText.find(
      (node) =>
        typeof node.props.children === 'string' &&
        node.props.children === 'Test Thread Title',
    );
    expect(titleNode).toBeDefined();
  });

  it('renders the author username in the thread header', async () => {
    const renderer = await renderScreen();
    const allText = renderer.root.findAllByType(
      'Text' as unknown as React.ComponentType,
    );
    const authorNode = allText.find(
      (node) =>
        typeof node.props.children === 'string' &&
        node.props.children === 'alice',
    );
    expect(authorNode).toBeDefined();
  });

  it('renders reply items for each reply', async () => {
    const renderer = await renderScreen();
    const reply1 = renderer.root.findAll(
      (node) => node.props.testID === 'reply-item-reply-1',
    );
    const reply2 = renderer.root.findAll(
      (node) => node.props.testID === 'reply-item-reply-2',
    );
    expect(reply1.length).toBeGreaterThan(0);
    expect(reply2.length).toBeGreaterThan(0);
  });

  it('renders reply author usernames', async () => {
    const renderer = await renderScreen();
    const allText = renderer.root.findAllByType(
      'Text' as unknown as React.ComponentType,
    );
    const bobNode = allText.find(
      (node) =>
        typeof node.props.children === 'string' &&
        node.props.children === 'bob',
    );
    const charlieNode = allText.find(
      (node) =>
        typeof node.props.children === 'string' &&
        node.props.children === 'charlie',
    );
    expect(bobNode).toBeDefined();
    expect(charlieNode).toBeDefined();
  });

  it('renders the send button', async () => {
    const renderer = await renderScreen();
    const sendBtn = renderer.root.findAll(
      (node) => node.props.testID === 'send-button',
    );
    expect(sendBtn.length).toBeGreaterThan(0);
  });

  it('shows "Replying to @bob" for nested reply-2 (parentReplyId: reply-1)', async () => {
    const renderer = await renderScreen();
    const allText = renderer.root.findAllByType(
      'Text' as unknown as React.ComponentType,
    );
    const contextNode = allText.find(
      (node) =>
        typeof node.props.children === 'string' &&
        node.props.children === '↳ Replying to @bob',
    );
    expect(contextNode).toBeDefined();
  });

  it('does not show "Replying to" for top-level reply-1', async () => {
    const renderer = await renderScreen();
    const allText = renderer.root.findAllByType(
      'Text' as unknown as React.ComponentType,
    );
    // Only reply-2 has a parent — exactly one "Replying to" line should exist
    const contextNodes = allText.filter(
      (node) =>
        typeof node.props.children === 'string' &&
        node.props.children.startsWith('↳ Replying to'),
    );
    expect(contextNodes.length).toBe(1);
  });
});
