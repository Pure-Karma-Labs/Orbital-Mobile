/**
 * Wrapper-level contract tests for orbital-media-export.
 *
 * These cover the two things index.tsx exists for and that no integration test
 * can observe: narrowing of the native STRING resolutions, and normalization
 * of native rejections into a MediaExportError whose message can never carry a
 * native message, a path or a filename.
 */

const mockNative = {
  saveToPhotoLibrary: jest.fn<Promise<void>, [string, string, string, number]>(
    () => Promise.resolve(),
  ),
  exportFiles: jest.fn<Promise<string>, [unknown]>(() =>
    Promise.resolve('saved'),
  ),
  getPhotoAddPermission: jest.fn<Promise<string>, []>(() =>
    Promise.resolve('granted'),
  ),
  requestPhotoAddPermission: jest.fn<Promise<string>, []>(() =>
    Promise.resolve('granted'),
  ),
};

jest.mock('../NativeOrbitalMediaExport', () => ({
  __esModule: true,
  default: mockNative,
}));

import {
  MEDIA_EXPORT_ERROR_CODES,
  MediaExportError,
  exportFiles,
  getPhotoAddPermission,
  isMediaExportError,
  requestPhotoAddPermission,
  saveToPhotoLibrary,
} from '../index';

/** A native rejection as the bridge delivers it: code + a leaky message. */
function nativeRejection(code: string) {
  const e = new Error(
    `failed at /var/mobile/Containers/Data/Application/ABC/Library/media/42.jpg (holiday-photo.jpg)`,
  );
  (e as Error & { code: string }).code = code;
  return e;
}

const LEAKY_SUBSTRINGS = [
  '/var/mobile',
  'holiday-photo',
  '42.jpg',
  'Containers',
];

beforeEach(() => {
  jest.clearAllMocks();
  mockNative.saveToPhotoLibrary.mockResolvedValue(undefined);
  mockNative.exportFiles.mockResolvedValue('saved');
  mockNative.getPhotoAddPermission.mockResolvedValue('granted');
  mockNative.requestPhotoAddPermission.mockResolvedValue('granted');
});

describe('path normalization', () => {
  it('strips a file:// scheme before the native call', async () => {
    await saveToPhotoLibrary({
      sourcePath: 'file:///var/media/42.heic',
      mimeType: 'image/heic',
      displayName: 'Orbital-1.heic',
      createdAtMs: 1700000000000,
    });
    expect(mockNative.saveToPhotoLibrary).toHaveBeenCalledWith(
      '/var/media/42.heic',
      'image/heic',
      'Orbital-1.heic',
      1700000000000,
    );
  });

  it('passes a plain path through unchanged, including for exportFiles', async () => {
    await exportFiles([
      {
        sourcePath: 'file:///var/media/7.bin',
        mimeType: 'application/pdf',
        displayName: 'report.pdf',
      },
      {
        sourcePath: '/var/media/8.bin',
        mimeType: 'text/csv',
        displayName: 'rows.csv',
      },
    ]);
    expect(mockNative.exportFiles).toHaveBeenCalledWith([
      {
        sourcePath: '/var/media/7.bin',
        mimeType: 'application/pdf',
        displayName: 'report.pdf',
      },
      {
        sourcePath: '/var/media/8.bin',
        mimeType: 'text/csv',
        displayName: 'rows.csv',
      },
    ]);
  });
});

