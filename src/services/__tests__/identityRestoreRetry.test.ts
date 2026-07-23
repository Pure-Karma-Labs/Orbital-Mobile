/**
 * Tests for the deferred identity-restore retry orchestrator.
 *
 * Covers the four branches flagged in the PR #633 review:
 * (a) 'deferred' leaves the flag set and skips key init;
 * (b) 'restored'/'cleared'/'none' clear the flag and run key init;
 * (c) ConflictError from key init sets conflict state;
 * (d) unexpected throw is captured to Sentry with the flag left set.
 */

const mockSentryCaptureMessage = jest.fn();
const mockSentryCaptureException = jest.fn();
jest.mock('@sentry/react-native', () => ({
  captureMessage: (...args: unknown[]) => mockSentryCaptureMessage(...args),
  captureException: (...args: unknown[]) => mockSentryCaptureException(...args),
  addBreadcrumb: jest.fn(),
}));

const mockAttemptRestore = jest.fn();
jest.mock('../crypto/identityRestoreService', () => ({
  attemptKeychainIdentityRestore: (...args: unknown[]) => mockAttemptRestore(...args),
}));

const mockEnsureKeysInitialized = jest.fn();
jest.mock('../crypto/keyGenerationService', () => ({
  ensureKeysInitialized: (...args: unknown[]) => mockEnsureKeysInitialized(...args),
}));

const mockSetIdentityRestoreDeferred = jest.fn();
const mockSetIdentityKeyConflict = jest.fn();
const mockSetConflictSource = jest.fn();
jest.mock('../../stores/useAppStore', () => ({
  useAppStore: {
    getState: jest.fn(() => ({
      setIdentityRestoreDeferred: mockSetIdentityRestoreDeferred,
      setIdentityKeyConflict: mockSetIdentityKeyConflict,
      setConflictSource: mockSetConflictSource,
    })),
  },
}));

import { retryIdentityRestore } from '../identityRestoreRetry';
import { ConflictError } from '../api/errors';

describe('retryIdentityRestore', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockEnsureKeysInitialized.mockResolvedValue(undefined);
  });

  it("'deferred' leaves the flag set and does NOT run key init", async () => {
    mockAttemptRestore.mockResolvedValue('deferred');

    await retryIdentityRestore();

    expect(mockSetIdentityRestoreDeferred).not.toHaveBeenCalled();
    expect(mockEnsureKeysInitialized).not.toHaveBeenCalled();
  });

  it.each(['restored', 'cleared', 'none'] as const)(
    "'%s' clears the flag and runs key init",
    async (outcome) => {
      mockAttemptRestore.mockResolvedValue(outcome);

      await retryIdentityRestore();

      expect(mockSetIdentityRestoreDeferred).toHaveBeenCalledWith(false);
      expect(mockEnsureKeysInitialized).toHaveBeenCalled();
    },
  );

  it('ConflictError from key init sets conflict state (source local)', async () => {
    mockAttemptRestore.mockResolvedValue('cleared');
    mockEnsureKeysInitialized.mockRejectedValue(new ConflictError());

    await retryIdentityRestore();

    expect(mockSetIdentityKeyConflict).toHaveBeenCalledWith(true);
    expect(mockSetConflictSource).toHaveBeenCalledWith('local');
    // Flag was still cleared — the deferral itself resolved
    expect(mockSetIdentityRestoreDeferred).toHaveBeenCalledWith(false);
  });

  it('non-Conflict key-init failure is captured to Sentry (retry-key-init-failed)', async () => {
    mockAttemptRestore.mockResolvedValue('restored');
    mockEnsureKeysInitialized.mockRejectedValue(new Error('disk full'));

    await retryIdentityRestore();

    expect(mockSentryCaptureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: expect.objectContaining({ outcome: 'retry-key-init-failed' }),
      }),
    );
  });

  it('unexpected restore throw is captured to Sentry and leaves the flag set', async () => {
    mockAttemptRestore.mockRejectedValue(new Error('keychain exploded'));

    await retryIdentityRestore();

    expect(mockSentryCaptureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: expect.objectContaining({ outcome: 'retry-failed' }),
      }),
    );
    expect(mockSetIdentityRestoreDeferred).not.toHaveBeenCalled();
    expect(mockEnsureKeysInitialized).not.toHaveBeenCalled();
  });
});
