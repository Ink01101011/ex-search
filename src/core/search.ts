import { radixSort, timSort } from 'exsorted';
import type { SearchConfig, SearchResult, SearchOptions, SearchWithinOptions, SearchWithRows } from '../types';
import { createKernel, type ColumnDict, type KernelConfig, type KernelHit, type WordIndex } from './kernel';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

// radixSort key: score × 1_000_000 → integer, negated for descending order
const SCORE_PRECISION = 1_000_000;
const MAX_KEY = Number.MAX_SAFE_INTEGER;

const kernel = createKernel();

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

/**
 * Ranks the hits and builds the public result objects. `items[i]` is the row
 * object of `hits[i]`, so no row is read from the data again. `rows[i]` is the
 * data index of `results[i]`. Hits are ranked (not the result objects), with
 * the same keys, so the order is the one ranking results gives.
 */
function buildResults<T>(items: T[], hits: KernelHit[], algorithm: 'radix' | 'tim'): SearchWithRows<T> {
  // Ranking moves the hits, so while ranked each one carries its place in `items`.
  const n = hits.length;
  const dataRows = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    dataRows[i] = hits[i].row;
    hits[i].row = i;
  }
  const ranked = sortDescending(hits, algorithm);
  const results: SearchResult<T>[] = [];
  const rows = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    const hit = ranked[i];
    // Spread (not Object.assign) so an own "__proto__" key stays a plain property.
    const result = { ...(items[hit.row] as object) } as Record<string, unknown>;
    result.exFlowPriority = Math.round(hit.best);
    result.score = hit.score;
    result.fieldMatches = hit.fieldMatches;
    results.push(result as SearchResult<T>);
    rows[i] = dataRows[hit.row];
  }
  return { results, rows };
}

const NO_HITS = <T>(): SearchWithRows<T> => ({ results: [], rows: new Uint32Array(0) });

function normalise(query: string, caseSensitive: boolean): string {
  const q = query.trim();
  return caseSensitive ? q : q.toLowerCase();
}

type TextGetter = (row: number, key: number) => string | null | undefined;
type Row = Record<string | number | symbol, unknown> | null | undefined;

/**
 * The kernel's view of `data`. The kernel asks for every key of a row before
 * it moves on, so the row is read once and kept: an index read of `data` may
 * not be free (a Proxy, an array-like with getters). `current()` is the row of
 * the last `getText`.
 */
function rowReader<T>(data: T[], cfg: Required<SearchConfig<T>>): { getText: TextGetter; current: () => T } {
  const names = cfg.keys.map((k) => k.name as string | number | symbol);
  let last = -1;
  let item: Row;
  return {
    getText: (row, key) => {
      if (row !== last) {
        last = row;
        item = data[row] as Row;
      }
      return item == null ? undefined : kernel.toText(item[names[key]]);
    },
    current: () => item as T,
  };
}

type Dicts = Array<ColumnDict | null> | null;

// Data smaller than this is scored without dictionaries.
const DICT_MIN_ROWS = 1024;

/**
 * Dictionary-encodes every key whose texts repeat: at most one distinct text
 * per 16 rows (and at most 65,536). A key that goes past that is dropped as
 * soon as it does, so a key of distinct texts costs a fraction of one pass.
 * Reads each row once. Returns `null` when no key qualifies.
 */
function buildDicts<T>(data: T[], cfg: Required<SearchConfig<T>>): Dicts {
  const n = data.length;
  if (n < DICT_MIN_ROWS) return null;
  const names = cfg.keys.map((k) => k.name as string | number | symbol);
  const nKeys = names.length;
  const cap = Math.min(65536, n >>> 4);
  const maps: Array<Map<string | null, number> | null> = [];
  // Ids start as bytes and are widened when a key gets its 257th text.
  const ids: Array<Uint8Array | Uint16Array | null> = [];
  for (let k = 0; k < nKeys; k++) {
    maps.push(new Map());
    ids.push(new Uint8Array(n));
  }
  let live = nKeys;
  for (let r = 0; r < n && live > 0; r++) {
    const item = data[r] as Row;
    if (item == null) continue;
    for (let k = 0; k < nKeys; k++) {
      const map = maps[k];
      if (map === null) continue;
      const text = kernel.toText(item[names[k]]);
      let id = map.get(text);
      if (id === undefined) {
        if (map.size === cap) {
          maps[k] = null;
          ids[k] = null;
          live--;
          continue;
        }
        id = map.size;
        map.set(text, id);
        if (id === 256) {
          const wide = new Uint16Array(n);
          wide.set(ids[k]!);
          ids[k] = wide;
        }
      }
      ids[k]![r] = id;
    }
  }
  if (live === 0) return null;
  return maps.map((map, k) => {
    if (map === null) return null;
    const texts = [...map.keys()];
    return {
      ids: ids[k]!,
      texts,
      state: new Uint8Array(texts.length),
      scores: new Float64Array(texts.length),
      query: null,
      max: 0,
      cs: false,
      mode: '',
    };
  });
}

