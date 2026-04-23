import { radixSort, timSort } from 'exsorted';
import type { SearchConfig, SearchResult, FieldMatch } from './types';
import { Scorer } from './scorer';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const SCORE_PRECISION = 1_000_000; // radixSort key: score × 1_000_000 → integer

/** Score a single field value against the query. */
function scoreField(
  value: unknown,
  query: string,
  weight: number,
  config: Pick<SearchConfig<unknown>, 'caseSensitive' | 'fuzzyMaxDistance'>,
): Pick<FieldMatch, 'matchType' | 'rawScore' | 'fieldScore'> {
  const text = String(value ?? '');
  const cs = config.caseSensitive;
  const fmd = config.fuzzyMaxDistance;

  let rawScore: number;
  let matchType: FieldMatch['matchType'];

  const exact = Scorer.exact(text, query, cs);
  if (exact > 0) {
    rawScore = exact;
    matchType = 'exact';
  } else {
    const sw = Scorer.startsWith(text, query, cs);
    if (sw > 0) {
      rawScore = sw;
      matchType = 'startsWith';
    } else {
      const ct = Scorer.contains(text, query, cs);
      if (ct > 0) {
        rawScore = ct;
        matchType = 'contains';
      } else {
        const fz = Scorer.fuzzy(text, query, fmd, cs);
        if (fz > 0) {
          rawScore = fz;
          matchType = 'fuzzy';
        } else {
          rawScore = 0;
          matchType = 'none';
        }
      }
    }
  }

  return { matchType, rawScore, fieldScore: rawScore * weight };
}

/** Compute a SearchResult for one data item. Returns null if below threshold. */
function scoreItem<T>(
  item: T,
  query: string,
  config: Required<SearchConfig<T>>,
): SearchResult<T> | null {
  const fieldMatches: FieldMatch[] = config.keys.map((k) => {
    const { matchType, rawScore, fieldScore } = scoreField(
      item[k.name],
      query,
      k.weight,
      config,
    );
    return {
      key: String(k.name),
      weight: k.weight,
      matchType,
      rawScore,
      fieldScore,
    };
  });

  const bestFieldScore = Math.max(...fieldMatches.map((f) => f.fieldScore));
  const score = bestFieldScore / 100;

  if (score < config.threshold) return null;

  return {
    ...(item as object),
    // exFlowPriority mirrors the score so results can be piped into ex-flow
    exFlowPriority: Math.round(score * 100),
    score,
    fieldMatches,
  } as SearchResult<T>;
}

// ---------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------

function sortDescending<T>(
  results: SearchResult<T>[],
  algorithm: 'radix' | 'tim',
): SearchResult<T>[] {
  if (results.length === 0) return results;

  if (algorithm === 'radix') {
    // radixSort is ascending — negate key to get descending order
    return radixSort(results, (item) =>
      Math.round((1 - item.score) * SCORE_PRECISION),
    );
  }

  // timSort with comparator — stable, descending
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
  };
}

// ---------------------------------------------------------------------------
// Functional API
// ---------------------------------------------------------------------------

export function search<T>(
  data: T[],
  query: string,
  config: SearchConfig<T>,
): SearchResult<T>[] {
  if (!query.trim()) return [];

  const cfg = normaliseConfig(config);
  const scored: SearchResult<T>[] = [];

  for (const item of data) {
    const result = scoreItem(item, query, cfg);
    if (result !== null) scored.push(result);
  }

  return sortDescending(scored, cfg.sortAlgorithm);
}

// ---------------------------------------------------------------------------
// Class API
// ---------------------------------------------------------------------------

export class ExSearch<T> {
  private _config: Required<SearchConfig<T>>;
  private _data: T[] = [];

  constructor(config: SearchConfig<T>) {
    this._config = normaliseConfig(config);
  }

  setData(data: T[]): this {
    this._data = data;
    return this;
  }

