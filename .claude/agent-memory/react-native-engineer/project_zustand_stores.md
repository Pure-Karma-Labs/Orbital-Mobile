---
name: Zustand store architecture — Issue #7
description: Single useAppStore with 6 slices, useShallow selector hooks, MMKV encrypted persistence with deferred init pattern.
type: project
---

Zustand store is at `src/stores/`. Single store (`useAppStore`) composed of 6 slices.

Key facts:
- `src/stores/useAppStore.ts` — the store instance (combines all slices via Zustand `create`)
- `src/stores/slices/` — one file per domain slice: authSlice, conversationsSlice, threadsSlice, messagesSlice, contactsSlice, uiSlice
- `src/stores/index.ts` — barrel that re-exports `useAppStore` plus 6 named selector hooks
- `src/stores/middleware/persistence.ts` — MMKV adapter; uses deferred init (`initMMKV`/`getMMKVInstance`/`resetMMKVForTesting`)
- Selector hooks (`useAuth`, `useConversations`, `useThreads`, `useMessages`, `useContacts`, `useUI`) all wrap `useShallow` so components only re-render on shallow-equal changes
- `src/types/store.ts` — TypeScript interfaces for all store slice state shapes

Deferred init pattern for MMKV:
- `initMMKV(key)` called in bootstrap BEFORE AppRegistry — throws if called twice
- `getMMKVInstance()` throws with descriptive message if called before init
- `resetMMKVForTesting()` creates unencrypted in-memory instance for Jest

**Why:** Encryption key must come from Keychain before MMKV can be constructed. Deferred init keeps the module importable at any time without side effects.

**How to apply:** Always call `initMMKV()` in `src/bootstrap.ts` before any component tree mounts. In tests, call `resetMMKVForTesting()` in beforeEach.
