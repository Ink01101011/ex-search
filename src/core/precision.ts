// ---------------------------------------------------------------------------
// Precision search on sorted arrays
// ---------------------------------------------------------------------------
//
// All functions require the input array to be sorted ascending (with respect
// to the comparator / numeric key). The input is never sorted or mutated.
// They return the index of a matching element, or -1 when there is none.
// With duplicates, ANY matching index may be returned.
//
// Index arithmetic deliberately avoids 32-bit bit operators (`>>`, `>>>`, `|`)
// so arrays longer than 2^30 elements are handled correctly.

/** Three-way comparator: negative if a < b, positive if a > b, 0 if equal. */
export type Comparator<T> = (a: T, b: T) => number;

const defaultCompare = <T>(a: T, b: T): number => (a < b ? -1 : a > b ? 1 : 0);

// ---------------------------------------------------------------------------
// Exponential search
// ---------------------------------------------------------------------------

/**
 * Exponential (galloping) search. O(log i) where i is the target's position,
 * so it is fastest when the target is near the front or the array is huge.
 *
 * With the default comparator the array must not contain holes, `undefined`
 * or `NaN`: the default comparator returns 0 for incomparable values, so they
 * would be reported as matches or break the ordering. A `NaN` target always
 * yields -1 under the default comparator. When you pass your own comparator
 * it is used as-is (it may order `NaN`, e.g. last).
 *
 * @param arr     Array sorted ascending. Not modified.
 * @param target  Value to find.
 * @param compare Optional three-way comparator (defaults to `<` / `>`).
 * @returns Index of a matching element (any one if duplicates), or -1.
 *
 * @example
 * exponentialSearch([1, 3, 5, 7, 9], 7); // 3
 * exponentialSearch([1, 3, 5, 7, 9], 4); // -1
 */
