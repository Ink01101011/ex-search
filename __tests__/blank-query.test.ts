import { search, searchWithRows } from '../src/core/search';
import type { SearchConfig } from '../src/types';

type Row = { a: string };

describe('blank query is checked before the config (as in 2.0.0)', () => {
  const data: Row[] = [{ a: 'x' }];
  const bad: Array<[string, unknown]> = [
    ['keys is not an array', { keys: 'nope' }],
    ['negative weight', { keys: [{ name: 'a', weight: -1 }] }],
    ['NaN threshold', { keys: [{ name: 'a', weight: 1 }], threshold: NaN }],
  ];

  it.each(bad)('search(data, blank, config with %s) returns []', (_label, config) => {
    expect(search(data, '', config as SearchConfig<Row>)).toEqual([]);
    expect(search(data, '   ', config as SearchConfig<Row>)).toEqual([]);
    const r = searchWithRows(data, '  ', config as SearchConfig<Row>);
    expect(r.results).toEqual([]);
    expect(r.rows.length).toBe(0);
  });

  it('a non-blank query still validates the config', () => {
    expect(() => search(data, 'x', { keys: 'nope' } as unknown as SearchConfig<Row>)).toThrow(TypeError);
  });
});
