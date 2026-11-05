import { createSearch } from '../src';

interface Branch {
  id: string;
  name: string;
  address: string;
}

const branches: Branch[] = [
  { id: '001', name: 'สาขาสยามพารากอน', address: '991 ถ.พระราม 1 ปทุมวัน' },
  { id: '002', name: 'สาขาเซ็นทรัลลาดพร้าว', address: '1693 ถ.พหลโยธิน จตุจักร' },
  { id: '003', name: 'สาขาเชียงใหม่', address: '86 ถ.ช้างคลาน เมือง เชียงใหม่' },
];

describe('README examples', () => {
  it('section 2: a one-character typo of a whole value still matches via the fuzzy tier', () => {
    const searcher = createSearch<Branch>({
      keys: [
        { name: 'name', weight: 1.0 },
        { name: 'address', weight: 0.5 },
      ],
      threshold: 0.3,
      sortAlgorithm: 'radix',
    });
    searcher.setData(branches);

    const r3 = searcher.search('สาขาสยามพารากอม'); // last letter mistyped: whole-value distance 1
    expect(r3.map((r) => r.id)).toEqual(['001']);
    expect(r3[0].fieldMatches.find((m) => m.key === 'name')?.matchType).toBe('fuzzy');
  });
});
