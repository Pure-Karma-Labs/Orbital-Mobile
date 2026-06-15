/**
 * Reusable debounced fuzzy search hook backed by Fuse.js.
 *
 * Debounce pattern follows useLinkPreview.ts (useRef + setTimeout + cleanup).
 * `isSearching` is derived from the *debounced* text, not the raw input, to
 * avoid a flash where day-grouping disappears before results are computed.
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import type { IFuseOptions } from 'fuse.js';
import { getCachedFuseIndex } from '../utils/fuse';

export interface UseFuseSearchResult<T> {
  /** Raw input text — bound to the TextInput value */
  searchText: string;
  /** Setter for the raw input text */
  setSearchText: (text: string) => void;
  /** Filtered results (full list when not searching) */
  results: ReadonlyArray<T>;
  /** True when debounced text is non-empty — use this to toggle search mode UI */
  isSearching: boolean;
  /** Reset both raw and debounced text immediately */
  clearSearch: () => void;
}

export function useFuseSearch<T>(
  items: ReadonlyArray<T>,
  options: IFuseOptions<T>,
  debounceMs: number = 200,
): UseFuseSearchResult<T> {
  const [searchText, setSearchText] = useState('');
  const [debouncedText, setDebouncedText] = useState('');
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Debounce the search text
  useEffect(() => {
    // Clear any pending debounce
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }

    if (searchText.length === 0) {
      // Immediate clear — no need to debounce emptying the field
      setDebouncedText('');
      return;
    }

    debounceRef.current = setTimeout(() => {
      setDebouncedText(searchText);
      debounceRef.current = null;
    }, debounceMs);

    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
    };
  }, [searchText, debounceMs]);

  const isSearching = debouncedText.length > 0;

  const results: ReadonlyArray<T> = isSearching
    ? getCachedFuseIndex(items, options)
        .search(debouncedText)
        .map((r) => r.item)
    : items;

  const clearSearch = useCallback(() => {
    setSearchText('');
    setDebouncedText('');
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
  }, []);

  return { searchText, setSearchText, results, isSearching, clearSearch };
}
