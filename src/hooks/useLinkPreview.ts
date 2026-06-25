import { useEffect, useRef, useState } from 'react';
import { getLinkPreview } from '../services/api/linkPreviews';
import { NotFoundError } from '../services/api/errors';
import type { LinkPreviewResponse } from '../types/api';
import { URL_PATTERN_SOURCE, stripFormatChars } from '../utils/urlPattern';

const URL_REGEX = new RegExp(URL_PATTERN_SOURCE, 'gi');
const MAX_CACHE_SIZE = 200;

const previewCache = new Map<string, LinkPreviewResponse | null>();
const inflightRequests = new Map<string, Promise<LinkPreviewResponse | null>>();

export function extractFirstUrl(text: string | null): string | null {
  if (!text) return null;
  const matches = text.match(URL_REGEX);
  if (!matches) return null;
  for (const match of matches) {
    try {
      const cleaned = stripFormatChars(match);
      const url = new URL(cleaned);
      if (url.protocol === 'https:') return cleaned;
    } catch {
      // invalid URL, try next
    }
  }
  return null;
}

export function clearLinkPreviewCache(): void {
  previewCache.clear();
  inflightRequests.clear();
}

async function fetchPreview(
  url: string,
  signal?: AbortSignal,
): Promise<LinkPreviewResponse | null> {
  // Check cache
  if (previewCache.has(url)) return previewCache.get(url) ?? null;

  // Check in-flight
  const inflight = inflightRequests.get(url);
  if (inflight) return inflight;

  // Fetch
  const promise = getLinkPreview(url, signal)
    .then((data) => {
      if (previewCache.size >= MAX_CACHE_SIZE) {
        const firstKey = previewCache.keys().next().value;
        if (firstKey !== undefined) previewCache.delete(firstKey);
      }
      previewCache.set(url, data);
      return data;
    })
    .catch((err) => {
      if (err instanceof NotFoundError) {
        previewCache.set(url, null);
      }
      return null;
    })
    .finally(() => {
      inflightRequests.delete(url);
    });

  inflightRequests.set(url, promise);
  return promise;
}

export function useLinkPreview(
  text: string | null,
  options?: { debounceMs?: number },
): { preview: LinkPreviewResponse | null; loading: boolean } {
  const [preview, setPreview] = useState<LinkPreviewResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const url = extractFirstUrl(text);

    // Cleanup previous
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }

    if (!url) {
      setPreview(null);
      setLoading(false);
      return;
    }

    // Synchronous cache check
    if (previewCache.has(url)) {
      setPreview(previewCache.get(url) ?? null);
      setLoading(false);
      return;
    }

    const doFetch = () => {
      const controller = new AbortController();
      abortRef.current = controller;
      setLoading(true);

      fetchPreview(url, controller.signal).then((result) => {
        if (!controller.signal.aborted) {
          setPreview(result);
          setLoading(false);
        }
      });
    };

    if (options?.debounceMs) {
      debounceRef.current = setTimeout(doFetch, options.debounceMs);
    } else {
      doFetch();
    }

    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
      if (abortRef.current) {
        abortRef.current.abort();
        abortRef.current = null;
      }
    };
  }, [text, options?.debounceMs]);

  return { preview, loading };
}
