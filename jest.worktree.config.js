/**
 * Jest config for running tests inside a .claude/worktrees/ checkout.
 * The main jest.config.js ignores worktree paths — this override allows tests to run.
 */
const base = require('./jest.config');

// Entries that exist ONLY to exclude worktree/clone checkouts from the main
// config — strip exactly these; inherit everything else the base adds.
// Exact string match against the literals in jest.config.js: if those are ever
// reformulated (escaping, anchors), the filter would silently stop stripping
// them and worktree tests would stop running — the assertion below fails
// loudly at config load instead.
const WORKTREE_ONLY = ['\\.clone/', '\\.claude/worktrees/'];

const testPathIgnorePatterns = (base.testPathIgnorePatterns || []).filter(
  p => !WORKTREE_ONLY.includes(p),
);
if (testPathIgnorePatterns.length !== (base.testPathIgnorePatterns || []).length - WORKTREE_ONLY.length) {
  throw new Error(
    'jest.worktree.config.js: WORKTREE_ONLY entries not found verbatim in ' +
      'jest.config.js testPathIgnorePatterns — update WORKTREE_ONLY to match.',
  );
}

module.exports = {
  ...base,
  testPathIgnorePatterns,
  modulePathIgnorePatterns: (base.modulePathIgnorePatterns || []).filter(p => !WORKTREE_ONLY.includes(p)),
};
