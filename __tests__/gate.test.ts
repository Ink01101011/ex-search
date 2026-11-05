import type { SearchConfig } from '../src/types';
import { createKernel } from '../src/core/kernel';
import { ExSearch, __WORKER_SOURCE__, createSearch, search } from '../src/core/search';
import { exponentialSearch, fibonacciSearch, interpolationSearch } from '../src/core/precision';
import { FakeWorker, installFakeWorker, runWorkerSource, type WorkerSelf } from './helpers/fakeWorker';

// Deterministic PRNG so failures reproduce.
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

const KEYS = [{ name: 'name' as const, weight: 1 }];

type Row = Record<string, unknown>;
const run = (data: unknown[], q: string, extra: Partial<SearchConfig<Row>> = {}) =>
  search(data as Row[], q, { keys: [{ name: 'name', weight: 1 }], ...extra });
const names = (rs: Row[]) => rs.map((r) => r.name);

describe('poisoned rows (P2 / F12)', () => {
  const parse = (json: string) => JSON.parse(json) as unknown[];

  it('skips a null row instead of throwing', () => {
    const data = parse('[{"name":"alice"},null,{"name":"alicia"}]');
    expect(names(run(data, 'alice'))).toEqual(['alice', 'alicia']);
    expect(
      createSearch<Row>({ keys: [{ name: 'name', weight: 1 }] })
        .setData(data as Row[])
        .search('alice'),
    ).toHaveLength(2);
  });

  it('does not throw on a value like {"toString":1} and scores it as no match', () => {
    const data = parse('[{"name":"alice"},{"name":{"toString":1}},{"name":{"toString":null,"valueOf":null}}]');
    expect(names(run(data, 'alice'))).toEqual(['alice']);
  });

  it('does not match "[object Object]" text against the query "object"', () => {
    expect(run([{ name: { a: 1 } }, { name: [1, 2] }], 'object')).toEqual([]);
  });

  it('scores functions and symbols as no match, numbers / bigints / booleans by their text', () => {
    const data = [{ name: () => 'alice' }, { name: Symbol('alice') }, { name: 42 }, { name: 7n }, { name: true }];
    expect(names(run(data, '42'))).toEqual([42]);
    expect(names(run(data, '7'))).toEqual([7n]);
    expect(names(run(data, 'true'))).toEqual([true]);
    expect(run(data, 'alice')).toEqual([]);
  });

  it('treats null / undefined values as no match (not as the empty string)', () => {
    expect(run([{ name: null }, { name: undefined }], 'ab', { threshold: 0.1 })).toEqual([]);
  });
});

describe('result construction (P4)', () => {
  it('keeps an own "__proto__" key from changing the result prototype', () => {
    const row = JSON.parse('{"name":"alice","__proto__":{"polluted":true}}');
    const [r] = run([row], 'alice');
    expect(Object.getPrototypeOf(r)).toBe(Object.prototype);
    expect((r as Row).polluted).toBeUndefined();
  });
});

describe('fuzzyMaxDistance: 0 (F10)', () => {
  it('computes no distance at all', () => {
    const k = createKernel();
    const spy = jest.fn(() => 0);
    const hits = k.scoreRows(
      (r) => ['abc', 'abd', 'xyz'][r],
      3,
      'abx',
      { keys: [{ name: 'a', weight: 1 }], threshold: 0, fuzzyMaxDistance: 0, caseSensitive: false, fuzzyMode: 'word' },
      spy as never,
    );
    expect(spy).not.toHaveBeenCalled(); // word tokens are not even read
    expect(hits.every((h) => h.fieldMatches[0].matchType === 'none')).toBe(true);
  });
});

describe('query trimming (F8)', () => {
  const data = [{ name: 'apple' }, { name: 'apples' }];
  it('scores " apple " exactly like "apple" in search() and ExSearch', () => {
    const a = search(data, ' apple ', { keys: KEYS });
    expect(a).toEqual(search(data, 'apple', { keys: KEYS }));
    expect(a[0].score).toBe(1);
    expect(createSearch({ keys: KEYS }).setData(data).search('\tapple\n')).toEqual(a);
  });
});

