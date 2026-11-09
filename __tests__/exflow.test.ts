import { ExFlow } from 'ex-flow';
import { search } from '../src';

interface Branch {
  id: string;
  name: string;
  address: string;
}

const branches: Branch[] = [
  { id: 'c', name: 'Central Siam Plaza', address: '1 Rama 1 Rd' },
  { id: 'a', name: 'Siam', address: '2 Rama 1 Rd' },
  { id: 'b', name: 'Siam Paragon', address: '3 Rama 1 Rd' },
  { id: 'x', name: 'Chiang Mai Night Bazaar', address: '4 Chang Khlan Rd' },
];

const config = {
  keys: [
    { name: 'name' as const, weight: 1.0 },
    { name: 'address' as const, weight: 0.5 },
  ],
  threshold: 0.3,
};

describe('piping results into ex-flow (README section 6)', () => {
  it('runs the README example and orders fullSequence by score descending', () => {
    const results = search(branches, 'siam', config);
    expect(results.map((r) => r.id)).toEqual(['a', 'b', 'c']);

    // --- README example, verbatim ---
    const flow = new ExFlow<Branch>({ priorityAscending: false });
    // oxlint-disable-next-line no-unused-vars -- score/fieldMatches are dropped on purpose
    for (const { exFlowPriority, score, fieldMatches, ...branch } of results) {
      flow.addEntity({ id: branch.id, data: branch, dependsOn: [], priority: exFlowPriority });
    }
    const plan = flow.resolveExecutionPlan();
    // --- end README example ---

    // Tie order between equal priorities is ex-flow's business, so assert the
    // id set and the non-increasing priority order, not an exact id sequence.
    expect(plan.fullSequence.map((n) => n.id).sort()).toEqual(results.map((r) => r.id).sort());
    const priorities = plan.fullSequence.map((n) => n.exFlowPriority);
    expect([...priorities].sort((x, y) => y - x)).toEqual(priorities);
    expect([...priorities].sort((x, y) => y - x)).toEqual(results.map((r) => r.exFlowPriority));
  });

  it('passing a result as-is is rejected by ex-flow (reserved field), hence the lift', () => {
    const [first] = search(branches, 'siam', config);
    const flow = new ExFlow<Branch>();
    expect(() => flow.addEntity({ id: first.id, data: first as unknown as Branch, dependsOn: [] })).toThrow(
      /EXFLOW_RESERVED_FIELD/,
    );
  });
});
