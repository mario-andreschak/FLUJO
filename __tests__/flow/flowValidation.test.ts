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
const subflowNode = (id: string, label = id): VNode => ({
  id,
  type: 'subflow',
  data: { label, type: 'subflow', properties: {} },
});
const edge = (source: string, target: string, mcp = false): VEdge => ({
  id: `${source}-${target}`,
  source,
  target,
  data: { edgeType: mcp ? 'mcp' : 'standard' },
});
const biEdge = (source: string, target: string): VEdge => ({
  id: `${source}-${target}`,
  source,
  target,
  data: { edgeType: 'standard', bidirectional: true },
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

describe('validateFlow — subflow single outgoing path', () => {
  const base = [startNode(), processNode('p', { boundModel: 'm1' }), finishNode()];
  const ctx = { models: [{ id: 'm1', name: 'gpt' }] };

  it('passes a linear pass-through subflow (A > S > C)', () => {
    const flow: VFlow = {
      nodes: [...base, subflowNode('sub')],
      edges: [edge('start', 'p'), edge('p', 'sub'), edge('sub', 'finish')],
    };
    const r = validateFlow(flow, ctx);
    expect(codes(r)).not.toContain('subflow-multiple-outgoing');
  });

  it('passes a bidirectional call-and-return subflow (A <> S)', () => {
    const flow: VFlow = {
      nodes: [...base, subflowNode('sub')],
      edges: [edge('start', 'p'), biEdge('p', 'sub'), edge('p', 'finish')],
    };
    const r = validateFlow(flow, ctx);
    expect(codes(r)).not.toContain('subflow-multiple-outgoing');
  });

  it('flags a subflow with two outgoing edges as an error', () => {
    const flow: VFlow = {
      nodes: [...base, subflowNode('sub'), processNode('p2', { boundModel: 'm1' })],
      edges: [edge('start', 'p'), edge('p', 'sub'), edge('sub', 'p2'), edge('sub', 'finish')],
    };
    const r = validateFlow(flow, ctx);
    expect(codes(r)).toContain('subflow-multiple-outgoing');
    expect(r.isRunnable).toBe(false);
  });

  it('flags a subflow with a forward edge plus a bidirectional back-edge', () => {
    const flow: VFlow = {
      nodes: [...base, subflowNode('sub')],
      edges: [edge('start', 'p'), biEdge('p', 'sub'), edge('sub', 'finish')],
    };
    const r = validateFlow(flow, ctx);
    expect(codes(r)).toContain('subflow-multiple-outgoing');
  });

  it('accepts a parallel subflow (parallelSubflowIds) with a single outgoing edge', () => {
    const parallel: VNode = {
      id: 'gate',
      type: 'subflow',
      data: { label: 'gate', type: 'subflow', properties: { parallelSubflowIds: ['a', 'b'] } },
    };
    const flow: VFlow = {
      nodes: [...base, parallel],
      edges: [edge('start', 'p'), edge('p', 'gate'), edge('gate', 'finish')],
    };
    const r = validateFlow(flow, ctx);
    expect(codes(r)).not.toContain('subflow-multiple-outgoing');
    expect(codes(r)).not.toContain('subflow-both-targets');
    expect(r.isRunnable).toBe(true);
  });

  it('errors when a subflow sets BOTH subflowId and parallelSubflowIds', () => {
    const both: VNode = {
      id: 'gate',
      type: 'subflow',
      data: { label: 'gate', type: 'subflow', properties: { subflowId: 'x', parallelSubflowIds: ['a'] } },
    };
    const flow: VFlow = {
      nodes: [...base, both],
      edges: [edge('start', 'p'), edge('p', 'gate'), edge('gate', 'finish')],
    };
    const r = validateFlow(flow, ctx);
    expect(codes(r)).toContain('subflow-both-targets');
    expect(r.isRunnable).toBe(false);
  });

  it('warns on a concurrencyLimit below 1 in parallel mode', () => {
    const gate: VNode = {
      id: 'gate',
      type: 'subflow',
      data: { label: 'gate', type: 'subflow', properties: { parallelSubflowIds: ['a'], concurrencyLimit: 0 } },
    };
    const flow: VFlow = {
      nodes: [...base, gate],
      edges: [edge('start', 'p'), edge('p', 'gate'), edge('gate', 'finish')],
    };
    const r = validateFlow(flow, ctx);
    expect(codes(r)).toContain('subflow-concurrency-limit');
    expect(r.isRunnable).toBe(true); // warning only
  });

  // --- Dynamic fan-out target selection (issue #130) ---
  it('accepts a dynamic fan-out subflow (parallelSubflowIdsVar) whose var is captured upstream', () => {
    const gate: VNode = {
      id: 'gate',
      type: 'subflow',
      data: { label: 'gate', type: 'subflow', properties: { parallelSubflowIdsVar: 'TARGETS' } },
    };
    const p = processNode('p', { boundModel: 'm1', captureVariable: 'TARGETS' });
    const flow: VFlow = {
      nodes: [startNode(), p, finishNode(), gate],
      edges: [edge('start', 'p'), edge('p', 'gate'), edge('gate', 'finish')],
    };
    const r = validateFlow(flow, ctx);
    expect(codes(r)).not.toContain('subflow-parallel-var-uncaptured');
    expect(codes(r)).not.toContain('subflow-parallel-var-name');
    expect(r.isRunnable).toBe(true);
  });

  it('warns when the dynamic fan-out variable is never captured', () => {
    const gate: VNode = {
      id: 'gate',
      type: 'subflow',
      data: { label: 'gate', type: 'subflow', properties: { parallelSubflowIdsVar: 'TARGETS' } },
    };
    const flow: VFlow = {
      nodes: [...base, gate],
      edges: [edge('start', 'p'), edge('p', 'gate'), edge('gate', 'finish')],
    };
    const r = validateFlow(flow, ctx);
    expect(codes(r)).toContain('subflow-parallel-var-uncaptured');
    expect(r.isRunnable).toBe(true); // advisory only
  });

  it('errors when dynamic fan-out is combined with mapOverList', () => {
    const gate: VNode = {
      id: 'gate',
      type: 'subflow',
      data: {
        label: 'gate',
        type: 'subflow',
        properties: { parallelSubflowIdsVar: 'TARGETS', mapOverList: true, subflowId: 'x' },
      },
    };
    const p = processNode('p', { boundModel: 'm1', captureVariable: 'TARGETS' });
    const flow: VFlow = {
      nodes: [startNode(), p, finishNode(), gate],
      edges: [edge('start', 'p'), edge('p', 'gate'), edge('gate', 'finish')],
    };
    const r = validateFlow(flow, ctx);
    expect(codes(r)).toContain('subflow-map-and-parallel-var');
    expect(r.isRunnable).toBe(false);
  });

  it('errors when agentic fan-out (allowCallerFanout) is combined with mapOverList', () => {
    const gate: VNode = {
      id: 'gate',
      type: 'subflow',
      data: {
        label: 'gate',
        type: 'subflow',
        properties: { allowCallerFanout: true, mapOverList: true, subflowId: 'x' },
      },
    };
    const flow: VFlow = {
      nodes: [...base, gate],
      edges: [edge('start', 'p'), edge('p', 'gate'), edge('gate', 'finish')],
    };
    const r = validateFlow(flow, ctx);
    expect(codes(r)).toContain('subflow-map-and-caller-fanout');
    expect(r.isRunnable).toBe(false);
  });

  it('accepts a subflow with allowCallerFanout and no mapOverList', () => {
    const gate: VNode = {
      id: 'gate',
      type: 'subflow',
      data: { label: 'gate', type: 'subflow', properties: { subflowId: 'x', allowCallerFanout: true } },
    };
    const flow: VFlow = {
      nodes: [...base, gate],
      edges: [edge('start', 'p'), edge('p', 'gate'), edge('gate', 'finish')],
    };
    const r = validateFlow(flow, ctx);
    expect(codes(r)).not.toContain('subflow-map-and-caller-fanout');
    expect(r.isRunnable).toBe(true);
  });

  it('accepts a map-over-list subflow (mapOverList + subflowId) with a single outgoing edge', () => {
    const gate: VNode = {
      id: 'gate',
      type: 'subflow',
      data: { label: 'gate', type: 'subflow', properties: { subflowId: 'x', mapOverList: true } },
    };
    const flow: VFlow = {
      nodes: [...base, gate],
      edges: [edge('start', 'p'), edge('p', 'gate'), edge('gate', 'finish')],
    };
    const r = validateFlow(flow, ctx);
    expect(codes(r)).not.toContain('subflow-map-and-parallel');
    expect(codes(r)).not.toContain('subflow-map-no-child');
    expect(r.isRunnable).toBe(true);
  });

  it('errors when mapOverList is combined with parallelSubflowIds', () => {
    const gate: VNode = {
      id: 'gate',
      type: 'subflow',
      data: { label: 'gate', type: 'subflow', properties: { mapOverList: true, parallelSubflowIds: ['a'] } },
    };
    const flow: VFlow = {
      nodes: [...base, gate],
      edges: [edge('start', 'p'), edge('p', 'gate'), edge('gate', 'finish')],
    };
    const r = validateFlow(flow, ctx);
    expect(codes(r)).toContain('subflow-map-and-parallel');
    expect(r.isRunnable).toBe(false);
  });

  it('errors when mapOverList has no child flow (no subflowId)', () => {
    const gate: VNode = {
      id: 'gate',
      type: 'subflow',
      data: { label: 'gate', type: 'subflow', properties: { mapOverList: true } },
    };
    const flow: VFlow = {
      nodes: [...base, gate],
      edges: [edge('start', 'p'), edge('p', 'gate'), edge('gate', 'finish')],
    };
    const r = validateFlow(flow, ctx);
    expect(codes(r)).toContain('subflow-map-no-child');
    expect(r.isRunnable).toBe(false);
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

  it('does not treat handoff pills as server-bound (no tool-pill-disconnected)', () => {
    const prompt = `${encodeBindingPill('tool', 'handoff', 'handoff_to_xyz')}`;
    const flow: VFlow = {
      nodes: [startNode(), processNode('p', { boundModel: 'm1', promptTemplate: prompt }), finishNode()],
      edges: [edge('start', 'p'), edge('p', 'finish')],
    };
    const r = validateFlow(flow, { models: [{ id: 'm1' }] });
    expect(codes(r)).not.toContain('tool-pill-disconnected');
  });
});

describe('validateFlow — obsolete handoff pills (issue #180)', () => {
  it('warns when a handoff pill names a tool that no longer exists', () => {
    // p's only successor is finish (handoff_to_finish); the stale pill names a
    // target that was removed/renamed, so its tool name no longer resolves.
    const prompt = `${encodeBindingPill('tool', 'handoff', 'handoff_to_xyz')}`;
    const flow: VFlow = {
      nodes: [startNode(), processNode('p', { boundModel: 'm1', promptTemplate: prompt }), finishNode()],
      edges: [edge('start', 'p'), edge('p', 'finish')],
    };
    const r = validateFlow(flow, { models: [{ id: 'm1' }] });
    expect(codes(r)).toContain('handoff-pill-obsolete');
    expect(codes(r)).not.toContain('tool-pill-disconnected');
    expect(r.isRunnable).toBe(true); // warning only — never blocks a run
  });

  it('accepts a handoff pill that matches a current successor', () => {
    // p -> q gives p the handoff tool handoff_to_q (q's label is its id 'q').
    const prompt = `${encodeBindingPill('tool', 'handoff', 'handoff_to_q')}`;
    const flow: VFlow = {
      nodes: [
        startNode(),
        processNode('p', { boundModel: 'm1', promptTemplate: prompt }),
        processNode('q', { boundModel: 'm1' }),
        finishNode(),
      ],
      edges: [edge('start', 'p'), edge('p', 'q'), edge('q', 'finish')],
    };
    const r = validateFlow(flow, { models: [{ id: 'm1' }] });
    expect(codes(r)).not.toContain('handoff-pill-obsolete');
  });

  it('accepts a handoff pill reachable via a bidirectional back-edge', () => {
    // A bidirectional edge b <> p gives p a handoff route to b as well.
    const prompt = `${encodeBindingPill('tool', 'handoff', 'handoff_to_b')}`;
    const flow: VFlow = {
      nodes: [
        startNode(),
        processNode('p', { boundModel: 'm1', promptTemplate: prompt }),
        processNode('b', { boundModel: 'm1' }),
        finishNode(),
      ],
      edges: [edge('start', 'p'), biEdge('b', 'p'), edge('p', 'finish')],
    };
    const r = validateFlow(flow, { models: [{ id: 'm1' }] });
    expect(codes(r)).not.toContain('handoff-pill-obsolete');
  });
});

describe('validateFlow — MCP server with zero tools (issue #180)', () => {
  it('warns when a process node is wired to a connected server exposing 0 tools', () => {
    const flow: VFlow = {
      nodes: [startNode(), processNode('p', { boundModel: 'm1' }), finishNode(), mcpNode('mcp1', 'empty')],
      edges: [edge('start', 'p'), edge('p', 'finish'), edge('p', 'mcp1', true)],
    };
    const r = validateFlow(flow, {
      models: [{ id: 'm1' }],
      servers: [{ name: 'empty', status: 'connected' }],
      serverTools: { empty: [] },
    });
    expect(codes(r)).toContain('mcp-server-no-tools');
    expect(r.isRunnable).toBe(true); // warning only
  });

  it('does not warn when the connected server provides tools', () => {
    const flow: VFlow = {
      nodes: [startNode(), processNode('p', { boundModel: 'm1' }), finishNode(), mcpNode('mcp1', 'srv')],
      edges: [edge('start', 'p'), edge('p', 'finish'), edge('p', 'mcp1', true)],
    };
    const r = validateFlow(flow, {
      models: [{ id: 'm1' }],
      servers: [{ name: 'srv', status: 'connected' }],
      serverTools: { srv: ['read', 'write'] },
    });
    expect(codes(r)).not.toContain('mcp-server-no-tools');
  });

  it('does not warn when the tool list for a server is unknown (undefined, not gathered)', () => {
    const flow: VFlow = {
      nodes: [startNode(), processNode('p', { boundModel: 'm1' }), finishNode(), mcpNode('mcp1', 'srv')],
      edges: [edge('start', 'p'), edge('p', 'finish'), edge('p', 'mcp1', true)],
    };
    const r = validateFlow(flow, {
      models: [{ id: 'm1' }],
      servers: [{ name: 'srv', status: 'connected' }],
      serverTools: {}, // defined map, but no entry for 'srv' => unknown, not empty
    });
    expect(codes(r)).not.toContain('mcp-server-no-tools');
  });
});

describe('validateFlow — edge conditions (Tier 2b)', () => {
  const models = [{ id: 'm1' }];
  const condEdge = (source: string, target: string, condition: any): VEdge => ({
    id: `${source}-${target}`,
    source,
    target,
    data: { edgeType: 'standard', condition },
  });

  it('errors on a condition leaving a non-process node', () => {
    const flow: VFlow = {
      nodes: [startNode(), processNode('p', { boundModel: 'm1' }), finishNode()],
      edges: [condEdge('start', 'p', { kind: 'contains', value: 'x' }), edge('p', 'finish')],
    };
    const r = validateFlow(flow, { models });
    expect(codes(r)).toContain('edge-condition-non-process');
    expect(r.isRunnable).toBe(false);
  });

  it('warns when a conditioned node has no bare fallback edge', () => {
    const flow: VFlow = {
      nodes: [startNode(), processNode('p', { boundModel: 'm1' }), finishNode()],
      edges: [edge('start', 'p'), condEdge('p', 'finish', { kind: 'contains', value: 'FAIL' })],
    };
    const r = validateFlow(flow, { models });
    expect(codes(r)).toContain('edge-condition-no-fallback');
    // Advisory only — still runnable.
    expect(r.isRunnable).toBe(true);
  });

  it('does not warn when a bare fallback edge exists', () => {
    const flow: VFlow = {
      nodes: [startNode(), processNode('p', { boundModel: 'm1' }), processNode('fix', { boundModel: 'm1' }), finishNode()],
      edges: [
        edge('start', 'p'),
        condEdge('p', 'fix', { kind: 'contains', value: 'FAIL' }),
        edge('p', 'finish'),
      ],
    };
    const r = validateFlow(flow, { models });
    expect(codes(r)).not.toContain('edge-condition-no-fallback');
  });

  it('treats a bidirectional back-edge as a bare fallback', () => {
    const flow: VFlow = {
      nodes: [startNode(), processNode('a', { boundModel: 'm1' }), processNode('b', { boundModel: 'm1' }), finishNode()],
      edges: [
        edge('start', 'a'),
        // a <-> b bidirectional gives `a` a bare reverse route from b, but the
        // conditioned edge is a->finish; `a` also gets a->b forward. Put the
        // condition on a->finish and rely on a<->b as the bare fallback for `a`.
        biEdge('b', 'a'),
        condEdge('a', 'finish', { kind: 'contains', value: 'FAIL' }),
        edge('a', 'b'),
      ],
    };
    const r = validateFlow(flow, { models });
    expect(codes(r)).not.toContain('edge-condition-no-fallback');
  });

  it('warns on a regex condition that does not compile (kept, never matches)', () => {
    const flow: VFlow = {
      nodes: [startNode(), processNode('p', { boundModel: 'm1' }), processNode('q', { boundModel: 'm1' }), finishNode()],
      edges: [
        edge('start', 'p'),
        condEdge('p', 'q', { kind: 'regex', value: '[bad' }),
        edge('p', 'finish'),
      ],
    };
    const r = validateFlow(flow, { models });
    expect(codes(r)).toContain('edge-condition-regex');
  });

  it('warns on an unknown condition kind', () => {
    const flow: VFlow = {
      nodes: [startNode(), processNode('p', { boundModel: 'm1' }), processNode('q', { boundModel: 'm1' }), finishNode()],
      edges: [
        edge('start', 'p'),
        condEdge('p', 'q', { kind: 'switch', value: 'x' }),
        edge('p', 'finish'),
      ],
    };
    const r = validateFlow(flow, { models });
    expect(codes(r)).toContain('edge-condition-kind');
  });
});

describe('validateFlow — always condition (issue #111)', () => {
  const models = [{ id: 'm1' }];
  // Local edge-with-condition builder (the Tier 2b describe's condEdge is scoped
  // to that block). An `always` edge is the deterministic default route.
  const alwaysEdge = (source: string, target: string): VEdge => ({
    id: `${source}-${target}`,
    source,
    target,
    data: { edgeType: 'standard', condition: { kind: 'always' } },
  });

  it('accepts an always condition without a value — no missing-value warning', () => {
    const flow: VFlow = {
      nodes: [startNode(), processNode('p', { boundModel: 'm1' }), processNode('q', { boundModel: 'm1' }), finishNode()],
      edges: [edge('start', 'p'), alwaysEdge('p', 'q'), edge('p', 'finish'), edge('q', 'finish')],
    };
    const r = validateFlow(flow, { models });
    expect(codes(r)).not.toContain('edge-condition-value');
    expect(codes(r)).not.toContain('edge-condition-kind');
    expect(r.isRunnable).toBe(true);
  });

  it('treats an always edge as a valid fallback (no no-fallback warning even without a bare edge)', () => {
    const flow: VFlow = {
      nodes: [startNode(), processNode('p', { boundModel: 'm1' }), processNode('q', { boundModel: 'm1' }), finishNode()],
      edges: [edge('start', 'p'), alwaysEdge('p', 'q'), edge('q', 'finish')],
    };
    const r = validateFlow(flow, { models });
    expect(codes(r)).not.toContain('edge-condition-no-fallback');
    expect(r.isRunnable).toBe(true);
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