  updateConfig(config: Partial<SearchConfig<T>>): this {
    this._config = normaliseConfig({ ...this._config, ...config });
    return this;
  }

  search(query: string): SearchResult<T>[] {
    return search(this._data, query, this._config);
  }

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

export function createSearch<T>(config: SearchConfig<T>): ExSearch<T> {
  return new ExSearch(config);
}

// ---------------------------------------------------------------------------
// Web Worker bridge
// ---------------------------------------------------------------------------
// The worker receives a serialised payload, runs the scoring pipeline,
// and posts back the results. Only plain-serialisable data crosses the
// boundary (scores, fieldMatches, and the original item properties).

function runInWorker<T>(
  data: T[],
  query: string,
  config: Required<SearchConfig<T>>,
): Promise<SearchResult<T>[]> {
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

    worker.postMessage({ data, query, config });
  });
}

/**
 * Inlined worker source.
 * Contains a self-contained copy of the scoring logic (no module imports)
 * so it runs in an isolated Worker context without a bundler.
 */
const WORKER_SOURCE = `
(${workerEntry.toString()})();
`;

function workerEntry() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  self.onmessage = function (e: MessageEvent<any>) {
    const { data, query, config } = e.data;

    // Inline levenshtein (Myers bitwise)
    function levenshtein(a: string, b: string): number {
      if (a === b) return 0;
      if (!a.length) return b.length;
      if (!b.length) return a.length;
      if (a.length > b.length) { const t = a; a = b; b = t; }
      const m = a.length;
      const pm = new Map<string, number>();
      for (let i = 0; i < m; i++) pm.set(a[i], (pm.get(a[i]) ?? 0) | (1 << i));
      let x = (1 << m) - 1, score = m;
      for (let j = 0; j < b.length; j++) {
        const eq = pm.get(b[j]) ?? 0;
        const xv = x & eq;
        const xh = (((xv + x) & x) | xv) >>> 0;
        const ph = xh | ~(xv | x);
        const mh = x & xv;
        if (ph & (1 << (m - 1))) score++;
        if (mh & (1 << (m - 1))) score--;
        x = ((x << 1) | 1) & ~(((mh << 1) | 1) >>> 0) | (ph << 1) | 1;
        x = x >>> 0;
      }
      return score;
    }

    function norm(s: string, cs: boolean) { return cs ? s : s.toLowerCase(); }

    function scoreField(value: unknown, query: string, weight: number, cs: boolean, fmd: number) {
      const text = String(value ?? '');
      const t = norm(text, cs), q = norm(query, cs);
      if (t === q)           return { matchType: 'exact',      rawScore: 100, fieldScore: 100 * weight };
      if (t.startsWith(q))   return { matchType: 'startsWith', rawScore: 80,  fieldScore: 80 * weight };
      const dist = levenshtein(t, q);
      if (dist <= fmd) {
        const raw = (1 - dist / Math.max(t.length, q.length)) * 70;
        return { matchType: 'fuzzy', rawScore: raw, fieldScore: raw * weight };
      }
      return { matchType: 'none', rawScore: 0, fieldScore: 0 };
    }

    const results: unknown[] = [];
    for (const item of data) {
      const fieldMatches = config.keys.map((k: { name: string; weight: number }) => {
        const { matchType, rawScore, fieldScore } = scoreField(
          (item as Record<string, unknown>)[k.name], query, k.weight, config.caseSensitive, config.fuzzyMaxDistance
        );
        return { key: k.name, weight: k.weight, matchType, rawScore, fieldScore };
      });
      const best = Math.max(...fieldMatches.map((f: { fieldScore: number }) => f.fieldScore));
      const score = best / 100;
      if (score >= config.threshold) {
        results.push({ ...item, exFlowPriority: Math.round(score * 100), score, fieldMatches });
      }
    }

    results.sort((a: unknown, b: unknown) =>
      (b as { score: number }).score - (a as { score: number }).score
    );

    self.postMessage(results);
  };
}
