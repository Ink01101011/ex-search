/**
 * @jest-environment jsdom
 */
import { renderHook, waitFor } from '@testing-library/react';
import { ExSearch } from '../../src/core/search';
import { useExSearch } from '../../src/react/hooks/useExSearch';
import { useExSearchAsync } from '../../src/react/hooks/useExSearchAsync';
import type { SearchConfig } from '../../src/types';
import { FakeWorker, installFakeWorker } from '../helpers/fakeWorker';

interface Person {
  name: string;
}
const DATA: Person[] = [{ name: 'Alice' }, { name: 'Bob' }, { name: 'Alicia' }];
const CONFIG = { keys: [{ name: 'name' as const, weight: 1 }], useWorker: true };

describe('useExSearchAsync with a Worker', () => {
  let restore: () => void;
  beforeAll(() => {
    restore = installFakeWorker();
  });
  afterAll(() => restore());
  beforeEach(() => FakeWorker.reset());
  afterEach(() => jest.restoreAllMocks());

  it('resolves through the Worker and matches the sync result', async () => {
    const { result } = renderHook(() => useExSearchAsync(DATA, 'alic', CONFIG));
    await waitFor(() => expect(result.current.results).toHaveLength(2));
    expect(result.current.error).toBeNull();
    expect(result.current.results).toEqual(new ExSearch(CONFIG).setData(DATA).search('alic'));
    expect(FakeWorker.all.length).toBeGreaterThan(0);
  });

  it('terminates a superseded Worker search and an unmounted one (P3)', async () => {
    FakeWorker.reset('hang');
    let query = 'alice';
    const { rerender, unmount } = renderHook(() => useExSearchAsync(DATA, query, CONFIG));
    await waitFor(() => expect(FakeWorker.all).toHaveLength(1));
    expect(FakeWorker.all[0].terminated).toBe(false);

    query = 'bob';
    rerender();
    await waitFor(() => expect(FakeWorker.all).toHaveLength(2));
    expect(FakeWorker.all[0].terminated).toBe(true);
    expect(FakeWorker.all[1].terminated).toBe(false);

    unmount();
    expect(FakeWorker.all[1].terminated).toBe(true);
  });

  it('an aborted search never surfaces as an error', async () => {
    FakeWorker.reset('hang');
    let query = 'alice';
    const { result, rerender } = renderHook(() => useExSearchAsync(DATA, query, CONFIG));
    await waitFor(() => expect(FakeWorker.all).toHaveLength(1));
    query = '';
    rerender();
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBeNull();
    expect(result.current.results).toEqual([]);
    expect(FakeWorker.all[0].terminated).toBe(true);
  });

  it('falls back to the sync search when the Worker errors (P7)', async () => {
    FakeWorker.reset('error');
    const { result } = renderHook(() => useExSearchAsync(DATA, 'alice', CONFIG));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBeNull();
    expect(result.current.results.map((r) => r.name)).toEqual(['Alice', 'Alicia']);
  });

  it('reports error and clears stale results when the sync fallback fails too (P7)', async () => {
    const bad = [
      {
        get name(): string {
          throw new Error('getter exploded');
        },
      },
    ];
    let data: Array<{ name: string }> = DATA;
    const { result, rerender } = renderHook(() => useExSearchAsync(data, 'alice', CONFIG));
    await waitFor(() => expect(result.current.results.length).toBeGreaterThan(0));
    data = bad;
    rerender();
    await waitFor(() => expect(result.current.error).toBeInstanceOf(Error));
    expect(result.current.error?.message).toBe('getter exploded');
    expect(result.current.results).toEqual([]);
    expect(result.current.loading).toBe(false);
  });

  it('does not reset the searcher (word-mode token cache) on a query change (F7)', async () => {
    const config = { ...CONFIG, useWorker: false, fuzzyMode: 'word' as const };
    const update = jest.spyOn(ExSearch.prototype, 'updateConfig');
    const setData = jest.spyOn(ExSearch.prototype, 'setData');
    let query = 'alice';
    const { result, rerender } = renderHook(() => useExSearchAsync(DATA, query, config));
    await waitFor(() => expect(result.current.results.length).toBeGreaterThan(0));
    for (const q of ['alici', 'bob', 'alic']) {
      query = q;
      rerender();
      await waitFor(() => expect(result.current.loading).toBe(false));
    }
    expect(setData).toHaveBeenCalledTimes(1);
    expect(update).not.toHaveBeenCalled();
  });

  it('still applies a changed data or config identity', async () => {
    let data = DATA;
    let config: SearchConfig<Person> = { ...CONFIG, useWorker: false };
    const { result, rerender } = renderHook(() => useExSearchAsync(data, 'bob', config));
    await waitFor(() => expect(result.current.results).toHaveLength(1));
    data = [{ name: 'Bobby' }, { name: 'Bob' }];
    rerender();
    await waitFor(() => expect(result.current.results).toHaveLength(2));
    config = { ...config, threshold: 0.99 };
    rerender();
    await waitFor(() => expect(result.current.results).toHaveLength(1));
  });
});

describe('useExSearch', () => {
  it('keeps one searcher per (data, config) across query changes (F7)', () => {
    const config = { keys: [{ name: 'name' as const, weight: 1 }], fuzzyMode: 'word' as const };
    const setData = jest.spyOn(ExSearch.prototype, 'setData');
    let query = 'alice';
    const { result, rerender } = renderHook(() => useExSearch(DATA, query, config));
    expect(result.current.map((r) => r.name)).toContain('Alice');
    query = 'bob';
    rerender();
    expect(result.current.map((r) => r.name)).toEqual(['Bob']);
    expect(setData).toHaveBeenCalledTimes(1);
    setData.mockRestore();
  });
});
