---
name: Theme system implementation — Issue #5
description: Design system and theme tokens implemented in src/theme/. Key decisions about font PostScript names, context architecture, and test patterns.
type: project
---

Theme system is live at `src/theme/`. Entry-point is `src/theme/index.ts`.

Key facts:
- `createTheme('light'|'dark')` returns a complete `Theme` object (no dependencies on third-party styling libraries)
- `ThemeProvider` wraps the app, `useTheme()` consumes it
- `@react-native/new-app-screen` was moved from `dependencies` to `devDependencies` in `package.json` as part of this work
- `react-native.config.js` registers `src/theme/fonts/` as linked font assets

**Why:** Issue #5 spec required plain StyleSheet + React Context (no third-party styling libs).

**How to apply:** All future components use `useTheme()` from `src/theme`. Never reach into individual token files directly from component code — always go through `useTheme()`.
