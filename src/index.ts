/**
 * ex-search
 * ─────────
 * Scoring-based fuzzy search with radix/tim sort ranking.
 *
 * Scoring pipeline per field
 * ──────────────────────────
 *  1. Exact match    → rawScore = 100
 *  2. Starts-with    → rawScore = 80
 *  3. Fuzzy (Myers)  → rawScore = (1 − dist / maxLen) × 70
 *  4. No match       → rawScore = 0
 *
 *  fieldScore = rawScore × weight
 *  finalScore = max(fieldScore) / 100   → normalised 0.0–1.0
 *
 * Sorting
 * ───────
 *  radixSort (exsorted): O(n) — score × 1_000_000 as integer key, descending
 *  timSort   (exsorted): O(n log n) stable — used when sortAlgorithm = 'tim'
 */

export {
  search,
  createSearch,
  ExSearch,
} from './search';

export { Scorer } from './scorer';

export type {
  SearchConfig,
  SearchKey,
  SearchResult,
  FieldMatch,
  MatchType,
  SortAlgorithm,
  ScorerAPI,
} from './types';

export type { ExFlowResultItem } from 'ex-flow';
