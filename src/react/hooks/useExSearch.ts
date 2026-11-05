import { useMemo } from 'react';
import { ExSearch } from '../../core/search';
import type { SearchConfig, SearchResult } from '../../types';
import { useStableConfig } from './useStableConfig';

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
 * **Config stability** — `config` is compared by content (keys, weights and
 * every scalar field), so an inline config object is safe: it does not rebuild
 * the searcher. Wrapping it in `useMemo` is optional.
 *
 * @param data - Array of items to search.
 * @param query - Search string. An empty or whitespace-only query returns `[]`.
 * @param inlineConfig - Search configuration (keys, threshold, fuzzyMaxDistance, …).
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
export function useExSearch<T>(data: T[], query: string, inlineConfig: SearchConfig<T>): SearchResult<T>[] {
  const config = useStableConfig(inlineConfig);
  // One searcher per (data, config): in fuzzyMode 'word' its token cache then
  // survives query changes instead of re-tokenising every row per keystroke.
  const searcher = useMemo(() => new ExSearch(config).setData(data), [data, config]);
  return useMemo(() => searcher.search(query), [searcher, query]);
}
