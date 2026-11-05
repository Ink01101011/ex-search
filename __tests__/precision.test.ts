import { exponentialSearch, fibonacciSearch, interpolationSearch } from '../src';
import type { Comparator } from '../src';

// Deterministic PRNG so failures are reproducible.
function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), t | 1);
    r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

type Fn = (arr: number[], t: number) => number;
const impls: [string, Fn][] = [
  ['exponentialSearch', (a, t) => exponentialSearch(a, t)],
  ['fibonacciSearch', (a, t) => fibonacciSearch(a, t)],
  ['interpolationSearch', (a, t) => interpolationSearch(a, t)],
];

describe.each(impls)('%s', (_name, find) => {
  it('returns -1 on empty array', () => {
    expect(find([], 1)).toBe(-1);
  });

  it('handles a single element', () => {
    expect(find([5], 5)).toBe(0);
    expect(find([5], 4)).toBe(-1);
    expect(find([5], 6)).toBe(-1);
  });

  it('finds first and last elements', () => {
    const a = [1, 3, 5, 7, 9, 11, 13];
    expect(find(a, 1)).toBe(0);
    expect(find(a, 13)).toBe(6);
  });

  it('finds every element at every small size', () => {
    for (let n = 1; n <= 40; n++) {
      const a = Array.from({ length: n }, (_, i) => i * 3);
      for (let i = 0; i < n; i++) expect(find(a, a[i]!)).toBe(i);
      expect(find(a, -1)).toBe(-1);
      expect(find(a, n * 3)).toBe(-1);
      for (let i = 0; i < n; i++) expect(find(a, a[i]! + 1)).toBe(-1);
    }
  });

  it('returns -1 for values below, above and between', () => {
    const a = [10, 20, 30, 40];
    expect(find(a, 5)).toBe(-1);
    expect(find(a, 99)).toBe(-1);
    expect(find(a, 25)).toBe(-1);
  });

  it('returns a matching index with duplicates', () => {
    const a = [1, 2, 2, 2, 2, 3, 3, 4];
    const i = find(a, 2);
    expect(a[i]).toBe(2);
    const j = find(a, 3);
    expect(a[j]).toBe(3);
  });

  it('handles all-equal values', () => {
    const a = [7, 7, 7, 7, 7];
    expect(a[find(a, 7)]).toBe(7);
    expect(find(a, 6)).toBe(-1);
    expect(find(a, 8)).toBe(-1);
  });

  it('handles non-uniform (exponential) data', () => {
    const a = Array.from({ length: 50 }, (_, i) => 2 ** i);
    for (let i = 0; i < a.length; i++) expect(find(a, a[i]!)).toBe(i);
    expect(find(a, 3)).toBe(-1);
  });

  it('matches indexOf on a 100k array for random targets', () => {
    const a = Array.from({ length: 100_000 }, (_, i) => i * 2);
    const rand = mulberry32(0xc0ffee);
    for (let r = 0; r < 2000; r++) {
      const t = Math.floor(rand() * 210_000) - 5000;
      const expected = a.indexOf(t);
      const got = find(a, t);
      if (expected === -1) expect(got).toBe(-1);
      else expect(got).toBe(expected); // unique values
    }
  });

  it('returns -1 for a NaN target', () => {
    expect(find([1, 2, 3], NaN)).toBe(-1);
  });
});

describe('custom comparator', () => {
  const byId: Comparator<{ id: number }> = (a, b) => a.id - b.id;
  const rows = Array.from({ length: 30 }, (_, i) => ({ id: i * 5 }));

  it('works on objects by field', () => {
    expect(exponentialSearch(rows, { id: 65 }, byId)).toBe(13);
    expect(fibonacciSearch(rows, { id: 65 }, byId)).toBe(13);
    expect(exponentialSearch(rows, { id: 66 }, byId)).toBe(-1);
    expect(fibonacciSearch(rows, { id: 66 }, byId)).toBe(-1);
  });

  it('works on descending data with a reversed comparator', () => {
    const desc = [9, 7, 5, 3, 1];
    const rev: Comparator<number> = (a, b) => b - a;
    expect(exponentialSearch(desc, 3, rev)).toBe(3);
    expect(fibonacciSearch(desc, 9, rev)).toBe(0);
    expect(fibonacciSearch(desc, 4, rev)).toBe(-1);
  });
});

