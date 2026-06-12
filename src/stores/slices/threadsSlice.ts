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
  [['zustand/devtools', never]],
  [],
  ThreadsSlice
> = (set, get) => ({
  // Initial state
  threads: {},
  threadIdsByConversation: {},
  replies: {},
  replyIdsByThread: {},
  activeThreadId: null,
  threadLastViewedAt: {},

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
    // Preserve caller-supplied order (backend returns tree-order via recursive CTE)
    const ids = replies.map((r) => r.id);
    set(
      {
        replies: updatedReplies,
        replyIdsByThread: { ...replyIdsByThread, [threadId]: ids },
      },
      false,
      'threads/setReplies',
    );
  },

  appendReplies: (threadId, replies) => {
    const { replies: existingReplies, replyIdsByThread } = get();
    const updatedReplies = { ...existingReplies };
    for (const r of replies) {
      updatedReplies[r.id] = r;
    }
    const existingIds = replyIdsByThread[threadId] ?? [];
    // Append new IDs, preserving caller-supplied order and avoiding duplicates
    const existingIdSet = new Set(existingIds);
    const newIds = replies
      .map((r) => r.id)
      .filter((id) => !existingIdSet.has(id));
    set(
      {
        replies: updatedReplies,
        replyIdsByThread: {
          ...replyIdsByThread,
          [threadId]: [...existingIds, ...newIds],
        },
      },
      false,
      'threads/appendReplies',
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

  removeReply: (id: string) => {
    const { replies, replyIdsByThread } = get();
    const reply = replies[id];
    if (!reply) return;
    const { [id]: _, ...remaining } = replies;
    const existingIds = replyIdsByThread[reply.threadId] ?? [];
    set(
      {
        replies: remaining,
        replyIdsByThread: {
          ...replyIdsByThread,
          [reply.threadId]: existingIds.filter((rid) => rid !== id),
        },
      },
      false,
      'threads/removeReply',
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

    let insertIndex: number;
    if (reply.parentReplyId == null) {
      // Top-level reply: append to end
      insertIndex = existingIds.length;
    } else {
      // Nested reply: find parent, walk forward past descendants, insert after
      const parentIdx = existingIds.indexOf(reply.parentReplyId);
      if (parentIdx === -1) {
        insertIndex = existingIds.length;
      } else {
        const parentDepth = replies[reply.parentReplyId]?.depth ?? 0;
        let i = parentIdx + 1;
        while (i < existingIds.length) {
          const sibling = replies[existingIds[i]];
          if (!sibling || sibling.depth <= parentDepth) break;
          i++;
        }
        insertIndex = i;
      }
    }

    const updatedIds = [...existingIds];
    updatedIds.splice(insertIndex, 0, reply.id);

    set(
      {
        replies: { ...replies, [reply.id]: optimistic },
        replyIdsByThread: {
          ...replyIdsByThread,
          [reply.threadId]: updatedIds,
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

  markThreadViewed: (threadId: string) => {
    const { threadLastViewedAt } = get();
    const now = Date.now();
    const updated = { ...threadLastViewedAt, [threadId]: now };

    // Evict oldest entries when map exceeds 2000 to prevent unbounded growth
    const MAX_ENTRIES = 2000;
    if (Object.keys(updated).length > MAX_ENTRIES) {
      const entries = Object.entries(updated);
      entries.sort((a, b) => a[1] - b[1]); // oldest first
      const toRemove = entries.length - MAX_ENTRIES;
      for (let i = 0; i < toRemove; i++) {
        delete updated[entries[i][0]];
      }
    }

    set(
      { threadLastViewedAt: updated },
      false,
      'threads/markThreadViewed',
    );
  },
});
