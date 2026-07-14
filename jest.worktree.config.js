/**
 * Jest config for running tests inside a .claude/worktrees/ checkout.
 * The main jest.config.js ignores worktree paths — this override allows tests to run.
 */
const base = require('./jest.config');

// Entries that exist ONLY to exclude worktree/clone checkouts from the main
// config — strip exactly these; inherit everything else the base adds.
const WORKTREE_ONLY = ['\\.clone/', '\\.claude/worktrees/'];

module.exports = {
  ...base,
  testPathIgnorePatterns: (base.testPathIgnorePatterns || []).filter(p => !WORKTREE_ONLY.includes(p)),
  modulePathIgnorePatterns: (base.modulePathIgnorePatterns || []).filter(p => !WORKTREE_ONLY.includes(p)),
};
