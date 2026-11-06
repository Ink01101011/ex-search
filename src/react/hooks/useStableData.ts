import { useRef } from 'react';

/** Shallow equality of two arrays: same length and every element `===`. */
export function dataEqual<T>(a: readonly T[], b: readonly T[]): boolean {
  if (a === b) return true;
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Returns the previously seen array while the new one has the same length and
 * the same elements (`===`), so hooks can key on data CONTENT: an inline
 * `items.filter(...)` (a new array every render) no longer restarts effects or
 * rebuilds searchers. O(n) per render, far cheaper than a search.
 * @internal
 */
export function useStableData<T>(data: T[]): T[] {
  const ref = useRef(data);
  if (ref.current !== data && !dataEqual(ref.current, data)) ref.current = data;
  return ref.current;
}
