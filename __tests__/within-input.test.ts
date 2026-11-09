import { searchWithRows } from '../src/core/search';
import type { SearchConfig } from '../src/types';

type Row = { a: string };

describe('within is read once and bounded', () => {
  const data: Row[] = Array.from({ length: 10 }, (_, i) => ({ a: `item ${i}` }));
  const cfg: SearchConfig<Row> = { keys: [{ name: 'a', weight: 1 }], threshold: 0 };

  it('rejects a length that is not a finite uint32', () => {
    for (const length of [Infinity, 2 ** 32, 1e15, NaN, -1]) {
      expect(() => searchWithRows(data, 'item', cfg, { within: { length } })).toThrow(TypeError);
    }
  });

  it('does not use the iterator of the array it was given', () => {
    const within = [0, 1];
    (within as unknown as Record<symbol, unknown>)[Symbol.iterator] = function* () {
      yield 9;
      yield 9;
    };
    expect(Array.from(searchWithRows(data, 'item', cfg, { within }).rows)).toEqual([0, 1]);
  });

  it('reads length once and each index at most once', () => {
    const reads: Record<string, number> = {};
    const within = new Proxy([3, 1, 2, 1], {
      get(target, prop, receiver) {
        reads[String(prop)] = (reads[String(prop)] ?? 0) + 1;
        return Reflect.get(target, prop, receiver);
      },
    });
    const r = searchWithRows(data, 'item', cfg, { within });
    expect(Array.from(r.rows)).toEqual([1, 2, 3]);
    expect(reads.length).toBe(1);
    for (const i of ['0', '1', '2', '3']) expect(reads[i]).toBe(1);
  });

  it('a Proxy whose element changes between reads cannot add rows', () => {
    let n = 0;
    const within = new Proxy([0, 1], {
      get(target, prop, receiver) {
        if (prop === '1') return n++ === 0 ? 1 : -5;
        return Reflect.get(target, prop, receiver);
      },
    });
    expect(Array.from(searchWithRows(data, 'item', cfg, { within }).rows)).toEqual([0, 1]);
  });

  it('keeps messy input working: duplicates, unordered, out of range, fractions', () => {
    const within = [5, 3, 3, -1, 99, 2.5, 0, NaN, 5];
    expect(Array.from(searchWithRows(data, 'item', cfg, { within }).rows)).toEqual([0, 3, 5]);
    expect(Array.from(searchWithRows(data, 'item', cfg, { within: new Float64Array([4, 2, 2]) }).rows)).toEqual([2, 4]);
    expect(Array.from(searchWithRows(data, 'item', cfg, { within: [] }).rows)).toEqual([]);
  });

  it('a long sparse within is walked without copying holes', () => {
    const big: number[] = [];
    big.length = 2 ** 22;
    big[3] = 7;
    expect(Array.from(searchWithRows(data, 'item', cfg, { within: big }).rows)).toEqual([7]);
  });
});
