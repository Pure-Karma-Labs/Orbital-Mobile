/**
 * Tests for the Meta import API service (#926).
 *
 * Mostly route/method/body pins: these five functions have no logic beyond
 * naming the endpoint correctly, and getting a path or an opt-out wrong is
 * exactly the failure a type cannot catch. The camelCase→snake_case transform
 * of the batch body is asserted through the REAL client in the last block,
 * because that transform is what makes `importKey` arrive as `import_key`.
 */

jest.mock('../client', () => ({
  request: jest.fn(),
}));

import { request } from '../client';
import {
  completeImport,
  getGroupImports,
  getImportSession,
  startImport,
  submitImportBatch,
} from '../imports';
import type { ImportBatchRequest } from '../../../types/api';

const mockRequest = request as jest.MockedFunction<typeof request>;

const GROUP_ID = '11111111-2222-4333-8444-555555555555';
const IMPORT_ID = '66666666-7777-4888-8999-aaaaaaaaaaaa';

beforeEach(() => {
  jest.clearAllMocks();
  mockRequest.mockResolvedValue({});
});

describe('startImport', () => {
  it('POSTs the declared trio to the group route', async () => {
    await startImport(GROUP_ID, { declaredPosts: 12, declaredBytes: 345, source: 'facebook' });

    // `source` is REQUIRED since B#352 and decides which allowance bucket the
    // session spends; omitting it is 400 `IMPORT_DECLARED_INVALID`, not a
    // default.
    expect(mockRequest).toHaveBeenCalledWith({
      method: 'POST',
      path: `/api/groups/${GROUP_ID}/imports`,
      body: { declaredPosts: 12, declaredBytes: 345, source: 'facebook' },
      retryOn429: false,
    });
  });

  it('carries either source verbatim', async () => {
    await startImport(GROUP_ID, { declaredPosts: 1, declaredBytes: 0, source: 'instagram' });

    expect(mockRequest.mock.calls[0][0].body).toEqual({
      declaredPosts: 1,
      declaredBytes: 0,
      source: 'instagram',
    });
  });
});

describe('getGroupImports', () => {
  it('GETs the preflight for the group', async () => {
    await getGroupImports(GROUP_ID);

    expect(mockRequest).toHaveBeenCalledWith({
      method: 'GET',
      path: `/api/groups/${GROUP_ID}/imports`,
      retryOn429: false,
    });
  });
});

describe('getImportSession', () => {
  it('GETs one session by id', async () => {
    await getImportSession(IMPORT_ID);

    expect(mockRequest).toHaveBeenCalledWith({
      method: 'GET',
      path: `/api/imports/${IMPORT_ID}`,
      retryOn429: false,
    });
  });
});

describe('submitImportBatch', () => {
  it('POSTs the items envelope to the threads route', async () => {
    const data: ImportBatchRequest = {
      items: [
        {
          importKey: 'AAAAAAAAAAAAAAAAAAAAAA==',
          originalCreatedAt: '2014-06-01',
          encryptedTitle: 'ct',
          encryptedBody: '',
          titleIv: 'iv1',
          bodyIv: 'iv2',
        },
      ],
    };

    await submitImportBatch(IMPORT_ID, data);

    expect(mockRequest).toHaveBeenCalledWith({
      method: 'POST',
      path: `/api/imports/${IMPORT_ID}/threads`,
      body: data,
      retryOn429: false,
    });
  });
});

describe('completeImport', () => {
  it('POSTs to the complete route with an explicit empty body', async () => {
    await completeImport(IMPORT_ID);

    expect(mockRequest).toHaveBeenCalledWith({
      method: 'POST',
      path: `/api/imports/${IMPORT_ID}/complete`,
      body: {},
      retryOn429: false,
    });
  });
});

