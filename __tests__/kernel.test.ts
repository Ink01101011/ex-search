import { createKernel } from '../src/core/kernel';
import { Scorer } from '../src/core/scorer';
import { search, createSearch, __WORKER_SOURCE__ } from '../src/core/search';

// Plain O(n·m) Wagner–Fischer — the reference every fast path is checked against.
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

function mutate(rand: () => number, s: string, edits: number, alphabet: string): string {
  let out = s;
  for (let e = 0; e < edits; e++) {
    const pos = Math.floor(rand() * (out.length + 1));
    const c = alphabet[Math.floor(rand() * alphabet.length)];
    const op = Math.floor(rand() * 3);
    if (op === 0) out = out.slice(0, pos) + c + out.slice(pos);
    else if (op === 1 && out.length > 0) out = out.slice(0, pos) + out.slice(pos + 1);
    else out = out.slice(0, pos) + c + out.slice(pos + 1);
  }
  return out;
}

const kernel = createKernel();

describe('levenshtein correctness at every length (issue #4)', () => {
  it('matches the reference for lengths 0–80 on random strings', () => {
    const rand = rng(42);
    for (let n = 0; n < 2500; n++) {
      const alphabet = n % 2 ? 'ab' : 'abcdefghijklmnopqrstuvwxyz';
      const a = randomString(rand, Math.floor(rand() * 81), alphabet);
      const b = randomString(rand, Math.floor(rand() * 81), alphabet);
      expect([a, b, Scorer.levenshtein(a, b)]).toEqual([a, b, referenceDistance(a, b)]);
    }
  });

  it('is exact on the 31 / 32 / 33 character word boundary', () => {
    const rand = rng(7);
    for (const len of [31, 32, 33, 64, 65]) {
      for (let n = 0; n < 200; n++) {
        const a = randomString(rand, len, 'abcdef');
        const b = mutate(rand, a, 1 + Math.floor(rand() * 4), 'abcdef');
        expect(Scorer.levenshtein(a, b)).toBe(referenceDistance(a, b));
      }
    }
  });

  it('returns 1 for one substitution in long strings (PoC from the issue)', () => {
    const a = 'x'.repeat(33);
    const b = 'x'.repeat(32) + 'y';
    expect(Scorer.levenshtein(a, b)).toBe(1);
    expect(Scorer.levenshtein('internationalisation-localisation-team', 'internationalisation-localisatoin-team')).toBe(
      2,
    );
    expect(
      Scorer.levenshtein('the quick brown fox jumps over the lazy dog', 'the quick brown fox jumps over the lazy dgo'),
    ).toBe(2);
  });

  it('handles Thai text', () => {
    expect(Scorer.levenshtein('สาขาสยามพารากอน', 'สาขาสยามพารากอม')).toBe(1);
  });
});

describe('boundedDistance / createMatcher', () => {
  it('agree with the reference whenever the distance is within max, and exceed max otherwise', () => {
    const rand = rng(99);
    for (let n = 0; n < 3000; n++) {
      const alphabet = 'abcde';
      const q = randomString(rand, 1 + Math.floor(rand() * 60), alphabet);
      const t =
        rand() < 0.5
          ? mutate(rand, q, Math.floor(rand() * 6), alphabet)
          : randomString(rand, Math.floor(rand() * 60), alphabet);
      const max = Math.floor(rand() * 5);
      const ref = referenceDistance(q, t);
      const bounded = kernel.boundedDistance(q, t, max);
      const matched = kernel.createMatcher(q, max)(t);
      if (ref <= max) {
        expect([q, t, max, bounded, matched]).toEqual([q, t, max, ref, ref]);
      } else {
        expect(bounded).toBeGreaterThan(max);
        expect(matched).toBeGreaterThan(max);
      }
    }
  });

  it('rejects on length difference alone', () => {
    expect(kernel.boundedDistance('abc', 'abcdefgh', 3)).toBeGreaterThan(3);
    expect(kernel.createMatcher('abc', 3)('abcdefgh')).toBeGreaterThan(3);
  });

  it('treats a negative, NaN or zero max as "no fuzzy match"', () => {
    expect(kernel.boundedDistance('abc', 'abd', -1)).toBeGreaterThan(-1);
    expect(kernel.createMatcher('abc', Number.NaN)('abd')).toBe(Infinity);
    expect(kernel.createMatcher('abc', 0)('abd')).toBeGreaterThan(0);
  });

  it('survives an infinite max', () => {
    expect(kernel.boundedDistance('a'.repeat(40), 'b'.repeat(45), Infinity)).toBe(45);
    expect(kernel.createMatcher('a'.repeat(40), Infinity)('b'.repeat(45))).toBe(45);
  });
});