export function exponentialSearch<T>(arr: readonly T[], target: T, compare?: Comparator<T>): number {
  const n = arr.length;
  if (n === 0 || (compare === undefined && target !== target)) return -1; // default comparator: NaN never matches
  const cmp = compare ?? defaultCompare;
  if (cmp(arr[0] as T, target) === 0) return 0;

  let bound = 1;
  while (bound < n && cmp(arr[bound] as T, target) < 0) bound *= 2;

  let lo = Math.floor(bound / 2);
  let hi = Math.min(bound, n - 1);
  while (lo <= hi) {
    const mid = lo + Math.floor((hi - lo) / 2);
    const c = cmp(arr[mid] as T, target);
    if (c === 0) return mid;
    if (c < 0) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}

// ---------------------------------------------------------------------------
// Fibonacci search
// ---------------------------------------------------------------------------

/**
 * Fibonacci search. O(log n); splits the range using Fibonacci numbers, so it
 * needs only addition and subtraction (no division).
 *
 * With the default comparator the array must not contain holes, `undefined`
 * or `NaN` (the default comparator returns 0 for incomparable values). A
 * `NaN` target always yields -1 under the default comparator; a custom
 * comparator is used as-is.
 *
 * @param arr     Array sorted ascending. Not modified.
 * @param target  Value to find.
 * @param compare Optional three-way comparator (defaults to `<` / `>`).
 * @returns Index of a matching element (any one if duplicates), or -1.
 *
 * @example
 * fibonacciSearch([1, 3, 5, 7, 9], 9); // 4
 * fibonacciSearch([1, 3, 5, 7, 9], 2); // -1
 */
export function fibonacciSearch<T>(arr: readonly T[], target: T, compare?: Comparator<T>): number {
  const n = arr.length;
  if (n === 0 || (compare === undefined && target !== target)) return -1; // default comparator: NaN never matches
  const cmp = compare ?? defaultCompare;

  let fib2 = 0; // (m-2)'th Fibonacci
  let fib1 = 1; // (m-1)'th Fibonacci
  let fib = fib2 + fib1; // m'th Fibonacci, smallest >= n
  while (fib < n) {
    fib2 = fib1;
    fib1 = fib;
    fib = fib2 + fib1;
  }

  let offset = -1;
  while (fib > 1) {
    const i = Math.min(offset + fib2, n - 1);
    const c = cmp(arr[i] as T, target);
    if (c < 0) {
      fib = fib1;
      fib1 = fib2;
      fib2 = fib - fib1;
      offset = i;
    } else if (c === 0) {
      return i;
    } else {
      // Greater, or incomparable (NaN): treated as "greater", like exponentialSearch.
      fib = fib2;
      fib1 = fib1 - fib2;
      fib2 = fib - fib1;
    }
  }

  if (fib1 === 1 && offset + 1 < n && cmp(arr[offset + 1] as T, target) === 0) return offset + 1;
  return -1;
}

// ---------------------------------------------------------------------------
// Interpolation search
// ---------------------------------------------------------------------------

/**
 * Interpolation search for numeric keys. O(log log n) on uniformly
 * distributed data, O(log n) worst case: after about `2 * ceil(log2(n)) + 2`
 * interpolation steps without converging it falls back to plain bisection,
 * so skewed data (e.g. exponential growth or a huge outlier) cannot degrade
 * it to linear time. Each probe reads at most one key.
 *
 * The array must not contain holes, `undefined` or `NaN` keys. `NaN` targets
 * and `NaN` keys encountered at the bounds yield -1.
 *
 * @param arr    Array sorted ascending by `key`. Not modified.
 * @param target Numeric value to find. `NaN` always yields -1.
 * @param key    Maps an element to its numeric key. Optional only for `number[]`.
 * @returns Index of a matching element (any one if duplicates), or -1.
 *
 * @example
 * interpolationSearch([10, 20, 30, 40, 50], 40); // 3
 * interpolationSearch([{ t: 1 }, { t: 5 }], 5, (x) => x.t); // 1
 */
export function interpolationSearch(arr: readonly number[], target: number): number;
export function interpolationSearch<T>(arr: readonly T[], target: number, key: (item: T) => number): number;
export function interpolationSearch<T>(arr: readonly T[], target: number, key?: (item: T) => number): number {
  const n = arr.length;
  if (n === 0 || Number.isNaN(target)) return -1;
  const keyOf = key ?? ((item: T): number => item as unknown as number);

  // `a` and `b` are probed indices whose keys are known; once the initial
  // endpoint checks pass, keyA < target < keyB always holds, so the answer (if
  // any) lies strictly between them and no division by zero can occur.
  let a = 0;
  let b = n - 1;
  let keyA = keyOf(arr[a] as T);
  let keyB = keyOf(arr[b] as T);
  if (Number.isNaN(keyA) || Number.isNaN(keyB)) return -1;
  if (target < keyA || target > keyB) return -1;
  if (target === keyA) return a;
  if (target === keyB) return b;

  let interpolations = 2 * Math.ceil(Math.log2(n)) + 2;
  while (b - a > 1) {
    let pos: number;
    if (interpolations > 0) {
      interpolations--;
      const span = keyB - keyA;
      // An infinite or non-finite span (an Infinity bound) gives no usable
      // interpolation: bisect right away instead of creeping from a + 1.
      pos = Number.isFinite(span) ? a + Math.floor(((target - keyA) * (b - a)) / span) : a + Math.floor((b - a) / 2);
      if (!Number.isFinite(pos)) pos = a + Math.floor((b - a) / 2);
      pos = Math.min(b - 1, Math.max(a + 1, pos));
    } else {
      pos = a + Math.floor((b - a) / 2); // bisection fallback
    }

    const k = keyOf(arr[pos] as T);
    if (k === target) return pos;
    if (Number.isNaN(k)) return -1;
    if (k < target) {
      a = pos;
      keyA = k;
    } else {
      b = pos;
      keyB = k;
    }
  }
  return -1;
}
