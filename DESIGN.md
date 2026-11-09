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
4. **`fuzzyMode: 'word'`** — the matcher also runs over each whitespace word
   of the value (maximal `\S+` runs, the same words `split(/\s+/)` gives); the
   best score wins. `ExSearch` builds a word index once per data / config
   version and drops it on `setData` / `updateConfig`. The index stores no
   strings: `cells` (ascending `row × nKeys + key` of the cells with words),
   `starts` (word range per listed cell) and `spans` (flat `[start, end)`
   offsets into the case-normalised text; `Uint16Array` unless a value is
   longer than 65 535 code units). A cell whose only word is the whole value
   is left out, since tier 4 already scored the whole value. The matcher
   compares the query with `text[start, end)` in place, so a repeat query
   neither splits nor slices. The one-shot `search()` and the Worker find the
   words on the fly with the same splitter.
5. **Row subset (`within`)** — the subset is normalised to ascending, unique,
   in-range indices and the kernel visits only those rows, in the same order a
   full scan would, so ties rank identically. `canNarrow` proves
   `hits(next) ⊆ hits(prev)` from the tier scores alone: with the fuzzy tier
   off, a field scoring 100 / 80 / 65 on `next` scores at least
   `min(tier, 80)` on `prev` when `prev` is a prefix of `next` (`min(tier, 65)`
   when it is only a substring), and each key's weight is checked against
   `threshold` with the kernel's own arithmetic.
6. **Allocation** — per-key scores go into reusable arrays; `fieldMatches` and
   the result object are built only for rows at or above `threshold`.
