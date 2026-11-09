import type { MatchType } from '../types';

/**
 * Compact word index for `fuzzyMode: 'word'`, built once per data version.
 * Words are stored as offsets into each cell's case-normalised text, never as
 * substrings. A cell is `row * nKeys + key`. Cells whose only word is the whole
 * value are left out (the whole value is already scored by the fuzzy tier).
 */
export interface WordIndex {
  /** Ascending ids of the cells that have at least one indexed word. */
  cells: Uint32Array;
  /** Words of `cells[i]` are words `starts[i]` (inclusive) to `starts[i + 1]` (exclusive). */
  starts: Uint32Array;
  /** Flat `[start, end)` offset pairs: word `w` is `text.slice(spans[2w], spans[2w + 1])`. */
  spans: Uint16Array | Uint32Array;
}

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
  function myers(peq: Map<string, number>, m: number, text: string, from: number, to: number): number {
    let Pv = m === WORD ? 0xffffffff : (1 << m) - 1;
    let Mv = 0;
    let score = m;
    const last = m - 1;

    for (let j = from; j < to; j++) {
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
    if (a.length <= WORD) return myers(buildPeq(a), a.length, b, 0, b.length);
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
   * `match(text, from, to)` compares the query with `text.slice(from, to)`
   * (the whole text by default) and gives the distance when it is ≤ `max`,
   * else a value > `max`.
   */
  function createMatcher(query: string, max: number): (text: string, from?: number, to?: number) => number {
    const q = query.length;
    if (!(max >= 0)) return () => Infinity;
    if (q === 0) return (text, from = 0, to = text.length) => to - from;
    if (q <= WORD) {
      const peq = buildPeq(query);
      return (text, from = 0, to = text.length) => {
        const len = to - from;
        const diff = len > q ? len - q : q - len;
        if (diff > max) return diff;
        if (len === 0) return q;
        return myers(peq, q, text, from, to);
      };
    }
    return (text, from = 0, to = text.length) => {
      const len = to - from;
      const diff = len > q ? len - q : q - len;
      if (diff > max) return diff;
      return banded(query, from === 0 && to === text.length ? text : text.slice(from, to), max);
    };
  }

  /** Splits a value into whitespace-separated words. */
  function tokenize(text: string): string[] {
    const out: string[] = [];
    const parts = text.split(/\s+/);
    for (let i = 0; i < parts.length; i++) if (parts[i]) out.push(parts[i]);
    return out;
  }

  // Maximal runs of non-whitespace: the same words `tokenize` returns.
  const WORD_RE = /\S+/g;

  /**
   * Appends the `[start, end)` offsets of the words of `text` to `out` and
   * returns how many it appended. A text whose only word is the whole text
   * appends nothing: that word is the value itself, scored separately.
   */
  function wordSpans(text: string, out: number[]): number {
    const base = out.length;
    WORD_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = WORD_RE.exec(text)) !== null) out.push(m.index, WORD_RE.lastIndex);
    if (out.length - base === 2 && out[base] === 0 && out[base + 1] === text.length) out.length = base;
    return (out.length - base) / 2;
  }

  /**
   * Builds the word index of every (row, key) cell of `data`. Texts are derived
   * and case-normalised exactly as `scoreRows` derives them. Offsets are stored
   * as 16-bit integers when every text fits, else 32-bit.
   */
  function buildWordIndex<T>(data: T[], keys: KernelKey[], caseSensitive: boolean): WordIndex {
    const nKeys = keys.length;
    let cells = new Uint32Array(64);
    let starts = new Uint32Array(65);
    let spans = new Uint32Array(128);
    let nCells = 0;
    let nSpans = 0;
    let maxLen = 0;
    const scratch: number[] = [];

    for (let r = 0; r < data.length; r++) {
      const item = data[r] as Record<string | number | symbol, unknown>;
      for (let k = 0; k < nKeys; k++) {
        const raw = String(item[keys[k].name] ?? '');
        const text = caseSensitive ? raw : raw.toLowerCase();
        scratch.length = 0;
        if (wordSpans(text, scratch) === 0) continue;

        if (nCells + 1 >= cells.length) {
          cells = grow(cells, cells.length * 2);
          starts = grow(starts, cells.length + 1);
        }
        if (nSpans + scratch.length > spans.length) {
          spans = grow(spans, Math.max(spans.length * 2, nSpans + scratch.length));
        }
        for (let i = 0; i < scratch.length; i++) spans[nSpans + i] = scratch[i];
        nSpans += scratch.length;
        cells[nCells++] = r * nKeys + k;
        starts[nCells] = nSpans / 2;
        if (text.length > maxLen) maxLen = text.length;
      }
    }

    return {
      cells: cells.slice(0, nCells),
      starts: starts.slice(0, nCells + 1),
      spans: maxLen <= 0xffff ? Uint16Array.from(spans.subarray(0, nSpans)) : spans.slice(0, nSpans),
    };
  }

  function grow(a: Uint32Array, size: number): Uint32Array<ArrayBuffer> {
    const b = new Uint32Array(size);
    b.set(a);
    return b;
  }

  const MATCH_EXACT: MatchType = 'exact';
  const MATCH_STARTS: MatchType = 'startsWith';
  const MATCH_CONTAINS: MatchType = 'contains';
  const MATCH_FUZZY: MatchType = 'fuzzy';
  const MATCH_NONE: MatchType = 'none';

  /**
   * Runs the four-tier pipeline over `data` and returns the unsorted survivors.
   * Rows that fall below the threshold allocate nothing.
   *
   * In `fuzzyMode: 'word'` the words come from `words` (built by
   * `buildWordIndex` over the same data and keys) or, when it is `null`, are
   * found on the fly. `rows`, when given, lists the only row indices to score
   * (ascending, unique, each `< data.length`). `rowsOut`, when given, receives
   * the data index of each returned result, in the same order.
   */
  function scoreRows<T>(
    data: T[],
    normQuery: string,
    config: KernelConfig,
    words: WordIndex | null,
    rows?: ArrayLike<number> | null,
    rowsOut?: number[] | null,
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
    const live: number[] = [];
    /** Fuzzy score of a word at distance `d` (0 when beyond `max`). */
    const wordScore = (d: number, len: number): number => (d <= max ? (1 - d / (len > qLen ? len : qLen)) * 55 : 0);
    // Position in `words.cells`; cells are visited in ascending order.
    let cursor = 0;
    const count = rows == null ? data.length : rows.length;

    for (let i = 0; i < count; i++) {
      const r = rows == null ? i : rows[i];
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
          if (wordMode) {
            let ws = 0;
            if (words === null) {
              live.length = 0;
              const n = wordSpans(text, live);
              for (let w = 0; w < n; w++) {
                const s = wordScore(match(text, live[2 * w], live[2 * w + 1]), live[2 * w + 1] - live[2 * w]);
                if (s > ws) ws = s;
              }
            } else {
              // Lower bound of this cell in the ascending `cells`: rows are
              // visited in ascending order, so it is usually at or just past
              // `cursor`; fall back to a binary search after a short walk.
              const cell = r * nKeys + k;
              const cells = words.cells;
              const nc = cells.length;
              let lo = cursor === 0 || (cursor <= nc && cells[cursor - 1] < cell) ? cursor : 0;
              for (let step = 0; step < 4 && lo < nc && cells[lo] < cell; step++) lo++;
              if (lo < nc && cells[lo] < cell) {
                let hi = nc;
                while (lo < hi) {
                  const mid = (lo + hi) >>> 1;
                  if (cells[mid] < cell) lo = mid + 1;
                  else hi = mid;
                }
              }
              cursor = lo;
              if (lo < nc && cells[lo] === cell) {
                const spans = words.spans;
                const to = words.starts[lo + 1];
                for (let w = words.starts[lo]; w < to; w++) {
                  const s = wordScore(match(text, spans[2 * w], spans[2 * w + 1]), spans[2 * w + 1] - spans[2 * w]);
                  if (s > ws) ws = s;
                }
              }
            }
            if (ws > score) {
              type = MATCH_FUZZY;
              score = ws;
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
      if (rowsOut != null) rowsOut.push(r);
    }

    return results;
  }

  return { levenshtein, boundedDistance, createMatcher, tokenize, wordSpans, buildWordIndex, scoreRows };
}

export type Kernel = ReturnType<typeof createKernel>;
