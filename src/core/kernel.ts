import type { MatchType } from '../types';

/**
 * Compact word index for `fuzzyMode: 'word'`, built once per data version.
 * A cell is `row * nKeys + key`. The index keeps where each word of a cell
 * starts and ends, as offsets into the cell's case-normalised text (never a
 * substring). Cells whose only word is the whole value are left out (the
 * whole value is already scored by the fuzzy tier) and cost nothing.
 */
export interface WordIndex {
  /**
   * Four numbers per block of 64 cells that holds an indexed cell, in
   * ascending block order: the block number (`cell >>> 6`), the offset in
   * `data` of the block's first entry, then two 32-bit masks in which bit
   * `cell & 63` is set when the cell is indexed. Blocks with no indexed cell
   * are not listed.
   */
  blocks: Uint32Array;
  /**
   * The entries of the indexed cells, in ascending cell order. An entry is a
   * run of LEB128 varints:
   *  - `2 * bytes + t`: `bytes` is the length of the rest of the entry;
   *  - when `t` is 1, the count of whitespace code units after the last word;
   *  - the start of the first word;
   *  - per further word, `2 * gap + s`, where `gap` is its start minus the
   *    start of the word before it. When `s` is 0 one whitespace code unit
   *    separates the two words; when it is 1 the count of whitespace code
   *    units between them follows.
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

/** A surviving row: its index, best weighted field score and per-field breakdown. */
export interface KernelHit {
  row: number;
  /** Best weighted field score (0 – 100 × weight). */
  best: number;
  /** `best / 100`. */
  score: number;
  fieldMatches: Array<{
    key: string;
    weight: number;
    matchType: MatchType;
    rawScore: number;
    fieldScore: number;
  }>;
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
  const SCRATCH_LIMIT = 65536;
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
   * `m` (1 ≤ m ≤ 32, encoded in `peq`) and `text.slice(from, to)` of any length.
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
    const d = bandedRun(a, b, max);
    // Do not pin a huge scratch buffer for the lifetime of the kernel after one
    // very long comparison.
    if (rowA.length > SCRATCH_LIMIT) {
      rowA = new Int32Array(64);
      rowB = new Int32Array(64);
    }
    return d;
  }