describe('error normalization', () => {
  it.each(MEDIA_EXPORT_ERROR_CODES)('preserves the native code %s', async (code) => {
    mockNative.saveToPhotoLibrary.mockRejectedValue(nativeRejection(code));
    await expect(
      saveToPhotoLibrary({
        sourcePath: '/var/media/42.jpg',
        mimeType: 'image/jpeg',
        displayName: 'a.jpg',
        createdAtMs: 0,
      }),
    ).rejects.toMatchObject({ name: 'MediaExportError', code });
  });

  it('maps an unexpected native code to EEXPORT', async () => {
    mockNative.saveToPhotoLibrary.mockRejectedValue(nativeRejection('EWHATEVER'));
    await expect(
      saveToPhotoLibrary({
        sourcePath: '/var/media/42.jpg',
        mimeType: 'image/jpeg',
        displayName: 'a.jpg',
        createdAtMs: 0,
      }),
    ).rejects.toMatchObject({ code: 'EEXPORT' });
  });

  it('maps a rejection with no code at all to EEXPORT', async () => {
    mockNative.exportFiles.mockRejectedValue('something went wrong');
    await expect(
      exportFiles([
        { sourcePath: '/a/b', mimeType: 'application/pdf', displayName: 'b.pdf' },
      ]),
    ).rejects.toMatchObject({ code: 'EEXPORT' });
  });

  it('never surfaces the native message, path or filename', async () => {
    mockNative.saveToPhotoLibrary.mockRejectedValue(nativeRejection('ENOSPC'));
    let thrown: unknown;
    try {
      await saveToPhotoLibrary({
        sourcePath: '/var/mobile/Containers/Data/Application/ABC/Library/media/42.jpg',
        mimeType: 'image/jpeg',
        displayName: 'holiday-photo.jpg',
        createdAtMs: 0,
      });
    } catch (e) {
      thrown = e;
    }
    expect(isMediaExportError(thrown)).toBe(true);
    const serialized = `${(thrown as Error).message} ${(thrown as Error).stack ?? ''}`;
    for (const leak of LEAKY_SUBSTRINGS) {
      expect(serialized).not.toContain(leak);
    }
    expect((thrown as MediaExportError).message).toBe('not enough space to save');
  });

  it('passes an already-normalized MediaExportError through untouched', async () => {
    const original = new MediaExportError('ECANCELLED');
    mockNative.exportFiles.mockRejectedValue(original);
    await expect(
      exportFiles([
        { sourcePath: '/a/b', mimeType: 'application/pdf', displayName: 'b.pdf' },
      ]),
    ).rejects.toBe(original);
  });
});

describe('exportFiles narrowing', () => {
  it.each(['saved', 'cancelled'])('accepts %s', async (result) => {
    mockNative.exportFiles.mockResolvedValue(result);
    await expect(
      exportFiles([
        { sourcePath: '/a/b', mimeType: 'application/pdf', displayName: 'b.pdf' },
      ]),
    ).resolves.toBe(result);
  });

  it('rejects an unexpected native resolution', async () => {
    mockNative.exportFiles.mockResolvedValue('probably');
    await expect(
      exportFiles([
        { sourcePath: '/a/b', mimeType: 'application/pdf', displayName: 'b.pdf' },
      ]),
    ).rejects.toMatchObject({ code: 'EEXPORT' });
  });

  it('refuses an empty batch without calling native', async () => {
    await expect(exportFiles([])).rejects.toMatchObject({ code: 'EEXPORT' });
    expect(mockNative.exportFiles).not.toHaveBeenCalled();
  });
});

describe('permission narrowing', () => {
  const statuses = [
    'granted',
    'denied',
    'restricted',
    'notDetermined',
    'notRequired',
  ];

  it.each(statuses)('passes %s through from getPhotoAddPermission', async (status) => {
    mockNative.getPhotoAddPermission.mockResolvedValue(status);
    await expect(getPhotoAddPermission()).resolves.toBe(status);
  });

  it.each(statuses)('passes %s through from requestPhotoAddPermission', async (status) => {
    mockNative.requestPhotoAddPermission.mockResolvedValue(status);
    await expect(requestPhotoAddPermission()).resolves.toBe(status);
  });

  it('rejects an unknown status rather than guessing granted or denied', async () => {
    mockNative.getPhotoAddPermission.mockResolvedValue('limited');
    await expect(getPhotoAddPermission()).rejects.toMatchObject({
      code: 'EEXPORT',
    });
  });

  it('rejects an unknown status from the request path too', async () => {
    mockNative.requestPhotoAddPermission.mockResolvedValue('');
    await expect(requestPhotoAddPermission()).rejects.toMatchObject({
      code: 'EEXPORT',
    });
  });
});
