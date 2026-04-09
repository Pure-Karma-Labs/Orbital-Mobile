/**
 * Manual Jest mock for @op-engineering/op-sqlite.
 *
 * This native module is not installed in node_modules (it's resolved at
 * build time by the React Native bundler). This mock provides the minimum
 * export shape so that:
 *   1. Jest can resolve `import { open } from '@op-engineering/op-sqlite'`
 *   2. Test files can override behavior via `jest.mock(...)` as usual
 */

const mockDb = {
  executeSync: jest.fn(() => ({ rows: [], rowsAffected: 0 })),
  close: jest.fn(),
  execute: jest.fn(() => Promise.resolve({ rows: [], rowsAffected: 0 })),
  delete: jest.fn(),
};

module.exports = {
  open: jest.fn(() => mockDb),
};
