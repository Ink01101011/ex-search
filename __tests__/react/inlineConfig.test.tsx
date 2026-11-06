/**
 * @jest-environment jsdom
 */
import { renderHook, waitFor, act } from '@testing-library/react';
import { ExSearch } from '../../src/core/search';
import { useExSearch } from '../../src/react/hooks/useExSearch';
import { useExSearchAsync } from '../../src/react/hooks/useExSearchAsync';
import { configEqual } from '../../src/react/hooks/useStableConfig';
import type { SearchConfig } from '../../src/types';
import { FakeWorker, installFakeWorker } from '../helpers/fakeWorker';

interface Person {
  name: string;
}
const DATA: Person[] = [{ name: 'Alice' }, { name: 'Bob' }, { name: 'Alicia' }];
const RENDER_CAP = 60; // a regression loops forever: stop it instead of OOMing the worker

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('inline config (content-compared)', () => {
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

  /** Builds a fresh config literal each render, but stops producing new ones past the cap. */
  function capped(make: () => SearchConfig<Person>) {
    let renders = 0;
    let last: SearchConfig<Person> | undefined;
    return {
      get renders() {
        return renders;
      },
      next() {
        renders++;
        if (renders <= RENDER_CAP || !last) last = make();
        return last;
      },
    };
  }

  it('invalid inline config: few renders, error set, no depth warning', async () => {
    const c = capped(() => ({ keys: [{ name: 'name', weight: NaN }] }));
    const { result } = renderHook(() => useExSearchAsync(DATA, 'ali', c.next()));
    await act(async () => {
      await sleep(100);
    });
    expect(c.renders).toBeLessThan(10);
    expect(result.current.error).toBeInstanceOf(Error);
    expect(result.current.results).toEqual([]);
    expect(depthErrors).toBe(0);
  });

  it('valid inline config (sync path): render count settles after resolving', async () => {
    const c = capped(() => ({ keys: [{ name: 'name', weight: 1 }] }));
    const { result } = renderHook(() => useExSearchAsync(DATA, 'ali', c.next()));
    await waitFor(() => expect(result.current.results).toHaveLength(2));
    const settled = c.renders;
    await act(async () => {
      await sleep(100);
    });
    expect(c.renders).toBe(settled);
    expect(settled).toBeLessThan(10);
    expect(depthErrors).toBe(0);
  });

  describe('with a Worker', () => {
    let restore: () => void;
    beforeAll(() => {
      restore = installFakeWorker();
    });
    afterAll(() => restore());
    beforeEach(() => FakeWorker.reset());

    it('valid inline config: render count settles and only one Worker search ran', async () => {
      const c = capped(() => ({ keys: [{ name: 'name', weight: 1 }], useWorker: true }));
      const { result } = renderHook(() => useExSearchAsync(DATA, 'ali', c.next()));
      await waitFor(() => expect(result.current.results).toHaveLength(2));
      const settled = c.renders;
      await act(async () => {
        await sleep(100);
      });
      expect(c.renders).toBe(settled);
      expect(settled).toBeLessThan(10);
      expect(FakeWorker.all).toHaveLength(1);
    });
  });

  it('a changed config content still re-runs and applies', async () => {
    let threshold = 0.3;
    const { result, rerender } = renderHook(() =>
      useExSearchAsync(DATA, 'alxce', { keys: [{ name: 'name', weight: 1 }], threshold }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    const before = result.current.results.length;
    threshold = 0.99;
    rerender();
    await waitFor(() => expect(result.current.results.length).toBeLessThan(Math.max(before, 1)));
    expect(result.current.results).toEqual(
      new ExSearch({ keys: [{ name: 'name', weight: 1 }], threshold: 0.99 }).setData(DATA).search('alxce'),
    );

    // sync hook too: changed weight/threshold applies
    let th = 0.3;
    const sync = renderHook(() => useExSearch(DATA, 'alxce', { keys: [{ name: 'name', weight: 1 }], threshold: th }));
    const n0 = sync.result.current.length;
    th = 0.99;
    sync.rerender();
    expect(sync.result.current.length).toBeLessThan(Math.max(n0, 1));
  });

  it('F7: setData/updateConfig/constructor are not called per keystroke with an inline config', async () => {
    const setData = jest.spyOn(ExSearch.prototype, 'setData');
    const updateConfig = jest.spyOn(ExSearch.prototype, 'updateConfig');
    let query = 'a';
    const mk = () => ({ keys: [{ name: 'name' as const, weight: 1 }] });
    const sync = renderHook(() => useExSearch(DATA, query, mk()));
    const syncSetData = setData.mock.calls.length;
    for (const q of ['al', 'ali', 'alic']) {
      query = q;
      sync.rerender();
    }
    expect(setData.mock.calls.length).toBe(syncSetData);
    expect(updateConfig).not.toHaveBeenCalled();
    sync.unmount();

    query = 'a';
    setData.mockClear();
    const async = renderHook(() => useExSearchAsync(DATA, query, mk()));
    await waitFor(() => expect(async.result.current.loading).toBe(false));
    expect(setData).toHaveBeenCalledTimes(1);
    for (const q of ['al', 'ali', 'alic']) {
      query = q;
      async.rerender();
      await waitFor(() => expect(async.result.current.loading).toBe(false));
    }
    expect(setData).toHaveBeenCalledTimes(1);
    expect(updateConfig).not.toHaveBeenCalled();
    setData.mockRestore();
    updateConfig.mockRestore();
  });

  it('configEqual compares keys element-wise and every scalar', () => {
    const base: SearchConfig<Person> = { keys: [{ name: 'name', weight: 1 }], threshold: 0.3 };
    expect(configEqual(base, { keys: [{ name: 'name', weight: 1 }], threshold: 0.3 })).toBe(true);
    expect(configEqual(base, { keys: [{ name: 'name', weight: 2 }], threshold: 0.3 })).toBe(false);
    expect(configEqual(base, { ...base, keys: [] })).toBe(false);
    for (const extra of [
      { threshold: 0.4 },
      { fuzzyMaxDistance: 1 },
      { caseSensitive: true },
      { sortAlgorithm: 'tim' as const },
      { useWorker: true },
      { fuzzyMode: 'word' as const },
    ]) {
      expect(configEqual(base, { ...base, ...extra })).toBe(false);
    }
  });
});
