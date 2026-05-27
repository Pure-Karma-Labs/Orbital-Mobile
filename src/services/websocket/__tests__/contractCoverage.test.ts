/// <reference types="node" />

/**
 * WS event type contract coverage test.
 *
 * Verifies that the mobile WebSocket handler covers every event type the
 * backend declares in its snapshot registry. This test reads the committed
 * snapshot (copied from Orbital-Backend/ws-event-types.snapshot.json) and
 * confirms:
 *   1. Every backend broadcast type is in KNOWN_BROADCAST_TYPES.
 *   2. Every backend unicast type is in KNOWN_UNICAST_TYPES.
 *   3. Every KNOWN_BROADCAST_TYPES entry has a `case` in handleBroadcast.
 *   4. Every KNOWN_UNICAST_TYPES entry has a `case` in handleServerMessage.
 *
 * When the backend adds a new event type, updating the snapshot will cause
 * these tests to fail until the mobile handler is updated — that's the point.
 *
 * References: Orbital-Backend#30, Orbital-Backend#36, DEBT-024
 */

// ---------------------------------------------------------------------------
// Module mocks — prevent transitive TurboModule resolution
// ---------------------------------------------------------------------------

jest.mock('../../api/client', () => ({
  snakeToCamel: jest.fn((v: unknown) => v),
}));

jest.mock('../../crypto/contentCrypto', () => ({
  getOrFetchGroupKey: jest.fn(),
  invalidateGroupKey: jest.fn(),
  wrapGroupKey: jest.fn(),
  evictPendingCache: jest.fn(),
}));

jest.mock('../../crypto/identityKeyAccess', () => ({
  resolveRemoteIdentityKey: jest.fn(),
}));

jest.mock('../../api/groups', () => ({
  submitWrappedKey: jest.fn(),
}));

jest.mock('../../threadService', () => ({
  decryptThreadFields: jest.fn(),
  decryptReplyBody: jest.fn(),
  processMediaMetadata: jest.fn(),
}));

jest.mock('../../../stores/useAppStore', () => ({
  useAppStore: {
    getState: jest.fn(() => ({})),
  },
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import * as fs from 'fs';
import * as path from 'path';
import { KNOWN_BROADCAST_TYPES, KNOWN_UNICAST_TYPES } from '../messageHandler';

const snapshotPath = path.resolve(__dirname, 'ws-event-types.snapshot.json');

describe('WS event type contract coverage', () => {
  let snapshot: {
    broadcastTypes: Record<string, string>;
    unicastTypes: Record<string, string>;
  };

  beforeAll(() => {
    const raw = fs.readFileSync(snapshotPath, 'utf-8');
    snapshot = JSON.parse(raw);
  });

  // ------------------------------------------------------------------
  // 1. Backend broadcast types are covered by mobile
  // ------------------------------------------------------------------

  describe('backend broadcast types covered by mobile', () => {
    test('all backend broadcast types are in KNOWN_BROADCAST_TYPES', () => {
      const backendBroadcastTypes = Object.values(snapshot.broadcastTypes);
      for (const type of backendBroadcastTypes) {
        expect(KNOWN_BROADCAST_TYPES.has(type)).toBe(true);
      }
    });
  });

  // ------------------------------------------------------------------
  // 2. Backend unicast types are covered by mobile
  // ------------------------------------------------------------------

  describe('backend unicast types covered by mobile', () => {
    test('all backend unicast types are in KNOWN_UNICAST_TYPES', () => {
      const backendUnicastTypes = Object.values(snapshot.unicastTypes);
      for (const type of backendUnicastTypes) {
        expect(KNOWN_UNICAST_TYPES.has(type)).toBe(true);
      }
    });
  });

  // ------------------------------------------------------------------
  // 3. Handler switch coverage — every allow-listed type has a case
  // ------------------------------------------------------------------

  describe('handler switch coverage', () => {
    const handlerSource = fs.readFileSync(
      path.resolve(__dirname, '../messageHandler.ts'),
      'utf-8',
    );

    test('every KNOWN_BROADCAST_TYPES entry has a case in handleBroadcast', () => {
      // Extract handleBroadcast function body (ends at the next column-0 closing brace)
      const broadcastMatch = handlerSource.match(
        /async function handleBroadcast[\s\S]*?^}/m,
      );
      expect(broadcastMatch).not.toBeNull();

      for (const type of KNOWN_BROADCAST_TYPES) {
        expect(broadcastMatch![0]).toContain(`case '${type}'`);
      }
    });

    test('every KNOWN_UNICAST_TYPES entry has a case in handleServerMessage', () => {
      // Extract handleServerMessage function body (ends at the next column-0 closing brace)
      const mainMatch = handlerSource.match(
        /export async function handleServerMessage[\s\S]*?^}/m,
      );
      expect(mainMatch).not.toBeNull();

      for (const type of KNOWN_UNICAST_TYPES) {
        expect(mainMatch![0]).toContain(`case '${type}'`);
      }
    });
  });
});
