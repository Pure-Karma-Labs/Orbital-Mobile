/**
 * Tests for the navigation ref module — pending payload queue, flush,
 * and immediate delivery when consumer + nav are ready.
 */

import {
  navigationRef,
  setPendingNotificationPayload,
  setPayloadConsumer,
  flushPendingNotificationPayload,
  resetNavigationRefForTesting,
} from '../navigationRef';

beforeEach(() => {
  resetNavigationRefForTesting();
  // Default: nav NOT ready (killed-state scenario)
  jest.spyOn(navigationRef, 'isReady').mockReturnValue(false);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('pending notification payload', () => {
  it('flushes a queued payload to the registered consumer', () => {
    const consumer = jest.fn();
    setPayloadConsumer(consumer);
    setPendingNotificationPayload({ t: 'new_thread', tid: 't-1' });

    flushPendingNotificationPayload();

    expect(consumer).toHaveBeenCalledWith({ t: 'new_thread', tid: 't-1' });
  });

  it('clears the payload after flushing', () => {
    const consumer = jest.fn();
    setPayloadConsumer(consumer);
    setPendingNotificationPayload({ t: 'new_dm', gid: 'dm-1' });

    flushPendingNotificationPayload();
    flushPendingNotificationPayload();

    // Consumer should be called only once
    expect(consumer).toHaveBeenCalledTimes(1);
  });

  it('does not flush if no consumer is registered', () => {
    setPendingNotificationPayload({ t: 'new_thread', tid: 't-1' });

    // Should not throw
    expect(() => flushPendingNotificationPayload()).not.toThrow();
  });

  it('does not flush if no payload is queued', () => {
    const consumer = jest.fn();
    setPayloadConsumer(consumer);

    flushPendingNotificationPayload();

    expect(consumer).not.toHaveBeenCalled();
  });

  it('replaces the pending payload if set multiple times', () => {
    const consumer = jest.fn();
    setPayloadConsumer(consumer);
    setPendingNotificationPayload({ t: 'new_thread', tid: 't-1' });
    setPendingNotificationPayload({ t: 'new_dm', gid: 'dm-1' });

    flushPendingNotificationPayload();

    expect(consumer).toHaveBeenCalledWith({ t: 'new_dm', gid: 'dm-1' });
    expect(consumer).toHaveBeenCalledTimes(1);
  });

  it('resetNavigationRefForTesting clears both payload and consumer', () => {
    const consumer = jest.fn();
    setPayloadConsumer(consumer);
    setPendingNotificationPayload({ t: 'new_thread', tid: 't-1' });

    resetNavigationRefForTesting();
    flushPendingNotificationPayload();

    expect(consumer).not.toHaveBeenCalled();
  });
});

describe('immediate delivery (background tap with nav ready)', () => {
  it('delivers payload immediately when consumer is registered and nav is ready', () => {
    const consumer = jest.fn();
    jest.spyOn(navigationRef, 'isReady').mockReturnValue(true);
    setPayloadConsumer(consumer);

    setPendingNotificationPayload({ t: 'new_dm', gid: 'dm-1' });

    // Should be called immediately, not queued
    expect(consumer).toHaveBeenCalledWith({ t: 'new_dm', gid: 'dm-1' });
  });

  it('does not queue payload when delivered immediately', () => {
    const consumer = jest.fn();
    jest.spyOn(navigationRef, 'isReady').mockReturnValue(true);
    setPayloadConsumer(consumer);

    setPendingNotificationPayload({ t: 'new_thread', tid: 't-1' });
    consumer.mockClear();

    // Flushing should not call consumer again — payload was not queued
    flushPendingNotificationPayload();
    expect(consumer).not.toHaveBeenCalled();
  });

  it('queues payload when consumer is registered but nav is NOT ready', () => {
    const consumer = jest.fn();
    jest.spyOn(navigationRef, 'isReady').mockReturnValue(false);
    setPayloadConsumer(consumer);

    setPendingNotificationPayload({ t: 'new_thread', tid: 't-1' });

    // Should NOT be called immediately
    expect(consumer).not.toHaveBeenCalled();

    // Should be flushed later
    flushPendingNotificationPayload();
    expect(consumer).toHaveBeenCalledWith({ t: 'new_thread', tid: 't-1' });
  });

  it('queues payload when nav is ready but no consumer is registered', () => {
    jest.spyOn(navigationRef, 'isReady').mockReturnValue(true);

    // No consumer registered
    setPendingNotificationPayload({ t: 'new_dm', gid: 'dm-1' });

    // Register consumer and flush
    const consumer = jest.fn();
    setPayloadConsumer(consumer);
    flushPendingNotificationPayload();

    expect(consumer).toHaveBeenCalledWith({ t: 'new_dm', gid: 'dm-1' });
  });
});
