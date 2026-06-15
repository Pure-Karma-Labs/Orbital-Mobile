/**
 * Debounced FTS5 full-text search hook backed by SQLCipher.
 *
 * Replaces the Fuse.js in-memory search with database-backed FTS5 queries.
 * Debounce pattern mirrors useFuseSearch.ts (useRef + setTimeout + cleanup).
 * `isSearching` is derived from the *debounced* text, not the raw input, to
 * avoid a flash where day-grouping disappears before results are computed.
 */

import { useState, useRef, useMemo, useCallback, useEffect } from 'react';
import { searchAll } from '../database/repositories/searchRepository';

export interface UseSQLiteSearchResult {
  /** Raw input text -- bound to the TextInput value */
  searchText: string;
  /** Setter for the raw input text */
  setSearchText: (text: string) => void;
  /** Thread IDs matching the search query, ranked by relevance */
  resultThreadIds: ReadonlyArray<string>;
  /** True when debounced text is non-empty -- use this to toggle search mode UI */
  isSearching: boolean;
  /** Reset both raw and debounced text immediately */
  clearSearch: () => void;
}

export function useSQLiteSearch(
  conversationId: string | null,
  debounceMs: number = 200,
): UseSQLiteSearchResult {
  const [searchText, setSearchTextRaw] = useState('');
  const [debouncedText, setDebouncedText] = useState('');
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const setSearchText = useCallback(
    (text: string) => {
      setSearchTextRaw(text);

      // Clear any pending debounce
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }

      if (text.length === 0) {
        // Immediate clear -- no need to debounce emptying the field
        setDebouncedText('');
        return;
      }

      debounceRef.current = setTimeout(() => {
        setDebouncedText(text);
        debounceRef.current = null;
      }, debounceMs);
    },
    [debounceMs],
  );

  const clearSearch = useCallback(() => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    setSearchTextRaw('');
    setDebouncedText('');
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  const isSearching = debouncedText.length > 0;

  const resultThreadIds = useMemo((): ReadonlyArray<string> => {
    if (!isSearching || !conversationId) return [];
    return searchAll(conversationId, debouncedText);
  }, [isSearching, conversationId, debouncedText]);

  return { searchText, setSearchText, resultThreadIds, isSearching, clearSearch };
}
