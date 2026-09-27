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
    // Insertion order only — replyIdsByThread carries NO display meaning since
    // #821. Screens derive order from replyTree.ts (parentReplyId + createdAt).
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
    // Deduplicated union. Position is meaningless (#821) — this is a set with a
    // stable iteration order, not a render order.
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

  /**
   * Swap an optimistic reply for its server-confirmed row in ONE set() (#821).
   *
   * The old remove+upsert pair was the whole bug: `upsertReply` appends, so a
   * confirmed nested reply jumped to the bottom of the list. Order is now
   * derived in `replyTree.ts`, so position is irrelevant — but the swap still
   * has to be atomic (two set() calls render a frame with neither row) and it
   * must ALWAYS insert: if `oldId` has already been dropped (a WebSocket echo,
   * a reconcile), the confirmed reply still has to land.
   */
  replaceReply: (oldId: string, confirmed: Reply) => {
    const { replies, replyIdsByThread } = get();
    const previous = replies[oldId];

    const updatedReplies = { ...replies };
    if (oldId !== confirmed.id) delete updatedReplies[oldId];
    updatedReplies[confirmed.id] = confirmed;

    const updatedIdsByThread = { ...replyIdsByThread };
    // The optimistic row can only ever be in its own thread's list.
    if (previous && previous.threadId !== confirmed.threadId) {
      updatedIdsByThread[previous.threadId] = (
        updatedIdsByThread[previous.threadId] ?? []
      ).filter((rid) => rid !== oldId);
    }

    const ids = [...(updatedIdsByThread[confirmed.threadId] ?? [])];
    const oldIndex = ids.indexOf(oldId);
    const newIndex = ids.indexOf(confirmed.id);
    if (oldIndex !== -1) {
      if (newIndex !== -1 && newIndex !== oldIndex) {
        ids.splice(oldIndex, 1);
      } else {
        ids[oldIndex] = confirmed.id;
      }
    } else if (newIndex === -1) {
      ids.push(confirmed.id);
    }
    updatedIdsByThread[confirmed.threadId] = ids;

    set(
      { replies: updatedReplies, replyIdsByThread: updatedIdsByThread },
      false,
      'threads/replaceReply',
    );
  },

  /**
   * Drop this thread's replies that the server no longer returns (#821).
   *
   * The only client path that clears an admin-removed reply. An id is dropped
   * only when ALL THREE hold:
   * 1. it is in `candidateIds` — the ids present when the pagination pass
   *    STARTED. Anything that arrived mid-pass (a WebSocket reply, the user's
   *    own confirmed send) postdates the server snapshot the pass is comparing
   *    against, so it can never be evidence of a removal;
   * 2. it is absent from `keepIds` — the RAW server ids of the pass, raw so a
   *    row that failed to decrypt is never mistaken for a removal;
   * 3. it is not `pending` — an optimistic send the server has not acked.
   *
   * A row hydrated from SQLite is present at pass start, so an admin takedown
   * still propagates on the next full pass.
   *
   * @returns the dropped ids, so the caller can delete them from SQLite too.
   */
  reconcileReplies: (
    threadId: string,
    keepIds: ReadonlySet<string> | readonly string[],
    candidateIds: ReadonlySet<string> | readonly string[],
  ) => {
    const { replies, replyIdsByThread } = get();
    const ids = replyIdsByThread[threadId];
    if (!ids || ids.length === 0) return [];

    const keep: ReadonlySet<string> =
      keepIds instanceof Set ? keepIds : new Set(keepIds as readonly string[]);
    const candidates: ReadonlySet<string> =
      candidateIds instanceof Set
        ? candidateIds
        : new Set(candidateIds as readonly string[]);

    const dropped: string[] = [];
    const remaining: string[] = [];
    for (const id of ids) {
      const reply = replies[id];
      if (!candidates.has(id) || keep.has(id) || reply?.syncStatus === 'pending') {
        remaining.push(id);
      } else {
        dropped.push(id);
      }
    }
    if (dropped.length === 0) return [];

    const updatedReplies = { ...replies };
    for (const id of dropped) delete updatedReplies[id];

    set(
      {
        replies: updatedReplies,
        replyIdsByThread: { ...replyIdsByThread, [threadId]: remaining },
      },
      false,
      'threads/reconcileReplies',
    );
    return dropped;
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

  /**
   * Add a reply optimistically. Its ONLY job is the `pending` flag (#821).
   *
   * It used to splice the row in after its parent's descendants, because the
   * store list was the render order. It is not any more: `replyTree.ts` derives
   * display order from parentReplyId + createdAt on every render, so a plain
   * append is correct and the old splice was just a second, divergent ordering
   * implementation. Do not reintroduce positional logic here.
   */
  addOptimisticReply: (reply: Reply) => {
    const { replies, replyIdsByThread } = get();
    const optimistic: Reply = { ...reply, syncStatus: 'pending' };
    const existingIds = replyIdsByThread[reply.threadId] ?? [];
    const updatedIds = existingIds.includes(reply.id)
      ? existingIds
      : [...existingIds, reply.id];

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

  // No production caller since #749: both threadService failure paths call
  // removeThread/removeReply instead, so nothing writes 'failed' any more.
  // Retained only as slice API the suites exercise.
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
