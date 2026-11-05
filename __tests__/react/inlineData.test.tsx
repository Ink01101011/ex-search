/**
 * @jest-environment jsdom
 */
import { renderHook, waitFor, act } from '@testing-library/react';
import { useExSearch } from '../../src/react/hooks/useExSearch';
import { useExSearchAsync } from '../../src/react/hooks/useExSearchAsync';
import { dataEqual } from '../../src/react/hooks/useStableData';
import { ExSearch } from '../../src/core/search';
import { FakeWorker, installFakeWorker } from '../helpers/fakeWorker';

jest.setTimeout(15000);

interface Person {
  name: string;
}
const A: Person = { name: 'Alice' };
const B: Person = { name: 'Bob' };
const C: Person = { name: 'Alicia' };
const ITEMS = [A, B, C];
const RENDER_CAP = 60;
const CONFIG = { keys: [{ name: 'name' as const, weight: 1 }] };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Produces a NEW array of the current items each render, but stops past the cap. */
function cappedData(getItems: () => Person[]) {
  let renders = 0;
  let last: Person[] | undefined;
  return {
    get renders() {
      return renders;
    },
    next() {
      renders++;
      if (renders <= RENDER_CAP || !last) last = [...getItems()];
      return last;
    },
  };
}

describe('inline data (element-compared)', () => {
  let depthErrors: number;
  let errSpy: jest.SpyInstance;
  beforeEach(() => {
    depthErrors = 0;
    const orig = console.error;
    errSpy = jest.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
      if (String(a[0]).includes('Maximum update depth')) depthErrors++;
      else orig(...a);
    });
  });
  afterEach(() => errSpy.mockRestore());

  it('dataEqual: same length and === elements', () => {
    expect(dataEqual([A, B], [A, B])).toBe(true);
    expect(dataEqual([A, B], [B, A])).toBe(false);
    expect(dataEqual([A], [A, B])).toBe(false);
    expect(dataEqual([A], [{ ...A }])).toBe(false);
    expect(dataEqual([], [])).toBe(true);
  });

  it('async, sync path: inline data with equal elements settles in a few renders', async () => {
    const d = cappedData(() => ITEMS);
    const { result } = renderHook(() => useExSearchAsync(d.next(), 'ali', CONFIG));
    await waitFor(() => expect(result.current.results).toHaveLength(2));
    const settled = d.renders;
    await act(async () => {
      await sleep(100);
    });
    expect(d.renders).toBe(settled);
    expect(settled).toBeLessThan(10);
    expect(depthErrors).toBe(0);
  });

  it('async, fake Worker: settles and only one Worker search ran', async () => {
    const restore = installFakeWorker();
    try {
      FakeWorker.reset();
      const cfg = { ...CONFIG, useWorker: true };
      const d = cappedData(() => ITEMS);
      const { result } = renderHook(() => useExSearchAsync(d.next(), 'ali', cfg));
      await waitFor(() => expect(result.current.results).toHaveLength(2));
      const settled = d.renders;
      await act(async () => {
        await sleep(100);
      });
      expect(d.renders).toBe(settled);
      expect(settled).toBeLessThan(10);
      expect(FakeWorker.all).toHaveLength(1);
    } finally {
      restore();
    }
  });

  it('sync hook: inline data does not rebuild the searcher per render', () => {
    const setData = jest.spyOn(ExSearch.prototype, 'setData');
    try {
      const d = cappedData(() => ITEMS);
      const { result, rerender } = renderHook(() => useExSearch(d.next(), 'ali', CONFIG));
      const first = result.current;
      const calls = setData.mock.calls.length;
      rerender();
      rerender();
      expect(setData.mock.calls.length).toBe(calls);
      expect(result.current).toBe(first);
    } finally {
      setData.mockRestore();
    }
  });

  it('changed elements or length re-run (async and sync)', async () => {
    let items: Person[] = [A, B];
    const d = cappedData(() => items);
    const async = renderHook(() => useExSearchAsync(d.next(), 'ali', CONFIG));
    const sync = renderHook(() => useExSearch(d.next(), 'ali', CONFIG));
    await waitFor(() => expect(async.result.current.results).toHaveLength(1));
    expect(sync.result.current).toHaveLength(1);

    items = [A, B, C]; // length change
    async.rerender();
    sync.rerender();
    await waitFor(() => expect(async.result.current.results).toHaveLength(2));
    expect(sync.result.current).toHaveLength(2);

    items = [A, B, { name: 'Alina' }]; // same length, different element identity
    async.rerender();
    sync.rerender();
    await waitFor(() => expect(async.result.current.results.map((r) => r.name)).toContain('Alina'));
    expect(sync.result.current.map((r) => r.name)).toContain('Alina');
    expect(depthErrors).toBe(0);
  });
});
