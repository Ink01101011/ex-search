import { createKernel, type KernelConfig } from '../src/core/kernel';
import { Scorer } from '../src/core/scorer';
import { ExSearch, search } from '../src/core/search';
import { FakeWorker, installFakeWorker } from './helpers/fakeWorker';

// Deterministic PRNG so failures reproduce.
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function randomString(rand: () => number, len: number, alphabet: string): string {
  let out = '';
  for (let i = 0; i < len; i++) out += alphabet[Math.floor(rand() * alphabet.length)];
  return out;
}

// Plain O(n·m) Wagner–Fischer over UTF-16 code units.
function referenceDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1), prev[j] + 1, cur[j - 1] + 1);
    }
    prev = cur;
  }
  return prev[b.length];
}

type Person = { id: number; name: string; city: string; note: string };

const CITIES = ['bangkok', 'chiang mai', 'khon kaen', 'phuket'];
const PEOPLE: Person[] = Array.from({ length: 60 }, (_, i) => ({
  id: i,
  name: `name ${(i * 37) % 60}`,
  city: CITIES[i % CITIES.length],
  note: i % 7 === 0 ? 'nama here' : `row ${i}`,
}));
const KEYS = [
  { name: 'name' as const, weight: 1 },
  { name: 'city' as const, weight: 0.8 },
  { name: 'note' as const, weight: 0.5 },
];

/** `data` behind a Proxy that counts how often each row is read by index. */
function counted<T>(data: T[]): { view: T[]; reads: Map<number, number>; total: () => number } {
  const reads = new Map<number, number>();
  const view = new Proxy(data, {
    get(target, prop, receiver) {
      if (typeof prop === 'string' && /^\d+$/.test(prop)) reads.set(+prop, (reads.get(+prop) ?? 0) + 1);
      return Reflect.get(target, prop, receiver);
    },
  });
  return { view, reads, total: () => [...reads.values()].reduce((a, b) => a + b, 0) };
}

