---
name: metro-esm-resolution
description: fuse.js v7 .mjs breaks Metro — fix with resolverMainFields ['react-native','main','module'] to prefer CJS over ESM
metadata:
  type: feedback
---

fuse.js v7 ships `.mjs` that references `@babel/runtime/helpers/createClass` which Metro can't resolve. Fixed by setting `resolverMainFields: ['react-native', 'main', 'module']` in `metro.config.js` to prefer CJS entry points over ESM.

**Why:** Metro's default field resolution order includes `module` (ESM) before `main` (CJS). Some npm packages ship ESM that references Babel helpers Metro doesn't provide.

**How to apply:** If a new dependency causes "Unable to resolve module @babel/runtime/helpers/..." errors, check if it ships `.mjs` and ensure `metro.config.js` resolverMainFields puts `main` before `module`. This is already configured project-wide.
