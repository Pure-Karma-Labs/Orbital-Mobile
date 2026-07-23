// Temporary worktree-scoped jest config — removes the worktree exclusion so
// tests inside this worktree directory are discovered by Jest.
const base = require('./jest.config');
module.exports = {
  ...base,
  testPathIgnorePatterns: ['/node_modules/', '\\.clone/'],
  modulePathIgnorePatterns: ['\\.clone/'],
};
