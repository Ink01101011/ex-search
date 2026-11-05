/**
 * ex-search
 * ─────────
 * Scoring-based fuzzy search with radix/tim sort ranking.
 *
 * Scoring pipeline per field
 * ──────────────────────────
 *  1. Exact      → rawScore = 100
 *  2. StartsWith → rawScore = 80
 *  3. Contains   → rawScore = 65
 *  4. Fuzzy      → rawScore = (1 − dist / maxLen) × 55
 *  5. No match   → rawScore = 0
 *
 *  fieldScore = rawScore × weight
 *  finalScore = max(fieldScore) / 100   → normalised 0.0–1.0
 *
 * Sorting
 * ───────
 *  radixSort (exsorted): O(n) — score × 1_000_000 as integer key, descending
 *  timSort   (exsorted): O(n log n) stable — used when sortAlgorithm = 'tim'
 *
 * Precision search
 * ────────────────
 *  exponentialSearch / fibonacciSearch / interpolationSearch locate a value in
 *  an already ascending-sorted array and return its index (or -1).
 */

export { search, createSearch, ExSearch } from './core/search';

export { Scorer } from './core/scorer';

export { exponentialSearch, fibonacciSearch, interpolationSearch } from './core/precision';
export type { Comparator } from './core/precision';

export type {
  SearchConfig,
  SearchOptions,
  SearchKey,
  SearchResult,
  FieldMatch,
  MatchType,
  SortAlgorithm,
  FuzzyMode,
  ScorerAPI,
} from './types';

export type { ExFlowResultItem } from 'ex-flow';
