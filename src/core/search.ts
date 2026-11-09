import { radixSort, timSort } from 'exsorted';
import type { SearchConfig, SearchResult, SearchWithinOptions, SearchWithRows } from '../types';
import { createKernel, type KernelConfig, type WordIndex } from './kernel';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

// radixSort key: score × 1_000_000 → integer, negated for descending order
const SCORE_PRECISION = 1_000_000;

const kernel = createKernel();

function normalise(query: string, caseSensitive: boolean): string {
  return caseSensitive ? query : query.toLowerCase();
}

function runSearch<T>(
  data: T[],
  query: string,
  cfg: Required<SearchConfig<T>>,
  words: WordIndex | null,
  rows: Uint32Array | null,
): SearchResult<T>[] {
  const normQuery = normalise(query, cfg.caseSensitive);
  const scored = kernel.scoreRows(data, normQuery, cfg as KernelConfig, words, rows) as SearchResult<T>[];
  return sortDescending(scored, cfg.sortAlgorithm);
}

/**
 * `runSearch` that also tracks the data index of each result. The results are
 * ranked with the same algorithm and keys as `runSearch`, through index
 * wrappers, so `results` is in the same order `runSearch` gives.
 */
function runSearchWithRows<T>(
  data: T[],
  query: string,
  cfg: Required<SearchConfig<T>>,
  words: WordIndex | null,
  rows: Uint32Array | null,
): SearchWithRows<T> {
  const normQuery = normalise(query, cfg.caseSensitive);
  const found: number[] = [];
  const scored = kernel.scoreRows(data, normQuery, cfg as KernelConfig, words, rows, found) as SearchResult<T>[];
  const order = sortDescending(
    scored.map((r, i) => ({ score: r.score, i })),
    cfg.sortAlgorithm,
  );
  const results: SearchResult<T>[] = [];
  const out = new Uint32Array(order.length);
  for (let j = 0; j < order.length; j++) {
    results.push(scored[order[j].i]);
    out[j] = found[order[j].i];
  }
  return { results, rows: out };
}

const NO_HITS = <T>(): SearchWithRows<T> => ({ results: [], rows: new Uint32Array(0) });

/**
 * Normalises a `within` subset to ascending, unique, in-range row indices.
 * Entries that are not an integer row index of `data` are ignored. Returns
 * `null` when no subset was given (score every row). Throws a `TypeError` when
 * `length` is not a number in `[0, 2^32 - 1]`. `length` is read once and every
 * element at most once.
 */
function toRows(within: ArrayLike<number> | null | undefined, nRows: number): Uint32Array | null {
  if (within == null) return null;
  // `length` is read once; every element is read exactly once, validated and
  // copied in the same pass, so a getter or Proxy cannot change what is used.
  const n = within.length;
  if (typeof n !== 'number' || !(n >= 0) || n > 0xffffffff) {
    throw new TypeError('ex-search: options.within must be an array or typed array of row indices');
  }
  let out = new Uint32Array(n < 1024 ? n : 1024);
  let m = 0;
  let ordered = true;
  let prev = -1;
  for (let i = 0; i < n; i++) {
    const r = within[i];
    if (!(Number.isInteger(r) && r >= 0 && r < nRows)) continue;
    if (m === out.length) {
      const bigger = new Uint32Array(m * 2);
      bigger.set(out);
      out = bigger;
    }
    if (r <= prev) ordered = false;
    prev = r;
    out[m++] = r;
  }
  if (ordered) return out.subarray(0, m);

  const sorted = out.subarray(0, m).sort();
  let u = 0;
  for (let i = 0; i < m; i++) if (u === 0 || sorted[u - 1] !== sorted[i]) sorted[u++] = sorted[i];
  return sorted.subarray(0, u);
}

// ---------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------

