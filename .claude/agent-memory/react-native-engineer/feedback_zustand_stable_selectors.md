---
name: zustand-stable-selectors
description: Zustand selectors must return stable references (existing state objects, not new object literals) to avoid infinite re-render loops
metadata:
  type: feedback
---

Zustand selectors must return stable references from state, not new object literals.

**Why:** Returning `{ a: s.a, b: s.b }` creates a new object on every store notification. Even with `useShallow`, the selector itself runs on every state change and the outer component sees a "new" value each time. This causes `useEffect` dependency arrays to fire continuously, creating infinite re-render loops. Encountered when FileLibraryScreen's `storeMedia` selector initially returned a derived object instead of `s.media` directly.

**How to apply:**
- When selecting a single slice field: `useAppStore(s => s.media)` -- returns the existing object reference
- When selecting a single item: `useAppStore(s => s.media[id])` -- stable as long as the item reference doesn't change
- When selecting multiple fields: use `useShallow` with the standard hook pattern (`useConversations`, `useAuth`, etc.)
- NEVER: `useAppStore(s => ({ media: s.media, count: s.mediaCount }))` without `useShallow`
- If you need a derived value (filtered subset, mapped array), compute it in `useMemo` downstream of the selector, not inside the selector itself
