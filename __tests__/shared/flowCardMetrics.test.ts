import type { Edge } from '@xyflow/react';
import type { Flow, FlowNode } from '@/shared/types/flow';
import { getFlowCardMetrics } from '@/utils/shared/flowCardMetrics';

const node = (id: string, type: string, properties?: Record<string, unknown>): FlowNode => ({
  id,
  type,
  position: { x: 0, y: 0 },
  data: { label: id, type, properties },
});

const edge = (
  source: string,
  target: string,
  data: Record<string, unknown> = { edgeType: 'standard' },
): Edge => ({ id: `${source}-${target}`, source, target, data });

const metrics = (nodes: FlowNode[], edges: Edge[] = []) =>
  getFlowCardMetrics({ nodes, edges } as Pick<Flow, 'nodes' | 'edges'>);

describe('getFlowCardMetrics', () => {
  it('counts Process nodes as steps without counting their MCP attachments', () => {
    expect(metrics(
      [node('process', 'process'), node('mcp-a', 'mcp'), node('mcp-b', 'mcp')],
      [
        edge('process', 'mcp-a', { edgeType: 'mcp' }),
        edge('mcp-b', 'process', { edgeType: 'mcp' }),
      ],
    )).toEqual({ stepCount: 1, subagentCount: 0, signalCount: 0 });
  });

  it('classifies a bidirectional Process/Subflow connection as a sub-agent', () => {
    expect(metrics(
      [node('process', 'process'), node('child', 'subflow')],
      [edge('process', 'child', { edgeType: 'standard', bidirectional: true })],
    )).toEqual({ stepCount: 1, subagentCount: 1, signalCount: 0 });
  });

  it('classifies a leaf Subflow with one incoming one-way connection as a sub-agent', () => {
    expect(metrics(
      [node('process', 'process'), node('child', 'subflow')],
      [edge('process', 'child')],
    )).toEqual({ stepCount: 1, subagentCount: 1, signalCount: 0 });
  });

  it('classifies a pass-through Subflow between different nodes as a step', () => {
    expect(metrics(
      [node('before', 'process'), node('child', 'subflow'), node('after', 'process')],
      [edge('before', 'child'), edge('child', 'after')],
    )).toEqual({ stepCount: 3, subagentCount: 0, signalCount: 0 });
  });

  it('does not call a Subflow returning to the same node a sequential step', () => {
    expect(metrics(
      [node('process', 'process'), node('child', 'subflow')],
      [edge('process', 'child'), edge('child', 'process')],
    )).toEqual({ stepCount: 1, subagentCount: 0, signalCount: 0 });
  });

  it('counts only configured signal nodes as emitted signals', () => {
    expect(metrics([
      node('start', 'start'),
      node('ready', 'signal', { topic: 'ready' }),
      node('blank', 'signal', { topic: '   ' }),
      node('resource', 'resource'),
      node('finish', 'finish'),
    ])).toEqual({ stepCount: 0, subagentCount: 0, signalCount: 1 });
  });
});
