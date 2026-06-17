/**
 * Security invariant: cipher_memory_security PRAGMA must be the first
 * executeSync call after opening the database.
 */

import { open } from '@op-engineering/op-sqlite';
import type { DB } from '@op-engineering/op-sqlite';
import { initDatabase, closeDatabase } from '../connection';

jest.mock('@op-engineering/op-sqlite', () => ({
  open: jest.fn(() => ({
    executeSync: jest.fn(() => ({ rows: [], rowsAffected: 0 })),
    close: jest.fn(),
  })),
}));

const mockOpen = open as jest.MockedFunction<typeof open>;

function makeMockDb() {
  const mockDb = {
    executeSync: jest.fn(() => ({ rows: [], rowsAffected: 0 })),
    close: jest.fn(),
  };
  mockOpen.mockReturnValueOnce(mockDb as unknown as DB);
  return mockDb;
}

describe('cipher_memory_security PRAGMA ordering', () => {
  beforeEach(() => {
    closeDatabase();
    jest.clearAllMocks();
  });

  it('cipher_memory_security = ON is the first executeSync call', () => {
    const mockDb = makeMockDb();
    initDatabase('test-key');
    const firstCall = (mockDb.executeSync.mock.calls as unknown as [string][])[0][0];
    expect(firstCall).toBe('PRAGMA cipher_memory_security = ON');
  });
});
