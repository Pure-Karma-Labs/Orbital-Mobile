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
export const CachesDirectoryPath = '/tmp/test-cache';
export const DocumentDirectoryPath = '/tmp/test-docs';
