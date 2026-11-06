import { radixSort, timSort } from 'exsorted';
import type { SearchConfig, SearchResult, SearchOptions } from '../types';
import { createKernel, type KernelConfig, type KernelHit, type TokenSource } from './kernel';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

// radixSort key: score × 1_000_000 → integer, negated for descending order
const SCORE_PRECISION = 1_000_000;
const MAX_KEY = Number.MAX_SAFE_INTEGER;

const kernel = createKernel();

/** Tokenises on demand, without caching — used by the one-shot functional API. */
const tokenizeLive: TokenSource = (_row, _key, text) => kernel.tokenize(text);

function radixKey(score: number): number {
  const key = Math.round((1 - score) * SCORE_PRECISION);
  return key > MAX_KEY ? MAX_KEY : key < -MAX_KEY ? -MAX_KEY : key;
}

function toKernelConfig<T>(cfg: Required<SearchConfig<T>>): KernelConfig {
  return {
    keys: cfg.keys.map((k) => ({ name: String(k.name), weight: k.weight })),
    threshold: cfg.threshold,
    fuzzyMaxDistance: cfg.fuzzyMaxDistance,
    caseSensitive: cfg.caseSensitive,
    fuzzyMode: cfg.fuzzyMode,
  };
}

/** Builds the public result object from the original row and its hit. */
function buildResults<T>(data: T[], hits: KernelHit[], algorithm: 'radix' | 'tim'): SearchResult<T>[] {
  const out: SearchResult<T>[] = [];
  for (let i = 0; i < hits.length; i++) {
    const hit = hits[i];
    // Spread (not Object.assign) so an own "__proto__" key stays a plain property.
    const result = { ...(data[hit.row] as object) } as Record<string, unknown>;
    result.exFlowPriority = Math.round(hit.best);
    result.score = hit.score;
    result.fieldMatches = hit.fieldMatches;
    out.push(result as SearchResult<T>);
  }
  return sortDescending(out, algorithm);
}

function normalise(query: string, caseSensitive: boolean): string {
  const q = query.trim();
  return caseSensitive ? q : q.toLowerCase();
}

function runSearch<T>(
  data: T[],
  query: string,
  cfg: Required<SearchConfig<T>>,
  tokensFor: TokenSource | null,
): SearchResult<T>[] {
  const names = cfg.keys.map((k) => k.name as string | number | symbol);
  const getText = (row: number, key: number): string | null | undefined => {
    const item = data[row] as Record<string | number | symbol, unknown> | null | undefined;
    return item == null ? undefined : kernel.toText(item[names[key]]);
  };
  const hits = kernel.scoreRows(
    getText,
    data.length,
    normalise(query, cfg.caseSensitive),
    toKernelConfig(cfg),
    tokensFor,
  );
  return buildResults(data, hits, cfg.sortAlgorithm);
}

// ---------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------

function sortDescending<T>(results: SearchResult<T>[], algorithm: 'radix' | 'tim'): SearchResult<T>[] {
  if (results.length === 0) return results;

  if (algorithm === 'radix') {
    // radixSort is ascending — negate key to get descending order
    const sorted = radixSort(results, (item) => radixKey(item.score));
    // The integer key rounds to 1e-6, so scores that differ by less than that
    // share a key. Re-order each run of equal keys by exact score (stable).
    let i = 0;
    while (i < sorted.length) {
      const key = radixKey(sorted[i].score);
      let j = i + 1;
      while (j < sorted.length && radixKey(sorted[j].score) === key) j++;
      if (j - i > 1) {
        const run = sorted.slice(i, j).sort((a, b) => b.score - a.score);
        for (let r = 0; r < run.length; r++) sorted[i + r] = run[r];
      }
      i = j;
    }
    return sorted;
  }

  return timSort(results, (a, b) => b.score - a.score);
}

// ---------------------------------------------------------------------------
// Config normalisation
// ---------------------------------------------------------------------------

