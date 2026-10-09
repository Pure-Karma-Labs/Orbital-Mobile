/**
 * Shared react-test-renderer node queries for screen and component tests.
 *
 * House convention: these suites drive `react-test-renderer` directly — there
 * is no `@testing-library/react-native` in this project. Before #872 each suite
 * hand-rolled the same four or five walkers, and they had silently diverged.
 *
 * ## The host-node rule (why there are two flavours of every query)
 *
 * `react-test-renderer`'s tree contains BOTH component nodes (one per React
 * element, including function components) and host nodes (the platform
 * primitives actually rendered). A component node keeps its props — including
 * `testID` — even on a render where the component returns `null`.
 *
 * `ErrorBanner` (`src/components/ErrorBanner.tsx`) is the concrete case: it
 * takes `testID` as a prop and returns `null` when `message === null`. An
 * unfiltered `testID` lookup therefore "finds" a banner that is not on screen,
 * which makes an absence assertion vacuous and a presence assertion a
 * tautology. Filtering to `typeof node.type === 'string'` (host nodes only) is
 * what makes those assertions real.
 *
 * The hazard is specific to a component that RETURNS null while mounted
 * (`ErrorBanner`, `SuccessBanner`). An element the parent creates
 * conditionally (`{cond && <X testID=… />}`, or `TextInput`'s `${testID}-error`
 * Text) leaves no node at all when hidden, so an unfiltered lookup is honest
 * there — but the host helpers are correct in both cases, so prefer them.
 *
 * So:
 * - `findByTestId` is ONLY for driving props on a node already known to be
 *   rendered — typically `.props.onChangeText(...)` / `.props.onPress()`, which
 *   must hit the shared `TextInput`/`Button` wrapper's COMPONENT node, where
 *   the handler prop lives.
 * - Every presence, absence or conditional-render assertion must go through
 *   `hasHostTestId`, `findHostByTestId` or `bannerMessage`.
 *
 * ## Migrating the remaining local copies
 *
 * Roughly thirty other suites still define their own walkers. When one is
 * touched, map it by BEHAVIOUR, not by name:
 * - a local copy that already filters to host nodes (e.g. `MediaItemView`,
 *   `MediaThumbnailStrip`, `ProgressBar`) → **`findHostByTestId`** /
 *   `hasHostTestId`. A host-filtered ARRAY copy (`MediaThumbnailStrip`'s
 *   `findAllByTestId`) has no shared counterpart yet — keep it local;
 * - an UNFILTERED copy that backs a presence/absence assertion on a
 *   null-returning component (the pre-#872 Login/ForgotPassword banner case)
 *   → `hasHostTestId` / `bannerMessage`, and expect assertions to change;
 * - an unfiltered copy used only to drive props (including
 *   `MediaThumbnailStrip`'s `findComponentByTestId`) → `findByTestId`;
 * - an UNFILTERED array-returning copy (e.g. `ReplyComposer`) →
 *   `findAllByTestId`;
 * - a null-returning copy (e.g. `MediaItemView.unavailable`) → rewrite the
 *   call sites onto `hasHostTestId`.
 *
 * Swapping a host-filtered local copy onto the same-named `findByTestId` would
 * silently widen matching back to component nodes and re-introduce the vacuity
 * this module exists to prevent.
 *
 * ## Placement
 *
 * Helpers used across layers (screens, components, services) live here in
 * `src/testUtils/`; single-layer helpers live in that layer's own `testUtils/`
 * (`src/database/testUtils/`, `src/services/testUtils/`).
 *
 * ## Import fence
 *
 * `react-test-renderer` is a devDependency, so this module takes a type-only
 * import of it and has NO runtime imports at all. It must stay that way: this
 * file lives under `src/` and is reachable from production code by import.
 *
 * `scripts/check-security-invariants.mjs` treats `src/testUtils/` as
 * production code for invariant 20's cross-file scan, which exempts only
 * `errors.ts` itself and `__tests__/` / `.test.` paths — so code here may not
 * name `serverMessage`;
 * a fixture that needs it belongs in a `__tests__/` file. The only
 * `testUtils/` exemption in that script is invariant 3's (test-only imports);
 * do not add one to invariant 20.
 */

import type { ReactTestInstance } from 'react-test-renderer';

/**
 * The host tag `'Text'` in the shape `findAllByType`/`findByType` expect.
 *
 * Derived from the method signature rather than from `react`'s
 * `ComponentType`, so that this module keeps its single type-only import.
 */
type RtrElementType = Parameters<ReactTestInstance['findAllByType']>[0];

const TEXT = 'Text' as unknown as RtrElementType;

/**
 * First node — component OR host — carrying `testID`. Throws when absent.
 *
 * Use this ONLY to drive props on a node known to be rendered. For anything
 * that asserts whether something is on screen, use `hasHostTestId`,
 * `findHostByTestId` or `bannerMessage` instead.
 */
export function findByTestId(root: ReactTestInstance, testID: string): ReactTestInstance {
  const found = root.findAll((node) => node.props.testID === testID);
  if (found.length === 0) throw new Error(`No element with testID "${testID}"`);
  return found[0];
}

/**
 * Every node — component AND host — carrying `testID`. Empty array when none.
 *
 * Because component nodes are included, a `toHaveLength(0)` on this is only
 * meaningful for a component that is not mounted at all; prefer
 * `hasHostTestId` for "is it rendered".
 */
export function findAllByTestId(root: ReactTestInstance, testID: string): ReactTestInstance[] {
  return root.findAll((node) => node.props.testID === testID);
}

/**
 * First HOST node carrying `testID`. Throws when none is rendered.
 *
 * The right helper for asserting on real platform props (keyboardType,
 * autoCapitalize, accessibility props) — the component node would carry the
 * same prop names and make the assertion near-vacuous.
 */
export function findHostByTestId(root: ReactTestInstance, testID: string): ReactTestInstance {
  const found = root.findAll(
    (node) => typeof node.type === 'string' && node.props.testID === testID,
  );
  if (found.length === 0) throw new Error(`No HOST element with testID "${testID}"`);
  return found[0];
}

/** True when a HOST node with `testID` is in the rendered output. */
export function hasHostTestId(root: ReactTestInstance, testID: string): boolean {
  return (
    root.findAll((node) => typeof node.type === 'string' && node.props.testID === testID).length > 0
  );
}

/**
 * The children of the first `Text` inside the HOST node carrying `testID`, or
 * `undefined` when no host node is rendered.
 *
 * Reading through the banner's own `testID` means a matching string elsewhere
 * on the screen cannot satisfy the assertion. The host filter is what lets
 * `expect(bannerMessage(root, id)).toBeUndefined()` actually fail when a banner
 * IS showing, and keeps it from throwing when one is not.
 *
 * Returns `unknown`: `Text`'s `children` is not necessarily a string.
 */
export function bannerMessage(root: ReactTestInstance, testID: string): unknown {
  const host = root.findAll(
    (node) => typeof node.type === 'string' && node.props.testID === testID,
  );
  if (host.length === 0) return undefined;
  return host[0].findByType(TEXT).props.children;
}

/**
 * react-test-renderer equivalent of `queryByText` — the first `Text` whose
 * children are exactly `text`, or `undefined` when there is none.
 */
export function queryByText(root: ReactTestInstance, text: string): ReactTestInstance | undefined {
  return root.findAllByType(TEXT).find((node) => node.props.children === text);
}
