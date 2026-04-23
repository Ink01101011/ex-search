import { search, createSearch } from '../src/core/search';

interface Branch {
  id: string;
  name: string;
  address: string;
}

const branches: Branch[] = [
  { id: '001', name: 'สาขาสยามพารากอน', address: '991 ถ.พระราม 1 ปทุมวัน' },
  { id: '002', name: 'สาขาลาดพร้าว', address: '1693 ถ.พหลโยธิน จตุจักร' },
  { id: '003', name: 'สาขาเชียงใหม่', address: '86 ถ.ช้างคลาน เมือง เชียงใหม่' },
];

const config = {
  keys: [
    { name: 'name' as const, weight: 1.0 },
    { name: 'address' as const, weight: 0.5 },
  ],
  threshold: 0.3,
};

describe('search()', () => {
  it('returns empty array for empty query', () => {
    expect(search(branches, '', config)).toEqual([]);
    expect(search(branches, '   ', config)).toEqual([]);
  });

  it('finds exact match first', () => {
    const results = search(branches, 'สาขาสยามพารากอน', config);
    expect(results[0].id).toBe('001');
    expect(results[0].score).toBe(1.0);
  });

  it('attaches score and fieldMatches to each result', () => {
    // 'สยาม' is a substring of 'สาขาสยามพารากอน' → contains match
    const results = search(branches, 'สยาม', config);
    expect(results[0].score).toBeGreaterThan(0);
    expect(results[0].fieldMatches).toHaveLength(2);
    expect(results[0].fieldMatches[0].matchType).toBe('contains');
  });

  it('sets exFlowPriority = Math.round(score * 100)', () => {
    const results = search(branches, 'สยาม', config);
    expect(results[0].exFlowPriority).toBe(Math.round(results[0].score * 100));
  });

  it('sorts results by score descending', () => {
    const results = search(branches, 'สาขา', config);
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
    }
  });

  it('filters out results below threshold', () => {
    const results = search(branches, 'สยาม', { ...config, threshold: 0.9 });
    results.forEach((r) => expect(r.score).toBeGreaterThanOrEqual(0.9));
  });

  it('works with timSort algorithm', () => {
    const results = search(branches, 'สาขา', { ...config, sortAlgorithm: 'tim' });
    expect(results.length).toBeGreaterThan(0);
  });
});

describe('createSearch() / ExSearch', () => {
  it('returns the same results as search()', () => {
    const searcher = createSearch<Branch>(config);
    searcher.setData(branches);
    const r1 = searcher.search('สยาม');
    const r2 = search(branches, 'สยาม', config);
    expect(r1.map((r) => r.id)).toEqual(r2.map((r) => r.id));
  });

  it('supports chained setData + search', () => {
    // 'ลาดพร้าว' is a substring of 'สาขาลาดพร้าว' → contains match
    const results = createSearch<Branch>(config).setData(branches).search('ลาดพร้าว');
    expect(results[0].id).toBe('002');
  });

  it('updateConfig changes threshold', () => {
    const searcher = createSearch<Branch>(config).setData(branches);
    const low = searcher.search('เชียงใหม่');
    searcher.updateConfig({ threshold: 0.95 });
    const high = searcher.search('เชียงใหม่');
    expect(high.length).toBeLessThanOrEqual(low.length);
  });
});
