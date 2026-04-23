/**
 * Example: searching a list of bank branches
 */
import { createSearch, search, Scorer } from '../index';

interface Branch {
  id: string;
  name: string;
  address: string;
  province: string;
}

const branches: Branch[] = [
  { id: '001', name: 'สาขาสยามพารากอน', address: '991 ถ.พระราม 1 ปทุมวัน', province: 'กรุงเทพฯ' },
  { id: '002', name: 'สาขาเซ็นทรัลลาดพร้าว', address: '1693 ถ.พหลโยธิน จตุจักร', province: 'กรุงเทพฯ' },
  { id: '003', name: 'สาขาเชียงใหม่ไนท์บาซาร์', address: '86 ถ.ช้างคลาน เมือง', province: 'เชียงใหม่' },
];

// ── 1. Functional API (one-shot) ───────────────────────────────────────────

const results = search(branches, 'สยาม', {
  keys: [
    { name: 'name', weight: 1.0 },
    { name: 'address', weight: 0.5 },
    { name: 'province', weight: 0.3 },
  ],
  threshold: 0.3,
  sortAlgorithm: 'radix',
});

// results[0] → { id: '001', name: 'สาขาสยามพารากอน', score: 0.8, fieldMatches: [...], exFlowPriority: 80 }

// ── 2. Class API (reusable — best when query changes often) ────────────────

const searcher = createSearch<Branch>({
  keys: [
    { name: 'name', weight: 1.0 },
    { name: 'address', weight: 0.5 },
  ],
  threshold: 0.3,
  fuzzyMaxDistance: 3,
  sortAlgorithm: 'radix',
});

searcher.setData(branches);

const r1 = searcher.search('เซ็นทรัล');
const r2 = searcher.search('Chiangmai'); // fuzzy — will still score if within distance

// ── 3. Async / Web Worker (large datasets, browser only) ──────────────────

const asyncSearcher = createSearch<Branch>({
  keys: [{ name: 'name', weight: 1.0 }],
  threshold: 0.3,
  useWorker: true, // ← moves scoring off the main thread
  sortAlgorithm: 'radix',
});

asyncSearcher.setData(branches);
const r3 = await asyncSearcher.searchAsync('ลาดพร้าว');

// ── 4. Low-level Scorer (custom pipelines) ────────────────────────────────

Scorer.levenshtein('Somchai', 'Somchay'); // → 1
Scorer.exact('สยาม', 'สยาม'); // → 100
Scorer.startsWith('สยามพารากอน', 'สยาม'); // → 80
Scorer.fuzzy('Chiangmai', 'Chiengmai'); // → ~57  (dist=2, maxLen=9 → (1-2/9)×70)

// ── 5. Pipe into ex-flow (exFlowPriority is already set on each result) ───

// import { ExFlow } from 'ex-flow';
// const flow = new ExFlow<Branch>({ priorityAscending: false });
// r1.forEach((result) => flow.addEntity({ id: result.id, data: result, dependsOn: [] }));
// const plan = flow.resolveExecutionPlan();
