import type { StateCreator } from 'zustand';
import type { AppState, MediaSlice } from '../../types/store';

export const createMediaSlice: StateCreator<
  AppState,
  [['zustand/devtools', never]],
  [],
  MediaSlice
> = (set, get) => ({
  // Initial state
  media: {},
  mediaIdsByThread: {},
  mediaIdsByReply: {},

  // Actions

  mergeMediaForThread: (threadId, items) => {
    const { media, mediaIdsByThread } = get();
    const updated = { ...media };
    const existingIds = mediaIdsByThread[threadId] ?? [];
    const seen = new Set<string>(existingIds);
    const mergedIds = [...existingIds];
    for (const item of items) {
      const existing = updated[item.id];
      if (existing?.downloadState === 'downloading') {
        if (!seen.has(item.id)) {
          mergedIds.push(item.id);
          seen.add(item.id);
        }
        continue;
      }
      updated[item.id] = item;
      if (!seen.has(item.id)) {
        mergedIds.push(item.id);
        seen.add(item.id);
      }
    }
    set(
      {
        media: updated,
        mediaIdsByThread: {
          ...get().mediaIdsByThread,
          [threadId]: mergedIds,
        },
      },
      false,
      'media/mergeMediaForThread',
    );
  },

  mergeMediaForReply: (replyId, items) => {
    const { media, mediaIdsByReply } = get();
    const updated = { ...media };
    const existingIds = mediaIdsByReply[replyId] ?? [];
    const seen = new Set<string>(existingIds);
    const mergedIds = [...existingIds];
    for (const item of items) {
      const existing = updated[item.id];
      if (existing?.downloadState === 'downloading') {
        if (!seen.has(item.id)) {
          mergedIds.push(item.id);
          seen.add(item.id);
        }
        continue;
      }
      updated[item.id] = item;
      if (!seen.has(item.id)) {
        mergedIds.push(item.id);
        seen.add(item.id);
      }
    }
    set(
      {
        media: updated,
        mediaIdsByReply: {
          ...get().mediaIdsByReply,
          [replyId]: mergedIds,
        },
      },
      false,
      'media/mergeMediaForReply',
    );
  },

  mergeMediaBatch: (byParent) => {
    set((state) => {
      const updatedMedia = { ...state.media };
      const updatedThreadIndex = { ...state.mediaIdsByThread };
      const updatedReplyIndex = { ...state.mediaIdsByReply };

      for (const [parentId, { type, items }] of byParent) {
        const indexMap = type === 'thread' ? updatedThreadIndex : updatedReplyIndex;
        const existingIds = indexMap[parentId] ?? [];
        const seen = new Set<string>(existingIds);
        const mergedIds = [...existingIds];

        for (const item of items) {
          const existing = updatedMedia[item.id];
          if (existing?.downloadState === 'downloading') {
            if (!seen.has(item.id)) {
              mergedIds.push(item.id);
              seen.add(item.id);
            }
            continue;
          }
          updatedMedia[item.id] = item;
          if (!seen.has(item.id)) {
            mergedIds.push(item.id);
            seen.add(item.id);
          }
        }

        indexMap[parentId] = mergedIds;
      }

      return {
        media: updatedMedia,
        mediaIdsByThread: updatedThreadIndex,
        mediaIdsByReply: updatedReplyIndex,
      };
    }, false, 'media/mergeMediaBatch');
  },

  setMediaBatch: (items) => {
    set((state) => {
      const updated = { ...state.media };
      for (const item of items) {
        const existing = updated[item.id];
        // Don't clobber items that are actively downloading —
        // that would reset the download state and trigger abort/restart loops.
        if (existing?.downloadState === 'downloading') continue;
        updated[item.id] = item;
      }
      return { media: updated };
    }, false, 'media/setMediaBatch');
  },

  upsertMedia: (item) => {
    const { media, mediaIdsByThread, mediaIdsByReply } = get();
    const updatedMedia = { ...media, [item.id]: item };

    // Update thread index if item has a threadId
    let updatedThreadIndex = mediaIdsByThread;
    if (item.threadId) {
      const current = mediaIdsByThread[item.threadId] ?? [];
      if (!current.includes(item.id)) {
        updatedThreadIndex = {
          ...mediaIdsByThread,
          [item.threadId]: [...current, item.id],
        };
      }
    }

    // Update reply index if item has a replyId
    let updatedReplyIndex = mediaIdsByReply;
    if (item.replyId) {
      const current = mediaIdsByReply[item.replyId] ?? [];
      if (!current.includes(item.id)) {
        updatedReplyIndex = {
          ...mediaIdsByReply,
          [item.replyId]: [...current, item.id],
        };
      }
    }

    set(
      {
        media: updatedMedia,
        mediaIdsByThread: updatedThreadIndex,
        mediaIdsByReply: updatedReplyIndex,
      },
      false,
      'media/upsertMedia',
    );
  },

  updateMediaDownloadState: (id, state, localPath) => {
    const { media } = get();
    const existing = media[id];
    if (!existing) return;
    set(
      {
        media: {
          ...media,
          [id]: {
            ...existing,
            downloadState: state,
            ...(localPath !== undefined ? { localPath } : {}),
          },
        },
      },
      false,
      'media/updateMediaDownloadState',
    );
  },

  updateMediaUploadState: (id, state) => {
    const { media } = get();
    const existing = media[id];
    if (!existing) return;
    set(
      {
        media: {
          ...media,
          [id]: { ...existing, uploadState: state },
        },
      },
      false,
      'media/updateMediaUploadState',
    );
  },

  removeMedia: (id) => {
    const { media, mediaIdsByThread, mediaIdsByReply } = get();
    const item = media[id];
    if (!item) return;

    const { [id]: _removed, ...rest } = media;

    // Remove from thread index
    let updatedThreadIndex = mediaIdsByThread;
    if (item.threadId && mediaIdsByThread[item.threadId]) {
      updatedThreadIndex = {
        ...mediaIdsByThread,
        [item.threadId]: mediaIdsByThread[item.threadId].filter((mid) => mid !== id),
      };
    }

    // Remove from reply index
    let updatedReplyIndex = mediaIdsByReply;
    if (item.replyId && mediaIdsByReply[item.replyId]) {
      updatedReplyIndex = {
        ...mediaIdsByReply,
        [item.replyId]: mediaIdsByReply[item.replyId].filter((mid) => mid !== id),
      };
    }

    set(
      {
        media: rest,
        mediaIdsByThread: updatedThreadIndex,
        mediaIdsByReply: updatedReplyIndex,
      },
      false,
      'media/removeMedia',
    );
  },
});
