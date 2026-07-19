import { buildWaveGraph, makeKey } from '@/frontend/components/Waves/waveGraph';
import { WAVE_WINDOWS } from '@/frontend/components/Waves/waveTimeline';
import type { Wave, WaveChainEdge, WaveChainNode, WaveNodeTiming } from '@/shared/types/waves/waves';

const NOW = Date.parse('2026-07-17T12:00:00.000Z');

function cnode(id: string, timing: WaveNodeTiming, isRoot = false): WaveChainNode {
  return {
    executionId: id,
    name: id,
    enabled: true,
    flowId: `f_${id}`,
    flowName: `Flow ${id}`,
    triggerKind: isRoot ? 'webhook' : 'flow-event',
    isRoot,
    timing,
    subflows: [],
    emittedSignals: [],
  };
}

const fixed: WaveNodeTiming = { mode: 'fixed' };
const evt: WaveNodeTiming = { mode: 'event', via: 'completion' };

function edge(from: string, to: string, over: Partial<WaveChainEdge> = {}): WaveChainEdge {
  return { fromExecutionId: from, toExecutionId: to, via: 'completion', on: ['completed'], ...over };
}

/** r → a → b linear chain rooted at a webhook (single, pinned instance). */
function linearWave(): Wave {
  return {
    id: 'r',
    rootExecutionIds: ['r'],
    nodes: [cnode('r', fixed, true), cnode('a', evt), cnode('b', { mode: 'event', via: 'signal', topic: 't' })],
    edges: [edge('r', 'a'), edge('a', 'b', { via: 'signal', topic: 't', on: undefined })],
    hasCycle: false,
  };
}

const keysOf = (w: ReturnType<typeof buildWaveGraph>) => w.nodes.map((n) => n.key).sort();

describe('buildWaveGraph lazy hover expansion (#144)', () => {
  test('collapsed: only root cards render until something is hovered', () => {
    const g = buildWaveGraph({ wave: linearWave(), now: NOW, windowMs: WAVE_WINDOWS['6h'], hoveredKey: null });
    expect(keysOf(g)).toEqual([makeKey('r', 0)]);
    expect(g.edges).toHaveLength(0);
    expect(g.nodes[0].isRoot).toBe(true);
    expect(g.nodes[0].hasSuccessors).toBe(true);
    expect(g.nodes[0].expanded).toBe(false);
  });

  test('hovering the root reveals exactly its next level', () => {
    const g = buildWaveGraph({ wave: linearWave(), now: NOW, windowMs: WAVE_WINDOWS['6h'], hoveredKey: makeKey('r', 0) });
    expect(keysOf(g)).toEqual([makeKey('a', 0), makeKey('r', 0)]);
    // The revealed edge is placed below the root.
    expect(g.edges.map((e) => e.id)).toEqual([`${makeKey('r', 0)}->${makeKey('a', 0)}`]);
    const rootCard = g.nodes.find((n) => n.key === makeKey('r', 0))!;
    expect(rootCard.expanded).toBe(true);
  });

  test('following the chain (hover a child) expands the next level again', () => {
    const g = buildWaveGraph({ wave: linearWave(), now: NOW, windowMs: WAVE_WINDOWS['6h'], hoveredKey: makeKey('a', 0) });
    expect(keysOf(g)).toEqual([makeKey('a', 0), makeKey('b', 0), makeKey('r', 0)]);
    const bEdge = g.edges.find((e) => e.target === makeKey('b', 0))!;
    expect(bEdge.chainEdge.via).toBe('signal');
    expect(bEdge.recursive).toBe(false);
  });
});

describe('buildWaveGraph recursion handling (#144)', () => {
  function cyclicWave(): Wave {
    return {
      id: 'r',
      rootExecutionIds: ['r'],
      nodes: [cnode('r', fixed, true), cnode('a', evt), cnode('b', evt)],
      edges: [edge('r', 'a'), edge('a', 'b'), edge('b', 'a')],
      hasCycle: true,
    };
  }

  test('a recursive back-edge terminates and is flagged distinctly', () => {
    const g = buildWaveGraph({ wave: cyclicWave(), now: NOW, windowMs: WAVE_WINDOWS['6h'], hoveredKey: makeKey('b', 0) });
    // Each execution is placed at most once — the cycle does not explode.
    expect(keysOf(g)).toEqual([makeKey('a', 0), makeKey('b', 0), makeKey('r', 0)]);
    const back = g.edges.find((e) => e.source === makeKey('b', 0) && e.target === makeKey('a', 0));
    expect(back).toBeDefined();
    expect(back!.recursive).toBe(true);
    // The forward edges are not recursive.
    expect(g.edges.filter((e) => e.recursive)).toHaveLength(1);
  });
});

describe('buildWaveGraph timeline occurrences (#144)', () => {
  function scheduleWave(cron: string): Wave {
    return {
      id: 'r',
      rootExecutionIds: ['r'],
      nodes: [cnode('r', { mode: 'timeline', nextRun: null, cron }, true)],
      edges: [],
      hasCycle: false,
    };
  }

  test('a recurring schedule expands into one root instance per upcoming run in the window', () => {
    const oneHour = buildWaveGraph({ wave: scheduleWave('0 * * * *'), now: NOW, windowMs: WAVE_WINDOWS['1h'], hoveredKey: null });
    const oneDay = buildWaveGraph({ wave: scheduleWave('0 * * * *'), now: NOW, windowMs: WAVE_WINDOWS['1d'], hoveredKey: null });
    expect(oneDay.nodes.length).toBeGreaterThan(oneHour.nodes.length);
    // All instances are roots bound to the same execution, with distinct keys.
    expect(oneDay.nodes.every((n) => n.isRoot && n.baseId === 'r')).toBe(true);
    expect(new Set(oneDay.nodes.map((n) => n.key)).size).toBe(oneDay.nodes.length);
    // Later runs sit further to the right than earlier ones.
    const sorted = [...oneDay.nodes].sort((a, b) => (a.runAt ?? 0) - (b.runAt ?? 0));
    for (let i = 1; i < sorted.length; i++) {
      expect(sorted[i].x).toBeGreaterThanOrEqual(sorted[i - 1].x);
    }
  });

  test('a schedule with no enumerable runs falls back to a single instance', () => {
    const g = buildWaveGraph({ wave: scheduleWave(''), now: NOW, windowMs: WAVE_WINDOWS['1d'], hoveredKey: null });
    expect(g.nodes).toHaveLength(1);
    expect(g.nodes[0].isRoot).toBe(true);
  });
});
