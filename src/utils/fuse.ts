/**
 * Fuse.js index caching utility.
 *
 * Two-level cache: Map<options, WeakMap<list, Fuse>> ensures we only build a
 * Fuse index once per (options, list) pair. Both the options object and the list
 * array should remain referentially stable (module-level constants and Zustand
 * store arrays via useShallow) to maximise cache hits.
 *
 * Ported from Orbital-Desktop/ts/util/fuse.std.ts — stripped of diacritics
 * wrapper (Fuse v7 has native `ignoreDiacritics: true`).
 */

import Fuse, { type IFuseOptions } from 'fuse.js';

const cachedIndices: Map<
  IFuseOptions<unknown>,
  WeakMap<ReadonlyArray<unknown>, Fuse<unknown>>
> = new Map();

export function getCachedFuseIndex<T>(
  list: ReadonlyArray<T>,
  options: IFuseOptions<T>,
): Fuse<T> {
  let indicesForOptions = cachedIndices.get(
    options as IFuseOptions<unknown>,
  );

  if (!indicesForOptions) {
    indicesForOptions = new WeakMap();
    cachedIndices.set(options as IFuseOptions<unknown>, indicesForOptions);
  }

  let index = indicesForOptions.get(list);
  if (!index) {
    index = new Fuse<unknown>(
      list as ReadonlyArray<unknown>,
      options as IFuseOptions<unknown>,
    );
    indicesForOptions.set(list, index);
  }

  return index as unknown as Fuse<T>;
}
