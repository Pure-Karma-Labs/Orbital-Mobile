import { VerifiedStatus } from '../../types/database';

// --- Mocks ---

const mockGetAllIdentityKeys = jest.fn();
const mockUpdateIdentityKeyVerified = jest.fn();

jest.mock('../../database/repositories/signalIdentityKeyRepository', () => ({
  getAllIdentityKeys: () => mockGetAllIdentityKeys(),
  updateIdentityKeyVerified: (...args: unknown[]) => mockUpdateIdentityKeyVerified(...args),
}));

const mockRefreshAndCompare = jest.fn();

jest.mock('../crypto/identityKeyAccess', () => ({
  refreshAndCompareIdentityKey: (...args: unknown[]) => mockRefreshAndCompare(...args),
}));

const mockSetContactVerifiedStatus = jest.fn();

jest.mock('../../stores/useAppStore', () => ({
  useAppStore: {
    getState: () => ({
      contacts: {
        'user-1': { id: 'user-1', username: 'alice', conversationIds: [] },
      },
      setContactVerifiedStatus: mockSetContactVerifiedStatus,
    }),
  },
}));

import {
  syncVerifiedStatusToStore,
  markContactVerified,
  checkIdentityAndNotify,
} from '../verificationService';

// --- Tests ---

beforeEach(() => {
  jest.clearAllMocks();
});

describe('syncVerifiedStatusToStore', () => {
  it('syncs verified status for contacts that exist in the store', () => {
    mockGetAllIdentityKeys.mockReturnValue([
      { address: 'user-1', verified: VerifiedStatus.Verified },
      { address: 'user-unknown', verified: VerifiedStatus.Unverified },
      { address: 'local', verified: VerifiedStatus.Default },
    ]);

    syncVerifiedStatusToStore();

    expect(mockSetContactVerifiedStatus).toHaveBeenCalledWith('user-1', VerifiedStatus.Verified);
    expect(mockSetContactVerifiedStatus).toHaveBeenCalledTimes(1);
  });

  it('skips local address and unknown contacts', () => {
    mockGetAllIdentityKeys.mockReturnValue([
      { address: 'local', verified: VerifiedStatus.Default },
    ]);

    syncVerifiedStatusToStore();

    expect(mockSetContactVerifiedStatus).not.toHaveBeenCalled();
  });
});

describe('markContactVerified', () => {
  it('updates DB and store when identity key row exists', () => {
    mockUpdateIdentityKeyVerified.mockReturnValue(1);

    markContactVerified('user-1');

    expect(mockUpdateIdentityKeyVerified).toHaveBeenCalledWith('user-1', VerifiedStatus.Verified);
    expect(mockSetContactVerifiedStatus).toHaveBeenCalledWith('user-1', VerifiedStatus.Verified);
  });

  it('warns and skips store update when no DB row exists', () => {
    mockUpdateIdentityKeyVerified.mockReturnValue(0);
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation();

    markContactVerified('user-missing');

    expect(mockUpdateIdentityKeyVerified).toHaveBeenCalledWith('user-missing', VerifiedStatus.Verified);
    expect(mockSetContactVerifiedStatus).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

describe('checkIdentityAndNotify', () => {
  it('returns true and updates store when identity changed', async () => {
    mockRefreshAndCompare.mockResolvedValue({
      publicKey: new ArrayBuffer(33),
      identityChanged: true,
    });

    const result = await checkIdentityAndNotify('user-1', 'current-user');

    expect(result).toBe(true);
    expect(mockSetContactVerifiedStatus).toHaveBeenCalledWith('user-1', VerifiedStatus.Unverified);
  });

  it('returns false and does not update store when identity unchanged', async () => {
    mockRefreshAndCompare.mockResolvedValue({
      publicKey: new ArrayBuffer(33),
      identityChanged: false,
    });

    const result = await checkIdentityAndNotify('user-1', 'current-user');

    expect(result).toBe(false);
    expect(mockSetContactVerifiedStatus).not.toHaveBeenCalled();
  });
});