function normaliseConfig<T>(config: SearchConfig<T>): Required<SearchConfig<T>> {
  if (!Array.isArray(config.keys)) {
    throw new TypeError('ex-search: config.keys must be an array of { name, weight }');
  }
  for (const k of config.keys) {
    if (typeof k.weight !== 'number' || !Number.isFinite(k.weight) || k.weight < 0) {
      throw new RangeError(
        `ex-search: weight for key "${String(k.name)}" must be a finite number >= 0 (received ${String(k.weight)})`,
      );
    }
  }
  if (config.threshold !== undefined && !Number.isFinite(config.threshold)) {
    throw new RangeError(`ex-search: threshold must be a finite number (received ${String(config.threshold)})`);
  }
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
    // An explicit `undefined` means "not provided": it keeps the current value.
    const defined: Partial<SearchConfig<T>> = {};
    for (const key of Object.keys(config) as Array<keyof SearchConfig<T>>) {
      if (config[key] !== undefined) (defined as Record<string, unknown>)[key] = config[key];
    }
    this._config = normaliseConfig({ ...this._config, ...defined });
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
   * the Worker posts back its hits; ranking and result objects are built on
   * the calling thread from the original items, so the output is identical to
   * `search()`. Falls back to synchronous execution when Worker is unavailable
   * (Node.js, SSR) or cannot be started or fed (CSP, Trusted Types, ...).
   *
   * Pass `options.signal` to cancel: the Worker is terminated and the Promise
   * rejects with an `AbortError`.
   */
  async searchAsync(query: string, options?: SearchOptions): Promise<SearchResult<T>[]> {
    const signal = options?.signal;
    throwIfAborted(signal);
    if (!this._config.useWorker || typeof Worker === 'undefined') {
      return this.search(query);
    }
    if (!query.trim()) return [];

    const cfg = this._config;
    const nKeys = cfg.keys.length;
    const data = this._data;
    const names = cfg.keys.map((k) => k.name as string | number | symbol);
    // Only the projected key texts cross the thread boundary, never the rows
    // themselves, so rows holding functions, symbols or getters behave exactly
    // as in the synchronous path.
    const texts: Array<string | null | undefined> = [];
    for (let r = 0; r < data.length; r++) {
      const item = data[r] as Record<string | number | symbol, unknown> | null | undefined;
      for (let k = 0; k < nKeys; k++) {
        texts.push(item == null ? undefined : kernel.toText(item[names[k]]));
      }
    }
    const hits = await runInWorker(
      {
        texts,
        nRows: data.length,
        normQuery: normalise(query, cfg.caseSensitive),
        config: toKernelConfig(cfg),
      },
      signal,
    );
    if (hits === null) return this.search(query); // Worker unusable: same answer, synchronously
    return buildResults(data, hits, cfg.sortAlgorithm);
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
// The worker receives the already-projected key texts (one string per row and
// key, or null / undefined), runs the shared scoring kernel and posts back
// lightweight hits (row index, score, per-field breakdown). The calling thread
// owns result construction and ranking.

interface WorkerPayload {
  texts: Array<string | null | undefined>;
  nRows: number;
  normQuery: string;
  config: KernelConfig;
}

/** One Blob URL per module, created lazily and kept for the page lifetime. */
let workerUrl: string | null = null;

function getWorkerUrl(): string {
  if (workerUrl === null) {
    workerUrl = URL.createObjectURL(new Blob([WORKER_SOURCE], { type: 'application/javascript' }));
  }
  return workerUrl;
}

function abortError(): Error {
  if (typeof DOMException === 'function') return new DOMException('The operation was aborted.', 'AbortError');
  const err = new Error('The operation was aborted.');
  err.name = 'AbortError';
  return err;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortError();
}

/**
 * Runs one search in a fresh Worker. Resolves with the hits, or with `null`
 * when the Worker could not be created or fed (the caller then searches
 * synchronously). Rejects on a Worker runtime error or when `signal` aborts.
 * All teardown goes through one `cleanup()`.
 */
function runInWorker(payload: WorkerPayload, signal: AbortSignal | undefined): Promise<KernelHit[] | null> {
  return new Promise((resolve, reject) => {
    let worker: Worker | null = null;
    let settled = false;

    const cleanup = () => {
      settled = true;
      try {
        signal?.removeEventListener('abort', onAbort);
      } catch {
        // ignore
      }
      if (worker !== null) {
        try {
          worker.onmessage = null;
          worker.onerror = null;
          worker.terminate();
        } catch {
          // ignore
        }
      }
    };
    const onAbort = () => {
      if (settled) return;
      cleanup();
      reject(abortError());
    };

    try {
      worker = new Worker(getWorkerUrl());
      worker.onmessage = (e: MessageEvent<KernelHit[]>) => {
        if (settled) return;
        cleanup();
        resolve(e.data);
      };
      worker.onerror = (e) => {
        if (settled) return;
        cleanup();
        reject(e);
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      worker.postMessage(payload);
    } catch {
      cleanup();
      resolve(null);
    }
  });
}

/**
 * Inlined worker source.
 * Self-contained copy of the scoring logic with no module imports so it
 * runs in an isolated Worker context without a bundler. The `__name` shim
 * keeps it working when a toolchain (esbuild `keepNames`, tsx) injects that
 * helper into the serialised functions.
 */
const WORKER_SOURCE = `
var __name = function (f) { return f; };
(${workerEntry.toString()})(${createKernel.toString()});
`;

/** @internal Exported for tests only. */
export const __WORKER_SOURCE__ = WORKER_SOURCE;

function workerEntry(makeKernel: typeof createKernel) {
  const k = makeKernel();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  self.onmessage = function (e: MessageEvent<any>) {
    const { texts, nRows, normQuery, config } = e.data;
    const nKeys = config.keys.length;
    const tokensFor = config.fuzzyMode === 'word' ? (_r: number, _k: number, text: string) => k.tokenize(text) : null;
    const hits = k.scoreRows(
      (row: number, key: number) => texts[row * nKeys + key],
      nRows,
      normQuery,
      config,
      tokensFor,
    );
    self.postMessage(hits);
  };
}
