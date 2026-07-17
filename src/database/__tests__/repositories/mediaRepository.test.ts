import { open } from '@op-engineering/op-sqlite';
import type { DB } from '@op-engineering/op-sqlite';
import { closeDatabase, resetDatabaseForTesting } from '../../connection';
import {
  saveMedia,
  getMedia,
  getMediaForThread,
  getMediaForReply,
  updateDownloadState,
  updateUploadState,
  getPendingDownloads,
  deleteMedia,
} from '../../repositories/mediaRepository';
import type { MediaRow } from '../../repositories/mediaRepository';

jest.mock('@op-engineering/op-sqlite', () => ({
  open: jest.fn(() => ({
    executeSync: jest.fn(() => ({ rows: [], rowsAffected: 0 })),
    close: jest.fn(),
  })),
}));

const mockOpen = open as jest.MockedFunction<typeof open>;

function makeDb(executeSync: jest.Mock) {
  const mockDb = { executeSync, close: jest.fn() };
  mockOpen.mockReturnValueOnce(mockDb as unknown as DB);
  resetDatabaseForTesting();
  return mockDb;
}

const sampleMedia: MediaRow = {
  id: 'media-1',
  thread_id: 'thread-1',
  reply_id: null,
  message_id: null,
  content_type: 'image/jpeg',
  file_name: 'photo.jpg',
  file_size: 2048000,
  width: 1920,
  height: 1080,
  duration: null,
  attachment_key: new Uint8Array(64).fill(0xEE),
  attachment_digest: new Uint8Array(32).fill(0xDD),
  cdn_number: null,
  cdn_key: null,
  local_path: null,
  thumbnail_path: null,
  blur_hash: null,
  expires_at: null,
  download_state: 'pending',
  upload_state: 'done',
  created_at: 1700000000000,
};

