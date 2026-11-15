import type { MatchType } from '../types';

/**
 * Compact word index for `fuzzyMode: 'word'`, built once per data version.
 * A cell is `row * nKeys + key`. Only the start offset of each word is kept
 * (into the cell's case-normalised text, never a substring); a word ends where
 * the whitespace before the next word begins, which is one code unit before
 * that word unless the entry says otherwise. Cells whose only word is the
 * whole value are left out (the whole value is already scored by the fuzzy
 * tier), so they cost one bit.
 */
export interface WordIndex {
  /** Bit `c & 31` of `bits[c >>> 5]` is set when cell `c` has indexed words. Cells past the end have none. */
  bits: Uint32Array;
  /** `blocks[b]` is the offset in `data` of the entry of the first indexed cell at or after cell `64 * b`. */
  blocks: Uint32Array;
  /**
   * The entries of the indexed cells, in ascending cell order. An entry is a
   * run of LEB128 varints. First `2 * words + t`, where `t` is 1 when
   * whitespace follows the last word. Then the start of the first word. Then,
   * per further word, `2 * gap + s`: `gap` is its start minus the start of the
   * word before it, and `s` is 0 when exactly one whitespace code unit
   * separates the two (so the earlier word ends at `start - 1`), else 1.
   */
  data: Uint8Array;
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

  /** Whether a UTF-16 code unit is `\s`: the WhiteSpace and LineTerminator characters of ECMAScript. */
  function isSpace(c: number): boolean {
    if (c > 32 && c < 0xa0) return false;
    return (
      c === 32 ||
      (c >= 9 && c <= 13) ||
      c === 0xa0 ||
      c === 0x1680 ||
      (c >= 0x2000 && c <= 0x200a) ||
      c === 0x2028 ||
      c === 0x2029 ||
      c === 0x202f ||
      c === 0x205f ||
      c === 0x3000 ||
      c === 0xfeff
    );
  }

  /**
   * Appends the `[start, end)` offsets of the words of `text` to `out` and
   * returns how many it appended. The words are the maximal runs of non-`\s`
   * code units (what `text.split(/\s+/)` returns, minus the empty strings).
   * A text whose only word is the whole text appends nothing: that word is
   * the value itself, scored separately.
   */
  function wordSpans(text: string, out: number[]): number {
    const base = out.length;
    const len = text.length;
    let i = 0;
    while (i < len) {
      while (i < len && isSpace(text.charCodeAt(i))) i++;
      if (i === len) break;
      const start = i;
      while (i < len && !isSpace(text.charCodeAt(i))) i++;
      out.push(start, i);
    }
    if (out.length - base === 2 && out[base] === 0 && out[base + 1] === len) out.length = base;
    return (out.length - base) / 2;
  }

  /**
   * Builds the word index of every (row, key) cell of `data`. Offsets refer to
   * the text as `scoreRows` derives and case-normalises it. A `null` or
   * `undefined` row has no cells (scoring such a row throws, as it always
   * has). The arrays grow by doubling from empty, so the build never holds
   * more than about three times what it returns.
   * Returns `null` when the index cannot be used: the cell ids
   * (`row * nKeys + key`) or the entry offsets do not fit in 32 bits, or
   * nearly every row is missing (a sparse array), where a bit per cell would
   * cost more than the words. The caller then scores without an index, which
   * finds the same words on the fly.
   */
  function buildWordIndex<T>(data: T[], keys: KernelKey[], caseSensitive: boolean): WordIndex | null {
    const nKeys = keys.length;
    const total = data.length * nKeys;
    if (!(total <= 0xffffffff)) return null;

    let bits = new Uint32Array(0);
    let blocks = new Uint32Array(0);
    let stream = new Uint8Array(0);
    let nBits = 0; // words of `bits` in use
    let nBlocks = 0; // entries of `blocks` in use
    let n = 0; // bytes of `stream` in use
    let visited = 0; // cells of the rows that are there
    const scratch: number[] = [];

    for (let r = 0; r < data.length; r++) {
      const item = data[r] as Record<string | number | symbol, unknown> | null | undefined;
      if (item == null) continue;
      for (let k = 0; k < nKeys; k++) {
        const raw = String(item[keys[k].name] ?? '');
        visited++;
        // Lower-casing keeps every offset and every whitespace position in place
        // except for U+0130, which grows to two code units. So the words of the
        // raw text sit at the offsets of the lower-cased text, and only a text
        // with U+0130 needs the real thing here (scoring lower-cases it again).
        const text = caseSensitive || raw.indexOf('\u0130') === -1 ? raw : raw.toLowerCase();
        scratch.length = 0;
        const count = wordSpans(text, scratch);
        if (count === 0) continue;

        const cell = r * nKeys + k;
        // `bits` and `blocks` cover every cell up to this one: 3 bits per cell.
        // That is only worth it while the rows are mostly there.
        if (cell > 4096 + visited * 64) return null;
        // A varint of a value below 2^32 takes at most 5 bytes.
        const need = n + (count + 1) * 5;
        if (need > 0xffffffff) return null;
        if (need > stream.length) {
          const bigger = new Uint8Array(Math.max(need, stream.length * 2, 256));
          bigger.set(stream.subarray(0, n));
          stream = bigger;
        }

        const word = cell >>> 5;
        if (word >= bits.length) bits = grow(bits, Math.max(word + 1, bits.length * 2, 8));
        bits[word] |= 1 << (cell & 31);
        nBits = word + 1;

        const block = cell >>> 6;
        if (block >= blocks.length) blocks = grow(blocks, Math.max(block + 1, blocks.length * 2, 8));
        while (nBlocks <= block) blocks[nBlocks++] = n;

        n = writeVarint(stream, n, count * 2 + (scratch[2 * count - 1] === text.length ? 0 : 1));
        n = writeVarint(stream, n, scratch[0]);
        for (let i = 1; i < count; i++) {
          const start = scratch[2 * i];
          n = writeVarint(stream, n, (start - scratch[2 * i - 2]) * 2 + (start - scratch[2 * i - 1] === 1 ? 0 : 1));
        }
      }
    }

    return { bits: bits.slice(0, nBits), blocks: blocks.slice(0, nBlocks), data: stream.slice(0, n) };
  }

