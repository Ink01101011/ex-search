import type { ColumnDict, WordIndex } from '../src/core/kernel';
import { ExSearch, searchWithRows } from '../src/core/search';
import type { SearchConfig } from '../src/types';
import { FakeWorker, installFakeWorker } from './helpers/fakeWorker';

// Deterministic PRNG so failures reproduce.
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

type Row = { id: number; status: unknown; city: string; name: string; tag?: string; n: number };

const VOCAB = [
  'somchai',
  'Jaidee',
  'siam',
  'Paragon',
  'บางนา',
  'สยาม',
  'chiang',
  'mai',
  'khon',
  'kaen',
  'active',
  'x',
  'İstanbul',
  'new  york',
  ' padded ',
];
const STATUS: unknown[] = ['active', 'inactive', 'Pending', '', null, 7, true];
const N = 4000;

/** Rows whose `status`, `city`, `tag` and `n` repeat and whose `name` does not; a few rows are missing. */
function makeRows(seed: number): Row[] {
  const rand = rng(seed);
  const pick = <V>(a: V[]): V => a[Math.floor(rand() * a.length)];
  return Array.from({ length: N }, (_, i) =>
    i % 997 === 5
      ? (null as unknown as Row)
      : {
          id: i,
          status: pick(STATUS),
          city: `${pick(VOCAB)} ${pick(VOCAB)}`,
          name: `${pick(VOCAB)} ${i}`,
          tag: i % 3 ? pick(VOCAB) : undefined,
          n: i % 50,
        },
  );
}

const KEYS: SearchConfig<Row>['keys'] = [
  { name: 'status', weight: 1 },
  { name: 'city', weight: 0.85 },
  { name: 'name', weight: 0.7 },
  { name: 'tag', weight: 0.55 },
  { name: 'n', weight: 0.4 },
];
const QUERIES = [
  'siam',
  'sian',
  'activ',
  'สยาม',
  'สยา',
  'chiang mai',
  'jaidee 12',
  '7',
  'x',
  'istanbul',
  'paragom',
  '49',
];

/** The dictionaries an engine holds (after its first search). */
function dictsOf<T>(engine: ExSearch<T>): Array<ColumnDict | null> | null | undefined {
  return (engine as unknown as { _dicts: Array<ColumnDict | null> | null | undefined })._dicts;
}
function wordsOf<T>(engine: ExSearch<T>): WordIndex | null | undefined {
  return (engine as unknown as { _words: WordIndex | null | undefined })._words;
}