describe('updateConfig with undefined (F9)', () => {
  it('keeps the current value for an explicit undefined', () => {
    const s = createSearch({ keys: KEYS, threshold: 0.9 }).setData([{ name: 'apple' }, { name: 'appel' }]);
    const before = s.search('apple');
    s.updateConfig({ threshold: undefined, keys: undefined });
    expect(s.search('apple')).toEqual(before);
    expect(before).toHaveLength(1);
  });
});

describe('config validation (P9)', () => {
  it.each([NaN, Infinity, -1])('rejects weight %p', (weight) => {
    expect(() => search([{ name: 'a' }], 'a', { keys: [{ name: 'name', weight }] })).toThrow(RangeError);
    expect(() => createSearch({ keys: [{ name: 'name', weight }] })).toThrow(/weight for key "name"/);
  });
  it.each([NaN, Infinity])('rejects threshold %p', (threshold) => {
    expect(() => search([{ name: 'a' }], 'a', { keys: KEYS, threshold })).toThrow(/threshold/);
  });
  it('rejects a missing keys array', () => {
    expect(() => createSearch({} as never)).toThrow(TypeError);
  });
  it('validates on updateConfig too', () => {
    expect(() => createSearch({ keys: KEYS }).updateConfig({ threshold: NaN })).toThrow(RangeError);
  });
  it('sorts sanely with an enormous (finite) weight: radix key is clamped', () => {
    const data = [{ name: 'apple' }, { name: 'applesauce' }, { name: 'xapplex' }];
    const radix = search(data, 'apple', { keys: [{ name: 'name', weight: 1e300 }], sortAlgorithm: 'radix' });
    const tim = search(data, 'apple', { keys: [{ name: 'name', weight: 1e300 }], sortAlgorithm: 'tim' });
    expect(radix.map((r) => r.name)).toEqual(['apple', 'applesauce', 'xapplex']);
    expect(radix).toEqual(tim);
  });
});

describe('radix near-ties (F6)', () => {
  it('orders scores closer than the 1e-6 key resolution exactly like tim', () => {
    // Two keys whose weights differ by 1e-8 give scores that share one radix key.
    const data = [
      { a: 'apple', b: 'zzz', id: 1 },
      { a: 'zzz', b: 'apple', id: 2 },
    ];
    const keys = [
      { name: 'a' as const, weight: 1 },
      { name: 'b' as const, weight: 1 + 1e-8 },
    ];
    const radix = search(data, 'apple', { keys, sortAlgorithm: 'radix' });
    const tim = search(data, 'apple', { keys, sortAlgorithm: 'tim' });
    expect(radix.map((r) => r.id)).toEqual([2, 1]);
    expect(radix.map((r) => r.id)).toEqual(tim.map((r) => r.id));
  });

  it('matches tim on seeded random data with many near-ties', () => {
    const rand = rng(7);
    const data = Array.from({ length: 300 }, (_, i) => ({ id: i, a: 'x'.repeat(1 + Math.floor(rand() * 4)) + 'q' }));
    const keys = [{ name: 'a' as const, weight: 0.5 + Math.floor(rand() * 3) * 1e-9 }];
    const r1 = search(data, 'xq', { keys, sortAlgorithm: 'radix', threshold: 0 });
    const r2 = search(data, 'xq', { keys, sortAlgorithm: 'tim', threshold: 0 });
    expect(r1.map((r) => r.score)).toEqual(r2.map((r) => r.score));
  });
});

describe('scratch rows are released (P5)', () => {
  it('stays correct across a very long comparison followed by short ones', () => {
    const k = createKernel();
    const big = 'ab'.repeat(40000); // 80k > 64k scratch entries
    const big2 = big.slice(0, 40000) + 'z' + big.slice(40001);
    expect(k.boundedDistance(big, big2, 3)).toBe(1);
    expect(k.levenshtein('x'.repeat(40) + 'a', 'x'.repeat(40) + 'b')).toBe(1);
    expect(k.boundedDistance('y'.repeat(50), 'y'.repeat(48) + 'zz', 3)).toBe(2);
  });
});

