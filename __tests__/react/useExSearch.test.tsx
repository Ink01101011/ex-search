/**
 * @jest-environment jsdom
 */
import { renderHook } from '@testing-library/react';
import { useExSearch } from '../../src/react/hooks/useExSearch';

interface Person {
  id: string;
  name: string;
  city: string;
}

const DATA: Person[] = [
  { id: '1', name: 'Alice', city: 'Bangkok' },
  { id: '2', name: 'Bob', city: 'Chiang Mai' },
  { id: '3', name: 'Charlie', city: 'Phuket' },
  { id: '4', name: 'David', city: 'Bangkok' },
];

const CONFIG = {
  keys: [
    { name: 'name' as const, weight: 1.0 },
    { name: 'city' as const, weight: 0.5 },
  ],
  threshold: 0.3,
};

describe('useExSearch', () => {
  it('returns empty array for empty query', () => {
    const { result } = renderHook(() => useExSearch(DATA, '', CONFIG));
    expect(result.current).toEqual([]);
  });

  it('returns empty array for whitespace-only query', () => {
    const { result } = renderHook(() => useExSearch(DATA, '   ', CONFIG));
    expect(result.current).toEqual([]);
  });

  it('returns matching result for exact query', () => {
    const { result } = renderHook(() => useExSearch(DATA, 'Alice', CONFIG));
    expect(result.current).toHaveLength(1);
    expect(result.current[0].name).toBe('Alice');
  });

  it('result has score, exFlowPriority, and fieldMatches', () => {
    const { result } = renderHook(() => useExSearch(DATA, 'Alice', CONFIG));
    const item = result.current[0];
    expect(typeof item.score).toBe('number');
    expect(typeof item.exFlowPriority).toBe('number');
    expect(Array.isArray(item.fieldMatches)).toBe(true);
  });

  it('returns results sorted by score descending', () => {
    // 'Bangkok' matches city of Alice and David; name field has weight 1.0 so
    // exact name match scores higher than city substring match
    const { result } = renderHook(() => useExSearch(DATA, 'Bangkok', CONFIG));
    const scores = result.current.map((r) => r.score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
  });

  it('updates results when query changes', () => {
    let query = 'Alice';
    const { result, rerender } = renderHook(() => useExSearch(DATA, query, CONFIG));
    expect(result.current[0].name).toBe('Alice');

    query = 'Bob';
    rerender();
    expect(result.current[0].name).toBe('Bob');
  });

  it('updates results when data changes', () => {
    let data = DATA;
    const { result, rerender } = renderHook(() => useExSearch(data, 'Alice', CONFIG));
    expect(result.current).toHaveLength(1);

    data = [...DATA, { id: '5', name: 'Alice Wong', city: 'Pattaya' }];
    rerender();
    expect(result.current).toHaveLength(2);
  });

  it('filters out results below threshold', () => {
    const strictConfig = { ...CONFIG, threshold: 0.9 };
    const { result } = renderHook(() => useExSearch(DATA, 'Alice', strictConfig));
    // Only exact match (score 1.0) passes threshold 0.9
    expect(result.current).toHaveLength(1);
    expect(result.current[0].score).toBeGreaterThanOrEqual(0.9);
  });
});