describe('fuzzy tier on long values (issue #4)', () => {
  it('Scorer.fuzzy scores a one-typo 38-character query', () => {
    expect(
      Scorer.fuzzy('internationalisation-localisation-team', 'internationalisation-localisatoin-team'),
    ).toBeGreaterThan(0);
  });

  it('search() finds a 43-character query with one transposition', () => {
    const data = [{ id: 1, text: 'the quick brown fox jumps over the lazy dog' }];
    const results = search(data, 'the quick brown fox jumps over the lazy dgo', {
      keys: [{ name: 'text', weight: 1 }],
    });
    expect(results).toHaveLength(1);
    expect(results[0].fieldMatches[0].matchType).toBe('fuzzy');
  });

  it('fuzzyMaxDistance: 0 disables the fuzzy tier', () => {
    const results = search([{ name: 'Somchai' }], 'Somchay', {
      keys: [{ name: 'name', weight: 1 }],
      fuzzyMaxDistance: 0,
    });
    expect(results).toEqual([]);
  });
});

describe("fuzzyMode: 'word' (issue #6)", () => {
  interface Person {
    id: number;
    name: string;
  }
  const people: Person[] = [
    { id: 1, name: 'Somchai Jaidee' },
    { id: 2, name: 'Malee Srisuk' },
  ];
  const base = { keys: [{ name: 'name' as const, weight: 1 }], threshold: 0.3 };

  it("does not match a one-word typo in 'value' mode (default)", () => {
    expect(search(people, 'Somchay', base)).toEqual([]);
  });

  it("matches the best word in 'word' mode", () => {
    const results = search(people, 'Somchay', { ...base, fuzzyMode: 'word' });
    expect(results.map((r) => r.id)).toEqual([1]);
    expect(results[0].fieldMatches[0].matchType).toBe('fuzzy');
    // 'somchay' vs 'somchai': distance 1 over 7 chars
    expect(results[0].fieldMatches[0].rawScore).toBeCloseTo((1 - 1 / 7) * 55);
  });

  it('keeps exact / startsWith / contains on the whole value', () => {
    const results = search(people, 'chai jai', { ...base, fuzzyMode: 'word' });
    expect(results[0].fieldMatches[0].matchType).toBe('contains');
  });

  it('still scores a multi-word query against the whole value', () => {
    const results = search(people, 'Somchai Jaidea', { ...base, fuzzyMode: 'word' });
    expect(results.map((r) => r.id)).toEqual([1]);
  });

  it('ExSearch caches tokens and invalidates them on setData / updateConfig', () => {
    const searcher = createSearch<Person>({ ...base, fuzzyMode: 'word' }).setData(people);
    expect(searcher.search('Somchay').map((r) => r.id)).toEqual([1]);
    expect(searcher.search('Malle').map((r) => r.id)).toEqual([2]);

    searcher.setData([{ id: 3, name: 'Prasert Somchay' }]);
    expect(searcher.search('Somchai').map((r) => r.id)).toEqual([3]);

    searcher.updateConfig({ fuzzyMode: 'value' });
    expect(searcher.search('Somchai')).toEqual([]);
  });

  it('ExSearch and search() return identical results', () => {
    const rand = rng(3);
    const words = ['somchai', 'jaidee', 'malee', 'srisuk', 'prasert', 'wongsa', 'bangkok', 'chiangmai'];
    const data = Array.from({ length: 300 }, (_, id) => ({
      id,
      name: Array.from({ length: 1 + Math.floor(rand() * 3) }, () => words[Math.floor(rand() * words.length)]).join(
        ' ',
      ),
      city: words[Math.floor(rand() * words.length)],
    }));
    const cfg = {
      keys: [
        { name: 'name' as const, weight: 1 },
        { name: 'city' as const, weight: 0.5 },
      ],
      fuzzyMode: 'word' as const,
      sortAlgorithm: 'tim' as const,
    };
    const searcher = createSearch<(typeof data)[number]>(cfg).setData(data);
    for (const q of ['somchay', 'malle', 'bankok', 'chiangmai jaide', 'zzz']) {
      expect(searcher.search(q)).toEqual(search(data, q, cfg));
    }
  });
});

describe('Worker source', () => {
  // Coverage instrumentation injects counters that do not exist inside the
  // evaluated worker source, so only run this without coverage.
  const covered = typeof (globalThis as { __coverage__?: unknown }).__coverage__ !== 'undefined';
  (covered ? it.skip : it)('runs the shared kernel and matches the main thread', () => {
    const fakeSelf: { onmessage?: (e: { data: unknown }) => void; postMessage: (r: unknown) => void } = {
      postMessage: () => undefined,
    };
    new Function('self', __WORKER_SOURCE__)(fakeSelf);

    const data = [
      { id: 1, name: 'Somchai Jaidee' },
      { id: 2, name: 'Malee Srisuk' },
      { id: 3, name: 'the quick brown fox jumps over the lazy dog' },
    ];
    for (const [query, fuzzyMode] of [
      ['somchay', 'word'],
      ['somchay', 'value'],
      ['the quick brown fox jumps over the lazy dgo', 'value'],
    ] as const) {
      const config = {
        keys: [{ name: 'name' as const, weight: 1 }],
        threshold: 0.3,
        fuzzyMaxDistance: 3,
        caseSensitive: false,
        sortAlgorithm: 'tim' as const,
        useWorker: true,
        fuzzyMode,
      };
      let posted: unknown;
      fakeSelf.postMessage = (r) => {
        posted = r;
      };
      fakeSelf.onmessage!({ data: { data, normQuery: query, config } });
      expect(posted).toEqual(search(data, query, config));
    }
  });
});
