import { canNarrow, createSearch, ExSearch, search, searchWithRows } from '../src/core/search';
import { createKernel } from '../src/core/kernel';
import type { SearchConfig, SearchResult } from '../src/types';
import { FakeWorker, installFakeWorker } from './helpers/fakeWorker';

// ---------------------------------------------------------------------------
// Seeded random data
// ---------------------------------------------------------------------------

function prng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Row = { id: number; a: unknown; b: unknown };

const WORDS = [
  'somchai',
  'jaidee',
  'Siam',
  'paragon',
  'บางนา',
  'สยาม',
  'name',
  'name12',
  'abc',
  'abd',
  'İstanbul',
  'x',
];
const SPACES = [' ', '  ', '\t', '\n', ' ', '　', ' '];

function makeText(rnd: () => number): unknown {
  const pick = rnd();
  if (pick < 0.06) return null;
  if (pick < 0.1) return Math.floor(rnd() * 1000);
  if (pick < 0.12) return { nested: true };
  let s = rnd() < 0.2 ? SPACES[Math.floor(rnd() * SPACES.length)] : '';
  const n = 1 + Math.floor(rnd() * 4);
  for (let i = 0; i < n; i++) {
    if (i > 0) s += SPACES[Math.floor(rnd() * SPACES.length)];
    let w = WORDS[Math.floor(rnd() * WORDS.length)];
    if (rnd() < 0.3) w = w.slice(0, Math.max(1, w.length - 1)) + 'z'; // a typo
    if (rnd() < 0.2) w = w.toUpperCase();
    s += w;
  }
  if (rnd() < 0.2) s += SPACES[Math.floor(rnd() * SPACES.length)];
  return s;
}

function makeData(rnd: () => number, n: number): Array<Row | null> {
  const out: Array<Row | null> = [];
  for (let i = 0; i < n; i++) out.push(rnd() < 0.03 ? null : { id: i, a: makeText(rnd), b: makeText(rnd) });
  return out;
}

function makeQuery(rnd: () => number): string {
  const w = WORDS[Math.floor(rnd() * WORDS.length)];
  const cut = 1 + Math.floor(rnd() * w.length);
  let q = w.slice(0, cut);
  if (rnd() < 0.3) q = q.slice(0, -1) + 'q';
  if (rnd() < 0.2) q = q.toUpperCase();
  if (rnd() < 0.1) q = ` ${q} `;
  return q;
}

function makeConfig(rnd: () => number): SearchConfig<Row> {
  return {
    keys: [
      { name: 'a', weight: [1, 0.5, 0.8, 0][Math.floor(rnd() * 4)] },
      { name: 'b', weight: [1, 0.5, 0.3][Math.floor(rnd() * 3)] },
    ],
    threshold: [0, 0.2, 0.3, 0.5, 0.65, 0.8, 0.9, 1][Math.floor(rnd() * 8)],
    fuzzyMaxDistance: [0, 0, 1, 2, 3][Math.floor(rnd() * 5)],
    caseSensitive: rnd() < 0.2,
    fuzzyMode: rnd() < 0.6 ? 'word' : 'value',
    sortAlgorithm: rnd() < 0.5 ? 'radix' : 'tim',
  };
}

const ids = (rs: SearchResult<Row>[]) => rs.map((r) => (r as unknown as Row).id);

// ---------------------------------------------------------------------------
// Reference word-mode scorer (string tokens, the pre-index implementation)
// ---------------------------------------------------------------------------

const ref = createKernel();

function referenceScore(text: string, q: string, max: number, word: boolean): number {
  if (text === q) return 100;
  if (text.startsWith(q)) return 80;
  if (text.includes(q)) return 65;
  if (!(max > 0)) return 0;
  let score = 0;
  const fz = (t: string) => {
    const d = ref.levenshtein(q, t);
    return d <= max ? (1 - d / Math.max(t.length, q.length)) * 55 : 0;
  };
  score = fz(text);
  if (word) {
    const tokens = ref.tokenize(text);
    const start = tokens.length === 1 && tokens[0] === text ? 1 : 0;
    for (let i = start; i < tokens.length; i++) score = Math.max(score, fz(tokens[i]));
  }
  return score;
}