describe('precision search NaN handling (G4-L / G4-I)', () => {
  it('fibonacciSearch treats a NaN comparator result as "greater", not as a match', () => {
    const arr = [1, 2, 3, 4, 5, 6, 7, 8];
    const nanCmp = (a: number, b: number) => (a === 5 ? NaN : a - b);
    expect(fibonacciSearch(arr, 5, nanCmp)).toBe(-1);
    expect(exponentialSearch(arr, 5, nanCmp)).toBe(-1);
    expect(fibonacciSearch(arr, 3, nanCmp)).toBe(2);
  });

  it('interpolationSearch bisects immediately when a bound is infinite', () => {
    const n = 4096;
    const arr = Array.from({ length: n }, (_, i) => i);
    arr[n - 1] = Infinity;
    let reads = 0;
    const key = (x: number) => (reads++, x);
    expect(interpolationSearch(arr, 3000, key)).toBe(3000);
    expect(reads).toBeLessThanOrEqual(2 * Math.ceil(Math.log2(n)) + 4);
    expect(interpolationSearch(arr, 2999.5)).toBe(-1);
    expect(interpolationSearch([-Infinity, 1, 2, 3, 4, 5, Infinity], 4)).toBe(4);
  });
});

describe('worker source, run end to end in an isolated context (P6)', () => {
  const data = [
    { id: 1, name: 'Somchai Jaidee' },
    { id: 2, name: 'Malee Srisuk' },
    { id: 3, name: 'the quick brown fox jumps over the lazy dog' },
  ];
  function runOnce(source: string, query: string, fuzzyMode: 'word' | 'value') {
    let posted: unknown;
    const self: WorkerSelf = { onmessage: null, postMessage: (m) => (posted = m) };
    runWorkerSource(self, source);
    const config = {
      keys: [{ name: 'name', weight: 1 }],
      threshold: 0.3,
      fuzzyMaxDistance: 3,
      caseSensitive: false,
      fuzzyMode,
    };
    self.onmessage!({ data: { texts: data.map((d) => d.name), nRows: data.length, normQuery: query, config } });
    return JSON.parse(JSON.stringify(posted)) as Array<{ row: number; score: number }>;
  }

  it('produces the same hits as the main thread', () => {
    for (const [query, mode] of [
      ['somchay', 'word'],
      ['somchay', 'value'],
      ['the quick brown fox jumps over the lazy dgo', 'value'],
    ] as const) {
      const expected = search(data, query, { keys: KEYS, fuzzyMode: mode, sortAlgorithm: 'tim' });
      const hits = runOnce(__WORKER_SOURCE__, query, mode);
      expect(hits.map((h) => data[h.row].id).sort()).toEqual(expected.map((r) => r.id).sort());
      for (const h of hits) expect(h.score).toBe(expected.find((r) => r.id === data[h.row].id)!.score);
    }
  });

  it('defines the __name helper that esbuild keepNames / tsx inject', () => {
    expect(__WORKER_SOURCE__.trimStart().startsWith('var __name')).toBe(true);
    // Simulate a toolchain wrapping serialised functions with __name(fn, "name").
    const injected = __WORKER_SOURCE__.replace(
      'self.onmessage = function',
      '__name(function probe() {}, "probe"); self.onmessage = function',
    );
    expect(injected).not.toBe(__WORKER_SOURCE__);
    expect(runOnce(injected, 'somchay', 'word')).toHaveLength(1);
  });
});

