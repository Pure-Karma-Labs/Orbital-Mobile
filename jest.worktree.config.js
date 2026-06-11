/**
 * Jest config for running tests inside a .claude/worktrees/ checkout.
 * The main jest.config.js ignores worktree paths — this override allows tests to run.
 */
const base = require('./jest.config');

module.exports = {
  ...base,
  roots: ['<rootDir>/src'],
  testPathIgnorePatterns: ['/node_modules/'],
  modulePathIgnorePatterns: [],
};