  function grow(a: Uint32Array, size: number): Uint32Array<ArrayBuffer> {
    const b = new Uint32Array(size);
    b.set(a);
    return b;
  }

  /** Writes `v` (an integer in `[0, 2^32)`) at `buf[at]` as a LEB128 varint and returns the offset after it. */
  function writeVarint(buf: Uint8Array, at: number, v: number): number {
    while (v > 127) {
      buf[at++] = (v & 127) | 128;
      v >>>= 7;
    }
    buf[at++] = v;
    return at;
  }

  // Read offset of `readVarint`. The kernel is synchronous, so one is enough.
  let vp = 0;

  /** Reads the varint at `buf[vp]` and moves `vp` past it. */
  function readVarint(buf: Uint8Array): number {
    let b = buf[vp++];
    let v = b & 127;
    for (let mul = 128; b > 127; mul *= 128) {
      b = buf[vp++];
      v += (b & 127) * mul;
    }
    return v;
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
    const bits = words === null ? new Uint32Array(0) : words.bits;
    const blocks = words === null ? bits : words.blocks;
    const stream = words === null ? new Uint8Array(0) : words.data;
    // `pos` is the offset in `stream` of the entry of the first indexed cell at or after cell `at`.
    let at = 0;
    let pos = 0;
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
              const cell = r * nKeys + k;
              const word = cell >>> 5;
              if (word < bits.length && (bits[word] >>> (cell & 31)) & 1) {
                // Find this cell's entry. Cells are visited in ascending
                // order, so it is usually the one at `pos`; otherwise walk
                // from the start of its block of 64 cells.
                const block = cell >>> 6;
                if (cell < at || at >>> 6 !== block || at > 0xffffffff) {
                  at = block * 64;
                  pos = blocks[block];
                }
                // Varints are read in place; only one of two bytes or more
                // (a count or a gap above 127) goes through `readVarint`.
                let p = pos;
                for (; at < cell; at++) {
                  if ((bits[at >>> 5] >>> (at & 31)) & 1) {
                    // Skip an entry: its head, then one varint per word.
                    vp = p;
                    let left = readVarint(stream) >>> 1;
                    p = vp;
                    while (left > 0 && p < stream.length) if (stream[p++] < 128) left--;
                  }
                }
                let head = stream[p++];
                if (head > 127) {
                  vp = p - 1;
                  head = readVarint(stream);
                  p = vp;
                }
                let start = stream[p++];
                if (start > 127) {
                  vp = p - 1;
                  start = readVarint(stream);
                  p = vp;
                }
                for (let w = head >>> 1; w > 1; w--) {
                  let gap = stream[p++];
                  if (gap > 127) {
                    vp = p - 1;
                    gap = readVarint(stream);
                    p = vp;
                  }
                  // The word ends where the whitespace before the next word
                  // begins: one code unit back, or further when flagged.
                  const next = start + (gap >>> 1);
                  let end = next - 1;
                  if (gap & 1) while (end > start && isSpace(text.charCodeAt(end - 1))) end--;
                  const s = wordScore(match(text, start, end), end - start);
                  if (s > ws) ws = s;
                  start = next;
                }
                // The last word runs to the end, or to the trailing whitespace when flagged.
                let end = text.length;
                if (head & 1) while (end > start && isSpace(text.charCodeAt(end - 1))) end--;
                const s = wordScore(match(text, start, end), end - start);
                if (s > ws) ws = s;
                at = cell + 1;
                pos = p;
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

  return { levenshtein, boundedDistance, createMatcher, wordSpans, buildWordIndex, scoreRows };
}

export type Kernel = ReturnType<typeof createKernel>;
