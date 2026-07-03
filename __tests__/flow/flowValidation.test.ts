/**
 * Tests for the flow consistency checker (src/utils/shared/flowValidation.ts).
 *
 * Covers the inconsistencies a flow can drift into: deleted/renamed bound models,
 * renamed/deleted MCP servers, missing or duplicate Start nodes, missing Finish nodes,
 * Process nodes with no model, orphaned/unreachable nodes, unconnected MCP nodes, and
 * dangling tool pills left behind when an MCP node is deleted or its server renamed.
 */
import {
  validateFlow,
  mcpServersConnectedToProcess,
  type VFlow,
  type VNode,
  type VEdge,
} from '@/utils/shared/flowValidation';
import { encodeBindingPill } from '@/utils/shared/mcpBinding';

const startNode = (id = 'start', over: Partial<VNode> = {}): VNode => ({
  id,
  type: 'start',
  data: { label: 'Start', type: 'start', properties: {} },
  ...over,
});
const processNode = (id: string, properties: Record<string, any> = {}, label = id): VNode => ({
  id,
  type: 'process',
  data: { label, type: 'process', properties },
});
const mcpNode = (id: string, boundServer?: string, label = id): VNode => ({
  id,
  type: 'mcp',
  data: { label, type: 'mcp', properties: boundServer ? { boundServer } : {} },
});
const finishNode = (id = 'finish'): VNode => ({
  id,
  type: 'finish',
  data: { label: 'Finish', type: 'finish', properties: {} },
});
const edge = (source: string, target: string, mcp = false): VEdge => ({
  id: `${source}-${target}`,
  source,
  target,
  data: { edgeType: mcp ? 'mcp' : 'standard' },
});

const codes = (r: { issues: { code: string }[] }) => r.issues.map((i) => i.code);

describe('validateFlow — structure', () => {
  it('flags a missing Start node as an error', () => {
    const flow: VFlow = { nodes: [processNode('p', { boundModel: 'm1' }), finishNode()], edges: [] };
    const r = validateFlow(flow);
    expect(codes(r)).toContain('no-start-node');
    expect(r.isRunnable).toBe(false);
  });

  it('flags more than one Start node', () => {
    const flow: VFlow = { nodes: [startNode('s1'), startNode('s2'), finishNode()], edges: [edge('s1', 'finish')] };
    const r = validateFlow(flow);
    expect(codes(r)).toContain('multiple-start-nodes');
  });

  it('warns when there is no Finish node', () => {
    const flow: VFlow = {
      nodes: [startNode(), processNode('p', { boundModel: 'm1' })],
      edges: [edge('start', 'p')],
    };
    const r = validateFlow(flow);
    expect(codes(r)).toContain('no-finish-node');
  });

  it('passes a well-formed start -> process -> finish flow', () => {
    const flow: VFlow = {
      nodes: [startNode(), processNode('p', { boundModel: 'm1' }), finishNode()],
      edges: [edge('start', 'p'), edge('p', 'finish')],
    };
    const r = validateFlow(flow, { models: [{ id: 'm1', name: 'gpt' }] });
    expect(r.issues).toEqual([]);
    expect(r.isRunnable).toBe(true);
  });
});

describe('validateFlow — model binding', () => {
  it('errors when a process node has no bound model', () => {
    const flow: VFlow = {
      nodes: [startNode(), processNode('p', {}), finishNode()],
      edges: [edge('start', 'p'), edge('p', 'finish')],
    };
    expect(codes(validateFlow(flow))).toContain('process-missing-model');
  });

  it('errors when the bound model was deleted', () => {
    const flow: VFlow = {
      nodes: [startNode(), processNode('p', { boundModel: 'gone', modelName: 'old-tech' }), finishNode()],
      edges: [edge('start', 'p'), edge('p', 'finish')],
    };
    const r = validateFlow(flow, { models: [{ id: 'other', name: 'x' }] });
    expect(codes(r)).toContain('process-model-missing');
  });

  it('does not flag a stale cached model technical name (binding is by id, cache is display-only)', () => {
    const flow: VFlow = {
      nodes: [startNode(), processNode('p', { boundModel: 'm1', modelName: 'old-name' }), finishNode()],
      edges: [edge('start', 'p'), edge('p', 'finish')],
    };
    const r = validateFlow(flow, { models: [{ id: 'm1', name: 'new-name' }] });
    expect(codes(r)).not.toContain('process-model-renamed');
    expect(r.issues).toEqual([]);
    expect(r.isRunnable).toBe(true); // still runs — binding is by id
  });

  it('skips model checks entirely when no models context is provided', () => {
    const flow: VFlow = {
      nodes: [startNode(), processNode('p', { boundModel: 'whatever' }), finishNode()],
      edges: [edge('start', 'p'), edge('p', 'finish')],
    };
    expect(validateFlow(flow).issues).toEqual([]);
  });
});

