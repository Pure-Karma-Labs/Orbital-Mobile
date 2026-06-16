import { open } from '@op-engineering/op-sqlite';
import type { DB } from '@op-engineering/op-sqlite';
import { resetDatabaseForTesting } from '../connection';

const mockOpen = open as jest.MockedFunction<typeof open>;

export function makeDb(executeSync: jest.Mock) {
  const mockDb = { executeSync, close: jest.fn() };
  mockOpen.mockReturnValueOnce(mockDb as unknown as DB);
  resetDatabaseForTesting();
  return mockDb;
}
