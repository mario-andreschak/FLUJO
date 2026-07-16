/**
 * Tier 3 — resource nodes in the flow validator, plus the REGRESSION guard
 * that resource edges are never misread as flow control (reachability,
 * subflow single-outgoing, condition fallback).
 */
import { validateFlow, VFlow } from '@/utils/shared/flowValidation';

const node = (id: string, type: string, properties: Record<string, unknown> = {}, label = id) => ({
  id,
  type,
  data: { label, type, properties },
});

const controlEdge = (source: string, target: string, data: Record<string, unknown> = {}) => ({
  id: `${source}->${target}`,
  source,
  target,
  data: { edgeType: 'standard', ...data },
});

const resourceEdge = (source: string, target: string) => ({
  id: `${source}->${target}:res`,
  source,
  target,
  data: { edgeType: 'resource' },
});

const baseNodes = [
  node('start', 'start'),
  node('proc', 'process', { boundModel: 'm', promptTemplate: 'do it' }),
  node('finish', 'finish'),
];
const baseEdges = [controlEdge('start', 'proc'), controlEdge('proc', 'finish')];

const codes = (flow: VFlow, context = {}) => validateFlow(flow, context).issues.map((i) => i.code);

describe('resource node checks', () => {
  it('warns on an unbound static resource node', () => {
    const flow: VFlow = {
      nodes: [...baseNodes, node('res', 'resource', { scope: 'mcp' })],
      edges: [...baseEdges, resourceEdge('res', 'proc')],
    };
    expect(codes(flow)).toContain('resource-missing-binding');
  });

  it('warns on a run artifact with no name, and on an invalid name', () => {
    const noName: VFlow = {
      nodes: [...baseNodes, node('res', 'resource', { scope: 'run' })],
      edges: [...baseEdges, resourceEdge('proc', 'res')],
    };
    expect(codes(noName)).toContain('resource-missing-binding');

    const badName: VFlow = {
      nodes: [...baseNodes, node('res', 'resource', { scope: 'run', runName: '1bad name' })],
      edges: [...baseEdges, resourceEdge('proc', 'res')],
    };
    expect(codes(badName)).toContain('resource-run-name');
  });

  it('warns on an unconnected resource node', () => {
    const flow: VFlow = {
      nodes: [...baseNodes, node('res', 'resource', { scope: 'mcp', boundServer: 's', uri: 'u://x' })],
      edges: baseEdges,
    };
    expect(codes(flow)).toContain('resource-node-unconnected');
  });

  it('errors when a step writes INTO a static resource', () => {
    const flow: VFlow = {
      nodes: [...baseNodes, node('res', 'resource', { scope: 'mcp', boundServer: 's', uri: 'u://x' })],
      edges: [...baseEdges, resourceEdge('proc', 'res')],
    };
    const result = validateFlow(flow, {});
    const issue = result.issues.find((i) => i.code === 'resource-produce-static');
    expect(issue?.severity).toBe('error');
  });

  it('warns on multiple producers and consumed-never-produced run artifacts', () => {
    const twoProducers: VFlow = {
      nodes: [
        ...baseNodes,
        node('proc2', 'process', { boundModel: 'm' }),
        node('res', 'resource', { scope: 'run', runName: 'artifact' }),
      ],
      edges: [
        ...baseEdges,
        controlEdge('proc', 'proc2'),
        resourceEdge('proc', 'res'),
        resourceEdge('proc2', 'res'),
      ],
    };
    expect(codes(twoProducers)).toContain('resource-multiple-producers');

    const consumedOnly: VFlow = {
      nodes: [...baseNodes, node('res', 'resource', { scope: 'run', runName: 'artifact' })],
      edges: [...baseEdges, resourceEdge('res', 'proc')],
    };
    expect(codes(consumedOnly)).toContain('resource-consumed-never-produced');
  });

  it('warns when the bound server is unknown (with a server context)', () => {
    const flow: VFlow = {
      nodes: [...baseNodes, node('res', 'resource', { scope: 'mcp', boundServer: 'ghost', uri: 'u://x' })],
      edges: [...baseEdges, resourceEdge('res', 'proc')],
    };
    expect(codes(flow, { servers: [{ name: 'other' }] })).toContain('resource-server-missing');
    // Without server context the check is skipped.
    expect(codes(flow, {})).not.toContain('resource-server-missing');
  });
});

describe('REGRESSION: resource edges are not control edges', () => {
  it('a consume edge does not make the process node reachable through the resource node', () => {
    // start → proc → finish is intact; res → proc is a resource edge. If the
    // classifier ever leaked, res would count as an extra route and the
    // validator's adjacency would differ — pin the healthy flow's issues.
    const flow: VFlow = {
      nodes: [...baseNodes, node('res', 'resource', { scope: 'run', runName: 'a' })],
      edges: [...baseEdges, resourceEdge('res', 'proc'), resourceEdge('proc', 'res')],
    };
    const result = validateFlow(flow, {});
    // No structural complaints beyond the (intentional) none here.
    expect(result.issues.map((i) => i.code)).not.toContain('unreachable-node');
    expect(result.issues.map((i) => i.code)).not.toContain('start-no-outgoing');
  });

  it('a produce edge does not count as a subflow outgoing path', () => {
    // Attach a resource to a SUBFLOW-adjacent process; then give a subflow
    // one control successor + wire the flow's process to a resource. The
    // subflow must not trip subflow-multiple-outgoing because of resource
    // edges anywhere.
    const flow: VFlow = {
      nodes: [
        node('start', 'start'),
        node('sub', 'subflow', { subflowId: 'child' }),
        node('proc', 'process', { boundModel: 'm' }),
        node('finish', 'finish'),
        node('res', 'resource', { scope: 'run', runName: 'a' }),
      ],
      edges: [
        controlEdge('start', 'sub'),
        controlEdge('sub', 'proc'),
        controlEdge('proc', 'finish'),
        resourceEdge('proc', 'res'),
      ],
    };
    expect(codes(flow)).not.toContain('subflow-multiple-outgoing');
  });

  it('a resource edge is not a bare fallback for a conditioned node', () => {
    const flow: VFlow = {
      nodes: [...baseNodes, node('res', 'resource', { scope: 'run', runName: 'a' })],
      edges: [
        controlEdge('start', 'proc'),
        controlEdge('proc', 'finish', { condition: { kind: 'contains', value: 'DONE' } }),
        // The only other edge leaving proc is resource wiring — NOT a fallback.
        resourceEdge('proc', 'res'),
      ],
    };
    expect(codes(flow)).toContain('edge-condition-no-fallback');
  });
});
