/**
 * fuzzyMode 'word': first query (builds the word index) vs repeat queries, and
 * the index's memory, at 100k rows × 4 keys.
 *   pnpm exec tsx bench/word-index.bench.ts
 */
import { createSearch } from '../src';
import { createKernel } from '../src/core/kernel';

const ROWS = 100_000;
const FIRST = ['Somchai', 'Mali', 'Anan', 'Kanya', 'Prasert', 'Suda', 'Wichai', 'Nok'];
const LAST = ['Jaidee', 'Boonmee', 'Rakthai', 'Srisuk', 'Thongdee', 'Chaiyo'];
const CITY = ['Bangkok', 'Chiang Mai', 'Khon Kaen', 'Hat Yai', 'Nakhon Ratchasima', 'Phuket'];
const STATUS = ['active', 'inactive', 'pending'];

type Row = { name: string; email: string; city: string; status: string };
const data: Row[] = [];
for (let i = 0; i < ROWS; i++) {
  const f = FIRST[i % FIRST.length];
  const l = LAST[(i * 7) % LAST.length];
  data.push({
    name: `${f} ${l} ${i}`,
    email: `${f.toLowerCase()}.${i}@example.com`,
    city: CITY[(i * 3) % CITY.length],
    status: STATUS[i % STATUS.length],
  });
}

const keys = [
  { name: 'name' as const, weight: 1 },
  { name: 'email' as const, weight: 0.6 },
  { name: 'city' as const, weight: 0.5 },
  { name: 'status' as const, weight: 0.3 },
];

function time(fn: () => unknown): number {
  const t = performance.now();
  fn();
  return performance.now() - t;
}

const typed = ['s', 'so', 'som', 'somc', 'somch', 'somcha', 'somchay', 'somchay j'];
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

for (let warm = 0; warm < 2; warm++) createSearch({ keys, fuzzyMode: 'word' }).setData(data.slice(0, 5000)).search('x');

const s = createSearch({ keys, fuzzyMode: 'word' }).setData(data);
const first = time(() => s.search('somchay'));
const repeats = typed.map((q) => time(() => s.search(q)));

// Index size, measured directly from its typed arrays.
const k = createKernel();
const idx = k.buildWordIndex(data, keys, false);
if (idx === null) throw new Error('word index not built');
const bytes = idx.cells.byteLength + idx.starts.byteLength + idx.spans.byteLength;

// The previous cache: one string[] per (row, key).
const g = globalThis as { gc?: () => void };
let stringCacheMB = 'n/a (run node with --expose-gc)';
if (g.gc) {
  g.gc();
  const before = process.memoryUsage().heapUsed;
  const cache = data.flatMap((row) => keys.map((key) => k.tokenize(row[key.name].toLowerCase())));
  g.gc();
  stringCacheMB = ((process.memoryUsage().heapUsed - before) / 1e6).toFixed(1) + ' MB';
  void cache.length;
}

console.log(`rows × keys            : ${ROWS} × ${keys.length}`);
console.log(`first query (+ build)  : ${first.toFixed(1)} ms`);
console.log(
  `repeat query (median)  : ${median(repeats).toFixed(1)} ms  [${repeats.map((t) => t.toFixed(0)).join(', ')}]`,
);
console.log(`index build alone      : ${time(() => k.buildWordIndex(data, keys, false)).toFixed(1)} ms`);
console.log(
  `word index             : ${(bytes / 1e6).toFixed(2)} MB (${idx.cells.length} cells, ${idx.spans.length / 2} words, ${idx.spans.constructor.name})`,
);
console.log(`string[] cache (old)   : ${stringCacheMB}`);
