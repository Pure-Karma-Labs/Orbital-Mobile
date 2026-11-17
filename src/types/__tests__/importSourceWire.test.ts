/**
 * `ImportSourceWire` ↔ `ImportSource` — the one pin that keeps two spellings
 * of the same closed set from drifting (#996 / B#352).
 *
 * `src/types/api.ts` is the wire-shape leaf and imports nothing, so it cannot
 * reach the parser's `ImportSource`; the import source therefore exists twice
 * in this codebase. That is fine only while the two are provably the SAME set.
 *
 * The assertions below are two-way on purpose. A one-way `extends` would pass
 * while one side gained a member: `'facebook'|'instagram'|'threads'` still
 * extends nothing it should not if the test only asks in one direction. The
 * failure mode that matters is silent — a source the parser can produce but no
 * route accepts, or an allowance bucket the server reports and the client can
 * never index — so the check is a compile error, not a runtime one.
 */

import type { ImportSourceWire } from '../api';
import type { ImportSource } from '../../services/metaImport/types';

/** `true` only when `A` and `B` are mutually assignable. */
type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/** A compile error here IS the finding; the runtime assertion is the carrier. */
type SourcesAgree = MutuallyAssignable<ImportSourceWire, ImportSource>;

const SOURCES_AGREE: SourcesAgree = true;

/**
 * The members themselves, so a reader can see what the pin is pinning.
 *
 * Typed as both sides at once: adding a member to either union without the
 * other fails here too, and this array is what a `satisfies` check would be if
 * the project's TypeScript target allowed one in a test.
 */
const WIRE_SOURCES: readonly ImportSourceWire[] = ['facebook', 'instagram'];
const PARSER_SOURCES: readonly ImportSource[] = ['facebook', 'instagram'];

describe('ImportSourceWire', () => {
  it('is the same closed set as the parser ImportSource', () => {
    // The type-level assertion above is the real test — if it fails, this file
    // does not compile and `tsc --noEmit` reports it. This asserts the
    // constant so the pin cannot be deleted as unused.
    expect(SOURCES_AGREE).toBe(true);
    expect([...WIRE_SOURCES].sort()).toEqual([...PARSER_SOURCES].sort());
  });

  it('is exactly the two sources the import routes accept', () => {
    // `IMPORT_SOURCES` in Orbital-Backend `src/config/imports.js`. A third
    // source is a wire change, a migration and an allowance bucket, so it has
    // to break something here first.
    expect(WIRE_SOURCES).toEqual(['facebook', 'instagram']);
  });
});
