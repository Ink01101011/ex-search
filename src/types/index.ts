// ---------------------------------------------------------------------------
// Match
// ---------------------------------------------------------------------------

export type MatchType = 'exact' | 'startsWith' | 'contains' | 'fuzzy' | 'none';

export interface FieldMatch {
  /** Field name that was evaluated */
  key: string;
  /** Weight assigned to this field (0.0 – 1.0) */
  weight: number;
  /** Best match strategy that fired for this field */
  matchType: MatchType;
  /** Raw score before weight is applied (0 – 100) */
  rawScore: number;
  /** Final score after weight is applied: rawScore × weight (0 – 100) */
  fieldScore: number;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface SearchKey<T> {
  /** Property of T to search against */
  name: keyof T;
  /**
   * Importance multiplier (0.0 – 1.0).
   * Typically 1.0 for primary identifiers (e.g. name),
   * 0.5 for secondary fields (e.g. address).
   */
  weight: number;
}

export type SortAlgorithm = 'radix' | 'tim';

export interface SearchConfig<T> {
  /** Fields to search and their weights */
  keys: SearchKey<T>[];

  /**
   * Minimum normalized score (0.0 – 1.0) required to include a result.
   * Results whose best field score / 100 < threshold are discarded.
   * @default 0.3
   */
  threshold?: number;

  /**
   * Maximum Levenshtein distance considered a valid fuzzy match.
   * Larger values allow more typos but slow down matching.
   * @default 3
   */
  fuzzyMaxDistance?: number;

  /**
   * When true, string comparisons are case-sensitive.
   * @default false
   */
  caseSensitive?: boolean;

  /**
   * Algorithm used to rank results by score.
   * 'radix'  — O(n) for integer keys; best for large result sets
   * 'tim'    — O(n log n) stable; best when scores have many ties
   * @default 'radix'
   */
  sortAlgorithm?: SortAlgorithm;

  /**
   * Run the search pipeline inside a Web Worker to avoid blocking the UI.
   * Only available in browser environments.
   * @default false
   */
  useWorker?: boolean;
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

/**
 * A single search result.
 * Mirrors the shape of ExFlowResultItem so results can be fed directly into
 * ex-flow pipelines; exFlowPriority = Math.round(score * 100).
 *
 * We use a type alias (not interface extends) to avoid propagating ex-flow's
 * `ExFlowSafeData` constraint onto every generic in this library.
 */
export type SearchResult<T> = Omit<T, 'exFlowPriority'> & {
  /** exFlowPriority mirrors score so the result plugs into ex-flow as-is */
  exFlowPriority: number;
  /**
   * Normalized relevance score in the range 0.0 – 1.0.
   * Higher is more relevant.
   */
  score: number;
  /** Per-field breakdown of how the score was computed */
  fieldMatches: FieldMatch[];
};

// ---------------------------------------------------------------------------
// Scorer (low-level utilities exposed for custom use)
// ---------------------------------------------------------------------------

export interface ScorerAPI {
  /**
   * Returns 100 if a === b (after optional case normalisation), 0 otherwise.
   */
  exact(a: string, b: string, caseSensitive?: boolean): number;

  /**
   * Returns 80 if text starts with query, 0 otherwise.
   */
  startsWith(text: string, query: string, caseSensitive?: boolean): number;

  /**
   * Returns 65 if text contains query as a substring, 0 otherwise.
   */
  contains(text: string, query: string, caseSensitive?: boolean): number;

  /**
   * Returns a fuzzy score 0 – 55 derived from Levenshtein distance:
   *   score = (1 - distance / max(a.length, b.length)) × 55
   * Returns 0 if distance > fuzzyMaxDistance.
   */
  fuzzy(a: string, b: string, fuzzyMaxDistance?: number, caseSensitive?: boolean): number;

  /**
   * Raw Levenshtein distance computed via the bitwise Myers algorithm.
   * O(n × ⌈m/w⌉) time, O(m) space (w = machine word size, typically 64).
   */
  levenshtein(a: string, b: string): number;
}

// ---------------------------------------------------------------------------
// Re-exports
// ---------------------------------------------------------------------------

export type { ExFlowResultItem } from 'ex-flow';
