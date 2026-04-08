import type { StateCreator } from 'zustand';
import type {
  AppState,
  Reply,
  SyncStatus,
  Thread,
  ThreadsSlice,
} from '../../types/store';

export const createThreadsSlice: StateCreator<
  AppState,
  [],
  [],
  ThreadsSlice
> = (set, get) => ({
  // Initial state
  threads: {},
  threadIdsByConversation: {},
  replies: {},
  replyIdsByThread: {},
  activeThreadId: null,

  // Actions
  setThreads: (conversationId, threads) => {
    const { threads: existingThreads, threadIdsByConversation } = get();
    const updatedThreads = { ...existingThreads };
    for (const t of threads) {
      updatedThreads[t.id] = t;
    }
    // Order by createdAt descending (newest threads first)
    const ids = [...threads]
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((t) => t.id);
    set(
      {
        threads: updatedThreads,
        threadIdsByConversation: {
          ...threadIdsByConversation,
          [conversationId]: ids,
        },
      },
      false,
      'threads/setThreads',
    );
  },

  upsertThread: (thread) => {
    const { threads, threadIdsByConversation } = get();
    const updatedThreads = { ...threads, [thread.id]: thread };
    const existingIds = threadIdsByConversation[thread.conversationId] ?? [];
    const updatedIds = existingIds.includes(thread.id)
      ? existingIds
      : [thread.id, ...existingIds];
    set(
      {
        threads: updatedThreads,
        threadIdsByConversation: {
          ...threadIdsByConversation,
          [thread.conversationId]: updatedIds,
        },
      },
      false,
      'threads/upsertThread',
    );
  },

  removeThread: (id) => {
    const { threads, threadIdsByConversation, activeThreadId } = get();
    const thread = threads[id];
    const updatedThreads = { ...threads };
    delete updatedThreads[id];

    const updatedIdsByConversation = { ...threadIdsByConversation };
    if (thread) {
      const existingIds =
        updatedIdsByConversation[thread.conversationId] ?? [];
      updatedIdsByConversation[thread.conversationId] = existingIds.filter(
        (tid) => tid !== id,
      );
    }

    set(
      {
        threads: updatedThreads,
        threadIdsByConversation: updatedIdsByConversation,
        activeThreadId: activeThreadId === id ? null : activeThreadId,
      },
      false,
      'threads/removeThread',
    );
  },

  setActiveThread: (id) =>
    set({ activeThreadId: id }, false, 'threads/setActiveThread'),

  setReplies: (threadId, replies) => {
    const { replies: existingReplies, replyIdsByThread } = get();
    const updatedReplies = { ...existingReplies };
    for (const r of replies) {
      updatedReplies[r.id] = r;
    }
    // Order by createdAt ascending (chronological)
    const ids = [...replies]
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((r) => r.id);
    set(
      {
        replies: updatedReplies,
        replyIdsByThread: { ...replyIdsByThread, [threadId]: ids },
      },
      false,
      'threads/setReplies',
    );
  },

  upsertReply: (reply) => {
    const { replies, replyIdsByThread } = get();
    const updatedReplies = { ...replies, [reply.id]: reply };
    const existingIds = replyIdsByThread[reply.threadId] ?? [];
    const updatedIds = existingIds.includes(reply.id)
      ? existingIds
      : [...existingIds, reply.id];
    set(
      {
        replies: updatedReplies,
        replyIdsByThread: {
          ...replyIdsByThread,
          [reply.threadId]: updatedIds,
        },
      },
      false,
      'threads/upsertReply',
    );
  },

  addOptimisticThread: (thread: Thread) => {
    const { threads, threadIdsByConversation } = get();
    const optimistic: Thread = { ...thread, syncStatus: 'pending' };
    const existingIds =
      threadIdsByConversation[thread.conversationId] ?? [];
    set(
      {
        threads: { ...threads, [thread.id]: optimistic },
        threadIdsByConversation: {
          ...threadIdsByConversation,
          [thread.conversationId]: [thread.id, ...existingIds],
        },
      },
      false,
      'threads/addOptimisticThread',
    );
  },

  addOptimisticReply: (reply: Reply) => {
    const { replies, replyIdsByThread } = get();
    const optimistic: Reply = { ...reply, syncStatus: 'pending' };
    const existingIds = replyIdsByThread[reply.threadId] ?? [];
    set(
      {
        replies: { ...replies, [reply.id]: optimistic },
        replyIdsByThread: {
          ...replyIdsByThread,
          [reply.threadId]: [...existingIds, reply.id],
        },
      },
      false,
      'threads/addOptimisticReply',
    );
  },

  updateThreadSyncStatus: (id: string, status: SyncStatus) => {
    const { threads } = get();
    const existing = threads[id];
    if (!existing) {
      return;
    }
    set(
      { threads: { ...threads, [id]: { ...existing, syncStatus: status } } },
      false,
      'threads/updateThreadSyncStatus',
    );
  },

  updateReplySyncStatus: (id: string, status: SyncStatus) => {
    const { replies } = get();
    const existing = replies[id];
    if (!existing) {
      return;
    }
    set(
      { replies: { ...replies, [id]: { ...existing, syncStatus: status } } },
      false,
      'threads/updateReplySyncStatus',
    );
  },
});
