import { canNarrow, createSearch, ExSearch, search, searchWithRows, __WORKER_SOURCE__ } from '../src/core/search';
import { createKernel } from '../src/core/kernel';
import { tokenize } from './helpers/tokenize';
import type { SearchConfig, SearchResult } from '../src/types';

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

function makeData(rnd: () => number, n: number): Row[] {
  const out: Row[] = [];
  for (let i = 0; i < n; i++) out.push({ id: i, a: makeText(rnd), b: makeText(rnd) }); // 1.x: a null row throws
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
    const tokens = tokenize(text);
    const start = tokens.length === 1 && tokens[0] === text ? 1 : 0;
    for (let i = start; i < tokens.length; i++) score = Math.max(score, fz(tokens[i]));
  }
  return score;
}

function referenceIds(data: Row[], query: string, cfg: SearchConfig<Row>): Set<number> {
  const out = new Set<number>();
  const cs = cfg.caseSensitive ?? false;
  if (!query.trim()) return out;
  const q = cs ? query : query.toLowerCase(); // 1.x does not trim the query
  for (const row of data) {
    let best = -Infinity;
    for (const k of cfg.keys) {
      const raw = String(row[k.name] ?? ''); // 1.x text derivation
      const text = cs ? raw : raw.toLowerCase();
      const s = referenceScore(text, q, cfg.fuzzyMaxDistance ?? 3, cfg.fuzzyMode === 'word');
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
      const tokens = tokenize(text);
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

  it('indexes words that start past 65 535 code units', () => {
    const k = createKernel();
    const long = 'a'.repeat(70000) + ' somchai';
    const idx = k.buildWordIndex([{ n: long }, { n: 'x y' }], [{ name: 'n', weight: 1 }], false)!;
    // 4 bytes follow: start 0, then the gap 70001 (doubled) as a three-byte varint. Then the entry of 'x y'.
    expect(Array.from(idx.data)).toEqual([8, 0, 0xe2, 0xc5, 0x08, 4, 0, 4]);
    const data = [{ name: long }, { name: 'x y' }];
    const s = createSearch({ keys: [{ name: 'name', weight: 1 }], fuzzyMode: 'word' }).setData(data);
    expect(s.search('somchay')).toEqual(
      search(data, 'somchay', { keys: [{ name: 'name', weight: 1 }], fuzzyMode: 'word' }),
    );
    expect(s.search('somchay')).toHaveLength(1);
  });

  it('stays compact: one byte per word start, single-word cells left out', () => {
    const k = createKernel();
    const texts = ['alpha', 'beta gamma', '  delta', 'eps'];
    const pq = [
      { name: 'p', weight: 1 },
      { name: 'q', weight: 1 },
    ];
    const idx = k.buildWordIndex(
      [
        { p: texts[0], q: texts[1] },
        { p: texts[2], q: texts[3] },
      ],
      pq,
      false,
    )!;
    // One block: number 0, entries from offset 0, cells 1 and 2 indexed.
    expect(Array.from(idx.blocks)).toEqual([0, 0, 0b0110, 0]);
    // 'beta gamma': 2 bytes follow, words at 0 and +5 after one space. '  delta': 1 byte follows, a word at 2.
    expect(Array.from(idx.data)).toEqual([4, 0, 10, 2, 2]);
    // One code unit of whitespace after the last word, and a separator of 3 code units before 'gamma'.
    const flagged = k.buildWordIndex([{ p: 'beta \t gamma ' }], [pq[0]], false)!;
    expect(Array.from(flagged.data)).toEqual([9, 1, 0, 15, 3]);
  });

  it('keeps nothing when every cell is a single word', () => {
    const k = createKernel();
    const data = Array.from({ length: 5000 }, (_, r) => ({ p: `w${r}p`, q: `w${r}q`, n: r, missing: null }));
    const keys = ['p', 'q', 'n', 'missing'].map((name) => ({ name, weight: 1 }));
    const idx = k.buildWordIndex(data, keys, false)!;
    expect(idx.blocks.byteLength + idx.data.byteLength).toBe(0);
  });

  it('takes at most 2 bytes per cell on name-like data (issue #22)', () => {
    const k = createKernel();
    const rows = 20000;
    const data = Array.from({ length: rows }, (_, r) => ({
      name: `Somchai Jaidee ${r}`,
      email: `somchai.${r}@example.com`,
      city: 'Hat Yai',
      status: 'active',
    }));
    const keys = ['name', 'email', 'city', 'status'].map((name) => ({ name, weight: 1 }));
    const idx = k.buildWordIndex(data, keys, false)!;
    const bytes = idx.blocks.byteLength + idx.data.byteLength;
    expect(bytes / (rows * 4)).toBeLessThanOrEqual(2);
  });

  it('finds the words of a cell wherever it sits in its block of 64, in any row subset', () => {
    // 1 key, so cell === row. Every third row is multi-word; the rest are one word.
    const rnd = prng(22);
    const data: Array<{ id: number; name: string }> = [];
    for (let r = 0; r < 400; r++) {
      const pad = ' '.repeat(Math.floor(rnd() * 3));
      data.push({ id: r, name: r % 3 === 0 ? `${pad}mr${r}  somchai\tjaidee ${pad}` : `solo${r}` });
    }
    const cfg = { keys: [{ name: 'name' as const, weight: 1 }], fuzzyMode: 'word' as const };
    const s = createSearch(cfg).setData(data);
    const full = s.searchWithRows('somchay');
    expect(Array.from(full.rows).sort((x, y) => x - y)).toEqual(data.filter((d) => d.id % 3 === 0).map((d) => d.id));
    expect(full.results).toEqual(search(data, 'somchay', cfg));
    for (let round = 0; round < 200; round++) {
      const within: number[] = [];
      for (let r = 0; r < 400; r++) if (rnd() < 0.05) within.push(r);
      within.push(63, 64, 127, 128, 399);
      const got = s.searchWithRows('somchay', { within });
      const want = searchWithRows(data, 'somchay', cfg, { within });
      expect(Array.from(got.rows)).toEqual(Array.from(want.rows));
      expect(got.results).toEqual(want.results);
    }
  });

  it('reads multi-byte word starts (63 / 64 / 127 / 128 / 16383 / 16384)', () => {
    const cfg = { keys: [{ name: 'name' as const, weight: 1 }], fuzzyMode: 'word' as const };
    for (const gap of [
      61,
      62,
      63,
      64,
      65,
      126,
      127,
      128,
      129,
      8190,
      8191,
      8192,
      8193,
      16382,
      16383,
      16384,
      16385,
      2 ** 21 - 1,
      2 ** 21,
    ]) {
      const data = [
        { name: 'x'.repeat(gap - 1) + ' somchai ' + 'y'.repeat(gap) + '\n\njaidee  ' },
        { name: 'solo' },
        { name: 'q'.repeat(gap) + ' boonmee' },
      ];
      const s = createSearch(cfg).setData(data);
      for (const q of ['somchay', 'jaidea', 'boonmea']) {
        const got = s.searchWithRows(q);
        const want = searchWithRows(data, q, cfg);
        expect(Array.from(got.rows)).toEqual(Array.from(want.rows));
        expect(got.results.map((r) => r.score)).toEqual(want.results.map((r) => r.score));
        expect(got.rows.length).toBe(1);
      }
    }
  });

  it('costs only what the indexed cells cost when most rows are missing', () => {
    const k = createKernel();
    const keys = [{ name: 'name', weight: 1 }];
    const cfg = { keys: [{ name: 'name' as const, weight: 1 }], fuzzyMode: 'word' as const };
    const sparse: Array<{ name: string }> = [];
    sparse[70] = { name: 'mr somchai jaidee' };
    sparse[250000] = { name: 'ms somchai boonmee' };
    sparse[500000] = { name: 'dr somchai rakthai' };
    const idx = k.buildWordIndex(sparse, keys, false)!;
    // Three blocks of 64 cells are listed, not the 7813 that span the array.
    expect(Array.from(idx.blocks.filter((_, i) => i % 4 === 0))).toEqual([1, 3906, 7812]);
    expect(idx.blocks.byteLength + idx.data.byteLength).toBeLessThan(64);
    const s = createSearch(cfg).setData(sparse);
    const within = [70, 250000, 500000];
    expect(s.search('somchay', { within })).toEqual(search(sparse, 'somchay', cfg, { within }));
    expect(s.search('somchay', { within })).toHaveLength(3);
  });

  it('indexes dense rows that follow a long run of missing rows', () => {
    const k = createKernel();
    const keys = [{ name: 'name', weight: 1 }];
    const lead: Array<{ name: string } | null> = [];
    for (let r = 0; r < 6000; r++) lead.push(r < 5000 ? null : { name: `mr somchai ${r}` });
    const idx = k.buildWordIndex(lead, keys, false)!;
    expect(idx).not.toBeNull();
    expect(idx.blocks.length / 4).toBe(16); // rows 5000..5999 fall in 16 blocks of 64
    expect(idx.blocks[0]).toBe(5000 >>> 6);
  });

  it('stores the whitespace of padded and many-word values instead of rescanning it', () => {
    const k = createKernel();
    const cfg = { keys: [{ name: 'name' as const, weight: 1 }], fuzzyMode: 'word' as const };
    const many = Array.from({ length: 9000 }, (_, i) => `w${i}`).join('  ');
    const data = [
      { name: 'somchai'.padEnd(255, ' ') }, // a CHAR(255) column
      { name: `${many}\tsomchai   ` }, // an entry longer than 16 383 bytes
      { name: Array.from({ length: 70 }, (_, i) => `v${i}`).join(' ') + ' jaidee' }, // an entry longer than 127 bytes
      { name: 'mr  somchai\u3000jaidee \n' },
    ];
    const idx = k.buildWordIndex(data, [{ name: 'name', weight: 1 }], false)!;
    // 'somchai' + 248 spaces: 3 bytes follow (the 248 as two bytes, then start 0).
    expect(Array.from(idx.data.subarray(0, 4))).toEqual([7, 0xf8, 0x01, 0]);
    const s = createSearch(cfg).setData(data);
    for (const q of ['somchay', 'jaidea', 'w8999x', 'v69x', 'w0x']) {
      const got = s.searchWithRows(q);
      const want = searchWithRows(data, q, cfg);
      expect(Array.from(got.rows)).toEqual(Array.from(want.rows));
      expect(got.results.map((r) => r.score)).toEqual(want.results.map((r) => r.score));
      expect(got.rows.length).toBeGreaterThan(0);
    }
    // Every row subset, in every order the wrapper allows, lands on the right entry.
    for (let mask = 1; mask < 16; mask++) {
      const within = [0, 1, 2, 3].filter((r) => mask & (1 << r));
      for (const q of ['somchay', 'jaidea']) {
        expect(s.searchWithRows(q, { within }).results).toEqual(searchWithRows(data, q, cfg, { within }).results);
      }
    }
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
        const allowed = new Set(within.filter((r) => Number.isInteger(r)).map((r) => data[r]?.id));
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
    // Descending with duplicates: exercises normalisation.
    const within = [70, 3, 55, 3, 41, 12, 9, 200, -1];
    const sync = createSearch(cfg).setData(data).search('somchay', { within });
    expect(sync.length).toBeGreaterThan(3);

    expect(await createSearch(cfg).setData(data).searchAsync('somchay', { within })).toEqual(sync);

    // Coverage instrumentation injects counters the evaluated worker source lacks.
    if (typeof (globalThis as { __coverage__?: unknown }).__coverage__ !== 'undefined') return;
    const g = globalThis as Record<string, unknown>;
    const saved = { Worker: g.Worker, create: URL.createObjectURL, revoke: URL.revokeObjectURL };
    let posted = 0;
    g.Worker = class {
      onmessage: ((e: { data: unknown }) => void) | null = null;
      private readonly self: { onmessage?: (e: { data: unknown }) => void; postMessage: (r: unknown) => void };
      constructor() {
        this.self = { postMessage: (r) => queueMicrotask(() => this.onmessage?.({ data: structuredClone(r) })) };
        new Function('self', __WORKER_SOURCE__)(this.self);
      }
      postMessage(m: unknown) {
        posted++;
        this.self.onmessage!({ data: structuredClone(m) });
      }
      terminate() {}
    };
    URL.createObjectURL = () => 'blob:test';
    URL.revokeObjectURL = () => undefined;
    try {
      const s = new ExSearch({ ...cfg, useWorker: true }).setData(data);
      expect(await s.searchAsync('somchay', { within })).toEqual(sync);
      expect(posted).toBe(1);
    } finally {
      g.Worker = saved.Worker;
      URL.createObjectURL = saved.create;
      URL.revokeObjectURL = saved.revoke;
    }
  });
});

describe('canNarrow', () => {
  const keys = [{ name: 'name' as const, weight: 1 }];

  it('answers the documented cases', () => {
    expect(canNarrow('name 12', 'name 123', { keys, fuzzyMaxDistance: 0 })).toBe(true);
    expect(canNarrow('Name 12', 'name 123', { keys, fuzzyMaxDistance: 0 })).toBe(true);
    expect(canNarrow('name 12 ', 'name 123', { keys, fuzzyMaxDistance: 0 })).toBe(false); // 1.x keeps the space
    expect(canNarrow('na', 'nam', { keys: [{ name: 'name' as const, weight: -1 }], fuzzyMaxDistance: 0 })).toBe(false);
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
      data.forEach((r, i) => rowOf.set(r!.id, i));
      const values = data
        .flatMap((row) => (row ? [row.a, row.b] : []))
        .filter((v) => typeof v === 'string') as string[];
      for (let i = 0; i < 30; i++) {
        let prev = makeQuery(rnd);
        let next: string;
        const r = rnd();
        if (r < 0.5 && values.length > 0) {
          // next = a whole cell value (exact hits exist), prev = a prefix or an inner substring of it
          next = values[Math.floor(rnd() * values.length)];
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

/** Installs a browser-like Worker that runs the real worker source; returns a restore function. */
function installWorker(): () => void {
  const g = globalThis as Record<string, unknown>;
  const saved = { Worker: g.Worker, create: URL.createObjectURL, revoke: URL.revokeObjectURL };
  g.Worker = class {
    onmessage: ((e: { data: unknown }) => void) | null = null;
    private readonly self: { onmessage?: (e: { data: unknown }) => void; postMessage: (r: unknown) => void };
    constructor() {
      this.self = { postMessage: (r) => queueMicrotask(() => this.onmessage?.({ data: structuredClone(r) })) };
      new Function('self', __WORKER_SOURCE__)(this.self);
    }
    postMessage(m: unknown) {
      this.self.onmessage!({ data: structuredClone(m) });
    }
    terminate() {}
  };
  URL.createObjectURL = () => 'blob:test';
  URL.revokeObjectURL = () => undefined;
  return () => {
    g.Worker = saved.Worker;
    URL.createObjectURL = saved.create;
    URL.revokeObjectURL = saved.revoke;
  };
}

describe('searchWithRows', () => {
  it('returns search() results plus the data index of each one (randomised)', () => {
    const rnd = prng(31);
    for (let round = 0; round < 30; round++) {
      const data = makeData(rnd, 120);
      const cfg = makeConfig(rnd);
      const s = createSearch(cfg).setData(data);
      for (let i = 0; i < 10; i++) {
        const q = makeQuery(rnd);
        const within = rnd() < 0.5 ? randomWithin(rnd, data.length) : undefined;
        const opts = within && { within };
        const { results, rows } = s.searchWithRows(q, opts);
        expect(rows).toBeInstanceOf(Uint32Array);
        expect(results).toEqual(s.search(q, opts));
        expect(rows).toHaveLength(results.length);
        results.forEach((r, j) => expect((r as unknown as Row).id).toBe(data[rows[j]].id));
        expect(searchWithRows(data, q, cfg, opts)).toEqual({ results, rows });
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
      const s = createSearch(cfg).setData(data);
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

  it('searchAsyncWithRows: results equal searchAsync, rows point at them (fallback and Worker)', async () => {
    const rnd = prng(5);
    const data = makeData(rnd, 80);
    const cfg: SearchConfig<Row> = { ...makeConfig(rnd), fuzzyMode: 'word', fuzzyMaxDistance: 2, threshold: 0 };
    const within = [70, 3, 55, 3, 41, 12, 9, 200, -1];
    const sync = createSearch(cfg).setData(data).searchWithRows('somchay', { within });
    expect(sync.rows.length).toBeGreaterThan(3);
    expect(await createSearch(cfg).setData(data).searchAsyncWithRows('somchay', { within })).toEqual(sync);

    if (typeof (globalThis as { __coverage__?: unknown }).__coverage__ !== 'undefined') return;
    const restore = installWorker();
    try {
      const s = new ExSearch({ ...cfg, useWorker: true }).setData(data);
      for (const opts of [{ within }, undefined]) {
        const { results, rows } = await s.searchAsyncWithRows('somchay', opts);
        expect(results).toEqual(await s.searchAsync('somchay', opts));
        expect(results.length).toBeGreaterThan(3);
        results.forEach((r, j) => expect((r as unknown as Row).id).toBe(data[rows[j]].id));
      }
    } finally {
      restore();
    }
  });

  it('ends a word where its separator starts, however long the separator is', () => {
    const cfg = { keys: [{ name: 'name' as const, weight: 1 }], fuzzyMode: 'word' as const, threshold: 0.2 };
    const data = [{ name: 'ab  cd' }, { name: 'zz \t\n ab   ' }];
    const s = createSearch(cfg).setData(data);
    // 'ax' is 1 edit from 'ab' but 2 from 'ab ': a word that kept one unit of
    // its separator would fall under the threshold.
    const got = s.searchWithRows('ax');
    expect(Array.from(got.rows)).toEqual([0, 1]);
    expect(got.results.map((r) => r.score)).toEqual(searchWithRows(data, 'ax', cfg).results.map((r) => r.score));
  });
});
