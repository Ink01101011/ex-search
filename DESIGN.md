# ex-search — API Design

## Scoring Pipeline

```
query + field value
        │
        ▼
┌───────────────────┐
│  1. Exact match   │  rawScore = 100  (string equality)
│  2. Starts-with   │  rawScore = 80   (text.startsWith(query))
│  3. Contains      │  rawScore = 65   (text.includes(query))
│  4. Fuzzy         │  rawScore = 0–55 (1 − dist/maxLen) × 55
│  5. No match      │  rawScore = 0
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

| Algorithm | From     | Complexity | Best for           |
| --------- | -------- | ---------- | ------------------ |
| radixSort | exsorted | O(n)       | Large result sets  |
| timSort   | exsorted | O(n log n) | Stable / tie-heavy |

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
Scorer.levenshtein(a, b)          ← Myers O(n) for m ≤ 32, banded DP beyond
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

| Scenario             | Recommended config                            |
| -------------------- | --------------------------------------------- |
| < 10 k rows, browser | default (sync, radix)                         |
| 10 k–50 k, browser   | sortAlgorithm: 'radix', fuzzyMaxDistance: 2   |
| > 50 k, browser      | useWorker: true (scores in Worker, sort main) |
| Node.js / server     | sync always fine; Worker not available        |

## Fuzzy tier internals

All scoring lives in `src/core/kernel.ts` (`createKernel()`), a self-contained
factory whose source text is also embedded in the Web Worker, so the main
thread and the Worker run identical code.

1. **Length filter** — `|len(value) − len(query)| > fuzzyMaxDistance` ⇒ no
   match, no distance computed. `fuzzyMaxDistance: 0` therefore skips the
   fuzzy tier entirely.
2. **Per-query matcher** — the query's Myers bitmask table (`peq`) is built
   once per search and reused for every row × key.
3. **Distance** — Myers bit-parallel when the query is ≤ 32 chars (one 32-bit
   word); otherwise an Ukkonen-banded DP bounded by `fuzzyMaxDistance`,
   O(n·k), with early exit once every cell in a row exceeds the bound.
4. **`fuzzyMode: 'word'`** — the matcher also runs over each whitespace token
   of the value; the best score wins. `ExSearch` caches tokens per (row, key)
   and drops the cache on `setData` / `updateConfig`.
5. **Allocation** — per-key scores go into reusable arrays; `fieldMatches` and
   the result object are built only for rows at or above `threshold`.
