---
name: barrel-export-caution
description: Do NOT add components to barrel exports if they import hooks that pull in heavy service chains — causes cascading test failures in unrelated screens
metadata:
  type: feedback
---

Do NOT add components to `src/components/index.ts` if they import hooks that pull in heavy service chains (e.g., download service -> store -> MMKV -> NitroModules).

**Why:** Barrel re-exports mean every test file that imports *any* component from the barrel also transitively imports the full dependency chain of every exported component. When a component like MediaItemView imports useMediaDownload (which imports the download service, which imports the store, which imports MMKV and NitroModules), adding it to the barrel breaks tests for completely unrelated screens like LoginScreen or SettingsScreen that also import from the barrel.

**How to apply:** Before adding a new component to the barrel, check its import chain. If it reaches into services, stores with native dependencies, or hooks with side effects, keep it as a direct import only. MediaItemView, MediaGallery, and MediaLightbox are the canonical examples — they are imported directly by ReplyItem and ThreadHeader, not via the barrel. The barrel has a comment documenting this decision.

Related: [[media-display-layer]]
