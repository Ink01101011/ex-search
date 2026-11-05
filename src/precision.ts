// Standalone entry (`ex-search/precision`): precision search on sorted arrays
// with zero imports, so bundlers never pull in exsorted or the fuzzy engine.
export { exponentialSearch, fibonacciSearch, interpolationSearch } from './core/precision';
export type { Comparator } from './core/precision';
