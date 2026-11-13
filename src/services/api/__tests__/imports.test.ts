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
  it('POSTs the declared pair to the group route', async () => {
    await startImport(GROUP_ID, { declaredPosts: 12, declaredBytes: 345 });

    expect(mockRequest).toHaveBeenCalledWith({
      method: 'POST',
      path: `/api/groups/${GROUP_ID}/imports`,
      body: { declaredPosts: 12, declaredBytes: 345 },
      retryOn429: false,
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
  it('POSTs to the complete route with no body', async () => {
    await completeImport(IMPORT_ID);

    expect(mockRequest).toHaveBeenCalledWith({
      method: 'POST',
      path: `/api/imports/${IMPORT_ID}/complete`,
      retryOn429: false,
    });
  });
});

describe('rate-limit policy', () => {
  it('opts every import call out of the client 429 ladder', async () => {
    await startImport(GROUP_ID, { declaredPosts: 1, declaredBytes: 0 });
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