describe('column dictionaries (#27)', () => {
  it('encodes the keys whose texts repeat, with the narrowest ids, and leaves the others', () => {
    const engine = new ExSearch<Row>({ keys: KEYS }).setData(makeRows(1));
    expect(dictsOf(engine)).toBeUndefined(); // built on the first search
    engine.search('siam');
    const dicts = dictsOf(engine)!;
    expect(dicts.map((d) => d !== null)).toEqual([true, true, false, true, true]);
    const [status, city, , tag, n] = dicts as ColumnDict[];
    // Numbers and booleans are held as the text they are scored as; a missing value is `null`.
    expect(status.texts).toHaveLength(7);
    expect(new Set(status.texts)).toEqual(new Set(['active', 'inactive', 'Pending', '', null, '7', 'true']));
    expect(status.ids).toBeInstanceOf(Uint8Array);
    expect(city.texts.length).toBeLessThanOrEqual(VOCAB.length * VOCAB.length);
    expect(city.ids).toBeInstanceOf(Uint8Array);
    expect(tag.ids).toBeInstanceOf(Uint8Array);
    expect(n.texts).toHaveLength(50);
    for (const d of [status, city, tag, n]) expect(d.ids).toHaveLength(N);
  });

  it('uses 16-bit ids past 256 distinct texts and drops a key past one distinct text per 16 rows', () => {
    const rows = Array.from({ length: 8192 }, (_, i) => ({ a: `v${i % 300}`, b: `v${i % 512}`, c: `v${i % 513}` }));
    const engine = new ExSearch<(typeof rows)[number]>({
      keys: [
        { name: 'a', weight: 1 },
        { name: 'b', weight: 1 },
        { name: 'c', weight: 1 },
      ],
    }).setData(rows);
    engine.search('v1');
    const dicts = dictsOf(engine)!;
    expect(dicts[0]!.ids).toBeInstanceOf(Uint16Array);
    expect(dicts[0]!.texts).toHaveLength(300);
    expect(dicts[1]!.texts).toHaveLength(512); // exactly 8192 / 16
    expect(dicts[2]).toBeNull(); // one more than that
  });

  it('builds none for small data or when no key repeats', () => {
    const small = new ExSearch<Row>({ keys: KEYS }).setData(makeRows(1).slice(0, 1023));
    small.search('siam');
    expect(dictsOf(small)).toBeNull();

    const distinct = Array.from({ length: 2000 }, (_, i) => ({ name: `row ${i}` }));
    const engine = new ExSearch<{ name: string }>({ keys: [{ name: 'name', weight: 1 }] }).setData(distinct);
    engine.search('row 12');
    expect(dictsOf(engine)).toBeNull();
  });

  for (const fuzzyMode of ['value', 'word'] as const) {
    for (const caseSensitive of [false, true]) {
      it(`gives the results of a search without dictionaries (${fuzzyMode}, caseSensitive ${caseSensitive})`, () => {
        for (const sortAlgorithm of ['radix', 'tim'] as const) {
          for (const fuzzyMaxDistance of [0, 3]) {
            const config = { keys: KEYS, fuzzyMode, caseSensitive, sortAlgorithm, fuzzyMaxDistance, threshold: 0.25 };
            const data = makeRows(7);
            const engine = new ExSearch<Row>(config).setData(data);
            let hits = 0;
            for (const query of QUERIES) {
              // The one-shot function has no dictionaries and no word index.
              const want = searchWithRows(data, query, config);
              expect(engine.searchWithRows(query)).toEqual(want);
              hits += want.rows.length;
            }
            expect(hits).toBeGreaterThan(1000);
            expect(dictsOf(engine)!.filter((d) => d !== null)).toHaveLength(4);
          }
        }
      });
    }
  }

  it('gives the same results when the rows are scored in several calls, and for a narrowed call', () => {
    const config = { keys: KEYS, fuzzyMode: 'word' as const, threshold: 0.25 };
    const data = makeRows(11);
    const engine = new ExSearch<Row>(config).setData(data);
    for (const query of ['sian', 'chiang mai', 'สยา']) {
      for (let from = 0; from < N; from += 700) {
        const within = Uint32Array.from({ length: Math.min(700, N - from) }, (_, j) => from + j);
        expect(engine.searchWithRows(query, { within })).toEqual(searchWithRows(data, query, config, { within }));
      }
      const within = [5, 17, 2000, 2999];
      expect(engine.searchWithRows(query, { within })).toEqual(searchWithRows(data, query, config, { within }));
    }
  });

  it('keeps the scores of a query from call to call and drops them for another query or config', () => {
    const engine = new ExSearch<Row>({ keys: KEYS }).setData(makeRows(3));
    engine.search('siam', { within: [1, 2, 3] });
    const status = dictsOf(engine)![0]!;
    const scored = () => status.state.filter((code) => code !== 0).length;
    expect(scored()).toBeGreaterThan(0);
    expect(scored()).toBeLessThanOrEqual(3); // only the texts those three rows hold

    engine.search('siam');
    expect(scored()).toBe(status.texts.length);

    // Another query starts from nothing: a call over three rows scores at most three texts again.
    engine.search('sian', { within: [1, 2, 3] });
    expect(scored()).toBeLessThanOrEqual(3);
    // Coming back to the same query in a later call keeps what it has.
    engine.search('sian', { within: [4, 5, 6, 7, 8, 9, 10, 11] });
    const afterTwoCalls = scored();
    engine.search('sian', { within: [1, 2, 3] });
    expect(scored()).toBe(afterTwoCalls);

    // A config that changes a cell's score rebuilds the dictionaries.
    engine.updateConfig({ fuzzyMaxDistance: 1 });
    expect(dictsOf(engine)).toBeUndefined();
    engine.setData(makeRows(4));
    expect(dictsOf(engine)).toBeUndefined();
  });

  it("follows data changed in place without setData (fuzzyMode 'value')", () => {
    const config = { keys: KEYS, threshold: 0.25 };
    const data = makeRows(21);
    const engine = new ExSearch<Row>(config).setData(data);
    expect(engine.searchWithRows('siam')).toEqual(searchWithRows(data, 'siam', config));

    for (let i = 0; i < N; i += 7) {
      if (data[i] == null) continue;
      data[i].status = 'siam';
      data[i].city = 'totally new text';
    }
    for (let i = 3; i < N; i += 501) data[i] = { id: i, status: 'sian', city: 'x', name: 'y', tag: 'z', n: 1 };
    data[10] = null as unknown as Row;

    let hits = 0;
    for (const query of QUERIES) {
      const want = searchWithRows(data, query, config);
      expect(engine.searchWithRows(query)).toEqual(want);
      hits += want.rows.length;
    }
    expect(hits).toBeGreaterThan(1000);
    // The changed cells were scored as texts of their own, not from the dictionary.
    expect(searchWithRows(data, 'totally new', config).rows.length).toBeGreaterThan(400);
    expect(engine.searchWithRows('totally new')).toEqual(searchWithRows(data, 'totally new', config));
  });

  it('reads each row once per search after the first', () => {
    const data = makeRows(5);
    const reads = new Map<number, number>();
    const view = new Proxy(data, {
      get(target, prop, receiver) {
        if (typeof prop === 'string' && /^\d+$/.test(prop)) reads.set(+prop, (reads.get(+prop) ?? 0) + 1);
        return Reflect.get(target, prop, receiver);
      },
    });
    for (const fuzzyMode of ['value', 'word'] as const) {
      const engine = new ExSearch<Row>({ keys: KEYS, fuzzyMode }).setData(view);
      reads.clear();
      engine.search('siam');
      // The first search also builds the dictionaries (and the word index in word mode).
      const passes = fuzzyMode === 'word' ? 3 : 2;
      expect([...reads.values()].every((n) => n === passes)).toBe(true);
      expect(reads.size).toBe(N);

      reads.clear();
      expect(engine.search('activ').length).toBeGreaterThan(0);
      expect(reads.size).toBe(N);
      expect([...reads.values()].every((n) => n === 1)).toBe(true);
    }
  });

  it('keeps no word index entries for a key with a dictionary', () => {
    const data = makeRows(9);
    const encodedOnly = new ExSearch<Row>({
      keys: [
        { name: 'city', weight: 1 },
        { name: 'tag', weight: 1 },
      ],
      fuzzyMode: 'word',
    }).setData(data);
    encodedOnly.search('chiang');
    expect(dictsOf(encodedOnly)!.every((d) => d !== null)).toBe(true);
    expect(wordsOf(encodedOnly)!.blocks).toHaveLength(0);
    expect(wordsOf(encodedOnly)!.data).toHaveLength(0);

    // With a key of distinct texts next to them, the index holds that key only.
    const config = { keys: KEYS, fuzzyMode: 'word' as const };
    const mixed = new ExSearch<Row>(config).setData(data);
    mixed.search('chiang');
    const nameOnly = new ExSearch<Row>({ keys: [{ name: 'name', weight: 1 }], fuzzyMode: 'word' }).setData(data);
    nameOnly.search('chiang');
    expect(wordsOf(mixed)!.data.length).toBe(wordsOf(nameOnly)!.data.length);
    expect(wordsOf(mixed)!.data.length).toBeGreaterThan(0);
  });

  describe('through a Worker', () => {
    let restore: () => void;
    beforeAll(() => {
      restore = installFakeWorker();
    });
    afterAll(() => restore());
    beforeEach(() => FakeWorker.reset());
    afterEach(() => jest.restoreAllMocks());

    type Payload = { texts: unknown[]; nRows: number; cols: Array<{ ids: Uint32Array; texts: unknown[] } | null> };

    it('sends ids and distinct texts for a key with a dictionary and matches the synchronous results', async () => {
      const posted: Payload[] = [];
      const post = FakeWorker.prototype.postMessage;
      jest.spyOn(FakeWorker.prototype, 'postMessage').mockImplementation(function (this: FakeWorker, m: unknown) {
        posted.push(m as Payload);
        post.call(this, m);
      });
      for (const fuzzyMode of ['value', 'word'] as const) {
        const config = { keys: KEYS, fuzzyMode, threshold: 0.25 };
        const data = makeRows(31);
        const engine = new ExSearch<Row>({ ...config, useWorker: true }).setData(data);
        let hits = 0;
        for (const query of ['siam', 'chiang mai', 'สยา', '7']) {
          posted.length = 0;
          const got = await engine.searchAsyncWithRows(query);
          expect(got).toEqual(searchWithRows(data, query, config));
          hits += got.rows.length;
          expect(posted).toHaveLength(1);
          // Only `name` has no dictionary: one text per row for it, none for the others.
          expect(posted[0].texts).toHaveLength(N);
          expect(posted[0].cols.map((c) => c !== null)).toEqual([true, true, false, true, true]);
          expect(posted[0].cols[0]!.texts.length).toBeLessThan(10);
          expect(posted[0].cols[0]!.ids).toHaveLength(N);
        }
        expect(hits).toBeGreaterThan(1000);
      }
    });

    it('sends a changed cell as a text of its own, handles null rows and `within`', async () => {
      const config = { keys: KEYS, threshold: 0.25 };
      const data = makeRows(41);
      const engine = new ExSearch<Row>({ ...config, useWorker: true }).setData(data);
      expect(await engine.searchAsyncWithRows('siam')).toEqual(searchWithRows(data, 'siam', config));

      for (let i = 0; i < N; i += 9) if (data[i] != null) data[i].city = 'totally new text';
      data[20] = null as unknown as Row;
      const want = searchWithRows(data, 'totally new', config);
      expect(want.rows.length).toBeGreaterThan(300);
      expect(await engine.searchAsyncWithRows('totally new')).toEqual(want);
      // The engine's own dictionary is not touched by what one search had to add.
      expect(dictsOf(engine)![1]!.texts).not.toContain('totally new text');

      const within = [2999, 0, 9, 18, 20, 5, 1500, 9];
      expect(await engine.searchAsyncWithRows('totally new', { within })).toEqual(
        searchWithRows(data, 'totally new', config, { within }),
      );
      expect(FakeWorker.all).toHaveLength(3);
    });

    it('scores no missing row, also when the first key has a dictionary', async () => {
      // Every row holds the first text of the only key, so a missing row
      // mistaken for id 0 would come back as a hit.
      const data = Array.from({ length: 2000 }, (_, i) => (i % 100 === 3 ? null : { s: 'alpha' })) as Array<{
        s: string;
      }>;
      const config = { keys: [{ name: 's' as const, weight: 1 }] };
      const engine = new ExSearch<{ s: string }>({ ...config, useWorker: true }).setData(data);
      const got = await engine.searchAsyncWithRows('alpha');
      expect(got.rows).toHaveLength(1980);
      expect(got).toEqual(searchWithRows(data, 'alpha', config));
      expect(engine.searchWithRows('alpha')).toEqual(got);
      expect(dictsOf(engine)![0]!.texts).toEqual(['alpha']);
    });
  });
});
