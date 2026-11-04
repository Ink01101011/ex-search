import type { ScorerAPI } from '../types';
import { createKernel } from './kernel';

// ---------------------------------------------------------------------------
// Levenshtein
// ---------------------------------------------------------------------------
// Myers' bit-parallel algorithm when the shorter string fits in one 32-bit
// word (≤ 32 chars), an Ukkonen-banded DP otherwise. See ./kernel.ts.
//
// Reference: Myers (1999) "A Fast Bit-Vector Algorithm for Approximate
// String Matching Based on Dynamic Programming", JACM 46(3)

const kernel = createKernel();

// ---------------------------------------------------------------------------
// Public scorer
// ---------------------------------------------------------------------------

function normalise(s: string, caseSensitive = false): string {
  return caseSensitive ? s : s.toLowerCase();
}

/**
 * Low-level scoring primitives used internally by the search pipeline.
 * Exposed for custom use cases — e.g. highlighting, custom ranking, or
 * pre-filtering before calling `search()`.
 *
 * All string comparisons are **case-insensitive by default**.
 * Pass `caseSensitive: true` to any method to opt in to exact-case matching.
 *
 * @example
 * Scorer.levenshtein('Somchai', 'Somchay'); // 1
 * Scorer.fuzzy('Chiangmai', 'Chiengmai');   // ~49
 */
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
    // Length difference alone rules out a match without computing a distance.
    const dist = kernel.boundedDistance(na, nb, fuzzyMaxDistance);
    if (!(dist <= fuzzyMaxDistance)) return 0;
    const maxLen = Math.max(na.length, nb.length);
    return maxLen === 0 ? 55 : (1 - dist / maxLen) * 55;
  },

  levenshtein: kernel.levenshtein,
};
