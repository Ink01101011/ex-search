import { useMemo } from 'react';
import { ExSearch } from '../../core/search';
import type { SearchConfig, SearchResult } from '../../types';
import { useStableConfig } from './useStableConfig';
import { useStableData } from './useStableData';

/**
 * Synchronous search hook. Runs the full scoring pipeline on every render
 * where `data`, `query`, or `config` changes.
 *
 * **SSR-safe** — `useMemo` executes during server rendering, so results are
 * available on the first paint without a client-side waterfall.
 *
 * **Invalid config** — throws a `TypeError`/`RangeError` during render (catch it
 * with an error boundary). `useExSearchAsync` reports it through `error` instead.
 *
 * **Stability** — `config` (keys name/weight and every scalar option) and `data`
 * (element identity) are compared by content, so inline values are safe: a new
 * config literal or `items.filter(...)` array with equal content does not rebuild
 * the searcher. Treat both as immutable: mutating `config.keys` or the data array
 * in place is not detected.
 *
 * @param data - Array of items to search.
 * @param query - Search string. An empty or whitespace-only query returns `[]`.
 * @param config - Search configuration (keys, threshold, fuzzyMaxDistance, …).
 * @returns Scored and sorted results, or an empty array when the query is blank.
 *
 * @example
 * const config = useMemo(() => ({
 *   keys: [{ name: 'name' as const, weight: 1.0 }],
 *   threshold: 0.3,
 * }), []);
 *
 * const results = useExSearch(branches, query, config);
 */
export function useExSearch<T>(data: T[], query: string, config: SearchConfig<T>): SearchResult<T>[] {
  const stableConfig = useStableConfig(config);
  const stableData = useStableData(data);
  // One searcher per (data, config): in fuzzyMode 'word' its word index then
  // survives query changes instead of being rebuilt for every row per keystroke.
  const searcher = useMemo(() => new ExSearch(stableConfig).setData(stableData), [stableData, stableConfig]);
  return useMemo(() => searcher.search(query), [searcher, query]);
}
