import {
  buildWaveExecutionTree,
  buildWaveExecutionTrees,
  attachConversationsToWaveTree,
} from '@/utils/shared/waveHierarchy';
import { buildWaveLookup } from '@/utils/shared/waveGrouping';
import type {
  Wave,
  WaveChainEdge,
  WaveChainNode,
  WavesResponse,
} from '@/shared/types/waves/waves';

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

const response = (waves: Wave[]): WavesResponse => ({
  paused: false,
  generatedAt: '2026-07-22T00:00:00.000Z',
  waves,
  orphans: [],
});

describe('buildWaveExecutionTree', () => {
  it('builds a linear chain root -> A -> B', () => {
    const tree = buildWaveExecutionTree(
      wave('w', ['root'], [node('root'), node('A'), node('B')], [edge('root', 'A'), edge('A', 'B')]),
    );
    expect(tree.rootExecutionIds).toEqual(['root']);
    expect(tree.childrenByExecution.get('root')).toEqual(['A']);
    expect(tree.childrenByExecution.get('A')).toEqual(['B']);
    expect(tree.childrenByExecution.get('B')).toBeUndefined();
    expect(tree.orderedExecutionIds).toEqual(['root', 'A', 'B']);
  });

  it('supports multiple roots', () => {
    const tree = buildWaveExecutionTree(
      wave('w', ['r1', 'r2'], [node('r1'), node('r2'), node('c')], [edge('r1', 'c')]),
    );
    expect(tree.rootExecutionIds).toEqual(['r1', 'r2']);
    expect(tree.childrenByExecution.get('r1')).toEqual(['c']);
  });

  it('orders fan-out children deterministically (sorted)', () => {
    // Edges declared out of order; successor sort makes children stable.
    const tree = buildWaveExecutionTree(
      wave(
        'w',
        ['root'],
        [node('root'), node('c'), node('a'), node('b')],
        [edge('root', 'c'), edge('root', 'a'), edge('root', 'b')],
      ),
    );
    expect(tree.childrenByExecution.get('root')).toEqual(['a', 'b', 'c']);
  });

  it('terminates on a cycle, giving each node exactly one parent', () => {
    const tree = buildWaveExecutionTree(
      wave('w', ['root'], [node('root'), node('A'), node('B')], [
        edge('root', 'A'),
        edge('A', 'B'),
        edge('B', 'A'), // back-edge (recursion)
      ], true),
    );
    // Spanning tree: root->A->B; the B->A back-edge is NOT a second parent for A.
    expect(tree.childrenByExecution.get('root')).toEqual(['A']);
    expect(tree.childrenByExecution.get('A')).toEqual(['B']);
    expect(tree.childrenByExecution.get('B') ?? []).not.toContain('A');
    // Every node appears exactly once in the render order.
    expect([...tree.orderedExecutionIds].sort()).toEqual(['A', 'B', 'root']);
  });

  it('ignores dangling edges (from/to not present as nodes)', () => {
    const tree = buildWaveExecutionTree(
      wave('w', ['root'], [node('root'), node('A')], [
        edge('root', 'A'),
        edge('root', 'ghost'), // dangling — target missing
        edge('ghost', 'A'), // dangling — source missing
      ]),
    );
    expect(tree.childrenByExecution.get('root')).toEqual(['A']);
    expect(tree.orderedExecutionIds).toEqual(['root', 'A']);
  });

  it('derives the label identically to buildWaveLookup', () => {
    const w = wave('w', ['root'], [node('root', 'My Wave'), node('A')], [edge('root', 'A')]);
    const tree = buildWaveExecutionTree(w);
    const lookup = buildWaveLookup(response([w]));
    expect(tree.label).toBe('My Wave');
    expect(tree.label).toBe(lookup.get('root')?.label);
  });
});

describe('buildWaveExecutionTrees', () => {
  it('tolerates null / undefined / empty input', () => {
    expect(buildWaveExecutionTrees(null).size).toBe(0);
    expect(buildWaveExecutionTrees(undefined).size).toBe(0);
    expect(buildWaveExecutionTrees(response([])).size).toBe(0);
  });

  it('keys the map by wave id', () => {
    const trees = buildWaveExecutionTrees(
      response([wave('wA', ['r'], [node('r')], []), wave('wB', ['s'], [node('s')], [])]),
    );
    expect([...trees.keys()].sort()).toEqual(['wA', 'wB']);
  });
});

describe('attachConversationsToWaveTree', () => {
  const tree = buildWaveExecutionTree(
    wave('w', ['root'], [node('root'), node('A'), node('B')], [edge('root', 'A'), edge('A', 'B')]),
  );

  it('nests conversations under the execution they ran from', () => {
    const convs = [
      { id: 'c1', plannedExecutionId: 'root' },
      { id: 'c2', plannedExecutionId: 'A' },
      { id: 'c3', plannedExecutionId: 'A' },
    ];
    const { conversationsByExecution } = attachConversationsToWaveTree(tree, convs);
    expect(conversationsByExecution.get('root')?.map((c) => c.id)).toEqual(['c1']);
    expect(conversationsByExecution.get('A')?.map((c) => c.id)).toEqual(['c2', 'c3']);
    expect(conversationsByExecution.get('B')).toBeUndefined();
  });

  it('promotes a conversation with an unknown execution to the wave root (no disappearance)', () => {
    const convs = [{ id: 'x', plannedExecutionId: 'pruned-execution' }];
    const { conversationsByExecution, renderableExecutionIds } = attachConversationsToWaveTree(
      tree,
      convs,
    );
    expect(conversationsByExecution.get('root')?.map((c) => c.id)).toEqual(['x']);
    expect(renderableExecutionIds.has('root')).toBe(true);
  });

  it('marks only executions whose subtree has conversations as renderable', () => {
    // Conversation only on B: root and A are kept as connectors; standalone
    // empty executions would be pruned.
    const { renderableExecutionIds } = attachConversationsToWaveTree(tree, [
      { id: 'c', plannedExecutionId: 'B' },
    ]);
    expect(renderableExecutionIds.has('root')).toBe(true); // ancestor connector
    expect(renderableExecutionIds.has('A')).toBe(true); // ancestor connector
    expect(renderableExecutionIds.has('B')).toBe(true);
  });

  it('omits an empty sibling execution with no conversations in its subtree', () => {
    const t = buildWaveExecutionTree(
      wave('w', ['root'], [node('root'), node('A'), node('B')], [edge('root', 'A'), edge('root', 'B')]),
    );
    const { renderableExecutionIds } = attachConversationsToWaveTree(t, [
      { id: 'c', plannedExecutionId: 'A' },
    ]);
    expect(renderableExecutionIds.has('root')).toBe(true);
    expect(renderableExecutionIds.has('A')).toBe(true);
    expect(renderableExecutionIds.has('B')).toBe(false); // pruned: empty subtree
  });
});
