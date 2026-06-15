---
name: fuse-search-test-patterns
description: Patterns and gaps discovered when reviewing FTS5 search tests in PR #348 — mock shape, debounce verification, sanitizer edge cases
metadata:
  type: project
---

Test patterns established in PR #348 (FTS5 full-text search):

**renderHook helper** — project uses a hand-rolled renderHook (react-test-renderer + TestComponent) because @testing-library/react-native is not installed. Match this pattern for all future hook tests.

**Debounce testing** — jest.useFakeTimers() in beforeEach, jest.useRealTimers() in afterEach. Wrap setSearchText calls in act(), then wrap jest.advanceTimersByTime() in a separate act() to trigger state flush.

**searchRepository mock shape** — the test mocks `@op-engineering/op-sqlite` and uses `resetDatabaseForTesting()` + `makeDb(executeSync)` to inject a controlled executeSync. The repository routes through `queryMany → getDatabase().executeSync`, so the mock is correct.

**Gaps identified:**
- `sanitizeFtsQuery` has no test for single double-quote input (`"`) alone — technically covered by the general escape rule but worth noting
- `searchAll` does not test `executeSync` throwing an error — no crash/error path test
- Hook test does not assert `resultThreadIds` updates when `conversationId` changes mid-session
- Screen tests only mock `useSQLiteSearch` as static (isSearching: false); no test exercises search-active UI state in either screen

**Why:** This info shapes coverage gap prioritization for future test PRs.
**How to apply:** When writing new search-related tests, use the renderHook helper pattern and the makeDb factory. Flag error-path and conversationId-change tests as medium-priority follow-ups.