describe('a row is read once per search (#25)', () => {
  for (const fuzzyMode of ['value', 'word'] as const) {
    it(`fuzzyMode '${fuzzyMode}': one read per row, hits included, same results as a plain array`, () => {
      const c = counted(PEOPLE);
      const config = { keys: KEYS, fuzzyMode };
      const engine = new ExSearch<Person>(config).setData(c.view);

      const first = engine.searchWithRows('nama');
      expect(first.results.length).toBeGreaterThan(0);
      // In word mode the first search also builds the word index: one more read per row.
      const builds = fuzzyMode === 'word' ? 2 : 1;
      expect(c.total()).toBe(builds * PEOPLE.length);
      expect([...c.reads.values()].every((n) => n === builds)).toBe(true);

      c.reads.clear();
      const second = engine.searchWithRows('nama');
      expect(c.total()).toBe(PEOPLE.length);
      expect([...c.reads.values()].every((n) => n === 1)).toBe(true);

      const plain = new ExSearch<Person>(config).setData(PEOPLE).searchWithRows('nama');
      expect(first).toEqual(plain);
      expect(second).toEqual(plain);
    });
  }

  it('the one-shot search() reads each row once', () => {
    const c = counted(PEOPLE);
    const results = search(c.view, 'phuket', { keys: KEYS });
    expect(results.length).toBeGreaterThan(0);
    expect(c.total()).toBe(PEOPLE.length);
    expect(results).toEqual(search(PEOPLE, 'phuket', { keys: KEYS }));
  });

  it('with `within`, reads only those rows, once each', () => {
    const c = counted(PEOPLE);
    const engine = new ExSearch<Person>({ keys: KEYS }).setData(c.view);
    const within = [3, 7, 14, 21, 40];
    const got = engine.searchWithRows('nama', { within });
    expect([...c.reads.keys()].sort((a, b) => a - b)).toEqual(within);
    expect([...c.reads.values()].every((n) => n === 1)).toBe(true);
    expect(got).toEqual(new ExSearch<Person>({ keys: KEYS }).setData(PEOPLE).searchWithRows('nama', { within }));
    expect(got.rows.length).toBeGreaterThan(0);
    for (let i = 0; i < got.rows.length; i++) expect(got.results[i].id).toBe(got.rows[i]);
  });

  it('skips null and undefined rows after a single read', () => {
    const data = [{ name: 'alice' }, null, undefined, { name: 'alicia' }] as Array<{ name: string }>;
    const c = counted(data);
    const got = new ExSearch<{ name: string }>({ keys: [{ name: 'name', weight: 1 }] })
      .setData(c.view)
      .searchWithRows('alic');
    expect(Array.from(got.rows).sort()).toEqual([0, 3]);
    expect(c.total()).toBe(4);
  });

  it('builds each result from the row that was scored', () => {
    // An array-like that hands out a fresh object per read: a second read of a
    // hit row would give a different object than the one that was scored.
    let serial = 0;
    const view = new Proxy([] as Array<{ name: string; serial: number }>, {
      get(target, prop, receiver) {
        if (prop === 'length') return 3;
        if (typeof prop === 'string' && /^\d+$/.test(prop)) return { name: `alice ${prop}`, serial: ++serial };
        return Reflect.get(target, prop, receiver);
      },
    });
    const got = new ExSearch<{ name: string; serial: number }>({ keys: [{ name: 'name', weight: 1 }] })
      .setData(view)
      .search('alice');
    expect(got.map((r) => r.serial).sort()).toEqual([1, 2, 3]);
    expect(serial).toBe(3);
  });

  describe('through a Worker', () => {
    let restore: () => void;
    beforeAll(() => {
      restore = installFakeWorker();
    });
    afterAll(() => restore());
    beforeEach(() => FakeWorker.reset());

    it('reads each row once and matches the synchronous results', async () => {
      const c = counted(PEOPLE);
      const engine = new ExSearch<Person>({ keys: KEYS, useWorker: true }).setData(c.view);
      const got = await engine.searchAsyncWithRows('nama');
      expect(FakeWorker.all).toHaveLength(1);
      expect(c.total()).toBe(PEOPLE.length);
      expect(got.results.length).toBeGreaterThan(0);
      expect(got).toEqual(new ExSearch<Person>({ keys: KEYS }).setData(PEOPLE).searchWithRows('nama'));
    });

    it('with `within`, reads only those rows and reports their data indices', async () => {
      const c = counted(PEOPLE);
      const engine = new ExSearch<Person>({ keys: KEYS, useWorker: true }).setData(c.view);
      const within = [40, 3, 21, 7, 14, 7];
      const got = await engine.searchAsyncWithRows('nama', { within });
      expect(FakeWorker.all).toHaveLength(1);
      expect([...c.reads.keys()].sort((a, b) => a - b)).toEqual([3, 7, 14, 21, 40]);
      expect([...c.reads.values()].every((n) => n === 1)).toBe(true);
      expect(got).toEqual(new ExSearch<Person>({ keys: KEYS }).setData(PEOPLE).searchWithRows('nama', { within }));
      for (let i = 0; i < got.rows.length; i++) expect(got.results[i].id).toBe(got.rows[i]);
    });
  });
});

describe('scoreRows onHit', () => {
  it('is called once per hit, after the last text of that row and before the next row', () => {
    const k = createKernel();
    const texts = ['apple', 'pear', 'apple pie', 'plum', 'apples'];
    const log: string[] = [];
    const config: KernelConfig = {
      keys: [
        { name: 'a', weight: 1 },
        { name: 'b', weight: 1 },
      ],
      threshold: 0.5,
      fuzzyMaxDistance: 0,
      caseSensitive: false,
      fuzzyMode: 'value',
    };
    const hits = k.scoreRows(
      (row, key) => {
        log.push(`${row}.${key}`);
        return key === 0 ? texts[row] : 'x';
      },
      texts.length,
      'apple',
      config,
      null,
      null,
      () => log.push('hit'),
    );
    expect(hits.map((h) => h.row)).toEqual([0, 2, 4]);
    expect(log).toEqual(['0.0', '0.1', 'hit', '1.0', '1.1', '2.0', '2.1', 'hit', '3.0', '3.1', '4.0', '4.1', 'hit']);
  });
});

describe('the exact tiers from one search of the text', () => {
  it('gives exact / startsWith / contains / none exactly as ===, startsWith and includes do', () => {
    const k = createKernel();
    const rand = rng(2511);
    const alphabet = 'ab ';
    const texts = ['', 'a', 'ab', 'aba', ' ab', 'ab '];
    for (let i = 0; i < 400; i++) texts.push(randomString(rand, Math.floor(rand() * 7), alphabet));
    const config: KernelConfig = {
      keys: [{ name: 't', weight: 1 }],
      threshold: 0,
      fuzzyMaxDistance: 0,
      caseSensitive: true,
      fuzzyMode: 'value',
    };
    for (const query of ['', 'a', 'ab', 'aba', 'b a', 'abab', ' ']) {
      const hits = k.scoreRows((row) => texts[row], texts.length, query, config, null);
      expect(hits).toHaveLength(texts.length);
      for (const hit of hits) {
        const text = texts[hit.row];
        const expected =
          text === query
            ? ['exact', 100]
            : text.startsWith(query)
              ? ['startsWith', 80]
              : text.includes(query)
                ? ['contains', 65]
                : ['none', 0];
        expect([hit.fieldMatches[0].matchType, hit.fieldMatches[0].rawScore]).toEqual(expected);
      }
    }
  });
});