describe('rate-limit policy', () => {
  it('opts every import call out of the client 429 ladder', async () => {
    await startImport(GROUP_ID, { declaredPosts: 1, declaredBytes: 0, source: 'facebook' });
    await getGroupImports(GROUP_ID);
    await getImportSession(IMPORT_ID);
    await submitImportBatch(IMPORT_ID, { items: [] });
    await completeImport(IMPORT_ID);

    expect(mockRequest).toHaveBeenCalledTimes(5);
    for (const call of mockRequest.mock.calls) {
      expect(call[0].retryOn429).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Wire shape, through the real client
// ---------------------------------------------------------------------------

describe('the start body on the wire', () => {
  it('sends source alongside the snake_cased declared pair', async () => {
    jest.resetModules();
    jest.doMock('../tokenManager', () => ({
      tokenManager: {
        getAccessToken: jest.fn().mockResolvedValue('test-token'),
        clearTokens: jest.fn().mockResolvedValue(undefined),
      },
    }));
    jest.dontMock('../client');

    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: jest.fn().mockResolvedValue({}),
      text: jest.fn().mockResolvedValue('{}'),
      headers: { get: () => null },
    });
    (globalThis as Record<string, unknown>).fetch = fetchMock;

    const realImports = require('../imports') as typeof import('../imports');
    await realImports.startImport(GROUP_ID, {
      declaredPosts: 7,
      declaredBytes: 4096,
      source: 'instagram',
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const sent = JSON.parse(init.body as string);
    // `source` is already snake-case-shaped, so the transform must leave it
    // alone rather than drop it: the server rejects a body without it.
    expect(sent).toEqual({ declared_posts: 7, declared_bytes: 4096, source: 'instagram' });
  });
});

describe('the preflight response on the wire', () => {
  it('keeps both allowance buckets through snakeToCamel', async () => {
    jest.resetModules();
    jest.doMock('../tokenManager', () => ({
      tokenManager: {
        getAccessToken: jest.fn().mockResolvedValue('test-token'),
        clearTokens: jest.fn().mockResolvedValue(undefined),
      },
    }));
    jest.dontMock('../client');

    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: jest.fn().mockResolvedValue({
        allowances: {
          facebook: { posts_used: 10, bytes_used: 20, posts_limit: 1000, bytes_limit: 30 },
          instagram: { posts_used: 1, bytes_used: 2, posts_limit: 1000, bytes_limit: 3 },
        },
        open_import: { import_id: IMPORT_ID, status: 'open', source: 'instagram' },
        limits: { batch_max: 50 },
      }),
      text: jest.fn().mockResolvedValue('{}'),
      headers: { get: () => null },
    });
    (globalThis as Record<string, unknown>).fetch = fetchMock;

    const realImports = require('../imports') as typeof import('../imports');
    const response = await realImports.getGroupImports(GROUP_ID);

    // The two source KEYS are data, not field names: `snakeToCamel` must not
    // touch them, and the member numbers under them must survive.
    expect(Object.keys(response.allowances).sort()).toEqual(['facebook', 'instagram']);
    expect(response.allowances.facebook.postsUsed).toBe(10);
    expect(response.allowances.instagram.bytesLimit).toBe(3);
    // The open session carries ITS source, which is what makes a foreign
    // session recognisable before it is adopted.
    expect(response.openImport?.source).toBe('instagram');
    expect(response.limits.batchMax).toBe(50);
  });
});

describe('the batch body on the wire', () => {
  it('reaches the server in snake_case', async () => {
    jest.resetModules();
    jest.doMock('../tokenManager', () => ({
      tokenManager: {
        getAccessToken: jest.fn().mockResolvedValue('test-token'),
        clearTokens: jest.fn().mockResolvedValue(undefined),
      },
    }));
    jest.dontMock('../client');

    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: jest.fn().mockResolvedValue({ results: [], allowance: {} }),
      text: jest.fn().mockResolvedValue('{}'),
      headers: { get: () => null },
    });
    (globalThis as Record<string, unknown>).fetch = fetchMock;

    const realImports = require('../imports') as typeof import('../imports');
    await realImports.submitImportBatch(IMPORT_ID, {
      items: [
        {
          importKey: 'AAAAAAAAAAAAAAAAAAAAAA==',
          originalCreatedAt: '2014-06-01',
          encryptedTitle: 'ct',
          encryptedBody: '',
          titleIv: 'iv1',
          bodyIv: 'iv2',
          encryptedImportMeta: 'meta',
          importMetaIv: 'iv3',
          mediaIds: ['66666666-7777-4888-8999-aaaaaaaaaaab'],
        },
      ],
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain(`/api/imports/${IMPORT_ID}/threads`);
    const sent = JSON.parse(init.body as string);
    expect(Object.keys(sent.items[0]).sort()).toEqual([
      'body_iv',
      'encrypted_body',
      'encrypted_import_meta',
      'encrypted_title',
      'import_key',
      'import_meta_iv',
      'media_ids',
      'original_created_at',
      'title_iv',
    ]);
    expect(sent.items[0].import_key).toBe('AAAAAAAAAAAAAAAAAAAAAA==');
    expect(sent.items[0].media_ids).toEqual(['66666666-7777-4888-8999-aaaaaaaaaaab']);
  });
});
