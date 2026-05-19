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

  setMediaForThread: (threadId, items) => {
    const { media } = get();
    const updated = { ...media };
    const ids: string[] = [];
    for (const item of items) {
      updated[item.id] = item;
      ids.push(item.id);
    }
    set(
      {
        media: updated,
        mediaIdsByThread: {
          ...get().mediaIdsByThread,
          [threadId]: ids,
        },
      },
      false,
      'media/setMediaForThread',
    );
  },

  setMediaForReply: (replyId, items) => {
    const { media } = get();
    const updated = { ...media };
    const ids: string[] = [];
    for (const item of items) {
      updated[item.id] = item;
      ids.push(item.id);
    }
    set(
      {
        media: updated,
        mediaIdsByReply: {
          ...get().mediaIdsByReply,
          [replyId]: ids,
        },
      },
      false,
      'media/setMediaForReply',
    );
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