describe('the bitmask table of the matcher', () => {
  // Code units that share their low byte (0x61), so they meet in one slot of
  // the table, next to ordinary Latin and Thai letters.
  const CLASH = String.fromCharCode(0x61, 0x161, 0x261, 0xe61, 0xff61);
  const ALPHABET = CLASH + 'bcสยาม ';

  it('levenshtein matches the reference when code units share a table slot', () => {
    const rand = rng(77);
    for (let i = 0; i < 1500; i++) {
      const a = randomString(rand, Math.floor(rand() * 40), ALPHABET);
      const b = randomString(rand, Math.floor(rand() * 40), ALPHABET);
      expect(Scorer.levenshtein(a, b)).toBe(referenceDistance(a, b));
    }
  });

  it('a one-off comparison leaves nothing behind for the next one', () => {
    // Each call uses the same table; a slot left over from 'aš…' would change 'ɡ…'.
    const [a, s, g] = [CLASH[0], CLASH[1], CLASH[2]];
    expect(Scorer.levenshtein(a + s + a + s, s + a + s + a)).toBe(2);
    expect(Scorer.levenshtein(g + g, a + s)).toBe(2);
    expect(Scorer.levenshtein(g + g, g + g + a)).toBe(1);
    expect(Scorer.levenshtein('abc', 'abc' + s)).toBe(1);
    expect(Scorer.levenshtein('xyz', 'abc')).toBe(3);
  });

  /** `s` after `edits` random substitutions, insertions or deletions. */
  function edit(rand: () => number, s: string, edits: number): string {
    let out = s;
    for (let e = 0; e < edits; e++) {
      const pos = Math.floor(rand() * (out.length + 1));
      const c = ALPHABET[Math.floor(rand() * ALPHABET.length)];
      const op = Math.floor(rand() * 3);
      if (op === 0) out = out.slice(0, pos) + c + out.slice(pos);
      else if (op === 1) out = out.slice(0, pos) + out.slice(pos + 1);
      else out = out.slice(0, pos) + c + out.slice(pos + 1);
    }
    return out;
  }

  it('a matcher gives the reference distance, also between one-off comparisons', () => {
    const k = createKernel();
    const rand = rng(909);
    let within = 0;
    for (let i = 0; i < 300; i++) {
      const query = randomString(rand, 1 + Math.floor(rand() * 32), ALPHABET);
      const match = k.createMatcher(query, 4);
      for (let j = 0; j < 12; j++) {
        // Mostly the query with a few edits, so the distance is often within the bound.
        const text = j % 4 === 0 ? randomString(rand, Math.floor(rand() * 36), ALPHABET) : edit(rand, query, j % 4);
        // A one-off comparison in between must not disturb the matcher's own table.
        k.levenshtein(randomString(rand, 5, ALPHABET), text);
        const want = referenceDistance(query, text);
        const got = match(text);
        if (want <= 4) within++;
        if (want <= 4) expect(got).toBe(want);
        else expect(got).toBeGreaterThan(4);
        // A slice of a longer text is compared like the slice itself.
        const padded = `${CLASH}${text}${CLASH}`;
        const sliced = match(padded, CLASH.length, CLASH.length + text.length);
        if (want <= 4) expect(sliced).toBe(want);
        else expect(sliced).toBeGreaterThan(4);
      }
    }
    expect(within).toBeGreaterThan(2000); // most comparisons are checked for the exact distance
  });

  it('handles a 32-character query (the top bit of the mask)', () => {
    const q = 'abcdefghijklmnopqrstuvwxyz' + CLASH + 'z';
    expect(q).toHaveLength(32);
    const k = createKernel();
    const match = k.createMatcher(q, 3);
    expect(match(q)).toBe(0);
    expect(match(q.slice(0, 31) + 'y')).toBe(1);
    expect(match(q.slice(0, 30) + CLASH[1])).toBe(referenceDistance(q, q.slice(0, 30) + CLASH[1]));
    expect(Scorer.levenshtein(q, q.slice(1))).toBe(1);
  });
});
