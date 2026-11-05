import { useState, useEffect, useRef } from 'react';
import { ExSearch } from '../../core/search';
import type { SearchConfig, SearchResult } from '../../types';

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
 * **Config stability** — wrap `config` in `useMemo` to prevent the effect from
 * restarting on every render when the config object is defined inline.
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
  const [results, setResults] = useState<SearchResult<T>[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const searcherRef = useRef<ExSearch<T> | null>(null);
  // Identities last pushed into the searcher: re-pushing an unchanged config
  // or dataset would drop the word-mode token cache on every keystroke.
  const appliedData = useRef<T[] | null>(null);
  const appliedConfig = useRef<SearchConfig<T> | null>(null);

  useEffect(() => {
    if (!query.trim()) {
      setResults([]);
      setLoading(false);
      setError(null);
      return;
    }

    const controller = new AbortController();
    let cancelled = false;

    if (searcherRef.current === null) {
      searcherRef.current = new ExSearch(config);
      appliedConfig.current = config;
    }
    const searcher = searcherRef.current;
    if (appliedConfig.current !== config) {
      searcher.updateConfig(config);
      appliedConfig.current = config;
    }
    if (appliedData.current !== data) {
      searcher.setData(data);
      appliedData.current = data;
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
          setResults([]);
          setError(toError(syncErr));
        }
        setLoading(false);
      });

    return () => {
      cancelled = true;
      controller.abort(); // terminates a superseded or unmounted Worker search
    };
  }, [data, query, config]);

  return { results, loading, error };
}

function isAbortError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { name?: unknown }).name === 'AbortError';
}

function toError(err: unknown): Error {
  if (err instanceof Error) return err;
  const message = typeof err === 'object' && err !== null ? (err as { message?: unknown }).message : undefined;
  return new Error(typeof message === 'string' ? message : String(err));
}
