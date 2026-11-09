import { useState, useEffect, useRef } from 'react';
import { ExSearch } from '../../core/search';
import type { SearchConfig, SearchResult } from '../../types';
import { useStableConfig } from './useStableConfig';
import { useStableData } from './useStableData';

/**
 * Async search hook that optionally delegates scoring to a Web Worker.
 *
 * When `config.useWorker` is `true` and `Worker` is available (browser only),
 * scoring runs off the main thread and the UI stays responsive during large
 * dataset searches. In all other environments — including SSR and Node.js —
 * execution falls back to the synchronous path automatically.
 *
 * **SSR-safe** — `useEffect` is skipped during server rendering; the hook
 * returns `{ results: [], loading: false }` on first paint without suspending.
 *
 * **Invalid config** — unlike `useExSearch` (which throws during render), an
 * invalid config here is caught inside the effect and reported through `error`
 * with `results: []`.
 *
 * **Stability** — `config` (keys name/weight and every scalar option) and `data`
 * (element identity) are compared by content, so inline values are safe: a new
 * config literal or `items.filter(...)` array with equal content does not restart
 * the effect. Treat both as immutable: mutating `config.keys` or the data array
 * in place is not detected.
 *
 * @param data - Array of items to search.
 * @param query - Search string. An empty or whitespace-only query returns `[]`
 *   immediately without triggering a loading state.
 * @param config - Search configuration (keys, threshold, fuzzyMaxDistance, …).
 * @returns `{ results, loading, error }` — `loading` is `true` only while an
 *   async Worker search is in flight. When the async path fails the hook falls
 *   back to the synchronous search; `error` is set (and `results` emptied) only
 *   if that fails too. A superseded or unmounted search is aborted (the Worker
 *   is terminated) and never surfaces as an error.
 *
 * @example
 * const config = useMemo(() => ({
 *   keys: [{ name: 'name' as const, weight: 1.0 }],
 *   threshold: 0.3,
 *   useWorker: true,
 * }), []);
 *
 * const { results, loading, error } = useExSearchAsync(branches, query, config);
 */
export function useExSearchAsync<T>(
  data: T[],
  query: string,
  config: SearchConfig<T>,
): { results: SearchResult<T>[]; loading: boolean; error: Error | null } {
  const stableConfig = useStableConfig(config);
  const stableData = useStableData(data);
  const [results, setResults] = useState<SearchResult<T>[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const searcherRef = useRef<ExSearch<T> | null>(null);
  // Identities last pushed into the searcher: re-pushing an unchanged config
  // or dataset would drop the word-mode word index on every keystroke.
  const appliedData = useRef<T[] | null>(null);
  const appliedConfig = useRef<SearchConfig<T> | null>(null);

  useEffect(() => {
    if (!query.trim()) {
      setResults(emptyResults);
      setLoading(false);
      setError(null);
      return;
    }

    const controller = new AbortController();
    let cancelled = false;

    let searcher: ExSearch<T>;
    try {
      if (searcherRef.current === null || appliedConfig.current !== stableConfig) {
        // A new config identity gets a fresh searcher (as useExSearch does) so
        // omitted or undefined fields reset to their defaults, like search().
        searcherRef.current = new ExSearch(stableConfig);
        appliedConfig.current = stableConfig;
        appliedData.current = null;
      }
      searcher = searcherRef.current;
      if (appliedData.current !== stableData) {
        searcher.setData(stableData);
        appliedData.current = stableData;
      }
    } catch (err) {
      // An invalid config must not throw out of the effect: surface it as `error`.
      searcherRef.current = null;
      appliedConfig.current = null;
      appliedData.current = null;
      setResults(emptyResults);
      setError((prev) => sameError(prev, err));
      setLoading(false);
      return;
    }
    setLoading(true);

    searcher
      .searchAsync(query, { signal: controller.signal })
      .then((r) => {
        if (!cancelled) {
          setResults(r);
          setError(null);
          setLoading(false);
        }
      })
      .catch((err: unknown) => {
        if (cancelled || isAbortError(err)) return;
        // The async path failed (Worker runtime error, ...): answer from the
        // synchronous path when possible, otherwise show no results.
        try {
          const r = searcher.search(query);
          setResults(r);
          setError(null);
        } catch (syncErr) {
          setResults(emptyResults);
          setError((prev) => sameError(prev, syncErr));
        }
        setLoading(false);
      });

    return () => {
      cancelled = true;
      controller.abort(); // terminates a superseded or unmounted Worker search
    };
  }, [stableData, query, stableConfig]);

  return { results, loading, error };
}

// Bail-out updaters: returning the previous state skips the re-render, so a
// repeated no-op (empty results, same error message) cannot loop.
function emptyResults<R>(prev: R[]): R[] {
  return prev.length === 0 ? prev : [];
}

function sameError(prev: Error | null, err: unknown): Error {
  const next = toError(err);
  return prev !== null && prev.message === next.message ? prev : next;
}

function isAbortError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { name?: unknown }).name === 'AbortError';
}

function toError(err: unknown): Error {
  if (err instanceof Error) return err;
  const message = typeof err === 'object' && err !== null ? (err as { message?: unknown }).message : undefined;
  return new Error(typeof message === 'string' ? message : String(err));
}
