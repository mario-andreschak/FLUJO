import type { Edge } from '@xyflow/react';
import type { Flow, FlowNode } from '@/shared/types/flow';
import { buildProcessToSubflowDraft } from '@/frontend/components/Flow/FlowManager/FlowBuilder/utils/convertProcessToSubflow';

const node = (id: string, type: string, x = 0, y = 0): FlowNode => ({
  id,
  type,
  position: { x, y },
  data: { label: id, type, properties: type === 'process' ? { promptTemplate: `prompt-${id}` } : {} },
});

const control = (id: string, source: string, target: string, data: Record<string, unknown> = {}): Edge => ({
  id,
  source,
  target,
  sourceHandle: `${source === 'start' ? 'start' : 'process'}-bottom`,
  targetHandle: `${target === 'finish' ? 'finish' : 'process'}-top`,
  type: 'custom',
  animated: true,
  data: { edgeType: 'standard', ...data },
});

const attachment = (id: string, source: string, target: string, edgeType: 'mcp' | 'resource'): Edge => ({
  id,
  source,
  target,
  sourceHandle: `${source}-attachment`,
  targetHandle: `${target}-attachment`,
  type: edgeType === 'mcp' ? 'mcpEdge' : 'resourceEdge',
  data: { edgeType },
});

const flow = (nodes: FlowNode[], edges: Edge[]): Flow => ({ id: 'parent', name: 'Parent', nodes, edges, updatedAt: 10 });
const ids = () => {
  let value = 0;
  return () => `generated-${++value}`;
};

describe('buildProcessToSubflowDraft', () => {
  it('builds an isolated child and rewires the parent input without mutating source data', () => {
    const parent = flow(
      [node('start', 'start', 0, 0), node('p', 'process', 0, 200)],
      [control('in', 'start', 'p')],
    );
    const before = JSON.stringify(parent);

    const draft = buildProcessToSubflowDraft({
      parentFlow: parent,
      processNodeId: 'p',
      subflowName: 'Child',
      createId: ids(),
    });

    expect(draft.valid).toBe(true);
    expect(JSON.stringify(parent)).toBe(before);
    expect(draft.childFlow?.nodes.map(n => n.type)).toEqual(['start', 'process', 'finish']);
    expect(draft.childFlow?.nodes.find(n => n.id === 'p')?.data.properties?.promptTemplate).toBe('prompt-p');
    expect(draft.parentFlow?.nodes.find(n => n.id === 'p')).toMatchObject({
      type: 'subflow',
      data: { type: 'subflow', properties: { subflowId: 'generated-1', inputMode: 'isolated' } },
    });
    expect(draft.parentFlow?.edges[0]).toMatchObject({ id: 'in', target: 'p', targetHandle: 'subflow-top' });
  });

  it('includes MCP, Resource, and outgoing Signal branches and condenses fan-out at Finish', () => {
    const parent = flow(
      [
        node('start', 'start'), node('p', 'process', 0, 100), node('m', 'mcp', 200, 100),
        node('r', 'resource', -200, 100), node('s1', 'signal', -50, 250), node('s2', 'signal', 50, 250),
      ],
      [
        control('in', 'start', 'p'),
        attachment('mcp', 'p', 'm', 'mcp'),
        attachment('resource', 'p', 'r', 'resource'),
        control('branch-1', 'p', 's1'),
        control('branch-2', 'p', 's2'),
      ],
    );

    const draft = buildProcessToSubflowDraft({ parentFlow: parent, processNodeId: 'p', subflowName: 'Fanout', createId: ids() });

    expect(draft.valid).toBe(true);
    expect(new Set(draft.selectedNodeIds)).toEqual(new Set(['p', 'm', 'r', 's1', 's2']));
    expect(draft.preview.attachmentCount).toBe(2);
    expect(draft.preview.signalCount).toBe(2);
    expect(draft.preview.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining('finish inside'),
      expect.stringContaining('converge'),
    ]));
    const finishId = draft.childFlow?.nodes.find(n => n.type === 'finish')?.id;
    expect(draft.childFlow?.edges.filter(edge => edge.target === finishId)).toHaveLength(2);
  });

  it('keeps a Process follow-up in the parent and preserves crossing-edge metadata', () => {
    const output = {
      ...control('out', 'p', 'next', { condition: { kind: 'always' }, visual: { waypoints: [1, 2] } }),
      style: { stroke: 'purple' },
      label: 'route',
    } as Edge;
    const parent = flow([node('p', 'process'), node('next', 'process', 0, 300)], [output]);

    const draft = buildProcessToSubflowDraft({ parentFlow: parent, processNodeId: 'p', subflowName: 'OneExit', createId: ids() });

    expect(draft.valid).toBe(true);
    expect(draft.selectedNodeIds).toEqual(['p']);
    expect(draft.preview.excludedBoundaryNodes).toEqual([{ id: 'next', label: 'next', type: 'process' }]);
    expect(draft.parentFlow?.edges[0]).toMatchObject({
      id: 'out', source: 'p', target: 'next', sourceHandle: 'subflow-bottom', label: 'route',
      data: { condition: { kind: 'always' }, visual: { waypoints: [1, 2] } },
      style: { stroke: 'purple' },
    });
    const finishId = draft.childFlow?.nodes.find(n => n.type === 'finish')?.id;
    expect(draft.childFlow?.edges.find(edge => edge.target === finishId)).toMatchObject({
      source: 'p', targetHandle: 'finish-top', label: 'route', style: { stroke: 'purple' },
    });
  });

  it('preserves bidirectional metadata on internal control edges', () => {
    const internal = control('internal', 'p', 'signal', { bidirectional: true, condition: { kind: 'model' } });
    const draft = buildProcessToSubflowDraft({
      parentFlow: flow([node('p', 'process'), node('signal', 'signal')], [internal]),
      processNodeId: 'p',
      subflowName: 'BidirectionalInside',
      createId: ids(),
    });

    expect(draft.valid).toBe(true);
    expect(draft.childFlow?.edges.find(edge => edge.id === 'internal')?.data).toEqual({
      edgeType: 'standard', bidirectional: true, condition: { kind: 'model' },
    });
  });

  it('rejects multiple parent exits under the one-output Subflow contract', () => {
    const draft = buildProcessToSubflowDraft({
      parentFlow: flow(
        [node('p', 'process'), node('a', 'process'), node('b', 'subflow')],
        [control('out-a', 'p', 'a'), control('out-b', 'p', 'b')],
      ),
      processNodeId: 'p',
      subflowName: 'Ambiguous',
      createId: ids(),
    });

    expect(draft.valid).toBe(false);
    expect(draft.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'multiple-outputs' }),
    ]));
    expect(draft.childFlow).toBeUndefined();
  });

  it('rejects bidirectional boundary crossings and shared attachments', () => {
    const draft = buildProcessToSubflowDraft({
      parentFlow: flow(
        [node('p', 'process'), node('next', 'process'), node('m', 'mcp'), node('other', 'process')],
        [
          control('two-way', 'p', 'next', { bidirectional: true }),
          attachment('owned', 'p', 'm', 'mcp'),
          attachment('shared', 'other', 'm', 'mcp'),
        ],
      ),
      processNodeId: 'p',
      subflowName: 'Invalid',
      createId: ids(),
    });

    expect(draft.valid).toBe(false);
    expect(draft.errors.map(error => error.code)).toEqual(expect.arrayContaining([
      'bidirectional-boundary', 'shared-attachment',
    ]));
  });
});
