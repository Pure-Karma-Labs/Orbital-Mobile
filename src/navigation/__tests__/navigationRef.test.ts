/**
 * Tests for the navigation ref module — pending payload queue and flush.
 */

import {
  setPendingNotificationPayload,
  setPayloadConsumer,
  flushPendingNotificationPayload,
  resetNavigationRefForTesting,
} from '../navigationRef';

beforeEach(() => {
  resetNavigationRefForTesting();
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
