---
name: react19-pin
description: React pinned to 19.1.1 — 19.1.8 breaks react-test-renderer (44 test failures across 8 screen suites); wait for react-test-renderer update
metadata:
  type: feedback
---

React 19.1.8 (from dependabot dep bump PR #315) breaks `react-test-renderer`. The `ReactNativeRenderer-dev.js` internals changed in a way that causes 44 test failures across 8 screen test suites. Pinned react to 19.1.1 in package.json until react-test-renderer catches up.

**Why:** Dependabot bumped all production deps including React. The test breakage was discovered during PR #315 review.

**How to apply:** Do NOT upgrade react past 19.1.1 until react-test-renderer is updated. If dependabot proposes a react upgrade, check react-test-renderer compatibility first. This also affects [[react19-test-renderer]] — the act() wrapping pattern is still required but is not sufficient for 19.1.8.