describe('validateFlow — MCP server binding', () => {
  it('warns (does not block) when an MCP node is bound to a server missing from the list', () => {
    // Absence is ambiguous — renamed/removed vs. just offline (VPN down) — so it's advisory,
    // not a hard error that blocks the run.
    const flow: VFlow = {
      nodes: [startNode(), processNode('p', { boundModel: 'm1' }), finishNode(), mcpNode('mcp1', 'old-server')],
      edges: [edge('start', 'p'), edge('p', 'finish'), edge('p', 'mcp1', true)],
    };
    const r = validateFlow(flow, { models: [{ id: 'm1' }], servers: [{ name: 'new-server', status: 'connected' }] });
    const missing = r.issues.find((i) => i.code === 'mcp-server-missing');
    expect(missing?.severity).toBe('warning');
    expect(r.isRunnable).toBe(true);
  });

  it('warns when the bound server exists but is not connected', () => {
    const flow: VFlow = {
      nodes: [startNode(), processNode('p', { boundModel: 'm1' }), finishNode(), mcpNode('mcp1', 'srv')],
      edges: [edge('start', 'p'), edge('p', 'finish'), edge('p', 'mcp1', true)],
    };
    const r = validateFlow(flow, { models: [{ id: 'm1' }], servers: [{ name: 'srv', status: 'error' }] });
    expect(codes(r)).toContain('mcp-server-disconnected');
  });

  it('warns about an MCP node not connected to any process node', () => {
    const flow: VFlow = {
      nodes: [startNode(), processNode('p', { boundModel: 'm1' }), finishNode(), mcpNode('mcp1', 'srv')],
      edges: [edge('start', 'p'), edge('p', 'finish')],
    };
    const r = validateFlow(flow, { models: [{ id: 'm1' }], servers: [{ name: 'srv', status: 'connected' }] });
    expect(codes(r)).toContain('mcp-node-unconnected');
  });
});

describe('validateFlow — connectivity', () => {
  it('errors when the Start node has no outgoing edge', () => {
    const flow: VFlow = {
      nodes: [startNode(), processNode('p', { boundModel: 'm1' }), finishNode()],
      edges: [edge('p', 'finish')],
    };
    const r = validateFlow(flow, { models: [{ id: 'm1' }] });
    expect(codes(r)).toContain('start-no-outgoing');
  });

  it('warns about a process node unreachable from start', () => {
    const flow: VFlow = {
      nodes: [startNode(), processNode('p1', { boundModel: 'm1' }), processNode('orphan', { boundModel: 'm1' }), finishNode()],
      edges: [edge('start', 'p1'), edge('p1', 'finish')],
    };
    const r = validateFlow(flow, { models: [{ id: 'm1' }] });
    expect(codes(r)).toContain('unreachable-node');
    expect(r.issues.find((i) => i.code === 'unreachable-node')?.nodeId).toBe('orphan');
  });

  it('treats bidirectional edges as connecting both ways for reachability', () => {
    // p2 has no forward path from start; the bidirectional edge stored as
    // p2 -> p1 must still make it reachable (via p1 -> p2).
    const biEdge: VEdge = { id: 'p2-p1', source: 'p2', target: 'p1', data: { edgeType: 'standard', bidirectional: true } };
    const flow: VFlow = {
      nodes: [startNode(), processNode('p1', { boundModel: 'm1' }), processNode('p2', { boundModel: 'm1' }), finishNode()],
      edges: [edge('start', 'p1'), edge('p1', 'finish'), biEdge],
    };
    const r = validateFlow(flow, { models: [{ id: 'm1' }] });
    expect(codes(r)).not.toContain('unreachable-node');
  });

  it('does not treat mcp edges as flow control for reachability', () => {
    // p is reachable via the standard edge; the mcp edge to mcp1 must not count.
    const flow: VFlow = {
      nodes: [startNode(), processNode('p', { boundModel: 'm1' }), finishNode(), mcpNode('mcp1', 'srv')],
      edges: [edge('start', 'p'), edge('p', 'finish'), edge('p', 'mcp1', true)],
    };
    const r = validateFlow(flow, { models: [{ id: 'm1' }], servers: [{ name: 'srv', status: 'connected' }] });
    expect(codes(r)).not.toContain('unreachable-node');
  });
});

