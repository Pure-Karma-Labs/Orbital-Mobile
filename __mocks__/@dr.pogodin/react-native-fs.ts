export const writeFile = jest.fn().mockResolvedValue(undefined);
export const unlink = jest.fn().mockResolvedValue(undefined);
export const readDir = jest.fn().mockResolvedValue([]);
export const CachesDirectoryPath = '/tmp/test-cache';
