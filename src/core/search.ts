import { radixSort, timSort } from 'exsorted';
import type { SearchConfig, SearchResult } from '../types';
import { createKernel, type KernelConfig, type TokenSource } from './kernel';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

// radixSort key: score × 1_000_000 → integer, negated for descending order
const SCORE_PRECISION = 1_000_000;

const kernel = createKernel();

/** Tokenises on demand, without caching — used by the one-shot functional API. */
const tokenizeLive: TokenSource = (_row, _key, text) => kernel.tokenize(text);

function runSearch<T>(
  data: T[],
  query: string,
  cfg: Required<SearchConfig<T>>,
  tokensFor: TokenSource | null,
): SearchResult<T>[] {
  const normQuery = cfg.caseSensitive ? query : query.toLowerCase();
  const scored = kernel.scoreRows(data, normQuery, cfg as KernelConfig, tokensFor) as SearchResult<T>[];
  return sortDescending(scored, cfg.sortAlgorithm);
}

// ---------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------

function sortDescending<T>(results: SearchResult<T>[], algorithm: 'radix' | 'tim'): SearchResult<T>[] {
  if (results.length === 0) return results;

  if (algorithm === 'radix') {
    // radixSort is ascending — negate key to get descending order
    return radixSort(results, (item) => Math.round((1 - item.score) * SCORE_PRECISION));
  }

  return timSort(results, (a, b) => b.score - a.score);
}

// ---------------------------------------------------------------------------
// Config normalisation
// ---------------------------------------------------------------------------

function normaliseConfig<T>(config: SearchConfig<T>): Required<SearchConfig<T>> {
  return {
    keys: config.keys,
    threshold: config.threshold ?? 0.3,
    fuzzyMaxDistance: config.fuzzyMaxDistance ?? 3,
    caseSensitive: config.caseSensitive ?? false,
    sortAlgorithm: config.sortAlgorithm ?? 'radix',
    useWorker: config.useWorker ?? false,
    fuzzyMode: config.fuzzyMode ?? 'value',
  };
}

// ---------------------------------------------------------------------------
// Functional API
// ---------------------------------------------------------------------------

/**
 * One-shot search over an array of items.
 *
 * Runs the four-tier scoring pipeline (exact → startsWith → contains → fuzzy)
 * on every item, drops results whose score falls below `config.threshold`, and
 * returns the survivors sorted by score descending.
 *
 * Returns an empty array when `query` is blank or whitespace-only.
 *
 * @param data - Array of items to search.
 * @param query - The search string typed by the user.
 * @param config - Field weights, threshold, fuzzy distance, and sort algorithm.
 *
 * @example
 * const results = search(branches, 'สยาม', {
 *   keys: [{ name: 'name', weight: 1.0 }, { name: 'address', weight: 0.5 }],
 *   threshold: 0.3,
 * });
 */
export function search<T>(data: T[], query: string, config: SearchConfig<T>): SearchResult<T>[] {
  if (!query.trim()) return [];

  const cfg = normaliseConfig(config);
  return runSearch(data, query, cfg, cfg.fuzzyMode === 'word' ? tokenizeLive : null);
}

// ---------------------------------------------------------------------------
// Class API
// ---------------------------------------------------------------------------

/**
 * Stateful searcher. Create once, call `search()` or `searchAsync()` as many
 * times as needed without re-allocating the instance.
 *
 * Use `createSearch()` as a factory alternative to `new ExSearch()`.
 *
 * @example
 * const searcher = createSearch<Branch>({
 *   keys: [{ name: 'name', weight: 1.0 }],
 *   threshold: 0.3,
 * });
 * searcher.setData(branches);
 * const results = searcher.search('สยาม');
 */
export class ExSearch<T> {
  private _config: Required<SearchConfig<T>>;
  private _data: T[] = [];
  // Word tokens per (row, key), filled once on first use in fuzzyMode 'word'
  // and dropped whenever the data or the config changes.
  private _tokens: (string[] | undefined)[] | null = null;

  constructor(config: SearchConfig<T>) {
    this._config = normaliseConfig(config);
  }

