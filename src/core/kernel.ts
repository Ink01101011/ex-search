import type { MatchType } from '../types';

/** A row-level field reader: returns the (already case-normalised) text of key `k` for row `r`. */
export type TokenSource = (row: number, key: number, text: string) => string[];

export interface KernelKey {
  name: string | number | symbol;
  weight: number;
}

export interface KernelConfig {
  keys: KernelKey[];
  threshold: number;
  fuzzyMaxDistance: number;
  caseSensitive: boolean;
  fuzzyMode: 'value' | 'word';
}

/**
 * Scoring kernel shared by the main thread and the Web Worker.
 *
 * IMPORTANT: this function must stay self-contained — no imports, no
 * references to anything declared outside its body, and no type-only
 * constructs that emit runtime code. Its source text (`createKernel.toString()`)
 * is embedded verbatim into the Worker so both threads run the same code.
 */
export function createKernel() {
  // JS bitwise operators work on 32-bit integers, so one Myers block covers a
  // pattern of at most 32 characters.
  const WORD = 32;

  // Reusable DP rows for the banded fallback. The kernel is synchronous, so a
  // single pair per kernel instance is safe.
  let rowA = new Int32Array(64);
  let rowB = new Int32Array(64);

  /** peq[c] = bitmask of the positions in `pattern` where character c occurs. */
  function buildPeq(pattern: string): Map<string, number> {
    const peq = new Map<string, number>();
    for (let i = 0; i < pattern.length; i++) {
      const c = pattern[i];
      peq.set(c, (peq.get(c) ?? 0) | (1 << i));
    }
    return peq;
  }

  /**
   * Myers (1999) bit-parallel global edit distance between a pattern of length
   * `m` (1 ≤ m ≤ 32, encoded in `peq`) and `text` of any length.
   */
  function myers(peq: Map<string, number>, m: number, text: string): number {
    let Pv = m === WORD ? 0xffffffff : (1 << m) - 1;
    let Mv = 0;
    let score = m;
    const last = m - 1;

    for (let j = 0; j < text.length; j++) {
      const Eq = peq.get(text[j]) ?? 0;
      const Xv = Eq | Mv;
      const Xh = (((Eq & Pv) + Pv) ^ Pv) | Eq;

      let Ph = Mv | ~(Xh | Pv);
      let Mh = Pv & Xh;

      if ((Ph >>> last) & 1) score++;
      if ((Mh >>> last) & 1) score--;

      Ph = ((Ph << 1) | 1) >>> 0;
      Mh = (Mh << 1) >>> 0;

      Pv = (Mh | ~(Xv | Ph)) >>> 0;
      Mv = (Ph & Xv) >>> 0;
    }

    return score;
  }

  /**
   * Ukkonen-banded Levenshtein DP. Returns the exact distance when it is
   * ≤ `max`, otherwise `max + 1`. Runs in O(min(|a|,|b|) · max) and stops as
   * soon as every cell in a row exceeds `max`. Works for any string length.
   */
  function banded(a: string, b: string, max: number): number {
    if (a.length > b.length) {
      const t = a;
      a = b;
      b = t;
    }
    const n = a.length;
    const m = b.length;
    // A distance never exceeds the longer length; capping keeps INF finite so
    // it fits in an Int32Array even when `max` is Infinity.
    const cap = Math.min(max, m);
    const INF = cap + 1;
    if (m - n > cap) return INF;

    if (rowA.length < m + 1) {
      rowA = new Int32Array(m + 1);
      rowB = new Int32Array(m + 1);
    }
    let prev = rowA;
    let cur = rowB;

    for (let j = 0; j <= m; j++) prev[j] = j <= cap ? j : INF;

    for (let i = 1; i <= n; i++) {
      const lo = i - cap > 1 ? i - cap : 1;
      const hi = i + cap < m ? i + cap : m;
      let rowMin = INF;

      // Left edge of the band: D[i][0] = i when inside the band, else INF.
      const left = lo === 1 ? (i <= cap ? i : INF) : INF;
      cur[lo - 1] = left;
      if (left < rowMin) rowMin = left;

      const ca = a.charCodeAt(i - 1);
      for (let j = lo; j <= hi; j++) {
        let v = prev[j - 1] + (ca === b.charCodeAt(j - 1) ? 0 : 1);
        const up = prev[j] + 1;
        if (up < v) v = up;
        const lf = cur[j - 1] + 1;
        if (lf < v) v = lf;
        if (v > INF) v = INF;
        cur[j] = v;
        if (v < rowMin) rowMin = v;
      }
      // The next row reads prev[hi + 1]; it lies outside this band.
      if (hi < m) cur[hi + 1] = INF;

      if (rowMin > cap) return INF;
      const t = prev;
      prev = cur;
      cur = t;
    }

    return prev[m];
  }

  /** Exact Levenshtein distance for strings of any length. */
  function levenshtein(a: string, b: string): number {
    if (a === b) return 0;
    if (a.length === 0) return b.length;
    if (b.length === 0) return a.length;
    if (a.length > b.length) {
      const t = a;
      a = b;
      b = t;
    }
    if (a.length <= WORD) return myers(buildPeq(a), a.length, b);
    return banded(a, b, b.length);
  }

  /**
   * Returns the Levenshtein distance when it is ≤ `max`, otherwise `max + 1`
   * (or any value greater than `max`). Rejects on length difference alone
   * before running any distance algorithm.
   */
  function boundedDistance(a: string, b: string, max: number): number {
    if (!(max >= 0)) return Infinity;
    const diff = a.length > b.length ? a.length - b.length : b.length - a.length;
    if (diff > max) return diff;
    if (a === b) return 0;
    if (a.length <= WORD || b.length <= WORD) return levenshtein(a, b);
    return banded(a, b, max);
  }

  /**
   * Builds a per-query matcher. The query's bitmask table is built once and
   * reused for every text it is compared against.
   * The returned function gives the distance when it is ≤ `max`, else a value > `max`.
   */
  function createMatcher(query: string, max: number): (text: string) => number {
    const q = query.length;
    if (!(max >= 0)) return () => Infinity;
    if (q === 0) return (text) => text.length;
    if (q <= WORD) {
      const peq = buildPeq(query);
      return (text) => {
        const diff = text.length > q ? text.length - q : q - text.length;
        if (diff > max) return diff;
        if (text.length === 0) return q;
        return myers(peq, q, text);
      };
    }
    return (text) => {
      const diff = text.length > q ? text.length - q : q - text.length;
      if (diff > max) return diff;
      return banded(query, text, max);
    };
  }

  /** Splits a value into whitespace-separated words. */
  function tokenize(text: string): string[] {
    const out: string[] = [];
    const parts = text.split(/\s+/);
    for (let i = 0; i < parts.length; i++) if (parts[i]) out.push(parts[i]);
    return out;
  }

  const MATCH_EXACT: MatchType = 'exact';
  const MATCH_STARTS: MatchType = 'startsWith';
  const MATCH_CONTAINS: MatchType = 'contains';
  const MATCH_FUZZY: MatchType = 'fuzzy';
  const MATCH_NONE: MatchType = 'none';

  /**
   * Runs the four-tier pipeline over `data` and returns the unsorted survivors.
   * Rows that fall below the threshold allocate nothing.
   */
  function scoreRows<T>(
    data: T[],
    normQuery: string,
    config: KernelConfig,
    tokensFor: TokenSource | null,
  ): Array<Record<string, unknown>> {
    const keys = config.keys;
    const nKeys = keys.length;
    const cs = config.caseSensitive;
    const max = config.fuzzyMaxDistance;
    const threshold = config.threshold;
    const wordMode = config.fuzzyMode === 'word';
    const qLen = normQuery.length;
    const match = createMatcher(normQuery, max);

    const types: MatchType[] = [];
    const raws = new Float64Array(nKeys);
    const results: Array<Record<string, unknown>> = [];

    for (let r = 0; r < data.length; r++) {
      const item = data[r] as Record<string | number | symbol, unknown>;
      let best = -Infinity;

      for (let k = 0; k < nKeys; k++) {
        const value = item[keys[k].name];
        const raw = String(value ?? '');
        const text = cs ? raw : raw.toLowerCase();
        let type = MATCH_NONE;
        let score = 0;

        if (text === normQuery) {
          type = MATCH_EXACT;
          score = 100;
        } else if (text.startsWith(normQuery)) {
          type = MATCH_STARTS;
          score = 80;
        } else if (text.includes(normQuery)) {
          type = MATCH_CONTAINS;
          score = 65;
        } else {
          const d = match(text);
          if (d <= max) {
            type = MATCH_FUZZY;
            score = (1 - d / (text.length > qLen ? text.length : qLen)) * 55;
          }
          if (wordMode && tokensFor !== null) {
            const tokens = tokensFor(r, k, text);
            // A single token equal to the whole value was already scored above.
            const start = tokens.length === 1 && tokens[0] === text ? 1 : 0;
            for (let t = start; t < tokens.length; t++) {
              const tok = tokens[t];
              const td = match(tok);
              if (td <= max) {
                const s = (1 - td / (tok.length > qLen ? tok.length : qLen)) * 55;
                if (s > score) {
                  type = MATCH_FUZZY;
                  score = s;
                }
              }
            }
          }
        }

        types[k] = type;
        raws[k] = score;
        const fieldScore = score * keys[k].weight;
        if (fieldScore > best) best = fieldScore;
      }

      const total = best / 100;
      if (total < threshold) continue;

      const fieldMatches: Array<Record<string, unknown>> = [];
      for (let k = 0; k < nKeys; k++) {
        fieldMatches.push({
          key: String(keys[k].name),
          weight: keys[k].weight,
          matchType: types[k],
          rawScore: raws[k],
          fieldScore: raws[k] * keys[k].weight,
        });
      }

      const out: Record<string, unknown> = Object.assign({}, item);
      out.exFlowPriority = Math.round(best);
      out.score = total;
      out.fieldMatches = fieldMatches;
      results.push(out);
    }

    return results;
  }

  return { levenshtein, boundedDistance, createMatcher, tokenize, scoreRows };
}

export type Kernel = ReturnType<typeof createKernel>;
