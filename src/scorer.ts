import type { ScorerAPI } from './types';

// ---------------------------------------------------------------------------
// Levenshtein — Myers' bit-parallel algorithm
// ---------------------------------------------------------------------------
// Maintains two m-bit vectors Pv (positive vertical deltas) and Mv (negative).
// Each column of the DP table is encoded into these two bitmasks, giving
// O(n × ⌈m/w⌉) time with w = 31 (JS bitwise ops are 32-bit signed).
// For strings ≤ 31 chars the inner loop body runs exactly once — effectively O(n).
//
// Reference: Myers (1999) "A Fast Bit-Vector Algorithm for Approximate
// String Matching Based on Dynamic Programming", JACM 46(3)

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  // Keep a as the shorter string — bitmasks are built over a
  if (a.length > b.length) {
    const tmp = a;
    a = b;
    b = tmp;
  }

  const m = a.length;
  const n = b.length;

  // peq[c] = bitmask of positions in a where character c appears
  const peq = new Map<string, number>();
  for (let i = 0; i < m; i++) {
    peq.set(a[i], (peq.get(a[i]) ?? 0) | (1 << i));
  }

  // Pv: positive vertical deltas (all 1s → delta[i][0]=i, all +1 going down)
  // Mv: negative vertical deltas (none initially)
  let Pv = (1 << m) - 1;
  let Mv = 0;
  let score = m; // edit distance from a to the empty prefix of b

  for (let j = 0; j < n; j++) {
    const Eq = peq.get(b[j]) ?? 0;

    const Xv = Eq | Mv;
    const Xh = (((Eq & Pv) + Pv) ^ Pv) | Eq;

    let Ph = Mv | ~(Xh | Pv);
    let Mh = Pv & Xh;

    // Bottom-row delta determines whether edit distance increases or decreases
    if ((Ph >>> (m - 1)) & 1) score++;
    if ((Mh >>> (m - 1)) & 1) score--;

    // Shift horizontal deltas left to become the next column's vertical deltas
    Ph = ((Ph << 1) | 1) >>> 0;
    Mh = (Mh << 1) >>> 0;

    Pv = (Mh | ~(Xv | Ph)) >>> 0;
    Mv = (Ph & Xv) >>> 0;
  }

  return score;
}

// ---------------------------------------------------------------------------
// Public scorer
// ---------------------------------------------------------------------------

function normalise(s: string, caseSensitive = false): string {
  return caseSensitive ? s : s.toLowerCase();
}

export const Scorer: ScorerAPI = {
  exact(a, b, caseSensitive = false): number {
    return normalise(a, caseSensitive) === normalise(b, caseSensitive) ? 100 : 0;
  },

  startsWith(text, query, caseSensitive = false): number {
    return normalise(text, caseSensitive).startsWith(normalise(query, caseSensitive)) ? 80 : 0;
  },

  contains(text, query, caseSensitive = false): number {
    return normalise(text, caseSensitive).includes(normalise(query, caseSensitive)) ? 65 : 0;
  },

  fuzzy(a, b, fuzzyMaxDistance = 3, caseSensitive = false): number {
    const na = normalise(a, caseSensitive);
    const nb = normalise(b, caseSensitive);
    const dist = levenshtein(na, nb);
    if (dist > fuzzyMaxDistance) return 0;
    const maxLen = Math.max(na.length, nb.length);
    return maxLen === 0 ? 55 : (1 - dist / maxLen) * 55;
  },

  levenshtein,
};
