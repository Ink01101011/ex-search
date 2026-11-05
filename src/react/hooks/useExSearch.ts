import { useMemo } from 'react';
import { ExSearch } from '../../core/search';
import type { SearchConfig, SearchResult } from '../../types';

/**
 * Synchronous search hook. Runs the full scoring pipeline on every render
 * where `data`, `query`, or `config` changes.
 *
 * **SSR-safe** — `useMemo` executes during server rendering, so results are
 * available on the first paint without a client-side waterfall.
 *
 * **Config stability** — wrap `config` in `useMemo` to prevent redundant
 * re-computations when the config object is defined inline in the component.
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
  // One searcher per (data, config): in fuzzyMode 'word' its token cache then
  // survives query changes instead of re-tokenising every row per keystroke.
  const searcher = useMemo(() => new ExSearch(config).setData(data), [data, config]);
  return useMemo(() => searcher.search(query), [searcher, query]);
}
