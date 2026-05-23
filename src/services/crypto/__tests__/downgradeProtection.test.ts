const mockSetItem = jest.fn();
const mockGetAllItems = jest.fn();

jest.mock('../../../database/repositories/itemRepository', () => ({
  setItem: (...args: unknown[]) => mockSetItem(...args),
  getAllItems: () => mockGetAllItems(),
}));

import {
  markEciesLocked,
  isEciesLocked,
  loadEciesLockState,
  clearEciesLockState,
} from '../downgradeProtection';

beforeEach(() => {
  jest.clearAllMocks();
  clearEciesLockState();
});

describe('markEciesLocked + isEciesLocked', () => {
  it('marks a group as locked and reports it', () => {
    expect(isEciesLocked('group-1')).toBe(false);
    markEciesLocked('group-1');
    expect(isEciesLocked('group-1')).toBe(true);
    expect(mockSetItem).toHaveBeenCalledWith('ecies_locked:group-1', '1');
  });

  it('is idempotent — setItem called only once', () => {
    markEciesLocked('group-2');
    markEciesLocked('group-2');
    expect(mockSetItem).toHaveBeenCalledTimes(1);
  });

  it('returns false for unknown groups', () => {
    expect(isEciesLocked('unknown-group')).toBe(false);
  });

  it('sets in-memory state even when DB throws', () => {
    mockSetItem.mockImplementationOnce(() => { throw new Error('DB not initialized'); });
    markEciesLocked('db-fail-group');
    expect(isEciesLocked('db-fail-group')).toBe(true);
  });
});

describe('loadEciesLockState', () => {
  it('hydrates locked groups from items table', () => {
    mockGetAllItems.mockReturnValueOnce([
      { id: 'ecies_locked:group-a', value: '1' },
      { id: 'ecies_locked:group-b', value: '1' },
      { id: 'identityKeyPublic', value: 'some-hex' },
      { id: 'other-item', value: 'data' },
    ]);

    loadEciesLockState();

    expect(isEciesLocked('group-a')).toBe(true);
    expect(isEciesLocked('group-b')).toBe(true);
    expect(isEciesLocked('identityKeyPublic')).toBe(false);
    expect(isEciesLocked('other-item')).toBe(false);
  });

  it('does not crash when DB is not initialized', () => {
    mockGetAllItems.mockImplementationOnce(() => { throw new Error('DB not initialized'); });
    expect(() => loadEciesLockState()).not.toThrow();
    expect(isEciesLocked('group-a')).toBe(false);
  });
});

describe('clearEciesLockState', () => {
  it('clears all locked state', () => {
    markEciesLocked('group-x');
    expect(isEciesLocked('group-x')).toBe(true);

    clearEciesLockState();

    expect(isEciesLocked('group-x')).toBe(false);
  });
});
