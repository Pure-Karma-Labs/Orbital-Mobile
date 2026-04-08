---
name: React 19 + react-test-renderer requires act() for hooks that trigger state
description: Components using useColorScheme or other hooks that schedule updates must be wrapped in act() when using react-test-renderer create().
type: feedback
---

In React 19, `react-test-renderer`'s `create()` is effectively async when components schedule state updates. Failing to wrap in `act()` causes "not wrapped in act()" warnings and can leave state unresolved so assertions fail.

**Why:** Observed when testing `ThemeProvider` which calls `useColorScheme()` — capturedTheme stayed null because the render hadn't flushed.

**How to apply:**
- Always wrap `create()` in `act()` when the component tree uses hooks
- Pass `colorSchemeOverride='light'` to `ThemeProvider` in tests to pin the color scheme and avoid side effects from the test environment's system preference
- For tests that expect throws, wrap the `create()` inside an `act()` inside the `expect(() => ...).toThrow()` callback