function runSearch<T>(
  data: T[],
  query: string,
  cfg: Required<SearchConfig<T>>,
  words: WordIndex | null,
  rows: Uint32Array | null,
  dicts: Dicts = null,
): SearchWithRows<T> {
  const reader = rowReader(data, cfg);
  const items: T[] = [];
  const hits = kernel.scoreRows(
    reader.getText,
    data.length,
    normalise(query, cfg.caseSensitive),
    toKernelConfig(cfg),
    words,
    rows,
    () => items.push(reader.current()),
    dicts,
  );
  return buildResults(items, hits, cfg.sortAlgorithm);
}

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
  return searchWithRows(data, query, config, options).results;
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
  // A blank query returns before the config is validated, as search() always has.
  if (!query.trim()) return NO_HITS();
  return runSearch(data, query, normaliseConfig(config), null, rows);
}

/**
 * Tells whether searching `nextQuery` only within the hits of `prevQuery`
 * (`search(nextQuery, { within: prevHitRows })`) is guaranteed to return
 * exactly what a full search for `nextQuery` returns, under `config`.
 *
 * Returns `true` only when that is provable:
 * - both queries normalise (trim, case) to the same string, for any config; or
 * - the fuzzy tier is off (`fuzzyMaxDistance: 0`), the normalised `prevQuery`
 *   is a substring of the normalised `nextQuery`, and no key's weight lets a
 *   row pass `threshold` on `nextQuery` while failing it on `prevQuery`
 *   (a field that matches `nextQuery` exactly / at its start / anywhere scores
 *   at least the starts-with (80) or contains (65) tier on `prevQuery`).
 *
 * With fuzzy matching on, a longer query can match rows the shorter one
 * missed, so the answer is `false`. A blank query on either side also gives
 * `false`.
 */
export function canNarrow<T>(prevQuery: string, nextQuery: string, config: SearchConfig<T>): boolean {
  return narrowable(prevQuery, nextQuery, normaliseConfig(config));
}