  function bandedRun(a: string, b: string, max: number): number {
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
   * Builds the word index of every (row, key) cell. `getText` follows the
   * `scoreRows` contract; offsets refer to the text as `scoreRows` normalises
   * it. The arrays grow by doubling from empty, so the build never holds more
   * than about three times what it returns, and what it returns grows with
   * the cells that have words, not with `nRows * nKeys`.
   * Returns `null` when the cell ids (`row * nKeys + key`) or the entry
   * offsets do not fit in 32 bits. The caller then scores without an index,
   * which finds the same words on the fly.
   */
  function buildWordIndex(
    getText: (row: number, key: number) => string | null | undefined,
    nRows: number,
    nKeys: number,
    caseSensitive: boolean,
  ): WordIndex | null {
    const total = nRows * nKeys;
    if (!(total <= 0xffffffff)) return null;

    let blocks = new Uint32Array(0);
    let data = new Uint8Array(0);
    let nBlocks = 0; // numbers of `blocks` in use (4 per block)
    let n = 0; // bytes of `data` in use
    const scratch: number[] = [];

    for (let r = 0; r < nRows; r++) {
      for (let k = 0; k < nKeys; k++) {
        const raw = getText(r, k);
        if (raw === undefined && k === 0) break;
        if (typeof raw !== 'string') continue;
        // Lower-casing keeps every offset and every whitespace position in place
        // except for U+0130, which grows to two code units. So the words of the
        // raw text sit at the offsets of the lower-cased text, and only a text
        // with U+0130 needs the real thing here (scoring lower-cases it again).
        const text = caseSensitive || raw.indexOf('\u0130') === -1 ? raw : raw.toLowerCase();
        scratch.length = 0;
        const count = wordSpans(text, scratch);
        if (count === 0) continue;

        // At most two varints per word plus two more, 5 bytes each (a varint
        // of a value below 2^32 takes at most 5 bytes).
        const need = n + count * 10 + 10;
        if (need > 0xffffffff) return null;
        if (need > data.length) {
          const bigger = new Uint8Array(Math.min(Math.max(need, data.length * 2, 256), 0xffffffff));
          bigger.set(data.subarray(0, n));
          data = bigger;
        }

        const cell = r * nKeys + k;
        const block = cell >>> 6;
        if (nBlocks === 0 || blocks[nBlocks - 4] !== block) {
          if (nBlocks === blocks.length) {
            const bigger = new Uint32Array(Math.max(blocks.length * 2, 64));
            bigger.set(blocks);
            blocks = bigger;
          }
          blocks[nBlocks] = block;
          blocks[nBlocks + 1] = n;
          nBlocks += 4;
        }
        blocks[nBlocks - 2 + ((cell >>> 5) & 1)] |= 1 << (cell & 31);

        // The entry's first varint holds its length, known only once the rest
        // is written: write the rest one byte further and move it if that
        // varint turns out to need more than one byte.
        const trail = text.length - scratch[2 * count - 1];
        let p = n + 1;
        if (trail !== 0) p = writeVarint(data, p, trail);
        p = writeVarint(data, p, scratch[0]);
        for (let i = 1; i < count; i++) {
          const start = scratch[2 * i];
          const sep = start - scratch[2 * i - 1];
          p = writeVarint(data, p, (start - scratch[2 * i - 2]) * 2 + (sep === 1 ? 0 : 1));
          if (sep !== 1) p = writeVarint(data, p, sep);
        }
        const bytes = p - n - 1;
        if (bytes > 0x7fffffff) return null;
        const head = bytes * 2 + (trail === 0 ? 0 : 1);
        if (head > 127) {
          let extra = 0;
          for (let v = head; v > 127; v >>>= 7) extra++;
          data.copyWithin(n + 1 + extra, n + 1, p);
          p += extra;
        }
        writeVarint(data, n, head);
        n = p;
      }
    }

    return { blocks: blocks.slice(0, nBlocks), data: data.slice(0, n) };
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
   * Turns a field value into searchable text. Strings pass through; numbers,
   * bigints and booleans are stringified; everything else (null, undefined,
   * objects, arrays, functions, symbols) has no text and never matches.
   */
  function toText(value: unknown): string | null {
    const t = typeof value;
    if (t === 'string') return value as string;
    if (t === 'number' || t === 'bigint' || t === 'boolean') return String(value);
    return null;
  }

  /**
   * Runs the four-tier pipeline over `nRows` rows and returns the unsorted
   * survivors as lightweight hits (row index, score, per-field breakdown).
   * `getText(row, key)` supplies the raw text of a field: `null` means "no
   * text" (scores 0) and `undefined` at key 0 means "skip this row entirely".
   * Rows that fall below the threshold allocate nothing.
   *
   * In `fuzzyMode: 'word'` the words come from `words` (built by
   * `buildWordIndex` over the same texts) or, when it is `null`, are found on
   * the fly. `rows`, when given, lists the only rows to score (ascending,
   * unique, each `< nRows`); hits keep their original row index.
   */
  function scoreRows(
    getText: (row: number, key: number) => string | null | undefined,
    nRows: number,
    normQuery: string,
    config: KernelConfig,
    words: WordIndex | null,
    rows?: ArrayLike<number> | null,
  ): KernelHit[] {
    const keys = config.keys;
    const nKeys = keys.length;
    const cs = config.caseSensitive;
    const max = config.fuzzyMaxDistance;
    const fuzzyOn = max > 0;
    const threshold = config.threshold;
    const wordMode = config.fuzzyMode === 'word';
    const qLen = normQuery.length;
    const match = createMatcher(normQuery, max);

    const types: MatchType[] = [];
    const raws = new Float64Array(nKeys);
    const hits: KernelHit[] = [];
    const live: number[] = [];
    /** Fuzzy score of a word at distance `d` (0 when beyond `max`). */
    const wordScore = (d: number, len: number): number => (d <= max ? (1 - d / (len > qLen ? len : qLen)) * 55 : 0);
    // The index is read only where words are scored.
    const indexed = words !== null && wordMode && fuzzyOn;
    const blocks = indexed ? words.blocks : new Uint32Array(0);
    const data = indexed ? words.data : new Uint8Array(0);
    const nb = blocks.length >>> 2; // listed blocks
    // `cb` is the block of the last lookup, `bi` where it landed among the
    // listed blocks, and `m0` / `m1` its two masks (0 when it is not listed).
    // `pos` is the offset in `data` of the entry of the first indexed cell
    // at or after cell `at` (0 to 64) of that block.
    let cb = -1;
    let bi = 0;
    let m0 = 0;
    let m1 = 0;
    let at = 0;
    let pos = 0;
    const count = rows == null ? nRows : rows.length;

    for (let i = 0; i < count; i++) {
      const r = rows == null ? i : rows[i];
      let best = -Infinity;

      for (let k = 0; k < nKeys; k++) {
        const raw = getText(r, k);
        if (raw === undefined && k === 0) break;
        let type = MATCH_NONE;
        let score = 0;

        if (typeof raw === 'string') {
          const text = cs ? raw : raw.toLowerCase();
          if (text === normQuery) {
            type = MATCH_EXACT;
            score = 100;
          } else if (text.startsWith(normQuery)) {
            type = MATCH_STARTS;
            score = 80;
          } else if (text.includes(normQuery)) {
            type = MATCH_CONTAINS;
            score = 65;
          } else if (fuzzyOn) {
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
                const block = cell >>> 6;
                if (block !== cb) {
                  // Lower bound of this block among the listed blocks. Rows
                  // are visited in ascending order, so it is usually at or
                  // just past `bi`; fall back to a binary search after a
                  // short walk.
                  let lo = bi === 0 || blocks[4 * bi - 4] < block ? bi : 0;
                  for (let step = 0; step < 4 && lo < nb && blocks[4 * lo] < block; step++) lo++;
                  if (lo < nb && blocks[4 * lo] < block) {
                    let hi = nb;
                    while (lo < hi) {
                      const mid = (lo + hi) >>> 1;
                      if (blocks[4 * mid] < block) lo = mid + 1;
                      else hi = mid;
                    }
                  }
                  bi = lo;
                  cb = block;
                  const listed = lo < nb && blocks[4 * lo] === block;
                  m0 = listed ? blocks[4 * lo + 2] : 0;
                  m1 = listed ? blocks[4 * lo + 3] : 0;
                  at = 0;
                  pos = listed ? blocks[4 * lo + 1] : 0;
                }
                const j = cell & 63;
                if (((j < 32 ? m0 : m1) >>> (j & 31)) & 1) {
                  // Find this cell's entry: hop over the entries of the
                  // indexed cells before it in the block, from where the last
                  // lookup stopped when that was earlier in the same block.
                  if (j < at) {
                    at = 0;
                    pos = blocks[4 * bi + 1];
                  }
                  // Varints are read in place; only one of two bytes or more
                  // goes through `readVarint`.
                  let p = pos;
                  for (; at < j; at++) {
                    if (((at < 32 ? m0 : m1) >>> (at & 31)) & 1) {
                      let skip = data[p++];
                      if (skip > 127) {
                        vp = p - 1;
                        skip = readVarint(data);
                        p = vp;
                      }
                      p += skip >>> 1;
                    }
                  }
                  let head = data[p++];
                  if (head > 127) {
                    vp = p - 1;
                    head = readVarint(data);
                    p = vp;
                  }
                  const stop = p + (head >>> 1);
                  let tail = 0;
                  if (head & 1) {
                    tail = data[p++];
                    if (tail > 127) {
                      vp = p - 1;
                      tail = readVarint(data);
                      p = vp;
                    }
                  }
                  let start = data[p++];
                  if (start > 127) {
                    vp = p - 1;
                    start = readVarint(data);
                    p = vp;
                  }
                  while (p < stop) {
                    let gap = data[p++];
                    if (gap > 127) {
                      vp = p - 1;
                      gap = readVarint(data);
                      p = vp;
                    }
                    // The word ends where the whitespace before the next word
                    // begins: one code unit back, or as many as the entry says.
                    const next = start + (gap >>> 1);
                    let end = next - 1;
                    if (gap & 1) {
                      let sep = data[p++];
                      if (sep > 127) {
                        vp = p - 1;
                        sep = readVarint(data);
                        p = vp;
                      }
                      end = next - sep;
                    }
                    const s = wordScore(match(text, start, end), end - start);
                    if (s > ws) ws = s;
                    start = next;
                  }
                  // The last word runs to the end, less any trailing whitespace.
                  const end = text.length - tail;
                  const s = wordScore(match(text, start, end), end - start);
                  if (s > ws) ws = s;
                  at = j + 1;
                  pos = stop;
                }
              }
              if (ws > score) {
                type = MATCH_FUZZY;
                score = ws;
              }
            }
          }
        }

        types[k] = type;
        raws[k] = score;
        const fieldScore = score * keys[k].weight;
        if (fieldScore > best) best = fieldScore;
      }

      if (best === -Infinity) continue; // skipped row (or no keys)
      const total = best / 100;
      if (total < threshold) continue;

      const fieldMatches: KernelHit['fieldMatches'] = [];
      for (let k = 0; k < nKeys; k++) {
        fieldMatches.push({
          key: String(keys[k].name),
          weight: keys[k].weight,
          matchType: types[k],
          rawScore: raws[k],
          fieldScore: raws[k] * keys[k].weight,
        });
      }
      hits.push({ row: r, best, score: total, fieldMatches });
    }

    return hits;
  }

  return { levenshtein, boundedDistance, createMatcher, wordSpans, buildWordIndex, toText, scoreRows };
}

export type Kernel = ReturnType<typeof createKernel>;
