/**
 * TEMP #928: replaced by importRunner exports at integration.
 *
 * Brief 2 (UI) is built in parallel with Brief 1 (runner) on separate
 * branches. Everything the frozen runner→UI type contract adds — and nothing
 * else — lives here, so that integration is a rewrite of THIS FILE ONLY: every
 * binding below has a one-line replacement once `importRunner.ts` carries the
 * new surface.
 *
 * | Binding here                | Becomes at integration                      |
 * |-----------------------------|---------------------------------------------|
 * | `ImportViewState`           | `ImportRunnerState`                          |
 * | `PickFailureReason`         | re-export from `importRunner`                |
 * | `PickParseResult`           | re-export from `importRunner`                |
 * | `ImportFailedItemCode`      | re-export from `importRunner`                |
 * | `UnmigratedImportItem`      | re-export from `importRunner`                |
 * | `UnmigratedCounts`          | re-export from `importRunner`                |
 * | `UnmigratedImportList`      | re-export from `importRunner`                |
 * | `importViewStore`           | `importStore`                                |
 * | `pickAndStartParse`         | re-export from `importRunner`                |
 * | `discardImportPreflight`    | re-export from `importRunner`                |
 * | `getImportUnmigratedItems`  | re-export from `importRunner`                |
 *
 * The two not-yet-existing FUNCTIONS are looked up on the runner module at
 * call time rather than stubbed outright: the moment Brief 1 lands they become
 * live without a UI edit, and until then they are an honest no-op (nothing to
 * discard, nothing unmigrated to list) instead of a crash.
 *
 * This module is the ONLY one in `src/screens/import/` with a runtime import
 * of the runner besides the screens themselves; `importCopy.ts` takes
 * type-only imports from it.
 */

import * as importRunner from '../../services/metaImport/importRunner';

import type { StoreApi } from 'zustand/vanilla';
import type { ImportItemCode } from '../../services/metaImport/importBatch';
import type { ImportItemFailureCode } from '../../services/metaImport/importErrors';
import type { ImportPreflight, ImportRunnerState } from '../../services/metaImport/importRunner';
import type { ImportSource, SkipReason } from '../../services/metaImport/types';

// ---------------------------------------------------------------------------
// ImportRunnerState: + autoRetryExhausted, − mediaTotal, − needsRepick
// ---------------------------------------------------------------------------

/**
 * The published state as Brief 1 leaves it.
 *
 * `mediaDone` is KEPT (gap 3): it is the only counter that moves during a
 * media batch of up to 50 items.
 */
export type ImportViewState = Omit<ImportRunnerState, 'mediaTotal' | 'needsRepick'> & {
  /**
   * The pre-run retry budget is spent. The job keeps its identity and a
   * resumable cause, so the member can retry by hand (§2 fix (b)).
   */
  readonly autoRetryExhausted: boolean;
};

/**
 * The live store, typed against {@link ImportViewState}.
 *
 * One cast, in one place: the store OBJECT is the runner's own, so a UI read
 * of `autoRetryExhausted` is `undefined` (falsy — never `stalled`) until Brief
 * 1 publishes it, which is exactly the pre-integration behaviour we want.
 */
export const importViewStore = importRunner.importStore as unknown as StoreApi<ImportViewState>;

// ---------------------------------------------------------------------------
// PickParseResult: one new arm
// ---------------------------------------------------------------------------

export type PickFailureReason = 'archive' | 'key_pending' | 'network' | 'other';

export type PickParseResult =
  | { readonly kind: 'preflight'; readonly preflight: ImportPreflight }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'refused'; readonly reason: 'job-running'; readonly conversationId: string }
  | { readonly kind: 'failed'; readonly reason: PickFailureReason };

/**
 * Widened only in its RESULT type — the runner's current arms are a subset of
 * the contract's, so this is an ordinary covariant assignment, not a cast.
 */
export function pickAndStartParse(args: {
  conversationId: string;
  source: ImportSource;
}): Promise<PickParseResult> {
  return importRunner.pickAndStartParse(args);
}

// ---------------------------------------------------------------------------
// The unmigrated list (§2 gap 6)
// ---------------------------------------------------------------------------

/**
 * Every per-item failure code the list can carry.
 *
 * `IMPORT_MEDIA_TOO_LARGE` is spelled out because Brief 1 adds it to
 * `IMPORT_ITEM_FAILURE_CODES` (§2 gap 8); after that it is already a member of
 * `ImportItemFailureCode` and the union is unchanged by its removal here.
 */
export type ImportFailedItemCode =
  ImportItemFailureCode | ImportItemCode | 'IMPORT_MEDIA_TOO_LARGE' | 'IMPORT_RESULT_UNKNOWN';

interface UnmigratedRowBase {
  readonly id: string;
  /** Epoch ms UTC. */
  readonly originalDate: number | null;
  /** LOCAL UI ONLY (F18): render, never log. */
  readonly sourceFile: string | null;
  readonly sourceIndex: number | null;
}

export type UnmigratedImportItem =
  | (UnmigratedRowBase & { readonly kind: 'skipped'; readonly reason: SkipReason })
  | (UnmigratedRowBase & { readonly kind: 'failed'; readonly code: ImportFailedItemCode })
  | (UnmigratedRowBase & { readonly kind: 'not_sent' });

export interface UnmigratedCounts {
  /** Includes extract-time `held_video`. */
  readonly skipped: Readonly<Partial<Record<SkipReason, number>>>;
  readonly failed: Readonly<Partial<Record<ImportFailedItemCode, number>>>;
  readonly notSent: number;
}

export interface UnmigratedImportList {
  /** ≤ 1000 rows, ordered by ordinal. */
  readonly items: readonly UnmigratedImportItem[];
  /** Full totals — NOT capped. */
  readonly counts: UnmigratedCounts;
  /** Total rows − `items.length`, never negative. */
  readonly truncated: number;
}

export const EMPTY_UNMIGRATED_LIST: UnmigratedImportList = Object.freeze({
  items: Object.freeze([]) as readonly UnmigratedImportItem[],
  counts: Object.freeze({
    skipped: Object.freeze({}),
    failed: Object.freeze({}),
    notSent: 0,
  }),
  truncated: 0,
});

/**
 * The two functions Brief 1 adds, resolved at CALL time.
 *
 * `as unknown as` because the runner namespace object genuinely has neither
 * property yet; a direct assertion between the two shapes is not expressible.
 */
const futureRunner = importRunner as unknown as {
  discardImportPreflight?: () => Promise<void>;
  getImportUnmigratedItems?: () => UnmigratedImportList;
};

/** Discards a ready (or idle-with-jobId ready-in-DB) job. No network. */
export function discardImportPreflight(): Promise<void> {
  const fn = futureRunner.discardImportPreflight;
  return fn === undefined ? Promise.resolve() : fn();
}

/** Synchronous (op-sqlite `executeSync`), bounded by `LIMIT 1000`. */
export function getImportUnmigratedItems(): UnmigratedImportList {
  const fn = futureRunner.getImportUnmigratedItems;
  return fn === undefined ? EMPTY_UNMIGRATED_LIST : fn();
}