function narrowable<T>(prevQuery: string, nextQuery: string, cfg: Required<SearchConfig<T>>): boolean {
  const p = normalise(prevQuery, cfg.caseSensitive);
  const n = normalise(nextQuery, cfg.caseSensitive);
  if (p === '' || n === '') return false;
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
  // `undefined` = not built yet; `null` = built, but the data is too large to index.
  private _words: WordIndex | null | undefined = undefined;
  // Dictionaries of the keys whose texts repeat, built on the first search and
  // dropped with the data or the config. `undefined` = not built yet.
  private _dicts: Dicts | undefined = undefined;

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
    this._words = undefined;
    this._dicts = undefined;
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
    this._words = undefined;
    this._dicts = undefined;
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
    return this.searchWithRows(query, options).results;
  }

  /**
   * `search()` that also returns where each result came from: `rows[i]` is the
   * data index of `results[i]`. Pass `rows` back as `within` to narrow the next
   * query when `canNarrow(prevQuery, nextQuery)` is `true`.
   */
  searchWithRows(query: string, options?: SearchWithinOptions): SearchWithRows<T> {
    const rows = toRows(options?.within, this._data.length);
    if (!query.trim()) return NO_HITS();
    const dicts = this._dictionaries();
    return runSearch(this._data, query, this._config, this._wordIndex(), rows, dicts);
  }

  /**
   * `canNarrow(prevQuery, nextQuery, config)` for this instance's current
   * config: `true` only when `search(nextQuery, { within: <rows of the
   * prevQuery hits> })` provably equals a full `search(nextQuery)`.
   */
  canNarrow(prevQuery: string, nextQuery: string): boolean {
    return narrowable(prevQuery, nextQuery, this._config);
  }

  /** The dictionaries of the keys whose texts repeat (built on first use), or `null` when there are none. */
  private _dictionaries(): Dicts {
    if (this._dicts === undefined) this._dicts = buildDicts(this._data, this._config);
    return this._dicts;
  }

  /** The texts the word index is built from: a key with a dictionary has none (its words are found when a text is scored). */
  private _indexedText(): TextGetter {
    const getText = rowReader(this._data, this._config).getText;
    const dicts = this._dictionaries();
    if (dicts === null) return getText;
    return (row, key) => {
      const text = getText(row, key);
      return dicts[key] !== null && text !== undefined ? null : text;
    };
  }

  /** The cached word index in fuzzyMode 'word' (built on first use), else `null`. */
  private _wordIndex(): WordIndex | null {
    const cfg = this._config;
    if (cfg.fuzzyMode !== 'word' || !(cfg.fuzzyMaxDistance > 0)) return null;
    if (this._words === undefined) {
      this._words = kernel.buildWordIndex(this._indexedText(), this._data.length, cfg.keys.length, cfg.caseSensitive);
    }
    return this._words;
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
    return (await this.searchAsyncWithRows(query, options)).results;
  }

  /** `searchAsync()` that also returns the data index of each result, as `searchWithRows()` does. */
  async searchAsyncWithRows(query: string, options?: SearchOptions): Promise<SearchWithRows<T>> {
    const signal = options?.signal;
    throwIfAborted(signal);
    const within = options?.within === undefined ? undefined : { within: options.within };
    if (!this._config.useWorker || typeof Worker === 'undefined') {
      return this.searchWithRows(query, within);
    }
    const rows = toRows(options?.within, this._data.length);
    if (!query.trim()) return NO_HITS();

    const cfg = this._config;
    const nKeys = cfg.keys.length;
    const data = this._data;
    const names = cfg.keys.map((k) => k.name as string | number | symbol);
    const count = rows === null ? data.length : rows.length;
    // Only the projected key texts cross the thread boundary, never the rows
    // themselves, so rows holding functions, symbols or getters behave exactly
    // as in the synchronous path. With `within`, only those rows are sent.
    // A key with a dictionary sends its distinct texts and one id per row
    // instead of one text per row; a cell that no longer holds the text of
    // its id is sent as a text of its own.
    const dicts = this._dictionaries();
    const texts: Array<string | null | undefined> = [];
    const cols: WorkerPayload['cols'] = [];
    for (let k = 0; k < nKeys; k++) {
      const dict = dicts === null ? null : dicts[k];
      cols.push(dict === null ? null : { ids: new Uint32Array(count), texts: dict.texts });
    }
    const scored: T[] = []; // the rows as read, so results are built without reading them again
    for (let i = 0; i < count; i++) {
      const row = rows === null ? i : rows[i];
      const item = data[row] as Record<string | number | symbol, unknown> | null | undefined;
      scored.push(item as T);
      for (let k = 0; k < nKeys; k++) {
        const col = cols[k];
        if (col === null) {
          texts.push(item == null ? undefined : kernel.toText(item[names[k]]));
        } else if (item == null) {
          col.ids[i] = NO_ROW;
        } else {
          const text = kernel.toText(item[names[k]]);
          const id = dicts![k]!.ids[row];
          if (col.texts[id] === text) col.ids[i] = id;
          else {
            if (col.texts === dicts![k]!.texts) col.texts = col.texts.slice();
            col.ids[i] = col.texts.length;
            col.texts.push(text);
          }
        }
      }
    }
    const hits = await runInWorker(
      {
        texts,
        nRows: count,
        normQuery: normalise(query, cfg.caseSensitive),
        config: toKernelConfig(cfg),
        cols,
      },
      signal,
    );
    if (hits === null) return this.searchWithRows(query, within); // Worker unusable: same answer, synchronously
    // A hit's row counts the rows that were sent: take its row object, then
    // give it its data index.
    const items: T[] = [];
    for (const hit of hits) {
      items.push(scored[hit.row]);
      if (rows !== null) hit.row = rows[hit.row];
    }
    return buildResults(items, hits, cfg.sortAlgorithm);
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
  /** The texts of the keys without a dictionary, row by row. */
  texts: Array<string | null | undefined>;
  nRows: number;
  normQuery: string;
  config: KernelConfig;
  /** Per key: `null`, or its texts and the id of each sent row (`NO_ROW` for a null row). */
  cols: Array<{ ids: Uint32Array; texts: Array<string | null> } | null>;
}

// Id of a row that is `null` or `undefined`: it has no text for any key.
const NO_ROW = 0xffffffff;

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
    const { texts, nRows, normQuery, config, cols } = e.data;
    const nKeys = config.keys.length;
    // `slot[key]` is the place of a key among those sent as texts, or -1.
    const slot: number[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dicts: any[] = [];
    let nPlain = 0;
    for (let key = 0; key < nKeys; key++) {
      const col = cols == null ? null : cols[key]; // no `cols`: every key is sent as texts
      slot.push(col === null ? nPlain++ : -1);
      dicts.push(
        col === null
          ? null
          : {
              ids: col.ids,
              texts: col.texts,
              state: new Uint8Array(col.texts.length),
              scores: new Float64Array(col.texts.length),
              query: null,
              max: 0,
              cs: false,
              mode: '',
            },
      );
    }
    // Word mode finds words on the fly: each Worker serves a single search.
    const hits = k.scoreRows(
      (row: number, key: number) => {
        const dict = dicts[key];
        if (dict === null) return texts[row * nPlain + slot[key]];
        const id = dict.ids[row];
        return id === 0xffffffff ? undefined : dict.texts[id];
      },
      nRows,
      normQuery,
      config,
      null,
      null,
      null,
      dicts,
    );
    self.postMessage(hits);
  };
}
