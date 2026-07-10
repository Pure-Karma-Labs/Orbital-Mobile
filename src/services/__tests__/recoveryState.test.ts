/**
 * Tests for recoveryState — the dependency-free transient initiator flag
 * extracted from keyRecoveryService to avoid an import cycle with
 * notificationService (#539).
 */

import { isRecoveryInitiator, setRecoveryInitiator } from '../recoveryState';

describe('recoveryState', () => {
  afterEach(() => {
    setRecoveryInitiator(false);
  });

  it('defaults to false', () => {
    expect(isRecoveryInitiator()).toBe(false);
  });

  it('reflects the value passed to setRecoveryInitiator', () => {
    setRecoveryInitiator(true);
    expect(isRecoveryInitiator()).toBe(true);

    setRecoveryInitiator(false);
    expect(isRecoveryInitiator()).toBe(false);
  });
});
