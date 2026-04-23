import { Scorer } from '../src/core/scorer';

describe('Scorer.levenshtein', () => {
  it('returns 0 for identical strings', () => {
    expect(Scorer.levenshtein('Somchai', 'Somchai')).toBe(0);
  });

  it('returns 1 for single character substitution', () => {
    expect(Scorer.levenshtein('Somchai', 'Somchay')).toBe(1);
  });

  it('handles empty strings', () => {
    expect(Scorer.levenshtein('', 'abc')).toBe(3);
    expect(Scorer.levenshtein('abc', '')).toBe(3);
    expect(Scorer.levenshtein('', '')).toBe(0);
  });
});

describe('Scorer.exact', () => {
  it('returns 100 on exact match', () => {
    expect(Scorer.exact('สยาม', 'สยาม')).toBe(100);
  });

  it('returns 0 on mismatch', () => {
    expect(Scorer.exact('สยาม', 'ลาดพร้าว')).toBe(0);
  });

  it('is case-insensitive by default', () => {
    expect(Scorer.exact('Bangkok', 'bangkok')).toBe(100);
  });

  it('respects caseSensitive flag', () => {
    expect(Scorer.exact('Bangkok', 'bangkok', true)).toBe(0);
  });
});

describe('Scorer.startsWith', () => {
  it('returns 80 when text starts with query', () => {
    expect(Scorer.startsWith('สยามพารากอน', 'สยาม')).toBe(80);
  });

  it('returns 0 when text does not start with query', () => {
    expect(Scorer.startsWith('พารากอน', 'สยาม')).toBe(0);
  });
});

describe('Scorer.contains', () => {
  it('returns 65 when text contains the query', () => {
    expect(Scorer.contains('สาขาสยามพารากอน', 'สยาม')).toBe(65);
  });

  it('returns 0 when text does not contain the query', () => {
    expect(Scorer.contains('สาขาลาดพร้าว', 'สยาม')).toBe(0);
  });

  it('is case-insensitive by default', () => {
    expect(Scorer.contains('Bangkok Branch', 'BRANCH')).toBe(65);
  });
});

describe('Scorer.fuzzy', () => {
  it('returns 55 for identical strings (dist=0)', () => {
    expect(Scorer.fuzzy('abc', 'abc')).toBe(55);
  });

  it('returns 0 when distance exceeds fuzzyMaxDistance', () => {
    expect(Scorer.fuzzy('abc', 'xyz', 2)).toBe(0);
  });

  it('returns a value between 0 and 55 for close strings', () => {
    const score = Scorer.fuzzy('Chiangmai', 'Chiengmai');
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThanOrEqual(55);
  });
});
