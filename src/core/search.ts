import { radixSort, timSort } from 'exsorted';
import type { SearchConfig, SearchResult, FieldMatch } from '../types';
import { Scorer } from './scorer';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

// radixSort key: score × 1_000_000 → integer, negated for descending order
const SCORE_PRECISION = 1_000_000;

function scoreField(
  value: unknown,
  normQuery: string,
  weight: number,
  caseSensitive: boolean,
  fmd: number,
): Pick<FieldMatch, 'matchType' | 'rawScore' | 'fieldScore'> {
  const text = caseSensitive ? String(value ?? '') : String(value ?? '').toLowerCase();

  if (text === normQuery) return { matchType: 'exact', rawScore: 100, fieldScore: 100 * weight };
  if (text.startsWith(normQuery)) return { matchType: 'startsWith', rawScore: 80, fieldScore: 80 * weight };
  if (text.includes(normQuery)) return { matchType: 'contains', rawScore: 65, fieldScore: 65 * weight };

  const dist = Scorer.levenshtein(text, normQuery);
  if (dist <= fmd) {
    const rawScore = (1 - dist / Math.max(text.length, normQuery.length)) * 55;
    return { matchType: 'fuzzy', rawScore, fieldScore: rawScore * weight };
  }

  return { matchType: 'none', rawScore: 0, fieldScore: 0 };
}

function scoreItem<T>(item: T, normQuery: string, config: Required<SearchConfig<T>>): SearchResult<T> | null {
  const fieldMatches: FieldMatch[] = config.keys.map((k) => {
    const { matchType, rawScore, fieldScore } = scoreField(
      item[k.name],
      normQuery,
      k.weight,
      config.caseSensitive,
      config.fuzzyMaxDistance,
    );
    return { key: String(k.name), weight: k.weight, matchType, rawScore, fieldScore };
  });

  const bestFieldScore = Math.max(...fieldMatches.map((f) => f.fieldScore));
  const score = bestFieldScore / 100;

  if (score < config.threshold) return null;

  return {
    ...(item as object),
    exFlowPriority: Math.round(bestFieldScore),
    score,
    fieldMatches,
  } as SearchResult<T>;
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
  };
}

// ---------------------------------------------------------------------------
// Functional API
// ---------------------------------------------------------------------------

export function search<T>(data: T[], query: string, config: SearchConfig<T>): SearchResult<T>[] {
  if (!query.trim()) return [];

  const cfg = normaliseConfig(config);
  const normQuery = cfg.caseSensitive ? query : query.toLowerCase();
  const scored: SearchResult<T>[] = [];

  for (const item of data) {
    const result = scoreItem(item, normQuery, cfg);
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
(${workerEntry.toString()})();
`;

function workerEntry() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  self.onmessage = function (e: MessageEvent<any>) {
    const { data, normQuery, config } = e.data;

    // Myers bit-parallel Levenshtein — two-variable Pv/Mv form
    function levenshtein(a: string, b: string): number {
      if (a === b) return 0;
      if (!a.length) return b.length;
      if (!b.length) return a.length;
      if (a.length > b.length) {
        const t = a;
        a = b;
        b = t;
      }
      const m = a.length;
      const peq = new Map<string, number>();
      for (let i = 0; i < m; i++) peq.set(a[i], (peq.get(a[i]) ?? 0) | (1 << i));
      let Pv = (1 << m) - 1,
        Mv = 0,
        score = m;
      for (let j = 0; j < b.length; j++) {
        const Eq = peq.get(b[j]) ?? 0;
        const Xv = Eq | Mv;
        const Xh = (((Eq & Pv) + Pv) ^ Pv) | Eq;
        let Ph = Mv | ~(Xh | Pv);
        let Mh = Pv & Xh;
        if ((Ph >>> (m - 1)) & 1) score++;
        if ((Mh >>> (m - 1)) & 1) score--;
        Ph = ((Ph << 1) | 1) >>> 0;
        Mh = (Mh << 1) >>> 0;
        Pv = (Mh | ~(Xv | Ph)) >>> 0;
        Mv = (Ph & Xv) >>> 0;
      }
      return score;
    }

    function scoreField(value: unknown, normQuery: string, weight: number, cs: boolean, fmd: number) {
      const text = cs ? String(value ?? '') : String(value ?? '').toLowerCase();
      if (text === normQuery) return { matchType: 'exact', rawScore: 100, fieldScore: 100 * weight };
      if (text.startsWith(normQuery)) return { matchType: 'startsWith', rawScore: 80, fieldScore: 80 * weight };
      if (text.includes(normQuery)) return { matchType: 'contains', rawScore: 65, fieldScore: 65 * weight };
      const dist = levenshtein(text, normQuery);
      if (dist <= fmd) {
        const raw = (1 - dist / Math.max(text.length, normQuery.length)) * 55;
        return { matchType: 'fuzzy', rawScore: raw, fieldScore: raw * weight };
      }
      return { matchType: 'none', rawScore: 0, fieldScore: 0 };
    }

    const results: unknown[] = [];
    for (const item of data) {
      const fieldMatches = config.keys.map((k: { name: string; weight: number }) => {
        const { matchType, rawScore, fieldScore } = scoreField(
          (item as Record<string, unknown>)[k.name],
          normQuery,
          k.weight,
          config.caseSensitive,
          config.fuzzyMaxDistance,
        );
        return { key: k.name, weight: k.weight, matchType, rawScore, fieldScore };
      });
      const bestFieldScore = Math.max(...fieldMatches.map((f: { fieldScore: number }) => f.fieldScore));
      const score = bestFieldScore / 100;
      if (score >= config.threshold) {
        results.push({ ...item, exFlowPriority: Math.round(bestFieldScore), score, fieldMatches });
      }
    }

    results.sort((a: unknown, b: unknown) => (b as { score: number }).score - (a as { score: number }).score);

    self.postMessage(results);
  };
}
