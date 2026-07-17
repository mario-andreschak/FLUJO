/**
 * Signal node (issue #117) — FlowConverter builds it as a transparent inline
 * control node: a bare successor edge in and out, exactly like a process node,
 * and its topic/payload survive onto node_params. It is NOT an attachment node,
 * so its edges become real successors (unlike mcp/resource edges).
 */
import { FlowConverter } from '@/backend/execution/flow/FlowConverter';
import { SignalNode } from '@/backend/execution/flow/nodes/SignalNode';
import { BaseNode } from '@/backend/execution/flow/pocketflow';
import type { Flow as ReactFlow } from '@/frontend/types/flow/flow';

const node = (id: string, type: string, properties: Record<string, unknown> = {}) => ({
  id,
  type,
  position: { x: 0, y: 0 },
  data: { label: id, type, properties },
});

const controlEdge = (source: string, target: string) => ({
  id: `${source}->${target}`,
  source,
  target,
  data: { edgeType: 'standard' },
});

function collectNodes(flow: unknown): Map<string, BaseNode> {
  const seen = new Map<string, BaseNode>();
  const start = (flow as { start: BaseNode }).start;
  const walk = (n: BaseNode) => {
    const id = (n.node_params as { id?: string } | undefined)?.id ?? '?';
    if (seen.has(id)) return;
    seen.set(id, n);
    const succs = n.successors instanceof Map ? [...n.successors.values()] : Object.values(n.successors ?? {});
    for (const s of succs) walk(s as BaseNode);
  };
  walk(start);
  return seen;
}

describe('FlowConverter signal node', () => {
  it('builds a SignalNode inline with pass-through control flow', () => {
    const flow: ReactFlow = {
      id: 'flow-1',
      name: 'f',
      nodes: [
        node('start', 'start', { promptTemplate: '' }),
        node('sig', 'signal', { topic: 'greet', payloadTemplate: 'Hi ${var:name}' }),
        node('finish', 'finish'),
      ],
      edges: [controlEdge('start', 'sig'), controlEdge('sig', 'finish')],
    } as unknown as ReactFlow;

    const converted = FlowConverter.convert(flow);
    const nodes = collectNodes(converted);

    const sig = nodes.get('sig');
    expect(sig).toBeInstanceOf(SignalNode);
    expect(sig!.node_params.type).toBe('signal');
    expect((sig!.node_params.properties as { topic?: string }).topic).toBe('greet');
    expect((sig!.node_params.properties as { payloadTemplate?: string }).payloadTemplate).toBe(
      'Hi ${var:name}'
    );

    // Reachable inline: start → sig → finish.
    expect(nodes.has('start')).toBe(true);
    expect(nodes.has('finish')).toBe(true);
    const succIds = (sig!.successors instanceof Map ? [...sig!.successors.values()] : []).map(
      (s) => ((s as BaseNode).node_params as { id?: string }).id
    );
    expect(succIds).toEqual(['finish']);
  });
});
