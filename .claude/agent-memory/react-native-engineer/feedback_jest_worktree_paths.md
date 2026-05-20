---
name: jest-worktree-paths
description: Jest config excludes .claude/worktrees/ paths — override with --testPathIgnorePatterns and --modulePathIgnorePatterns flags when running tests from worktrees
metadata:
  type: feedback
---

Jest configuration excludes `.claude/worktrees/` in testPathIgnorePatterns. When running tests from a worktree (agents working in isolated worktrees), tests may not be found.

Override: `--testPathIgnorePatterns='/node_modules/' --modulePathIgnorePatterns=''`

This strips the worktree exclusion and the default module path ignore, allowing Jest to find and run tests normally from within a worktree directory.

**Why:** Agent workflow uses isolated worktrees for implementation. Without the override, `npm test` in a worktree silently finds zero test files.

**How to apply:** When launching implementation agents on worktrees, include these Jest overrides in the test command. In the main repo this is not needed.
