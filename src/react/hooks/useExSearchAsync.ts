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
 * @returns `{ results, loading }` — `loading` is `true` only while an async
 *   Worker search is in flight.
 *
 * @example
 * const config = useMemo(() => ({
 *   keys: [{ name: 'name' as const, weight: 1.0 }],
 *   threshold: 0.3,
 *   useWorker: true,
 * }), []);
 *
 * const { results, loading } = useExSearchAsync(branches, query, config);
 */
export function useExSearchAsync<T>(
  data: T[],
  query: string,
  config: SearchConfig<T>,
): { results: SearchResult<T>[]; loading: boolean } {
  const [results, setResults] = useState<SearchResult<T>[]>([]);
  const [loading, setLoading] = useState(false);
  const searcherRef = useRef<ExSearch<T> | null>(null);

  useEffect(() => {
    if (!query.trim()) {
      setResults([]);
      setLoading(false);
      return;
    }

    let cancelled = false;

    if (searcherRef.current === null) {
      searcherRef.current = new ExSearch(config);
    }
    searcherRef.current.updateConfig(config).setData(data);
    setLoading(true);

    searcherRef.current
      .searchAsync(query)
      .then((r) => {
        if (!cancelled) {
          setResults(r);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [data, query, config]);

  return { results, loading };
}
