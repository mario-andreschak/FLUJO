/**
 * Tier 3 — resource nodes in the FlowSpec codec.
 *
 * Pins: compile emits the resource FlowNode + a correctly-shaped, correctly-
 * DIRECTED resource edge (consume vs produce from key position); illegal
 * resource edges error; and — the AI-Improve data-loss guard — flowToSpec
 * round-trips resource nodes and their edges instead of silently dropping
 * them (flowToSpec drops unknown node types).
 */
import { compileFlowSpec, flowToSpec, FlowSpec } from '@/utils/shared/flowSpecCompiler';

const context = {
  models: [{ id: 'model-1', displayName: 'GPT' }],
  servers: [{ name: 'files' }],
  serverTools: { files: ['read'] },
};

const baseSpec = (extraNodes: unknown[], extraEdges: unknown[]): FlowSpec => ({
  name: 'resource_flow',
  nodes: [
    { key: 'start', type: 'start', prompt: 'sys' },
    { key: 'step', type: 'process', model: 'model-1', prompt: 'work' },
    { key: 'end', type: 'finish' },
    ...extraNodes as never[],
  ],
  edges: [
    { from: 'start', to: 'step' },
    { from: 'step', to: 'end' },
    ...extraEdges as never[],
  ],
});

describe('compile: resource nodes + edges', () => {
  it('compiles a static MCP resource with a consume edge (resource → process)', () => {
    const result = compileFlowSpec(
      baseSpec(
        [{ key: 'doc', type: 'resource', label: 'Spec Doc', server: 'files', uri: 'file:///spec.md' }],
        [{ from: 'doc', to: 'step' }]
      ),
      context
    );
    expect(result.errorCount).toBe(0);
    const flow = result.flow!;
    const resNode = flow.nodes.find((n) => n.type === 'resource')!;
    expect(resNode.data.properties).toMatchObject({ scope: 'mcp', boundServer: 'files', uri: 'file:///spec.md' });

    const resEdge = flow.edges.find((e) => (e.data as { edgeType?: string })?.edgeType === 'resource')!;
    const step = flow.nodes.find((n) => n.data.label === 'step' || n.data.properties?.promptTemplate === 'work')!;
    expect(resEdge.source).toBe(resNode.id);
    expect(resEdge.target).toBe(step.id);
    expect(resEdge.sourceHandle).toBe('resource-out');
    expect(resEdge.targetHandle).toBe('process-left-resource');
    expect(resEdge.type).toBe('resourceEdge');
    expect(resEdge.animated).toBe(false);
  });

  it('compiles a run artifact with a produce edge (process → resource)', () => {
    const result = compileFlowSpec(
      baseSpec(
        [{ key: 'out', type: 'resource', runName: 'report' }],
        [{ from: 'step', to: 'out' }]
      ),
      context
    );
    expect(result.errorCount).toBe(0);
    const flow = result.flow!;
    const resNode = flow.nodes.find((n) => n.type === 'resource')!;
    expect(resNode.data.properties).toMatchObject({ scope: 'run', runName: 'report' });

    const resEdge = flow.edges.find((e) => (e.data as { edgeType?: string })?.edgeType === 'resource')!;
    expect(resEdge.target).toBe(resNode.id);
    expect(resEdge.sourceHandle).toBe('process-right-resource');
    expect(resEdge.targetHandle).toBe('resource-in');
  });

  it('rejects resource edges to non-process nodes', () => {
    const result = compileFlowSpec(
      baseSpec(
        [{ key: 'doc', type: 'resource', server: 'files', uri: 'file:///x' }],
        [{ from: 'doc', to: 'end' }]
      ),
      context
    );
    expect(result.issues.map((i) => i.code)).toContain('resource-edge-invalid');
  });

  it('warns on an unbound static resource and an unknown server', () => {
    const unbound = compileFlowSpec(
      baseSpec([{ key: 'doc', type: 'resource' }], [{ from: 'doc', to: 'step' }]),
      context
    );
    expect(unbound.issues.map((i) => i.code)).toContain('resource-missing-binding');

    const ghost = compileFlowSpec(
      baseSpec([{ key: 'doc', type: 'resource', server: 'ghost', uri: 'u://x' }], [{ from: 'doc', to: 'step' }]),
      context
    );
    expect(ghost.issues.map((i) => i.code)).toContain('server-unknown');
  });

  it('resource nodes lay out as satellites (left of their process node)', () => {
    const result = compileFlowSpec(
      baseSpec(
        [{ key: 'doc', type: 'resource', server: 'files', uri: 'file:///x' }],
        [{ from: 'doc', to: 'step' }]
      ),
      context
    );
    const flow = result.flow!;
    const resNode = flow.nodes.find((n) => n.type === 'resource')!;
    const step = flow.nodes.find((n) => n.data.properties?.promptTemplate === 'work')!;
    expect(resNode.position.x).toBeLessThan(step.position.x);
    expect(resNode.position.y).toBe(step.position.y);
  });
});

describe('flowToSpec round-trip (AI-Improve data-loss guard)', () => {
  it('resource nodes + edges survive compile → flowToSpec → compile', () => {
    const first = compileFlowSpec(
      baseSpec(
        [
          { key: 'doc', type: 'resource', label: 'Doc', server: 'files', uri: 'file:///spec.md' },
          { key: 'out', type: 'resource', label: 'Out', runName: 'report' },
        ],
        [
          { from: 'doc', to: 'step' },
          { from: 'step', to: 'out' },
        ]
      ),
      context
    );
    expect(first.errorCount).toBe(0);

    const spec = flowToSpec(first.flow!);
    const resSpecNodes = spec.nodes.filter((n) => n.type === 'resource');
    expect(resSpecNodes).toHaveLength(2);
    expect(resSpecNodes.find((n) => n.uri === 'file:///spec.md')).toMatchObject({ server: 'files' });
    expect(resSpecNodes.find((n) => n.runName === 'report')).toBeDefined();

    // The edges survive with direction intact (keys are the flow node ids).
    const flowNodeByType = new Map(first.flow!.nodes.map((n) => [n.id, n.type]));
    const resEdges = spec.edges.filter(
      (e) => flowNodeByType.get(e.from) === 'resource' || flowNodeByType.get(e.to) === 'resource'
    );
    expect(resEdges).toHaveLength(2);

    // And a second compile reproduces resource nodes + edges (no loss).
    const second = compileFlowSpec(spec, context);
    expect(second.errorCount).toBe(0);
    expect(second.flow!.nodes.filter((n) => n.type === 'resource')).toHaveLength(2);
    expect(second.flow!.edges.filter((e) => (e.data as { edgeType?: string })?.edgeType === 'resource')).toHaveLength(2);
  });
});