function referenceIds(data: Array<Row | null>, query: string, cfg: SearchConfig<Row>): Set<number> {
  const out = new Set<number>();
  const cs = cfg.caseSensitive ?? false;
  const q = cs ? query.trim() : query.trim().toLowerCase();
  if (!q) return out;
  for (const row of data) {
    if (row == null) continue;
    let best = -Infinity;
    for (const k of cfg.keys) {
      const raw = ref.toText(row[k.name]);
      const text = raw === null ? null : cs ? raw : raw.toLowerCase();
      const s = text === null ? 0 : referenceScore(text, q, cfg.fuzzyMaxDistance ?? 3, cfg.fuzzyMode === 'word');
      best = Math.max(best, s * k.weight);
    }
    if (best / 100 >= (cfg.threshold ?? 0.3)) out.add(row.id);
  }
  return out;
}

// ---------------------------------------------------------------------------
// #14 — compact word index
// ---------------------------------------------------------------------------

describe('word index (fuzzyMode word)', () => {
  it('finds the same words as tokenize, as offsets', () => {
    const k = createKernel();
    const rnd = prng(7);
    for (let i = 0; i < 2000; i++) {
      const text = String(makeText(rnd));
      const spans: number[] = [];
      const n = k.wordSpans(text, spans);
      const words: string[] = [];
      for (let w = 0; w < n; w++) words.push(text.slice(spans[2 * w], spans[2 * w + 1]));
      const tokens = k.tokenize(text);
      const expected = tokens.length === 1 && tokens[0] === text ? [] : tokens;
      expect(words).toEqual(expected);
    }
  });

  it('gives the same results as the string-token reference and as one-shot search (randomised)', () => {
    const rnd = prng(14);
    for (let round = 0; round < 40; round++) {
      const data = makeData(rnd, 150);
      const cfg = makeConfig(rnd);
      const s = createSearch(cfg).setData(data as Row[]);
      for (let i = 0; i < 15; i++) {
        const q = makeQuery(rnd);
        const indexed = s.search(q);
        expect(indexed).toEqual(search(data as Row[], q, cfg));
        expect(new Set(ids(indexed))).toEqual(referenceIds(data, q, cfg));
      }
    }
  });

  it('builds the index once and reuses it across queries', () => {
    const data = [{ name: 'Somchai Jaidee' }, { name: 'Somsak Rakthai' }];
    const s = createSearch({ keys: [{ name: 'name', weight: 1 }], fuzzyMode: 'word' }).setData(data);
    const spy = jest.spyOn(String.prototype, 'split');
    try {
      s.search('somchay');
      s.search('somsek');
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
    const first = (s as unknown as { _words: unknown })._words;
    s.search('jaidee');
    expect((s as unknown as { _words: unknown })._words).toBe(first);
  });

  it('is rebuilt after setData and updateConfig', () => {
    const keys = [{ name: 'name' as const, weight: 1 }];
    const s = createSearch({ keys, fuzzyMode: 'word', threshold: 0 }).setData([{ name: 'Somchai Jaidee' }]);
    expect(s.search('somchay')[0].fieldMatches[0].matchType).toBe('fuzzy');
    s.setData([{ name: 'Mali Boonmee' }]);
    expect(s.search('malu')[0].fieldMatches[0].matchType).toBe('fuzzy');
    expect(s.search('somchay')[0].fieldMatches[0].matchType).toBe('none');
    s.updateConfig({ caseSensitive: true });
    expect(s.search('Malu')[0].fieldMatches[0].matchType).toBe('fuzzy');
    expect(s.search('mali')[0].fieldMatches[0].matchType).toBe('fuzzy'); // case-sensitive now: 'mali' is 1 edit from 'Mali'
  });

  it('uses 32-bit offsets when a value is longer than 65 535 code units', () => {
    const k = createKernel();
    const long = 'a'.repeat(70000) + ' somchai';
    const idx = k.buildWordIndex((r) => [long, 'x y'][r], 2, 1, false)!;
    expect(idx.spans).toBeInstanceOf(Uint32Array);
    const data = [{ name: long }, { name: 'x y' }];
    const s = createSearch({ keys: [{ name: 'name', weight: 1 }], fuzzyMode: 'word' }).setData(data);
    expect(s.search('somchay')).toEqual(
      search(data, 'somchay', { keys: [{ name: 'name', weight: 1 }], fuzzyMode: 'word' }),
    );
    expect(s.search('somchay')).toHaveLength(1);
  });

  it('stays compact: 16-bit offsets, single-word cells left out', () => {
    const k = createKernel();
    const texts = ['alpha', 'beta gamma', '  delta', 'eps'];
    const idx = k.buildWordIndex((r, key) => texts[r * 2 + key], 2, 2, false)!;
    expect(idx.spans).toBeInstanceOf(Uint16Array);
    expect(Array.from(idx.cells)).toEqual([1, 2]);
    expect(Array.from(idx.starts)).toEqual([0, 2, 3]);
    expect(Array.from(idx.spans)).toEqual([0, 4, 5, 10, 2, 7]);
  });
});

// ---------------------------------------------------------------------------
// #15 — within + canNarrow
// ---------------------------------------------------------------------------

function randomWithin(rnd: () => number, n: number): number[] {
  const out: number[] = [];
  const len = Math.floor(rnd() * n);
  for (let i = 0; i < len; i++) {
    const p = rnd();
    if (p < 0.03) out.push(-1);
    else if (p < 0.05) out.push(n + 5);
    else if (p < 0.06) out.push(1.5);
    else if (p < 0.07) out.push(Number.NaN);
    else out.push(Math.floor(rnd() * n));
  }
  if (rnd() < 0.5) out.sort((a, b) => a - b);
  return out;
}

describe('search within a row subset', () => {
  it('equals a full search filtered to the same rows (randomised)', () => {
    const rnd = prng(15);
    for (let round = 0; round < 40; round++) {
      const data = makeData(rnd, 120);
      const cfg = makeConfig(rnd);
      const s = createSearch(cfg).setData(data as Row[]);
      for (let i = 0; i < 10; i++) {
        const q = makeQuery(rnd);
        const within = randomWithin(rnd, data.length);
        const allowed = new Set(within.filter((r) => Number.isInteger(r)).map((r) => (data[r] as Row | null)?.id));
        const expected = s.search(q).filter((r) => allowed.has((r as unknown as Row).id));
        expect(s.search(q, { within })).toEqual(expected);
        expect(s.search(q, { within: Uint32Array.from(within.filter((r) => r >= 0 && Number.isInteger(r))) })).toEqual(
          expected,
        );
        expect(search(data as Row[], q, cfg, { within })).toEqual(expected);
      }
    }
  });

  it('returns nothing for an empty subset and rejects a non-list', () => {
    const s = createSearch({ keys: [{ name: 'name', weight: 1 }] }).setData([{ name: 'apple' }]);
    expect(s.search('apple', { within: [] })).toEqual([]);
    expect(() => s.search('apple', { within: 5 as never })).toThrow(TypeError);
  });

  it('searchAsync honours within, in the Worker and in the fallback', async () => {
    const rnd = prng(99);
    const data = makeData(rnd, 80) as Row[];
    const cfg: SearchConfig<Row> = { ...makeConfig(rnd), fuzzyMode: 'word', fuzzyMaxDistance: 2, threshold: 0 };
    // Descending with duplicates: exercises normalisation and the row mapping back.
    const within = [70, 3, 55, 3, 41, 12, 9, 200, -1];
    const sync = createSearch(cfg).setData(data).search('somchay', { within });
    expect(sync.length).toBeGreaterThan(3);

    expect(await createSearch(cfg).setData(data).searchAsync('somchay', { within })).toEqual(sync);

    const restore = installFakeWorker();
    try {
      FakeWorker.reset('ok');
      const s = new ExSearch({ ...cfg, useWorker: true }).setData(data);
      expect(await s.searchAsync('somchay', { within })).toEqual(sync);
      expect(FakeWorker.all).toHaveLength(1);
    } finally {
      restore();
    }
  });
});

describe('canNarrow', () => {
  const keys = [{ name: 'name' as const, weight: 1 }];

  it('answers the documented cases', () => {
    expect(canNarrow('name 12', 'name 123', { keys, fuzzyMaxDistance: 0 })).toBe(true);
    expect(canNarrow('Name 12 ', 'name 123', { keys, fuzzyMaxDistance: 0 })).toBe(true);
    expect(canNarrow('ame 1', 'name 123', { keys, fuzzyMaxDistance: 0 })).toBe(true); // contains, threshold 0.3
    expect(canNarrow('name 12', 'name 123', { keys })).toBe(false); // fuzzy on
    expect(canNarrow('name 12', 'name 12', { keys })).toBe(true); // same query, any config
    expect(canNarrow('name 13', 'name 123', { keys, fuzzyMaxDistance: 0 })).toBe(false);
    expect(canNarrow('', 'name', { keys, fuzzyMaxDistance: 0 })).toBe(false);
    // exact (100) on next but only starts-with (80) on prev, and 0.9 sits between
    expect(canNarrow('nam', 'name', { keys, fuzzyMaxDistance: 0, threshold: 0.9 })).toBe(false);
    expect(canNarrow('ame', 'name', { keys, fuzzyMaxDistance: 0, threshold: 0.7 })).toBe(false);
    expect(createSearch({ keys, fuzzyMaxDistance: 0 }).canNarrow('na', 'nam')).toBe(true);
  });

  it('says false with fuzzy on: a longer query can match rows the shorter one missed', () => {
    const cfg = { keys, fuzzyMaxDistance: 1 };
    const data = [{ name: 'abxd' }];
    expect(search(data, 'abc', cfg)).toEqual([]); // distance 2
    expect(search(data, 'abcd', cfg)).toHaveLength(1); // distance 1
    expect(canNarrow('abc', 'abcd', cfg)).toBe(false);
  });

  it('whenever it says true, narrowing equals a cold search (randomised)', () => {
    const rnd = prng(2026);
    let trues = 0;
    for (let round = 0; round < 60; round++) {
      const data = makeData(rnd, 120);
      const cfg = makeConfig(rnd);
      if (rnd() < 0.6) cfg.fuzzyMaxDistance = 0;
      const s = createSearch(cfg).setData(data as Row[]);
      const rowOf = new Map<number, number>();
      data.forEach((r, i) => r && rowOf.set(r.id, i));
      const values = data
        .flatMap((row) => (row ? [row.a, row.b] : []))
        .filter((v) => typeof v === 'string') as string[];
      for (let i = 0; i < 30; i++) {
        let prev = makeQuery(rnd);
        let next: string;
        const r = rnd();
        if (r < 0.5 && values.length > 0) {
          // next = a whole cell value (exact hits exist), prev = a prefix or an inner substring of it
          next = values[Math.floor(rnd() * values.length)].trim();
          const from = rnd() < 0.5 ? 0 : Math.floor(rnd() * next.length);
          prev = next.slice(from, from + 1 + Math.floor(rnd() * (next.length - from)));
        } else if (r < 0.75) {
          next = prev + WORDS[Math.floor(rnd() * WORDS.length)].slice(0, 2);
        } else if (r < 0.9) {
          next = 'n' + prev.trim() + 'e';
        } else {
          next = makeQuery(rnd);
        }
        if (!s.canNarrow(prev, next)) continue;
        trues++;
        const within = ids(s.search(prev)).map((id) => rowOf.get(id)!);
        expect(s.search(next, { within })).toEqual(s.search(next));
      }
    }
    expect(trues).toBeGreaterThan(200);
  });
});

describe('searchWithRows', () => {
  it('returns search() results plus the data index of each one (randomised)', () => {
    const rnd = prng(31);
    for (let round = 0; round < 30; round++) {
      const data = makeData(rnd, 120);
      const cfg = makeConfig(rnd);
      const s = createSearch(cfg).setData(data as Row[]);
      for (let i = 0; i < 10; i++) {
        const q = makeQuery(rnd);
        const within = rnd() < 0.5 ? randomWithin(rnd, data.length) : undefined;
        const opts = within && { within };
        const { results, rows } = s.searchWithRows(q, opts);
        expect(rows).toBeInstanceOf(Uint32Array);
        expect(results).toEqual(s.search(q, opts));
        expect(rows).toHaveLength(results.length);
        results.forEach((r, j) => expect((r as unknown as Row).id).toBe((data[rows[j]] as Row).id));
        expect(searchWithRows(data as Row[], q, cfg, opts)).toEqual({ results, rows });
      }
    }
  });

  it('gives empty results and rows for a blank query', () => {
    const s = createSearch({ keys: [{ name: 'name', weight: 1 }] }).setData([{ name: 'a' }]);
    expect(s.searchWithRows('  ')).toEqual({ results: [], rows: new Uint32Array(0) });
  });

  it('feeds within directly: narrowing with rows equals a cold search when canNarrow says so', () => {
    const rnd = prng(77);
    let narrowed = 0;
    for (let round = 0; round < 30; round++) {
      const data = makeData(rnd, 120);
      const cfg = { ...makeConfig(rnd), fuzzyMaxDistance: 0 };
      const s = createSearch(cfg).setData(data as Row[]);
      let prev = '';
      let prevRows: Uint32Array | undefined;
      const word = WORDS[Math.floor(rnd() * WORDS.length)];
      for (let n = 1; n <= word.length; n++) {
        const q = word.slice(0, n);
        const opts = prevRows && s.canNarrow(prev, q) ? { within: prevRows } : undefined;
        if (opts) narrowed++;
        const { results, rows } = s.searchWithRows(q, opts);
        expect(results).toEqual(s.search(q));
        prev = q;
        prevRows = rows;
      }
    }
    expect(narrowed).toBeGreaterThan(20);
  });

  it('searchAsyncWithRows matches the sync rows, in the Worker and in the fallback', async () => {
    const rnd = prng(5);
    const data = makeData(rnd, 80) as Row[];
    const cfg: SearchConfig<Row> = { ...makeConfig(rnd), fuzzyMode: 'word', fuzzyMaxDistance: 2, threshold: 0 };
    const within = [70, 3, 55, 3, 41, 12, 9, 200, -1];
    const sync = createSearch(cfg).setData(data).searchWithRows('somchay', { within });
    expect(sync.rows.length).toBeGreaterThan(3);
    expect(await createSearch(cfg).setData(data).searchAsyncWithRows('somchay', { within })).toEqual(sync);

    const restore = installFakeWorker();
    try {
      FakeWorker.reset('ok');
      const s = new ExSearch({ ...cfg, useWorker: true }).setData(data);
      expect(await s.searchAsyncWithRows('somchay', { within })).toEqual(sync);
      expect(await s.searchAsyncWithRows('somchay')).toEqual(createSearch(cfg).setData(data).searchWithRows('somchay'));
    } finally {
      restore();
    }
  });
});
