---
name: zustand-store-mock-completeness
description: Store test makeStore() stubs must include ALL slice fields — zustand 5.0.14 fails on missing AppState properties; update all 8 test files when adding a new slice field
metadata:
  type: feedback
---

PR #341 fixed store tests that broke under zustand 5.0.14. The issue: each slice test's `makeStore()` had incomplete AppState stubs missing fields from other slices added over time (viewingConversationId, threadLastViewedAt, avatarDigest, etc.). Zustand 5 is stricter about the full state shape.

Affected test files (8): authSlice.test.ts, blockedUsersSlice.test.ts, contactsSlice.test.ts, conversationsSlice.test.ts, mediaSlice.test.ts, mediaSlice.setMediaBatch.test.ts, notificationSlice.test.ts, threadsSlice.test.ts, uiSlice.test.ts.

Pattern: use `as const` for string literal fields (`colorScheme: 'system' as const`) to match the exact union types in the slice interfaces.

**Why:** Adding a new slice field or action to any slice requires updating makeStore() in ALL 8+ test files. Forgetting one causes opaque "property missing" failures.

**How to apply:** When adding a new field to ANY Zustand slice, grep for `makeStore()` in `src/stores/__tests__/` and add the new field stub to every occurrence. Consider creating a shared `makeTestStoreState()` helper to reduce duplication (tech debt).