function sortDescending<H extends { score: number }>(results: H[], algorithm: 'radix' | 'tim'): H[] {
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
 * @param options - `within`: score only these row indices (see `SearchWithinOptions`).
 *
 * @example
 * const results = search(branches, 'สยาม', {
 *   keys: [{ name: 'name', weight: 1.0 }, { name: 'address', weight: 0.5 }],
 *   threshold: 0.3,
 * });
 */
export function search<T>(
  data: T[],
  query: string,
  config: SearchConfig<T>,
  options?: SearchWithinOptions,
): SearchResult<T>[] {
  const rows = toRows(options?.within, data.length);
  if (!query.trim()) return [];

  const cfg = normaliseConfig(config);
  return runSearch(data, query, cfg, null, rows);
}

/**
 * `search()` that also returns where each result came from: `rows[i]` is the
 * index in `data` of `results[i]`. Pass `rows` back as `within` to narrow the
 * next query (when `canNarrow` allows it).
 */
export function searchWithRows<T>(
  data: T[],
  query: string,
  config: SearchConfig<T>,
  options?: SearchWithinOptions,
): SearchWithRows<T> {
  const rows = toRows(options?.within, data.length);
  if (!query.trim()) return NO_HITS();
  return runSearchWithRows(data, query, normaliseConfig(config), null, rows);
}

/**
 * Tells whether searching `nextQuery` only within the hits of `prevQuery`
 * (`search(nextQuery, { within: prevHitRows })`) is guaranteed to return
 * exactly what a full search for `nextQuery` returns, under `config`.
 *
 * Returns `true` only when that is provable:
 * - both queries are equal after case folding (when not `caseSensitive`), for
 *   any config; or
 * - the fuzzy tier is off (`fuzzyMaxDistance: 0`), every key weight is a
 *   finite number >= 0, the case-folded `prevQuery` is a substring of the
 *   case-folded `nextQuery`, and no key's weight lets a row pass `threshold`
 *   on `nextQuery` while failing it on `prevQuery` (a field that matches
 *   `nextQuery` exactly / at its start / anywhere scores at least the
 *   starts-with (80) or contains (65) tier on `prevQuery`).
 *
 * With fuzzy matching on, a longer query can match rows the shorter one
 * missed, so the answer is `false`. A blank query on either side also gives
 * `false`. Queries are compared as given (1.x does not trim them).
 */
export function canNarrow<T>(prevQuery: string, nextQuery: string, config: SearchConfig<T>): boolean {
  return narrowable(prevQuery, nextQuery, normaliseConfig(config));
}

function narrowable<T>(prevQuery: string, nextQuery: string, cfg: Required<SearchConfig<T>>): boolean {
  if (!prevQuery.trim() || !nextQuery.trim()) return false;
  const p = normalise(prevQuery, cfg.caseSensitive);
  const n = normalise(nextQuery, cfg.caseSensitive);
  if (p === n) return true;
  if (cfg.fuzzyMaxDistance > 0) return false;

  // Lowest raw score a field can get on `p` when it matches `n` at all.
  const floor = n.startsWith(p) ? 80 : n.includes(p) ? 65 : -1;
  if (floor < 0) return false;

  // A field scoring S on `n` scores at least min(S, floor) on `p` (S = 0 for
  // no match). Same arithmetic as the kernel: fieldScore = raw × weight, then
  // the row passes when max(fieldScore) / 100 >= threshold.
  const t = cfg.threshold;
  for (const key of cfg.keys) {
    const w = key.weight;
    if (!(typeof w === 'number' && Number.isFinite(w) && w >= 0)) return false;
    for (const tier of [100, 80, 65, 0]) {
      const passesNext = !((tier * w) / 100 < t);
      const passesPrev = !(((tier < floor ? tier : floor) * w) / 100 < t);
      if (passesNext && !passesPrev) return false;
    }
  }
  return true;
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
  // Word index of every (row, key), built on the first search in fuzzyMode
  // 'word' and dropped whenever the data or the config changes.
  private _words: WordIndex | null = null;

  constructor(config: SearchConfig<T>) {
    this._config = normaliseConfig(config);
  }

  /**
   * Replace the entire dataset. Returns `this` for chaining.
   * In `fuzzyMode: 'word'` each value is split into words once and the word
   * offsets are cached, so call `setData` again after mutating items in place.
   */
  setData(data: T[]): this {
    this._data = data;
    this._words = null;
    return this;
  }

  /**
   * Merge a partial config update into the current configuration.
   * Unspecified fields keep their previous value. Returns `this` for chaining.
   */
  updateConfig(config: Partial<SearchConfig<T>>): this {
    this._config = normaliseConfig({ ...this._config, ...config });
    this._words = null;
    return this;
  }

  /**
   * Synchronous search. Suitable for datasets up to ~50 000 records in
   * browser environments or any size in Node.js.
   *
   * Pass `options.within` to score only those row indices (for example the
   * hits of the previous query when `canNarrow` says that is exact).
   */
  search(query: string, options?: SearchWithinOptions): SearchResult<T>[] {
    const rows = toRows(options?.within, this._data.length);
    if (!query.trim()) return [];
    return runSearch(this._data, query, this._config, this._wordIndex(), rows);
  }

  /**
   * `search()` that also returns where each result came from: `rows[i]` is the
   * data index of `results[i]`. Pass `rows` back as `within` to narrow the next
   * query when `canNarrow(prevQuery, nextQuery)` is `true`.
   */
  searchWithRows(query: string, options?: SearchWithinOptions): SearchWithRows<T> {
    const rows = toRows(options?.within, this._data.length);
    if (!query.trim()) return NO_HITS();
    return runSearchWithRows(this._data, query, this._config, this._wordIndex(), rows);
  }

  /**
   * `canNarrow(prevQuery, nextQuery, config)` for this instance's current
   * config: `true` only when `search(nextQuery, { within: <rows of the
   * prevQuery hits> })` provably equals a full `search(nextQuery)`.
   */
  canNarrow(prevQuery: string, nextQuery: string): boolean {
    return narrowable(prevQuery, nextQuery, this._config);
  }

  /** The cached word index in fuzzyMode 'word' (built on first use), else `null`. */
  private _wordIndex(): WordIndex | null {
    const cfg = this._config;
    if (cfg.fuzzyMode !== 'word') return null;
    if (this._words === null) {
      this._words = kernel.buildWordIndex(this._data, cfg.keys as KernelConfig['keys'], cfg.caseSensitive);
    }
    return this._words;
  }

  /**
   * Async search. When `config.useWorker` is `true` and `Worker` is available,
   * scoring runs in a dedicated Worker thread and this Promise resolves once
   * the Worker posts back results. Falls back to synchronous execution
   * otherwise (Node.js, SSR, or when Worker is unavailable).
   *
   * `options.within` works as in `search()`: only those rows are posted.
   */
  async searchAsync(query: string, options?: SearchWithinOptions): Promise<SearchResult<T>[]> {
    if (!this._config.useWorker || typeof Worker === 'undefined') {
      return this.search(query, options);
    }
    const rows = toRows(options?.within, this._data.length);
    const data = rows === null ? this._data : Array.from(rows, (r) => this._data[r]);
    return runInWorker<T, SearchResult<T>[]>(data, query, this._config, false);
  }

  /**
   * `searchAsync()` that also returns the data index of each result, as
   * `searchWithRows()` does. `results` equals what `searchAsync()` gives.
   */
  async searchAsyncWithRows(query: string, options?: SearchWithinOptions): Promise<SearchWithRows<T>> {
    if (!this._config.useWorker || typeof Worker === 'undefined') {
      return this.searchWithRows(query, options);
    }
    const rows = toRows(options?.within, this._data.length);
    const data = rows === null ? this._data : Array.from(rows, (r) => this._data[r]);
    const res = await runInWorker<T, { results: SearchResult<T>[]; rows: number[] }>(data, query, this._config, true);
    const out = new Uint32Array(res.rows.length);
    for (let i = 0; i < out.length; i++) out[i] = rows === null ? res.rows[i] : rows[res.rows[i]];
    return { results: res.results, rows: out };
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

function runInWorker<T, R>(data: T[], query: string, config: Required<SearchConfig<T>>, withRows: boolean): Promise<R> {
  return new Promise((resolve, reject) => {
    const blob = new Blob([WORKER_SOURCE], { type: 'application/javascript' });
    const url = URL.createObjectURL(blob);
    const worker = new Worker(url);

    worker.onmessage = (e: MessageEvent<R>) => {
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
    worker.postMessage({ data, normQuery, config, withRows });
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
    const { data, normQuery, config, withRows } = e.data;
    // Word mode finds words on the fly: each Worker serves a single search.
    if (!withRows) {
      const results = k.scoreRows(data, normQuery, config, null);
      results.sort((a, b) => (b.score as number) - (a.score as number));
      self.postMessage(results);
      return;
    }
    // Same ranking as above (stable sort on score), applied to the row indices too.
    const found: number[] = [];
    const scored = k.scoreRows(data, normQuery, config, null, null, found);
    const order = scored.map((_r, i) => i);
    order.sort((a, b) => (scored[b].score as number) - (scored[a].score as number));
    self.postMessage({ results: order.map((i) => scored[i]), rows: order.map((i) => found[i]) });
  };
}
