export const read = jest.fn().mockResolvedValue('');
export const readFile = jest.fn().mockResolvedValue('');
export const writeFile = jest.fn().mockResolvedValue(undefined);
export const appendFile = jest.fn().mockResolvedValue(undefined);
export const copyFile = jest.fn().mockResolvedValue(undefined);
export const stat = jest.fn().mockResolvedValue({
  size: 0,
  mtime: new Date(),
  ctime: new Date(),
  isFile: () => true,
  isDirectory: () => false,
});
export const write = jest.fn().mockResolvedValue(undefined);
export const unlink = jest.fn().mockResolvedValue(undefined);
export const readDir = jest.fn().mockResolvedValue([]);
export const exists = jest.fn().mockResolvedValue(false);
export const mkdir = jest.fn().mockResolvedValue(undefined);
export const moveFile = jest.fn().mockResolvedValue(undefined);

/**
 * Streaming download surface (#578).
 *
 * `downloadFile` returns { jobId, promise } exactly like the real module, so a
 * test can resolve/reject the promise independently of the jobId the service
 * captures for `stopDownload`.
 */
export const stopDownload = jest.fn();
export const downloadFile = jest.fn(() => ({
  jobId: 1,
  promise: Promise.resolve({ jobId: 1, statusCode: 200, bytesWritten: 0 }),
}));

export const getFSInfo = jest.fn().mockResolvedValue({
  totalSpace: 64 * 1024 * 1024 * 1024,
  totalSpaceEx: 64 * 1024 * 1024 * 1024,
  freeSpace: 32 * 1024 * 1024 * 1024,
  freeSpaceEx: 32 * 1024 * 1024 * 1024,
});

export const CachesDirectoryPath = '/tmp/test-cache';
export const DocumentDirectoryPath = '/tmp/test-docs';
