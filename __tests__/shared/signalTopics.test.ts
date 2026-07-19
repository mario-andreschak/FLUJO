/**
 * Signal-topic helpers (issues #163/#165) — the pure, shared topic-scan module
 * consumed by BOTH the waves resolver and the planned-execution trigger editor.
 *
 * These tests pin: direct topic collection, subflow-reachable topic traversal
 * (incl. cycle/depth safety and dynamic fan-out being skipped), and the
 * topic→emitter index (direct vs via-subflow attribution, node counts).
 */
import type { Flow } from '@/shared/types/flow/flow';
import {
  directSubflowIds,
  directTopics,
  reachableTopics,
  buildTopicEmitterIndex,
} from '@/shared/utils/signalTopics';

const signalNode = (id: string, topic: string) => ({
  id,
  type: 'signal',
  position: { x: 0, y: 0 },
  data: { label: id, type: 'signal', properties: { topic } },
});

const subflowNode = (id: string, props: Record<string, unknown>) => ({
  id,
  type: 'subflow',
  position: { x: 0, y: 0 },
  data: { label: id, type: 'subflow', properties: props },
});

const flow = (id: string, name: string, nodes: any[]): Flow =>
  ({ id, name, nodes, edges: [] } as unknown as Flow);

describe('signalTopics — directTopics', () => {
  it('collects and trims topics from a flow’s own signal nodes', () => {
    const f = flow('f1', 'F1', [signalNode('s1', '  review-blocked  '), signalNode('s2', 'done')]);
    expect(directTopics(f)).toEqual(['review-blocked', 'done']);
  });

  it('ignores non-signal nodes and empty/whitespace topics', () => {
    const f = flow('f1', 'F1', [
      signalNode('s1', '   '),
      subflowNode('sub', { subflowId: 'x' }),
      { id: 'p', type: 'process', position: { x: 0, y: 0 }, data: { label: 'p', type: 'process', properties: {} } },
    ]);
    expect(directTopics(f)).toEqual([]);
  });

  it('is safe on undefined / malformed flows', () => {
    expect(directTopics(undefined)).toEqual([]);
    expect(directTopics({ id: 'x', name: 'x' } as unknown as Flow)).toEqual([]);
  });
});

describe('signalTopics — directSubflowIds', () => {
  it('collects single + parallel subflow ids and de-dupes', () => {
    const f = flow('f1', 'F1', [
      subflowNode('a', { subflowId: 'child1' }),
      subflowNode('b', { parallelSubflowIds: ['child2', 'child1', '  '] }),
    ]);
    expect(directSubflowIds(f)).toEqual(['child1', 'child2']);
  });

  it('skips dynamic fan-out (parallelSubflowIdsVar) — unknowable statically', () => {
    const f = flow('f1', 'F1', [subflowNode('a', { parallelSubflowIdsVar: 'chosen' })]);
    expect(directSubflowIds(f)).toEqual([]);
  });
});

describe('signalTopics — reachableTopics', () => {
  it('includes topics emitted by statically-reachable subflows', () => {
    const child = flow('child', 'Child', [signalNode('cs', 'from-child')]);
    const parent = flow('parent', 'Parent', [
      signalNode('ps', 'from-parent'),
      subflowNode('call', { subflowId: 'child' }),
    ]);
    const byId = new Map<string, Flow>([
      ['parent', parent],
      ['child', child],
    ]);
    expect([...reachableTopics('parent', byId)].sort()).toEqual(['from-child', 'from-parent']);
  });

  it('terminates on subflow cycles', () => {
    const a = flow('a', 'A', [signalNode('as', 'a-topic'), subflowNode('toB', { subflowId: 'b' })]);
    const b = flow('b', 'B', [signalNode('bs', 'b-topic'), subflowNode('toA', { subflowId: 'a' })]);
    const byId = new Map<string, Flow>([
      ['a', a],
      ['b', b],
    ]);
    expect([...reachableTopics('a', byId)].sort()).toEqual(['a-topic', 'b-topic']);
  });
});

describe('signalTopics — buildTopicEmitterIndex', () => {
  it('records direct emitters with node counts', () => {
    const f = flow('f1', 'Review Bot', [signalNode('s1', 'review-blocked'), signalNode('s2', 'review-blocked')]);
    const index = buildTopicEmitterIndex([f]);
    const emitters = index.get('review-blocked')!;
    expect(emitters).toHaveLength(1);
    expect(emitters[0]).toMatchObject({
      flowId: 'f1',
      flowName: 'Review Bot',
      signalNodeCount: 2,
      viaSubflow: false,
    });
  });

  it('attributes subflow-reachable topics with viaSubflow=true and count 0', () => {
    const child = flow('child', 'Child', [signalNode('cs', 'deep')]);
    const parent = flow('parent', 'Parent', [subflowNode('call', { subflowId: 'child' })]);
    const index = buildTopicEmitterIndex([parent, child]);

    const emitters = index.get('deep')!;
    // Child emits it directly; parent reaches it via the subflow.
    const child_ = emitters.find((e) => e.flowId === 'child')!;
    const parent_ = emitters.find((e) => e.flowId === 'parent')!;
    expect(child_).toMatchObject({ signalNodeCount: 1, viaSubflow: false });
    expect(parent_).toMatchObject({ signalNodeCount: 0, viaSubflow: true });
  });

  it('returns an empty index when there are no signals', () => {
    const f = flow('f1', 'F1', [
      { id: 'p', type: 'process', position: { x: 0, y: 0 }, data: { label: 'p', type: 'process', properties: {} } },
    ]);
    expect(buildTopicEmitterIndex([f]).size).toBe(0);
  });
});
