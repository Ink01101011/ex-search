/**
 * @jest-environment jsdom
 */
import { renderHook, waitFor } from '@testing-library/react';
import { useExSearchAsync } from '../../src/react/hooks/useExSearchAsync';

interface Person {
  id: string;
  name: string;
  city: string;
}

const DATA: Person[] = [
  { id: '1', name: 'Alice', city: 'Bangkok' },
  { id: '2', name: 'Bob', city: 'Chiang Mai' },
  { id: '3', name: 'Charlie', city: 'Phuket' },
];

const CONFIG = {
  keys: [{ name: 'name' as const, weight: 1.0 }],
  threshold: 0.3,
};

describe('useExSearchAsync', () => {
  it('starts with empty results and loading false', () => {
    const { result } = renderHook(() => useExSearchAsync(DATA, '', CONFIG));
    expect(result.current.results).toEqual([]);
    expect(result.current.loading).toBe(false);
  });

  it('does not set loading for empty query', async () => {
    const { result } = renderHook(() => useExSearchAsync(DATA, '', CONFIG));
    // loading must never flip to true for an empty query
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.results).toEqual([]);
  });

  it('resolves matching results', async () => {
    const { result } = renderHook(() => useExSearchAsync(DATA, 'Alice', CONFIG));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.results).toHaveLength(1);
    expect(result.current.results[0].name).toBe('Alice');
  });

  it('result has score, exFlowPriority, and fieldMatches', async () => {
    const { result } = renderHook(() => useExSearchAsync(DATA, 'Bob', CONFIG));
    await waitFor(() => expect(result.current.loading).toBe(false));
    const item = result.current.results[0];
    expect(typeof item.score).toBe('number');
    expect(typeof item.exFlowPriority).toBe('number');
    expect(Array.isArray(item.fieldMatches)).toBe(true);
  });

  it('updates results when query changes', async () => {
    let query = 'Alice';
    const { result, rerender } = renderHook(() => useExSearchAsync(DATA, query, CONFIG));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.results[0].name).toBe('Alice');

    query = 'Bob';
    rerender();
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.results[0].name).toBe('Bob');
  });

  it('clears results when query becomes empty', async () => {
    let query = 'Alice';
    const { result, rerender } = renderHook(() => useExSearchAsync(DATA, query, CONFIG));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.results).toHaveLength(1);

    query = '';
    rerender();
    await waitFor(() => expect(result.current.results).toEqual([]));
    expect(result.current.loading).toBe(false);
  });

  it('does not throw on unmount before search resolves', () => {
    const { unmount } = renderHook(() => useExSearchAsync(DATA, 'Charlie', CONFIG));
    // Unmounting while the effect is in flight sets the cancellation flag.
    // No setState-after-unmount warning or unhandled rejection should occur.
    expect(() => unmount()).not.toThrow();
  });
});