  /**
   * Replace the entire dataset. Returns `this` for chaining.
   * In `fuzzyMode: 'word'` each value is tokenised once and cached, so call
   * `setData` again after mutating items in place.
   */
  setData(data: T[]): this {
    this._data = data;
    this._tokens = null;
    return this;
  }

  /**
   * Merge a partial config update into the current configuration.
   * Unspecified fields keep their previous value. Returns `this` for chaining.
   */
  updateConfig(config: Partial<SearchConfig<T>>): this {
    this._config = normaliseConfig({ ...this._config, ...config });
    this._tokens = null;
    return this;
  }

  /**
   * Synchronous search. Suitable for datasets up to ~50 000 records in
   * browser environments or any size in Node.js.
   */
  search(query: string): SearchResult<T>[] {
    if (!query.trim()) return [];
    return runSearch(this._data, query, this._config, this._config.fuzzyMode === 'word' ? this._cachedTokens() : null);
  }

  private _cachedTokens(): TokenSource {
    const nKeys = this._config.keys.length;
    if (this._tokens === null) this._tokens = [];
    const cache = this._tokens;
    return (row, key, text) => {
      const i = row * nKeys + key;
      let tokens = cache[i];
      if (tokens === undefined) {
        tokens = kernel.tokenize(text);
        cache[i] = tokens;
      }
      return tokens;
    };
  }

  /**
   * Async search. When `config.useWorker` is `true` and `Worker` is available,
   * scoring runs in a dedicated Worker thread and this Promise resolves once
   * the Worker posts back results. Falls back to synchronous execution
   * otherwise (Node.js, SSR, or when Worker is unavailable).
   */
  async searchAsync(query: string): Promise<SearchResult<T>[]> {
    if (!this._config.useWorker || typeof Worker === 'undefined') {
      return this.search(query);
    }
    return runInWorker(this._data, query, this._config);
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** Factory that returns a pre-configured `ExSearch` instance. Equivalent to `new ExSearch(config)`. */
export function createSearch<T>(config: SearchConfig<T>): ExSearch<T> {
  return new ExSearch(config);
}

// ---------------------------------------------------------------------------
// Web Worker bridge
// ---------------------------------------------------------------------------
// The worker receives a serialised payload, runs the scoring pipeline,
// and posts back the results. Only plain-serialisable data crosses the
// boundary (scores, fieldMatches, and the original item properties).
//
// normQuery is pre-normalised by the caller so the worker does not need
// to re-apply case normalisation to the query on every item.

function runInWorker<T>(data: T[], query: string, config: Required<SearchConfig<T>>): Promise<SearchResult<T>[]> {
  return new Promise((resolve, reject) => {
    const blob = new Blob([WORKER_SOURCE], { type: 'application/javascript' });
    const url = URL.createObjectURL(blob);
    const worker = new Worker(url);

    worker.onmessage = (e: MessageEvent<SearchResult<T>[]>) => {
      URL.revokeObjectURL(url);
      worker.terminate();
      resolve(e.data);
    };

    worker.onerror = (e) => {
      URL.revokeObjectURL(url);
      worker.terminate();
      reject(e);
    };

    const normQuery = config.caseSensitive ? query : query.toLowerCase();
    worker.postMessage({ data, normQuery, config });
  });
}

/**
 * Inlined worker source.
 * Self-contained copy of the scoring logic with no module imports so it
 * runs in an isolated Worker context without a bundler.
 */
const WORKER_SOURCE = `
(${workerEntry.toString()})(${createKernel.toString()});
`;

/** @internal Exported for tests only. */
export const __WORKER_SOURCE__ = WORKER_SOURCE;

function workerEntry(makeKernel: typeof createKernel) {
  const k = makeKernel();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  self.onmessage = function (e: MessageEvent<any>) {
    const { data, normQuery, config } = e.data;
    const tokensFor = config.fuzzyMode === 'word' ? (_r: number, _k: number, text: string) => k.tokenize(text) : null;
    const results = k.scoreRows(data, normQuery, config, tokensFor);
    results.sort((a, b) => (b.score as number) - (a.score as number));
    self.postMessage(results);
  };
}
