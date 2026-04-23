# ex-search — API Design

## Scoring Pipeline

```
query + field value
        │
        ▼
┌───────────────────┐
│  1. Exact match   │  rawScore = 100  (string equality)
│  2. Starts-with   │  rawScore = 80   (text.startsWith(query))
│  3. Fuzzy (Myers) │  rawScore = 0–70 (1 − dist/maxLen) × 70
│  4. No match      │  rawScore = 0
└───────────────────┘
        │
        × weight  (0.0–1.0 per field)
        │
        ▼
   fieldScore  (0–100)
        │
   max over all fields
        │
        ÷ 100
        ▼
   score  (0.0–1.0)   ← threshold applied here
```

## Sorting

| Algorithm | From      | Complexity | Best for               |
|-----------|-----------|------------|------------------------|
| radixSort | exsorted  | O(n)       | Large result sets      |
| timSort   | exsorted  | O(n log n) | Stable / tie-heavy     |

radixSort key: `Math.round((1 − score) × 1_000_000)` (negated for descending).

## Public API surface

```ts
// Functional
search<T>(data, query, config) → SearchResult<T>[]

// Class (reuse across queries)
new ExSearch<T>(config)
  .setData(data)
  .search(query)          → SearchResult<T>[]
  .searchAsync(query)     → Promise<SearchResult<T>[]>

// Factory
createSearch<T>(config)   → ExSearch<T>

// Low-level
Scorer.exact(a, b, cs?)
Scorer.startsWith(text, query, cs?)
Scorer.fuzzy(a, b, maxDist?, cs?)
Scorer.levenshtein(a, b)          ← Myers O(n·⌈m/64⌉) bitwise
```

## Result shape

```ts
SearchResult<T> = T & {
  score:          number;        // 0.0–1.0
  fieldMatches:   FieldMatch[];  // per-field breakdown
  exFlowPriority: number;        // score × 100 — ready for ex-flow pipelines
}
```

## Performance notes

| Scenario              | Recommended config                              |
|-----------------------|-------------------------------------------------|
| < 10 k rows, browser  | default (sync, radix)                           |
| 10 k–50 k, browser    | sortAlgorithm: 'radix', fuzzyMaxDistance: 2     |
| > 50 k, browser       | useWorker: true (scores in Worker, sort main)   |
| Node.js / server      | sync always fine; Worker not available          |
