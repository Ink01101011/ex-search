import { ExSearch, search, searchWithRows } from '../src/core/search';
import { createKernel } from '../src/core/kernel';
import type { SearchConfig } from '../src/types';

type Row = { a: string };

const CFG: SearchConfig<Row> = { keys: [{ name: 'a', weight: 1 }], threshold: 0.3, fuzzyMaxDistance: 2 };
const WORD: SearchConfig<Row> = { ...CFG, fuzzyMode: 'word' };

describe('word index on very large datasets', () => {
  it('buildWordIndex returns null when the cell id cannot fit in 32 bits', () => {
    const k = createKernel();
    const keys = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `k${i}`, weight: 1 }));
    const sparse = (n: number) => new Array<Row>(n);
    expect(k.buildWordIndex(sparse(2 ** 21), keys(2 ** 11), false)).toBeNull();
    expect(k.buildWordIndex(sparse(2 ** 21), keys(2 ** 11 - 1), false)).not.toBeNull();
  });

  it('ExSearch equals search() when rows x keys exceeds 2^32', () => {
    // One real row at 2^20 and 4096 keys: 2^20 * 4096 === 2^32 wraps to cell 0.
    const nKeys = 4096;
    const keys = Array.from({ length: nKeys }, (_, i) => ({ name: i === 0 ? 'a' : `k${i}`, weight: 1 }));
    const config = { keys, threshold: 0.3, fuzzyMaxDistance: 2, fuzzyMode: 'word' } as SearchConfig<Row>;
    const data: Row[] = [];
    data[2 ** 20] = { a: 'mr somchai jaidee' };
    const within = [2 ** 20];

    const expected = search(data, 'somchay', config, { within });
    expect(expected.map((r) => r.a)).toEqual(['mr somchai jaidee']);
    const viaClass = new ExSearch<Row>(config).setData(data);
    expect(viaClass.search('somchay', { within }).map((r) => r.a)).toEqual(['mr somchai jaidee']);
    // The second search does not rebuild or change anything.
    expect(viaClass.search('somchay', { within }).map((r) => r.a)).toEqual(['mr somchai jaidee']);
  });
});

describe('word mode with null rows', () => {
  const data = [{ a: 'x somchai' }, null, { a: 'somchai zz' }] as unknown as Row[];

  it('searches the rows in within even when another row is null', () => {
    const viaClass = new ExSearch<Row>(WORD).setData(data);
    const expected = search(data, 'somchay', WORD, { within: [0, 2] });
    expect(expected).toHaveLength(2);
    expect(viaClass.search('somchay', { within: [0, 2] })).toEqual(expected);
    expect(Array.from(viaClass.searchWithRows('somchay', { within: [0] }).rows)).toEqual([0]);
  });

  it('still throws on a null row that is scored, as 1.2.0 did', () => {
    expect(() => search(data, 'somchay', WORD)).toThrow(TypeError);
    expect(() => new ExSearch<Row>(WORD).setData(data).search('somchay')).toThrow(TypeError);
  });
});

describe('word index text handling', () => {
  it('lower-casing keeps the length and the whitespace of every code point except U+0130', () => {
    // buildWordIndex takes the word offsets from the raw text; this is what makes that valid.
    const ws = /\s/;
    for (let c = 0; c <= 0x10ffff; c++) {
      if (c === 0x130 || (c >= 0xd800 && c <= 0xdfff)) continue;
      const ch = String.fromCodePoint(c);
      const low = ch.toLowerCase();
      if (low.length !== ch.length || ws.test(low) !== ws.test(ch)) {
        throw new Error(`U+${c.toString(16)} changes length or whitespace class when lower-cased`);
      }
    }
    expect('İ'.toLowerCase().length).toBe(2);
  });

  it('the index finds the same words as the live path with capitals, U+0130 and mixed scripts', () => {
    const texts = [
      'Somchai JAIDEE Siam',
      'İSTANBUL Somchai',
      'Mr  SOMCHAI\tJaidee',
      'ΣΟΦΟΣ Σοφός',
      'บางนา สยาม Somchai',
      'İİ Somchaİ jaidee',
      'ÀÉÎ Somchai',
    ];
    const data: Row[] = texts.map((a) => ({ a }));
    for (const caseSensitive of [false, true]) {
      const config = { ...WORD, caseSensitive };
      const cls = new ExSearch<Row>(config).setData(data);
      for (const q of ['somchay', 'SOMCHAY', 'jaidea', 'istanbul', 'σοφος', 'สยาม', 'somchai']) {
        const expected = searchWithRows(data, q, config);
        const got = cls.searchWithRows(q);
        expect(Array.from(got.rows)).toEqual(Array.from(expected.rows));
        expect(got.results.map((r) => r.score)).toEqual(expected.results.map((r) => r.score));
      }
    }
  });
});