describe('validateFlow — dangling tool pills', () => {
  it('errors when a prompt references a server the node is not connected to', () => {
    // The pill references "files", but the process node has no mcp edge to a "files" server.
    const prompt = `Use ${encodeBindingPill('tool', 'files', 'read')} please`;
    const flow: VFlow = {
      nodes: [startNode(), processNode('p', { boundModel: 'm1', promptTemplate: prompt }), finishNode()],
      edges: [edge('start', 'p'), edge('p', 'finish')],
    };
    const r = validateFlow(flow, { models: [{ id: 'm1' }] });
    expect(codes(r)).toContain('tool-pill-disconnected');
  });

  it('accepts a pill whose server is still connected', () => {
    const prompt = `Use ${encodeBindingPill('tool', 'files', 'read')}`;
    const flow: VFlow = {
      nodes: [
        startNode(),
        processNode('p', { boundModel: 'm1', promptTemplate: prompt }),
        finishNode(),
        mcpNode('mcp1', 'files'),
      ],
      edges: [edge('start', 'p'), edge('p', 'finish'), edge('p', 'mcp1', true)],
    };
    const r = validateFlow(flow, {
      models: [{ id: 'm1' }],
      servers: [{ name: 'files', status: 'connected' }],
    });
    expect(codes(r)).not.toContain('tool-pill-disconnected');
  });

  it('warns when a connected server no longer provides the referenced tool', () => {
    const prompt = `Use ${encodeBindingPill('tool', 'files', 'deleted_tool')}`;
    const flow: VFlow = {
      nodes: [
        startNode(),
        processNode('p', { boundModel: 'm1', promptTemplate: prompt }),
        finishNode(),
        mcpNode('mcp1', 'files'),
      ],
      edges: [edge('start', 'p'), edge('p', 'finish'), edge('p', 'mcp1', true)],
    };
    const r = validateFlow(flow, {
      models: [{ id: 'm1' }],
      servers: [{ name: 'files', status: 'connected' }],
      serverTools: { files: ['read', 'write'] },
    });
    expect(codes(r)).toContain('tool-unavailable');
  });

  it('ignores handoff pills (not server-bound)', () => {
    const prompt = `${encodeBindingPill('tool', 'handoff', 'handoff_to_xyz')}`;
    const flow: VFlow = {
      nodes: [startNode(), processNode('p', { boundModel: 'm1', promptTemplate: prompt }), finishNode()],
      edges: [edge('start', 'p'), edge('p', 'finish')],
    };
    const r = validateFlow(flow, { models: [{ id: 'm1' }] });
    expect(codes(r)).not.toContain('tool-pill-disconnected');
  });
});

describe('mcpServersConnectedToProcess', () => {
  it('returns servers reachable via mcp edges only', () => {
    const nodes = [processNode('p', {}), mcpNode('a', 'srvA'), mcpNode('b', 'srvB')];
    const edges = [edge('p', 'a', true), edge('p', 'b', false /* standard, must be ignored */)];
    const result = mcpServersConnectedToProcess('p', nodes, edges);
    expect([...result]).toEqual(['srvA']);
  });
});

// Note: the former stripServerBindings/computeOrphanedPromptCleanups helpers
// (eager pill scrubbing on node deletion) were removed on purpose: pills now
// survive edge/node deletion at design time so re-connecting restores them,
// and the 'tool-pill-disconnected' error above still blocks running a flow
// with genuinely orphaned pills.