describe('strings', () => {
  const words = ['apple', 'banana', 'cherry', 'date', 'elder', 'fig', 'grape'];
  it('finds strings with the default comparator', () => {
    expect(exponentialSearch(words, 'date')).toBe(3);
    expect(fibonacciSearch(words, 'grape')).toBe(6);
    expect(exponentialSearch(words, 'coconut')).toBe(-1);
    expect(fibonacciSearch(words, 'zzz')).toBe(-1);
  });
});

describe('interpolationSearch key function', () => {
  const rows = [{ t: 100 }, { t: 200 }, { t: 300 }, { t: 400 }];
  it('uses the key to read numeric values', () => {
    expect(interpolationSearch(rows, 300, (r) => r.t)).toBe(2);
    expect(interpolationSearch(rows, 250, (r) => r.t)).toBe(-1);
    expect(interpolationSearch(rows, 50, (r) => r.t)).toBe(-1);
  });

  it('handles infinite targets without throwing', () => {
    expect(interpolationSearch([1, 2, 3], Infinity)).toBe(-1);
    expect(interpolationSearch([1, 2, 3], -Infinity)).toBe(-1);
  });
});

describe('NaN handling with a custom comparator', () => {
  const total: Comparator<number> = (a, b) => {
    const an = Number.isNaN(a);
    const bn = Number.isNaN(b);
    if (an || bn) return an === bn ? 0 : an ? 1 : -1;
    return a - b;
  };

  it('finds NaN when the comparator orders it', () => {
    expect(exponentialSearch([1, 2, NaN], NaN, total)).toBe(2);
    expect(fibonacciSearch([1, 2, NaN], NaN, total)).toBe(2);
  });

  it('still finds regular values around NaN', () => {
    expect(exponentialSearch([1, 2, NaN], 2, total)).toBe(1);
    expect(fibonacciSearch([1, 2, NaN], 1, total)).toBe(0);
  });
});

describe('interpolationSearch worst case', () => {
  it('stays O(log n) key calls on an adversarial tail', () => {
    const n = 100_000;
    const arr = Array.from({ length: n }, (_, i) => (i === n - 1 ? 1e300 : i));
    let calls = 0;
    const key = (x: number): number => {
      calls++;
      return x;
    };
    const bound = 4 * Math.log2(n) + 10;
    for (const t of [0, 1, 500, 50_000, n - 2, n - 3, 1e300, 99_998.5, -1, 1e301]) {
      calls = 0;
      const i = interpolationSearch(arr, t, key);
      expect(i).toBe(Number.isInteger(t) || t === 1e300 ? arr.indexOf(t) : -1);
      expect(calls).toBeLessThanOrEqual(bound);
    }
  });

  it('stays O(log n) on geometric growth', () => {
    const n = 100_000;
    const arr = Array.from({ length: n }, (_, i) => 1.00002 ** i);
    let calls = 0;
    const key = (x: number): number => {
      calls++;
      return x;
    };
    for (const i of [0, 10, 50_000, n - 1]) {
      calls = 0;
      expect(interpolationSearch(arr, arr[i]!, key)).toBe(i);
      expect(calls).toBeLessThanOrEqual(4 * Math.log2(n) + 10);
    }
  });
});

describe('interpolationSearch typing', () => {
  it('requires a key unless the elements are numbers', () => {
    // @ts-expect-error key is required for non-number elements
    expect(() => interpolationSearch(['a', 'b'], 1)).not.toThrow();
    expect(interpolationSearch([1, 2, 3], 2)).toBe(1);
    expect(interpolationSearch([{ t: 1 }], 1, (r) => r.t)).toBe(0);
  });
});
