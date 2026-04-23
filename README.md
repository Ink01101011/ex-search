# ex-search

[![npm version](https://img.shields.io/npm/v/ex-search.svg)](https://www.npmjs.com/package/ex-search)
[![npm downloads](https://img.shields.io/npm/dm/ex-search.svg)](https://www.npmjs.com/package/ex-search)
[![CI](https://github.com/Ink01101011/ex-search/actions/workflows/ci.yml/badge.svg)](https://github.com/Ink01101011/ex-search/actions/workflows/ci.yml)
[![TypeScript](https://img.shields.io/badge/TypeScript-Ready-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Bundle size](https://img.shields.io/bundlephobia/minzip/ex-search)](https://bundlephobia.com/package/ex-search)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Scoring-based fuzzy search for TypeScript. Replaces naive `String.includes()` with a four-tier match pipeline — exact, starts-with, contains, and fuzzy — weighted per field and ranked using `radixSort` or `timSort` from [exsorted](https://www.npmjs.com/package/exsorted). Results carry an `exFlowPriority` field so they plug directly into [ex-flow](https://www.npmjs.com/package/ex-flow) pipelines.

## Features

- **Four-tier match pipeline** — exact (100), starts-with (80), contains (65), and fuzzy (0–55) per field
- **Field weights** — multiply each tier's score by a per-field importance factor (0.0–1.0)
- **Myers bit-parallel Levenshtein** — O(n × ⌈m/31⌉) fuzzy distance; effectively O(n) for strings under 31 characters
- **Pluggable sort backend** — choose `radixSort` (O(n), best for large result sets) or `timSort` (O(n log n) stable)
- **Web Worker support** — offload scoring to a Worker thread in browser environments to keep the UI responsive
- **React hooks** — `useExSearch` (sync, SSR-safe) and `useExSearchAsync` (Worker-backed) via `ex-search/react`
- **ex-flow compatible** — every result includes `exFlowPriority` mirroring the normalized score
- **Fully typed** — complete TypeScript generics; no `any` in public API
- **Dual module support** — ships as both ESM and CommonJS
- **Tree-shakeable** — import only `Scorer` utilities or the React hooks subpath independently

## Scoring Concept

Instead of returning a flat list of items that merely contain the query, `ex-search` assigns every candidate a relevance score and ranks results from most to least relevant.

### The four-tier pipeline

Each field is evaluated in order. The first tier that fires wins; lower tiers are not evaluated.

| Tier        | Condition                                  | Raw score |
| ----------- | ------------------------------------------ | --------- |
| Exact       | Field value equals query (case-normalised) | 100       |
| Starts-with | Field value begins with query              | 80        |
| Contains    | Field value includes query as a substring  | 65        |
| Fuzzy       | Levenshtein distance ≤ `fuzzyMaxDistance`  | 0 – 55    |
| No match    | None of the above                          | 0         |

Fuzzy score formula: `(1 − distance / max(fieldLen, queryLen)) × 55`

A distance of 0 gives 55 (identical strings that weren't caught by exact/contains), while the maximum allowed distance gives a score approaching 0.

### Field weights and final score

Raw score is multiplied by the field's `weight` (0.0–1.0) to produce a `fieldScore`. The highest `fieldScore` across all configured fields becomes the item's `score`, normalized to the 0.0–1.0 range.

```
fieldScore  = rawScore × weight
score       = max(fieldScore across all keys) / 100
```

**Example** — query `"สยาม"` against a branch record:

| Field   | Value                    | Tier     | Raw | Weight | fieldScore |
| ------- | ------------------------ | -------- | --- | ------ | ---------- |
| name    | `สาขาสยามพารากอน`        | contains | 65  | 1.0    | 65.0       |
| address | `991 ถ.พระราม 1 ปทุมวัน` | none     | 0   | 0.5    | 0.0        |

→ `score = 65.0 / 100 = 0.65`

Results with `score < threshold` are filtered out before ranking.

### Why radixSort for ranking?

After scoring, results must be sorted by `score` descending. Because scores are bounded floats in [0.0, 1.0], they can be converted to integer keys (`score × 1 000 000`) and sorted with `radixSort` in O(n) time. For 10 000 matched results this means ranking completes in microseconds. `timSort` is provided as a stable alternative when score ties must preserve insertion order.

## Installation

```bash
pnpm add ex-search
```

```bash
npm install ex-search
```

`ex-search` requires `exsorted` and `ex-flow` as peer dependencies:

```bash
pnpm add exsorted ex-flow
```

## Quick Start

### 1. One-shot functional search

```typescript
import { search } from 'ex-search';

interface Branch {
  id: string;
  name: string;
  address: string;
}

const branches: Branch[] = [
  { id: '001', name: 'สาขาสยามพารากอน', address: '991 ถ.พระราม 1 ปทุมวัน' },
  { id: '002', name: 'สาขาเซ็นทรัลลาดพร้าว', address: '1693 ถ.พหลโยธิน จตุจักร' },
  { id: '003', name: 'สาขาเชียงใหม่', address: '86 ถ.ช้างคลาน เมือง เชียงใหม่' },
];

const results = search(branches, 'สยาม', {
  keys: [
    { name: 'name', weight: 1.0 },
    { name: 'address', weight: 0.5 },
  ],
  threshold: 0.3,
});

// results[0] → {
//   id: '001',
//   name: 'สาขาสยามพารากอน',
//   address: '991 ถ.พระราม 1 ปทุมวัน',
//   score: 0.65,
//   exFlowPriority: 65,
//   fieldMatches: [
//     { key: 'name', weight: 1.0, matchType: 'contains', rawScore: 65, fieldScore: 65 },
//     { key: 'address', weight: 0.5, matchType: 'none', rawScore: 0, fieldScore: 0 },
//   ]
// }
```

### 2. Reusable class API (query changes often, data stays the same)

```typescript
import { createSearch } from 'ex-search';

const searcher = createSearch<Branch>({
  keys: [
    { name: 'name', weight: 1.0 },
    { name: 'address', weight: 0.5 },
  ],
  threshold: 0.3,
  sortAlgorithm: 'radix',
});

searcher.setData(branches);

// Call search as many times as needed without re-configuring
const r1 = searcher.search('สยาม');
const r2 = searcher.search('ลาดพร้าว');
const r3 = searcher.search('Chiengmai'); // fuzzy → matches 'เชียงใหม่' if within distance
```

### 3. Async search with Web Worker (large datasets, browser only)

```typescript
import { createSearch } from 'ex-search';

const searcher = createSearch<Branch>({
  keys: [{ name: 'name', weight: 1.0 }],
  threshold: 0.3,
  useWorker: true, // scoring runs off the main thread
  sortAlgorithm: 'radix',
});

searcher.setData(branches);

// Does not block the UI thread
const results = await searcher.searchAsync('สยาม');
```

### 4. Low-level Scorer utilities

```typescript
import { Scorer } from 'ex-search';

Scorer.levenshtein('Somchai', 'Somchay'); // 1
Scorer.exact('สยาม', 'สยาม'); // 100
Scorer.startsWith('สยามพารากอน', 'สยาม'); // 80
Scorer.contains('สาขาสยามพารากอน', 'สยาม'); // 65
Scorer.fuzzy('Chiangmai', 'Chiengmai'); // ~49  (dist=2, maxLen=9 → (1−2/9)×55)
```

### 5. React hooks

Install `react` as a peer dependency (already required if you are in a React project), then import from the `ex-search/react` subpath.

#### `useExSearch` — synchronous, SSR-safe

```typescript
import { useMemo } from 'react';
import { useExSearch } from 'ex-search/react';

function BranchList({ branches }: { branches: Branch[] }) {
  const [query, setQuery] = useState('');

  // Wrap config in useMemo so its reference stays stable across renders
  const config = useMemo(
    () => ({
      keys: [
        { name: 'name' as const, weight: 1.0 },
        { name: 'address' as const, weight: 0.5 },
      ],
      threshold: 0.3,
    }),
    [],
  );

  const results = useExSearch(branches, query, config);

  return (
    <>
      <input value={query} onChange={(e) => setQuery(e.target.value)} />
      {results.map((r) => <div key={r.id}>{r.name} — score {r.score.toFixed(2)}</div>)}
    </>
  );
}
```

`useExSearch` runs synchronously inside `useMemo`, so results are ready on the **first server render** — no loading state or layout shift.

#### `useExSearchAsync` — Worker-backed, large datasets

```typescript
import { useExSearchAsync } from 'ex-search/react';

function BranchList({ branches }: { branches: Branch[] }) {
  const [query, setQuery] = useState('');

  const config = useMemo(
    () => ({
      keys: [{ name: 'name' as const, weight: 1.0 }],
      threshold: 0.3,
      useWorker: true, // scoring runs off the main thread in browsers
    }),
    [],
  );

  const { results, loading } = useExSearchAsync(branches, query, config);

  return (
    <>
      <input value={query} onChange={(e) => setQuery(e.target.value)} />
      {loading && <span>Searching…</span>}
      {results.map((r) => <div key={r.id}>{r.name}</div>)}
    </>
  );
}
```

`useExSearchAsync` uses `useEffect`, so it is **skipped during SSR** — the initial render returns `{ results: [], loading: false }`. An empty or whitespace-only query resets results immediately without triggering the `loading` state. When `Worker` is unavailable (Node.js, SSR, or when `useWorker` is `false`) the hook falls back to synchronous execution transparently.

**Config stability note** — both hooks list `config` as a `useMemo`/`useEffect` dependency. If you create the config object inline (e.g. `useExSearch(data, query, { keys: [...] })`), a new object is produced on every render, causing the hook to re-run even when nothing changed. Wrapping the config in `useMemo` prevents this.

### 6. Piping results into ex-flow

Every `SearchResult<T>` carries `exFlowPriority = Math.round(score × 100)`, which is the field `ex-flow` reads for priority ordering. No transformation is needed.

```typescript
import { search } from 'ex-search';
import { ExFlow } from 'ex-flow';

const searchResults = search(branches, 'สยาม', config);

const flow = new ExFlow<Branch>({ priorityAscending: false });

searchResults.forEach((result) => {
  flow.addEntity({
    id: result.id,
    data: result,
    dependsOn: [],
    // exFlowPriority is already set by ex-search — no manual mapping required
  });
});

const plan = flow.resolveExecutionPlan();
```

## API Reference

### `search<T>(data, query, config)`

One-shot search over an array. Scores every item, filters by `threshold`, and returns results sorted by score descending.

```typescript
function search<T>(data: T[], query: string, config: SearchConfig<T>): SearchResult<T>[];
```

Returns an empty array when `query` is an empty string or whitespace only.

---

### `createSearch<T>(config)`

Factory that returns a pre-configured `ExSearch` instance.

```typescript
function createSearch<T>(config: SearchConfig<T>): ExSearch<T>;
```

---

### `class ExSearch<T>`

Reusable searcher. Create once, call `search()` or `searchAsync()` as many times as needed.

```typescript
class ExSearch<T> {
  constructor(config: SearchConfig<T>);

  setData(data: T[]): this;
  updateConfig(config: Partial<SearchConfig<T>>): this;

  search(query: string): SearchResult<T>[];
  searchAsync(query: string): Promise<SearchResult<T>[]>;
}
```

**`setData(data)`** — Replace the dataset. Returns `this` for chaining.

**`updateConfig(partial)`** — Merge a partial config update. All fields are optional; unspecified fields keep their previous value. Returns `this` for chaining.

**`search(query)`** — Synchronous. Suitable for datasets up to ~50 000 records in browser environments or any size in Node.js.

**`searchAsync(query)`** — When `useWorker: true` and the environment supports `Worker`, scoring runs in a dedicated Worker thread. Falls back to synchronous execution otherwise.

---

### `useExSearch<T>(data, query, config)` · `ex-search/react`

Synchronous search hook. Wraps `search()` in `useMemo`; re-runs when any dependency changes.

```typescript
function useExSearch<T>(data: T[], query: string, config: SearchConfig<T>): SearchResult<T>[];
```

SSR-safe — executes during server rendering. Returns `[]` for blank queries.

---

### `useExSearchAsync<T>(data, query, config)` · `ex-search/react`

Async search hook. Delegates to a Web Worker when `config.useWorker` is `true` and `Worker` is available; falls back to synchronous otherwise.

```typescript
function useExSearchAsync<T>(
  data: T[],
  query: string,
  config: SearchConfig<T>,
): { results: SearchResult<T>[]; loading: boolean };
```

SSR-safe — `useEffect` is skipped on the server; initial state is `{ results: [], loading: false }`. Blank queries skip the loading state entirely.

---

### `Scorer`

Low-level utilities exposed for custom pipelines.

```typescript
const Scorer: {
  exact(a: string, b: string, caseSensitive?: boolean): number;
  startsWith(text: string, query: string, caseSensitive?: boolean): number;
  contains(text: string, query: string, caseSensitive?: boolean): number;
  fuzzy(a: string, b: string, fuzzyMaxDistance?: number, caseSensitive?: boolean): number;
  levenshtein(a: string, b: string): number;
};
```

All string comparisons are **case-insensitive by default**. Pass `true` as the `caseSensitive` argument to opt in to case-sensitive matching.

`levenshtein` returns the raw edit distance (integer). The `fuzzy` method converts this to a score in the range 0–55 and returns 0 when the distance exceeds `fuzzyMaxDistance`.

---

### `SearchConfig<T>`

```typescript
interface SearchConfig<T> {
  keys: SearchKey<T>[];
  threshold?: number; // default: 0.3
  fuzzyMaxDistance?: number; // default: 3
  caseSensitive?: boolean; // default: false
  sortAlgorithm?: 'radix' | 'tim'; // default: 'radix'
  useWorker?: boolean; // default: false
}

interface SearchKey<T> {
  name: keyof T;
  weight: number; // 0.0 – 1.0
}
```

**`keys`** — Fields to search and their importance. A field with `weight: 1.0` contributes its full raw score; `weight: 0.5` halves it.

**`threshold`** — Minimum normalized score (0.0–1.0) to include a result. A value of `0.3` means only results with `score ≥ 0.30` are returned.

**`fuzzyMaxDistance`** — Maximum Levenshtein edit distance treated as a match. Distance 1 catches single-character typos; distance 3 allows three substitutions, insertions, or deletions. Larger values widen fuzzy recall but slow scoring when data is large.

**`caseSensitive`** — Applies to all four match tiers simultaneously.

**`sortAlgorithm`** — `'radix'` is faster for large result sets (O(n)); `'tim'` is stable and preserves insertion order among ties (O(n log n)).

**`useWorker`** — When `true`, `searchAsync()` delegates the entire scoring pipeline to a Web Worker. Has no effect in Node.js or when `Worker` is unavailable.

---

### `SearchResult<T>`

```typescript
type SearchResult<T> = Omit<T, 'exFlowPriority'> & {
  score: number; // 0.0 – 1.0, normalized
  exFlowPriority: number; // Math.round(score × 100)
  fieldMatches: FieldMatch[];
};

interface FieldMatch {
  key: string;
  weight: number;
  matchType: 'exact' | 'startsWith' | 'contains' | 'fuzzy' | 'none';
  rawScore: number; // 0 – 100, before weight
  fieldScore: number; // rawScore × weight
}
```

`fieldMatches` contains one entry per configured `key`, in the same order as `config.keys`. Use it to display highlighted match explanations in your UI or for debugging why an item ranked where it did.

## Field Weight Guide

Weights reflect how important a field is relative to your domain. There are no prescribed values — tune them based on what your users expect.

| Scenario                         | Field     | Suggested weight |
| -------------------------------- | --------- | ---------------- |
| Person name (primary identifier) | `name`    | `1.0`            |
| Username or code                 | `code`    | `0.8`            |
| Address or description           | `address` | `0.5`            |
| Tags or secondary metadata       | `tags`    | `0.3`            |

A weight of `0.0` disables scoring for that field while still including it in `fieldMatches` with a `fieldScore` of `0`.

## Performance Guide

| Dataset size     | Environment    | Recommended config                              |
| ---------------- | -------------- | ----------------------------------------------- |
| < 10 000 records | Browser / Node | Default (`radix`, sync)                         |
| 10 000 – 50 000  | Browser        | `sortAlgorithm: 'radix'`, `fuzzyMaxDistance: 2` |
| > 50 000         | Browser        | `useWorker: true`, `sortAlgorithm: 'radix'`     |
| Any size         | Node.js        | Sync always sufficient; `Worker` not available  |

Reducing `fuzzyMaxDistance` from 3 to 2 cuts the number of fuzzy candidates that reach the scoring step, which is the most CPU-intensive part of the pipeline. If you only need exact and substring matching, set `fuzzyMaxDistance: 0` to skip the Levenshtein computation entirely.

The Myers bit-parallel Levenshtein runs at O(n × ⌈m/31⌉) using JavaScript's 32-bit bitwise operations, where m is the shorter string length and n is the longer. For strings under 31 characters — the typical case for search queries — the inner bit-vector loop runs exactly once per character in n, giving effective O(n) behaviour.

## Import Paths

### Root import (recommended)

```typescript
import { search, createSearch, ExSearch, Scorer } from 'ex-search';
```

### React hooks

```typescript
import { useExSearch, useExSearchAsync } from 'ex-search/react';
```

The `ex-search/react` subpath is tree-shakeable from the core bundle. It requires `react` as a peer dependency and is safe to use in both CSR and SSR environments (Next.js App Router, Remix, etc.).

### Types-only import

```typescript
import type { SearchConfig, SearchResult, FieldMatch, MatchType, SortAlgorithm } from 'ex-search/types';
```

Use `ex-search/types` when you only need type annotations — for example, in a React component that receives `SearchResult<T>` as a prop without calling the search functions itself.

## Types Reference

| Type              | Description                                                                              |
| ----------------- | ---------------------------------------------------------------------------------------- |
| `SearchConfig<T>` | Configuration passed to `search()`, `createSearch()`, or `ExSearch` constructor          |
| `SearchKey<T>`    | A single `{ name: keyof T, weight: number }` entry inside `SearchConfig.keys`            |
| `SearchResult<T>` | An item from the input array enriched with `score`, `exFlowPriority`, and `fieldMatches` |
| `FieldMatch`      | Per-field scoring breakdown inside `SearchResult.fieldMatches`                           |
| `MatchType`       | `'exact' \| 'startsWith' \| 'contains' \| 'fuzzy' \| 'none'`                             |
| `SortAlgorithm`   | `'radix' \| 'tim'`                                                                       |
| `ScorerAPI`       | Shape of the exported `Scorer` object                                                    |

## Peer Dependencies

| Package    | Version                | Required for            |
| ---------- | ---------------------- | ----------------------- |
| `exsorted` | `^1.1.0`               | Core search and sorting |
| `ex-flow`  | `^1.0.4`               | `exFlowPriority` field  |
| `react`    | `^18.2.0` or `^19.0.0` | `ex-search/react` hooks |

All peer dependencies are optional — install only what you use. They are not bundled into `ex-search`.

## Compatibility

- **Node.js** — 18 and above
- **Browser** — any environment with ES2020 support; `useWorker` requires the Web Worker API
- **Module formats** — ESM (`import`) and CommonJS (`require`) via package exports
- **TypeScript** — 5.0 and above

## License

[MIT](LICENSE)
