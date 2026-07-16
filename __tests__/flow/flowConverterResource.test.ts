/**
 * Tier 3 — FlowConverter folding of resource edges.
 *
 * Pins the engine contract:
 *  - consume edge (resource→process) → an entry in the process node's
 *    `properties.resourceNodes` with role 'consume';
 *  - produce edge (process→resource, run scope) → role 'produce' AND
 *    `captureResource` derived from the artifact's runName (explicit
 *    captureResource wins);
 *  - resource edges NEVER become successors (no phantom control flow).
 */
import { FlowConverter } from '@/backend/execution/flow/FlowConverter';
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

const resourceEdge = (source: string, target: string) => ({
  id: `${source}->${target}:res`,
  source,
  target,
  data: { edgeType: 'resource' },
});

function buildFlow(extraNodes: unknown[], extraEdges: unknown[]): ReactFlow {
  return {
    id: 'flow-1',
    name: 'f',
    nodes: [
      node('start', 'start', { promptTemplate: '' }),
      node('proc', 'process', { boundModel: 'm' }),
      node('finish', 'finish'),
      ...extraNodes,
    ],
    edges: [controlEdge('start', 'proc'), controlEdge('proc', 'finish'), ...extraEdges],
  } as unknown as ReactFlow;
}

/** Walk the converted graph from the start node and collect nodes by id.
 * (pocketflow's Flow keeps `start` private — the test reaches through.) */
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

describe('FlowConverter resource edges', () => {
  it('consume edge folds into resourceNodes with role consume', () => {
    const flow = buildFlow(
      [node('res', 'resource', { scope: 'mcp', boundServer: 'srv', uri: 'srv://doc' })],
      [resourceEdge('res', 'proc')]
    );
    const converted = FlowConverter.convert(flow);
    const nodes = collectNodes(converted);
    const proc = nodes.get('proc')!;
    const resourceNodes = (proc.node_params.properties as { resourceNodes?: unknown[] }).resourceNodes;
    expect(resourceNodes).toEqual([
      expect.objectContaining({
        id: 'res',
        role: 'consume',
        properties: expect.objectContaining({ boundServer: 'srv', uri: 'srv://doc' }),
      }),
    ]);
    // No captureResource derived from a consume edge.
    expect((proc.node_params.properties as { captureResource?: string }).captureResource).toBeUndefined();
  });

  it('produce edge folds role produce AND derives captureResource from runName', () => {
    const flow = buildFlow(
      [node('res', 'resource', { scope: 'run', runName: 'report' })],
      [resourceEdge('proc', 'res')]
    );
    const converted = FlowConverter.convert(flow);
    const proc = collectNodes(converted).get('proc')!;
    const props = proc.node_params.properties as { resourceNodes?: Array<{ role: string }>; captureResource?: string };
    expect(props.resourceNodes?.[0]).toMatchObject({ id: 'res', role: 'produce' });
    expect(props.captureResource).toBe('report');
  });

  it('an explicit captureResource wins over the derived one', () => {
    const flow: ReactFlow = {
      id: 'flow-1',
      name: 'f',
      nodes: [
        node('start', 'start', { promptTemplate: '' }),
        node('proc', 'process', { boundModel: 'm', captureResource: 'explicit' }),
        node('finish', 'finish'),
        node('res', 'resource', { scope: 'run', runName: 'derived' }),
      ],
      edges: [
        controlEdge('start', 'proc'),
        controlEdge('proc', 'finish'),
        resourceEdge('proc', 'res'),
      ],
    } as unknown as ReactFlow;
    const converted = FlowConverter.convert(flow);
    const proc = collectNodes(converted).get('proc')!;
    expect((proc.node_params.properties as { captureResource?: string }).captureResource).toBe('explicit');
  });

  it('resource edges never create successors', () => {
    const flow = buildFlow(
      [node('res', 'resource', { scope: 'run', runName: 'a' })],
      [resourceEdge('res', 'proc'), resourceEdge('proc', 'res')]
    );
    const converted = FlowConverter.convert(flow);
    const nodes = collectNodes(converted);
    const proc = nodes.get('proc')!;
    const succIds = (proc.successors instanceof Map ? [...proc.successors.values()] : [])
      .map((s) => ((s as BaseNode).node_params as { id?: string }).id);
    // proc's only successor is finish — never the resource node.
    expect(succIds).toEqual(['finish']);
    // The resource node is unreachable from the control graph entirely.
    expect(nodes.has('res')).toBe(false);
  });
});