describe('mediaRepository', () => {
  afterEach(() => {
    closeDatabase();
    jest.clearAllMocks();
  });

  describe('saveMedia', () => {
    it('executes INSERT OR REPLACE with all 23 columns', () => {
      const executeSync = jest.fn(() => ({ rows: [], rowsAffected: 1 }));
      makeDb(executeSync);
      saveMedia(sampleMedia);
      expect(executeSync).toHaveBeenCalledWith(
        expect.stringContaining('INSERT OR REPLACE INTO orbital_media'),
        [
          'media-1',
          'thread-1',
          null,
          null,
          'image/jpeg',
          'photo.jpg',
          2048000,
          1920,
          1080,
          null,
          new Uint8Array(64).fill(0xEE),
          new Uint8Array(32).fill(0xDD),
          null,
          null,
          null,
          null,
          null,
          null,
          'pending',
          'done',
          1700000000000,
          null,
          0,
        ],
      );
    });
  });

  describe('getMedia', () => {
    it('queries by id', () => {
      const executeSync = jest.fn(() => ({ rows: [], rowsAffected: 0 }));
      makeDb(executeSync);
      getMedia('media-1');
      expect(executeSync).toHaveBeenCalledWith(
        'SELECT * FROM orbital_media WHERE id = ?',
        ['media-1'],
      );
    });

    it('returns null when not found', () => {
      makeDb(jest.fn(() => ({ rows: [], rowsAffected: 0 })));
      expect(getMedia('missing')).toBeNull();
    });

    it('returns the media row when found', () => {
      makeDb(
        jest.fn(() => ({
          rows: [{ ...sampleMedia }],
          rowsAffected: 0,
        })),
      );
      const result = getMedia('media-1');
      expect(result?.id).toBe('media-1');
      expect(result?.content_type).toBe('image/jpeg');
    });
  });

  describe('getMediaForThread', () => {
    it('queries by thread_id ordered by created_at ASC', () => {
      const executeSync = jest.fn((_sql: string, _params?: unknown[]) => ({ rows: [], rowsAffected: 0 }));
      makeDb(executeSync);
      getMediaForThread('thread-1');
      const selectCall = executeSync.mock.calls.find(
        (c) => typeof c[0] === 'string' && (c[0] as string).includes('SELECT'),
      ) as unknown as [string, unknown[]];
      expect(selectCall).toBeDefined();
      expect(selectCall[0]).toContain('WHERE thread_id = ?');
      expect(selectCall[0]).toContain('ORDER BY created_at ASC');
      expect(selectCall[1]).toEqual(['thread-1']);
    });

    it('returns matching rows', () => {
      makeDb(
        jest.fn(() => ({
          rows: [sampleMedia, { ...sampleMedia, id: 'media-2' }],
          rowsAffected: 0,
        })),
      );
      const result = getMediaForThread('thread-1');
      expect(result).toHaveLength(2);
      expect(result[1].id).toBe('media-2');
    });
  });

  describe('getMediaForReply', () => {
    it('queries by reply_id ordered by created_at ASC', () => {
      const executeSync = jest.fn((_sql: string, _params?: unknown[]) => ({ rows: [], rowsAffected: 0 }));
      makeDb(executeSync);
      getMediaForReply('reply-1');
      const selectCall = executeSync.mock.calls.find(
        (c) => typeof c[0] === 'string' && (c[0] as string).includes('SELECT'),
      ) as unknown as [string, unknown[]];
      expect(selectCall).toBeDefined();
      expect(selectCall[0]).toContain('WHERE reply_id = ?');
      expect(selectCall[0]).toContain('ORDER BY created_at ASC');
      expect(selectCall[1]).toEqual(['reply-1']);
    });
  });

  describe('updateDownloadState', () => {
    it('updates download_state without local_path', () => {
      const executeSync = jest.fn(() => ({ rows: [], rowsAffected: 1 }));
      makeDb(executeSync);
      updateDownloadState('media-1', 'downloading');
      expect(executeSync).toHaveBeenCalledWith(
        'UPDATE orbital_media SET download_state = ? WHERE id = ?',
        ['downloading', 'media-1'],
      );
    });

    it('updates download_state with local_path when provided', () => {
      const executeSync = jest.fn(() => ({ rows: [], rowsAffected: 1 }));
      makeDb(executeSync);
      updateDownloadState('media-1', 'downloaded', '/path/to/file.jpg');
      expect(executeSync).toHaveBeenCalledWith(
        'UPDATE orbital_media SET download_state = ?, local_path = ? WHERE id = ?',
        ['downloaded', '/path/to/file.jpg', 'media-1'],
      );
    });
  });

  describe('updateUploadState', () => {
    it('updates upload_state', () => {
      const executeSync = jest.fn(() => ({ rows: [], rowsAffected: 1 }));
      makeDb(executeSync);
      updateUploadState('media-1', 'uploading');
      expect(executeSync).toHaveBeenCalledWith(
        'UPDATE orbital_media SET upload_state = ? WHERE id = ?',
        ['uploading', 'media-1'],
      );
    });
  });

  describe('getPendingDownloads', () => {
    it('queries for pending download_state', () => {
      const executeSync = jest.fn((_sql: string, _params?: unknown[]) => ({ rows: [], rowsAffected: 0 }));
      makeDb(executeSync);
      getPendingDownloads();
      const selectCall = executeSync.mock.calls.find(
        (c) => typeof c[0] === 'string' && (c[0] as string).includes('SELECT'),
      ) as unknown as [string, unknown[]];
      expect(selectCall).toBeDefined();
      expect(selectCall[0]).toContain("WHERE download_state = 'pending'");
      expect(selectCall[0]).toContain('ORDER BY created_at ASC');
    });

    it('returns matching rows', () => {
      makeDb(
        jest.fn(() => ({
          rows: [sampleMedia],
          rowsAffected: 0,
        })),
      );
      const result = getPendingDownloads();
      expect(result).toHaveLength(1);
      expect(result[0].download_state).toBe('pending');
    });
  });

  describe('deleteMedia', () => {
    it('deletes by id', () => {
      const executeSync = jest.fn(() => ({ rows: [], rowsAffected: 1 }));
      makeDb(executeSync);
      deleteMedia('media-1');
      expect(executeSync).toHaveBeenCalledWith(
        'DELETE FROM orbital_media WHERE id = ?',
        ['media-1'],
      );
    });
  });

  describe('saveMedia — no FK constraint', () => {
    it('preserves thread_id/reply_id/message_id in a single INSERT (no retry)', () => {
      const executeSync = jest.fn((_sql: string, _params?: unknown[]) => ({
        rows: [],
        rowsAffected: 1,
      }));
      makeDb(executeSync);

      saveMedia(sampleMedia);

      const insertCalls = executeSync.mock.calls.filter(
        (c) => typeof c[0] === 'string' && (c[0] as string).includes('INSERT'),
      );
      expect(insertCalls).toHaveLength(1);

      const params = insertCalls[0][1] as unknown[];
      expect(params[0]).toBe('media-1');
      expect(params[1]).toBe(sampleMedia.thread_id);
      expect(params[2]).toBe(sampleMedia.reply_id);
      expect(params[3]).toBe(sampleMedia.message_id);
    });
  });
});