describe('searchAsync with useWorker (F5 / P1 / P3 / P8)', () => {
  let restore: () => void;
  beforeAll(() => {
    restore = installFakeWorker();
  });
  afterAll(() => restore());
  beforeEach(() => FakeWorker.reset());

  const make = <T>(data: T[], extra: object = {}) =>
    new ExSearch<T>({ keys: [{ name: 'name' as keyof T, weight: 1 }], useWorker: true, ...extra }).setData(data);

  it('matches the synchronous path on seeded random data (all modes and sorts)', async () => {
    const rand = rng(42);
    const alphabet = 'abc ';
    const data = Array.from({ length: 150 }, (_, i) => {
      let name = '';
      for (let c = 0, n = 2 + Math.floor(rand() * 10); c < n; c++)
        name += alphabet[Math.floor(rand() * alphabet.length)];
      return { id: i, name, extra: { nested: i } };
    });
    for (const fuzzyMode of ['value', 'word'] as const) {
      for (const sortAlgorithm of ['radix', 'tim'] as const) {
        const s = make(data, { fuzzyMode, sortAlgorithm });
        for (const q of ['ab', 'abc a', ' cab ', 'zzz', 'a']) {
          expect(await s.searchAsync(q)).toEqual(s.search(q));
        }
      }
    }
    expect(FakeWorker.all.length).toBeGreaterThan(0);
    expect(FakeWorker.all.every((w) => w.terminated)).toBe(true);
  });

  it('keeps item identity for nested values and works with function, symbol and getter rows', async () => {
    const fn = () => 1;
    const sym = Symbol('s');
    const getterRow = Object.defineProperty({ id: 3 }, 'name', { get: () => 'alice getter', enumerable: true });
    const data = [{ id: 1, name: 'alice', fn }, { id: 2, name: 'alicia', sym }, getterRow, null] as Array<{
      id: number;
      name?: string;
    } | null>;
    const s = make(data as Array<{ id: number; name: string }>);
    const viaWorker = await s.searchAsync('alic');
    expect(viaWorker).toEqual(s.search('alic'));
    expect(viaWorker).toHaveLength(3);
    expect((viaWorker[0] as unknown as { fn?: unknown }).fn ?? fn).toBe(fn);
  });

  it('supports Symbol key names', async () => {
    const k = Symbol('name');
    const s = new ExSearch<Record<symbol, string>>({ keys: [{ name: k, weight: 1 }], useWorker: true }).setData([
      { [k]: 'alice' },
      { [k]: 'bob' },
    ]);
    const r = await s.searchAsync('alice');
    expect(r).toEqual(s.search('alice'));
    expect(r).toHaveLength(1);
  });

  it('returns [] for a blank query without starting a Worker', async () => {
    expect(await make([{ name: 'a' }]).searchAsync('  ')).toEqual([]);
    expect(FakeWorker.all).toHaveLength(0);
  });

  it('falls back to sync search when new Worker throws (nothing leaks)', async () => {
    FakeWorker.reset('ctor-throws');
    const s = make([{ name: 'alice' }]);
    expect(await s.searchAsync('alice')).toEqual(s.search('alice'));
  });

  it('terminates the Worker and falls back to sync search when postMessage throws', async () => {
    FakeWorker.reset('post-throws');
    const s = make([{ name: 'alice' }]);
    expect(await s.searchAsync('alice')).toEqual(s.search('alice'));
    expect(FakeWorker.all).toHaveLength(1);
    expect(FakeWorker.all[0].terminated).toBe(true);
  });

  it('rejects on a Worker error event and terminates the Worker', async () => {
    FakeWorker.reset('error');
    await expect(make([{ name: 'alice' }]).searchAsync('alice')).rejects.toThrow('worker crashed');
    expect(FakeWorker.all[0].terminated).toBe(true);
  });

  it('abort: terminates the Worker and rejects with AbortError', async () => {
    FakeWorker.reset('hang');
    const controller = new AbortController();
    const p = make([{ name: 'alice' }]).searchAsync('alice', { signal: controller.signal });
    controller.abort();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    expect(FakeWorker.all[0].terminated).toBe(true);
  });

  it('rejects immediately for an already aborted signal, even without a Worker', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(make([{ name: 'a' }]).searchAsync('a', { signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(FakeWorker.all).toHaveLength(0);
    const plain = createSearch({ keys: KEYS }).setData([{ name: 'a' }]);
    await expect(plain.searchAsync('a', { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('a late message after abort is ignored', async () => {
    FakeWorker.reset('hang');
    const controller = new AbortController();
    const p = make([{ name: 'alice' }]).searchAsync('alice', { signal: controller.signal });
    controller.abort();
    await expect(p).rejects.toBeDefined();
    expect(() => FakeWorker.all[0].onmessage?.({ data: [] })).not.toThrow();
  });

  it('creates the Blob URL once per module, not per call', async () => {
    const spy = jest.spyOn(URL as unknown as { createObjectURL: () => string }, 'createObjectURL');
    await jest.isolateModulesAsync(async () => {
      const mod = await import('../src/core/search');
      const s = new mod.ExSearch<{ name: string }>({ keys: KEYS, useWorker: true }).setData([{ name: 'alice' }]);
      await s.searchAsync('alice');
      await s.searchAsync('alic');
      await s.searchAsync('ali');
    });
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});
