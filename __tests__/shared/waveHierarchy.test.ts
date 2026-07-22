import { buildWaveAdjacency } from '@/utils/shared/waveHierarchy';
import type { Wave, WaveChainEdge, WaveChainNode } from '@/shared/types/waves/waves';

// Minimal chain-node factory — mirrors waveGrouping.test.ts.
const node = (executionId: string, name = executionId, flowName?: string): WaveChainNode => ({
  executionId,
  name,
  enabled: true,
  flowId: `flow-${executionId}`,
  flowName,
  triggerKind: 'schedule',
  isRoot: false,
  timing: { mode: 'fixed' },
  subflows: [],
  emittedSignals: [],
});

const edge = (from: string, to: string): WaveChainEdge => ({
  fromExecutionId: from,
  toExecutionId: to,
  via: 'completion',
  on: ['completed'],
});

const wave = (
  id: string,
  rootExecutionIds: string[],
  nodes: WaveChainNode[],
  edges: WaveChainEdge[],
  hasCycle = false,
): Wave => ({ id, rootExecutionIds, nodes, edges, hasCycle });

describe('buildWaveAdjacency', () => {
  it('builds sorted successors + predecessors for a linear chain', () => {
    const adj = buildWaveAdjacency(
      wave('w', ['root'], [node('root'), node('A'), node('B')], [edge('root', 'A'), edge('A', 'B')]),
    );
    expect(adj.succ.get('root')).toEqual(['A']);
    expect(adj.succ.get('A')).toEqual(['B']);
    expect(adj.succ.get('B')).toEqual([]);
    expect(adj.preds.get('A')).toEqual(['root']);
    expect(adj.preds.get('B')).toEqual(['A']);
    expect(adj.edgeByPair.get('root->A')?.via).toBe('completion');
  });

  it('sorts fan-out successors deterministically', () => {
    const adj = buildWaveAdjacency(
      wave(
        'w',
        ['root'],
        [node('root'), node('c'), node('a'), node('b')],
        [edge('root', 'c'), edge('root', 'a'), edge('root', 'b')],
      ),
    );
    expect(adj.succ.get('root')).toEqual(['a', 'b', 'c']);
  });

  it('resolves declared roots (present in the wave), sorted', () => {
    const adj = buildWaveAdjacency(
      wave('w', ['r2', 'r1', 'ghost'], [node('r1'), node('r2'), node('c')], [edge('r1', 'c')]),
    );
    expect(adj.rootIds).toEqual(['r1', 'r2']); // sorted, 'ghost' dropped (not a node)
  });

  it('falls back to predecessor-less nodes when no declared root is present', () => {
    const adj = buildWaveAdjacency(
      wave('w', [], [node('root'), node('A'), node('B')], [edge('root', 'A'), edge('A', 'B')]),
    );
    expect(adj.rootIds).toEqual(['root']);
  });

  it('ignores dangling edges (from/to not present as nodes)', () => {
    const adj = buildWaveAdjacency(
      wave('w', ['root'], [node('root'), node('A')], [
        edge('root', 'A'),
        edge('root', 'ghost'), // dangling — target missing
        edge('ghost', 'A'), // dangling — source missing
      ]),
    );
    expect(adj.succ.get('root')).toEqual(['A']);
    expect(adj.preds.get('A')).toEqual(['root']);
    expect(adj.edgeByPair.has('root->ghost')).toBe(false);
    expect(adj.edgeByPair.has('ghost->A')).toBe(false);
  });

  it('gives a cycle-safe spanning tree: each node has at most one parent', () => {
    const adj = buildWaveAdjacency(
      wave('w', ['root'], [node('root'), node('A'), node('B')], [
        edge('root', 'A'),
        edge('A', 'B'),
        edge('B', 'A'), // back-edge (recursion)
      ], true),
    );
    expect(adj.parentOf.get('A')).toBe('root'); // NOT B, despite the B->A edge
    expect(adj.parentOf.get('B')).toBe('A');
    expect(adj.parentOf.has('root')).toBe(false); // a root has no parent
    // Walking parentOf from any node terminates at a root.
    let cur: string | undefined = 'B';
    const guard = new Set<string>();
    while (cur && adj.parentOf.has(cur) && !guard.has(cur)) {
      guard.add(cur);
      cur = adj.parentOf.get(cur);
    }
    expect(cur).toBe('root');
  });
});
