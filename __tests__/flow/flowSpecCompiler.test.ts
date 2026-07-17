/**
 * FlowSpec → Flow compiler tests (issue #14 flow generation).
 *
 * The compiler re-declares the builder's edge shapes (it must not import frontend
 * component modules), so a dedicated suite here PINS them to the originals:
 * `createEdgeFromConnection` (edgeUtils.ts) and `mcpEdgeOptions` (Canvas/types.ts).
 * If the builder's edge shape changes, these tests fail and the compiler must follow.
 */
import {
  compileFlowSpec,
  applyGenerationDefaults,
  sanitizeFlowName,
  FlowSpec,
  CompileContext,
} from '@/utils/shared/flowSpecCompiler';
import { validateFlow } from '@/utils/shared/flowValidation';
import { createEdgeFromConnection } from '@/frontend/components/Flow/FlowManager/FlowBuilder/Canvas/utils/edgeUtils';
import { mcpEdgeOptions } from '@/frontend/components/Flow/FlowManager/FlowBuilder/Canvas/types';
import type { FlowNode } from '@/frontend/types/flow/flow';
import type { Edge } from '@xyflow/react';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const context: CompileContext = {
  models: [
    { id: 'model-abc', name: 'gpt-4o', displayName: 'My GPT' },
    { id: 'model-def', name: 'claude-sonnet' },
  ],
  servers: [{ name: 'brave-search' }, { name: 'filesystem' }],
  serverTools: {
    'brave-search': ['web_search', 'news_search'],
    filesystem: ['read_file', 'write_file', 'list_directory'],
  },
  flows: [{ id: 'flow-1', name: 'Summarizer' }],
};

const happySpec: FlowSpec = {
  name: 'research_flow',
  description: 'Researches a topic and summarizes it',
  nodes: [
    { key: 'start', type: 'start', label: 'Start', prompt: 'You are a research pipeline.' },
    {
      key: 'research',
      type: 'process',
      label: 'Researcher',
      description: 'Searches the web',
      model: 'My GPT',
      prompt: 'Research the topic thoroughly.',
      servers: [{ name: 'brave-search', tools: ['web_search'] }],
    },
    { key: 'sum', type: 'subflow', label: 'Summarize', flow: 'Summarizer', inputMode: 'latest-message', outputMode: 'final-only' },
    { key: 'end', type: 'finish', label: 'Done' },
  ],
  edges: [
    { from: 'start', to: 'research' },
    { from: 'research', to: 'sum' },
    { from: 'sum', to: 'end' },
  ],
};

function byLabel(flow: NonNullable<ReturnType<typeof compileFlowSpec>['flow']>, label: string) {
  const node = flow.nodes.find((n) => n.data.label === label);
  expect(node).toBeDefined();
  return node!;
}

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('compileFlowSpec — happy path', () => {
  const result = compileFlowSpec(happySpec, context);
  const flow = result.flow!;

  it('compiles without errors', () => {
    expect(result.errorCount).toBe(0);
    expect(flow).not.toBeNull();
  });

  it('emits the flow shell (id, sanitized name, description)', () => {
    expect(flow.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(flow.name).toBe('research_flow');
    expect(flow.description).toBe('Researches a topic and summarizes it');
  });

  it('emits one node per spec node plus one MCP node per (process, server) pair', () => {
    // start, process, subflow, finish + 1 mcp
    expect(flow.nodes).toHaveLength(5);
    const types = flow.nodes.map((n) => n.type).sort();
    expect(types).toEqual(['finish', 'mcp', 'process', 'start', 'subflow']);
  });

  it('duplicates type into data.type and gives every node a uuid + position', () => {
    for (const node of flow.nodes) {
      expect(node.data.type).toBe(node.type);
      expect(node.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(typeof node.position.x).toBe('number');
      expect(typeof node.position.y).toBe('number');
    }
  });

  it('start node: prompt → properties.promptTemplate', () => {
    expect(byLabel(flow, 'Start').data.properties).toEqual({ promptTemplate: 'You are a research pipeline.' });
  });

  it('process node: prompt, resolved boundModel (displayName → id), description', () => {
    const research = byLabel(flow, 'Researcher');
    expect(research.data.properties).toEqual({
      promptTemplate: 'Research the topic thoroughly.',
      boundModel: 'model-abc',
    });
    expect(research.data.description).toBe('Searches the web');
    // mcpNodes is converter-derived and must NEVER be authored by the compiler.
    expect(research.data.properties).not.toHaveProperty('mcpNodes');
  });

  it('mcp node: boundServer + the requested enabledTools subset, labeled by server', () => {
    const mcp = byLabel(flow, 'brave-search');
    expect(mcp.type).toBe('mcp');
    expect(mcp.data.properties).toEqual({ boundServer: 'brave-search', enabledTools: ['web_search'] });
  });

  it('subflow node: flow name resolved to subflowId + modes', () => {
    expect(byLabel(flow, 'Summarize').data.properties).toEqual({
      subflowId: 'flow-1',
      inputMode: 'latest-message',
      outputMode: 'final-only',
    });
  });

  it('every edge has sourceHandle/targetHandle (the builder silently drops edges without them)', () => {
    expect(flow.edges).toHaveLength(4); // 3 control + 1 mcp
    for (const edge of flow.edges) {
      expect(edge.sourceHandle).toBeTruthy();
      expect(edge.targetHandle).toBeTruthy();
      expect(edge.id).toBe(`${edge.source}:${edge.sourceHandle}->${edge.target}:${edge.targetHandle}`);
    }
  });

  it('control edges use <type>-bottom → <type>-top handles', () => {
    const start = byLabel(flow, 'Start');
    const research = byLabel(flow, 'Researcher');
    const edge = flow.edges.find((e) => e.source === start.id)!;
    expect(edge.sourceHandle).toBe('start-bottom');
    expect(edge.target).toBe(research.id);
    expect(edge.targetHandle).toBe('process-top');
    expect(edge.type).toBe('custom');
    expect(edge.animated).toBe(true);
    expect(edge.data).toEqual({ edgeType: 'standard' });
  });

  it('mcp edge wires process-right-mcp → mcp-left', () => {
    const research = byLabel(flow, 'Researcher');
    const mcp = byLabel(flow, 'brave-search');
    const edge = flow.edges.find((e) => e.target === mcp.id)!;
    expect(edge.source).toBe(research.id);
    expect(edge.sourceHandle).toBe('process-right-mcp');
    expect(edge.targetHandle).toBe('mcp-left');
    expect(edge.type).toBe('mcpEdge');
    expect(edge.data).toEqual({ edgeType: 'mcp' });
  });

  it('layout: BFS depth top-down; mcp node right of its process node', () => {
    const start = byLabel(flow, 'Start');
    const research = byLabel(flow, 'Researcher');
    const sum = byLabel(flow, 'Summarize');
    const end = byLabel(flow, 'Done');
    const mcp = byLabel(flow, 'brave-search');
    expect(start.position.y).toBeLessThan(research.position.y);
    expect(research.position.y).toBeLessThan(sum.position.y);
    expect(sum.position.y).toBeLessThan(end.position.y);
    expect(mcp.position.x).toBeGreaterThan(research.position.x);
    expect(mcp.position.y).toBe(research.position.y);
  });

  it('the compiled flow passes validateFlow with the same context — zero issues', () => {
    const validation = validateFlow(flow, {
      models: context.models,
      servers: context.servers!.map((s) => ({ ...s, status: 'connected' })),
      serverTools: context.serverTools,
    });
    expect(validation.issues).toEqual([]);
    expect(validation.isRunnable).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Edge shapes PINNED to the builder's createEdgeFromConnection / mcpEdgeOptions
// ---------------------------------------------------------------------------

describe('compileFlowSpec — edge shapes match createEdgeFromConnection exactly', () => {
  const { flow } = compileFlowSpec(happySpec, context);

  function builderEdge(edge: Edge): Edge {
    // Re-create the same connection through the builder's own factory.
    const nodes = flow!.nodes.map((n) => ({ ...n })) as FlowNode[];
    return createEdgeFromConnection(
      {
        source: edge.source,
        sourceHandle: edge.sourceHandle!,
        target: edge.target,
        targetHandle: edge.targetHandle!,
      },
      nodes
    );
  }

  it('standard edge is byte-for-byte what the builder would create', () => {
    const compiled = flow!.edges.find((e) => (e.data as any).edgeType === 'standard')!;
    expect(compiled).toEqual(builderEdge(compiled));
  });

  it('mcp edge is byte-for-byte what the builder would create (markers/style incl.)', () => {
    const compiled = flow!.edges.find((e) => (e.data as any).edgeType === 'mcp')!;
    expect(compiled).toEqual(builderEdge(compiled));
    expect(compiled.markerEnd).toEqual(mcpEdgeOptions.markerEnd);
    expect(compiled.markerStart).toEqual(mcpEdgeOptions.markerStart);
    expect(compiled.style).toEqual(mcpEdgeOptions.style);
  });
});

// ---------------------------------------------------------------------------
// Tier 2b — deterministic edge conditions
// ---------------------------------------------------------------------------

describe('compileFlowSpec — edge conditions (Tier 2b)', () => {
  const condSpec = (edge: Partial<FlowSpec['edges'][number]>): FlowSpec => ({
    nodes: [
      { key: 's', type: 'start' },
      { key: 'p', type: 'process', model: 'model-def', prompt: 'x' },
      { key: 'f', type: 'finish' },
    ],
    edges: [
      { from: 's', to: 'p' },
      { from: 'p', to: 'f', ...edge } as FlowSpec['edges'][number],
    ],
  });

  // The compiler mints fresh uuids for node ids, so resolve edges by node TYPE.
  const processId = (flow: any) => flow.nodes.find((n: any) => n.type === 'process').id;
  const startId = (flow: any) => flow.nodes.find((n: any) => n.type === 'start').id;

  it('emits a valid condition into edge.data.condition', () => {
    const cond = { kind: 'contains' as const, value: 'FAIL', ignoreCase: true };
    const { flow, errorCount } = compileFlowSpec(condSpec({ condition: cond }), context);
    expect(errorCount).toBe(0);
    const edge = flow!.edges.find((e) => e.source === processId(flow))!;
    expect((edge.data as any).condition).toEqual(cond);
  });

  it('condition on a valid process edge is byte-for-byte what the builder would create', () => {
    const cond = { kind: 'regex' as const, value: 'PASS' };
    const { flow } = compileFlowSpec(condSpec({ condition: cond }), context);
    const compiled = flow!.edges.find((e) => e.source === processId(flow))!;
    const nodes = flow!.nodes.map((n) => ({ ...n })) as FlowNode[];
    const built = createEdgeFromConnection(
      {
        source: compiled.source,
        sourceHandle: compiled.sourceHandle!,
        target: compiled.target,
        targetHandle: compiled.targetHandle!,
      },
      nodes,
      cond
    );
    expect(compiled).toEqual(built);
  });

  it('drops an unknown condition kind with a warning', () => {
    const { flow, issues } = compileFlowSpec(condSpec({ condition: { kind: 'switch' as any, value: 'x' } }), context);
    expect(issues.some((i) => i.code === 'edge-condition-kind')).toBe(true);
    const edge = flow!.edges.find((e) => e.source === processId(flow))!;
    expect((edge.data as any).condition).toBeUndefined();
  });

  it('drops a condition on a non-process source edge with a warning', () => {
    // A condition on the start->process edge — start nodes never route on conditions.
    const spec: FlowSpec = {
      nodes: [
        { key: 's', type: 'start' },
        { key: 'p', type: 'process', model: 'model-def', prompt: 'x' },
        { key: 'f', type: 'finish' },
      ],
      edges: [
        { from: 's', to: 'p', condition: { kind: 'contains', value: 'x' } },
        { from: 'p', to: 'f' },
      ],
    };
    const { flow, issues } = compileFlowSpec(spec, context);
    expect(issues.some((i) => i.code === 'edge-condition-non-process')).toBe(true);
    const edge = flow!.edges.find((e) => e.source === startId(flow))!;
    expect((edge.data as any).condition).toBeUndefined();
  });

  it('keeps a bad regex condition but warns it will never match', () => {
    const { flow, issues } = compileFlowSpec(condSpec({ condition: { kind: 'regex', value: '[bad' } }), context);
    expect(issues.some((i) => i.code === 'edge-condition-regex')).toBe(true);
    const edge = flow!.edges.find((e) => e.source === processId(flow))!;
    expect((edge.data as any).condition).toEqual({ kind: 'regex', value: '[bad' });
  });

  it('accepts an always condition with no value (issue #111) — no edge-condition-value warning', () => {
    const { flow, issues, errorCount } = compileFlowSpec(condSpec({ condition: { kind: 'always' } as any }), context);
    expect(errorCount).toBe(0);
    expect(issues.some((i) => i.code === 'edge-condition-value')).toBe(false);
    const edge = flow!.edges.find((e) => e.source === processId(flow))!;
    expect((edge.data as any).condition).toEqual({ kind: 'always' });
  });

  it('drops a stray value on an always condition (keeps just { kind: "always" })', () => {
    const { flow } = compileFlowSpec(condSpec({ condition: { kind: 'always', value: 'ignored' } as any }), context);
    const edge = flow!.edges.find((e) => e.source === processId(flow))!;
    expect((edge.data as any).condition).toEqual({ kind: 'always' });
  });
});

// ---------------------------------------------------------------------------
// Reference resolution
// ---------------------------------------------------------------------------

describe('compileFlowSpec — model resolution', () => {
  const base: FlowSpec = {
    nodes: [
      { key: 's', type: 'start' },
      { key: 'p', type: 'process', model: '', prompt: 'x' },
      { key: 'f', type: 'finish' },
    ],
    edges: [
      { from: 's', to: 'p' },
      { from: 'p', to: 'f' },
    ],
  };
  const withModel = (model: string): FlowSpec => ({
    ...base,
    nodes: base.nodes.map((n) => (n.key === 'p' ? { ...n, model } : n)),
  });

  it('resolves an exact id', () => {
    const { flow, errorCount } = compileFlowSpec(withModel('model-def'), context);
    expect(errorCount).toBe(0);
    expect(flow!.nodes.find((n) => n.type === 'process')!.data.properties!.boundModel).toBe('model-def');
  });

  it('resolves a displayName case-insensitively', () => {
    const { flow } = compileFlowSpec(withModel('my gpt'), context);
    expect(flow!.nodes.find((n) => n.type === 'process')!.data.properties!.boundModel).toBe('model-abc');
  });

  it('resolves a technical name case-insensitively', () => {
    const { flow } = compileFlowSpec(withModel('CLAUDE-SONNET'), context);
    expect(flow!.nodes.find((n) => n.type === 'process')!.data.properties!.boundModel).toBe('model-def');
  });

  it('keeps an unresolved reference raw and warns (validateFlow raises the blocking error)', () => {
    const { flow, issues } = compileFlowSpec(withModel('no-such-model'), context);
    expect(flow!.nodes.find((n) => n.type === 'process')!.data.properties!.boundModel).toBe('no-such-model');
    expect(issues).toContainEqual(expect.objectContaining({ code: 'model-unresolved', severity: 'warning', nodeKey: 'p' }));
    const validation = validateFlow(flow!, { models: context.models });
    expect(validation.issues.map((i) => i.code)).toContain('process-model-missing');
  });
});

describe('compileFlowSpec — subflow resolution', () => {
  const subflowSpec = (flowRef?: string): FlowSpec => ({
    nodes: [
      { key: 's', type: 'start' },
      { key: 'sub', type: 'subflow', ...(flowRef !== undefined ? { flow: flowRef } : {}) },
      { key: 'f', type: 'finish' },
    ],
    edges: [
      { from: 's', to: 'sub' },
      { from: 'sub', to: 'f' },
    ],
  });

  it('resolves by id and by case-insensitive name', () => {
    expect(
      compileFlowSpec(subflowSpec('flow-1'), context).flow!.nodes.find((n) => n.type === 'subflow')!.data.properties!.subflowId
    ).toBe('flow-1');
    expect(
      compileFlowSpec(subflowSpec('summarizer'), context).flow!.nodes.find((n) => n.type === 'subflow')!.data.properties!.subflowId
    ).toBe('flow-1');
  });

  it('errors on an unresolved flow reference (no subflowId emitted)', () => {
    const { flow, issues, errorCount } = compileFlowSpec(subflowSpec('nope'), context);
    expect(errorCount).toBeGreaterThan(0);
    expect(issues).toContainEqual(expect.objectContaining({ code: 'subflow-unresolved', severity: 'error', nodeKey: 'sub' }));
    expect(flow!.nodes.find((n) => n.type === 'subflow')!.data.properties).not.toHaveProperty('subflowId');
  });

  it('errors when the flow reference is missing entirely', () => {
    const { issues } = compileFlowSpec(subflowSpec(undefined), context);
    expect(issues).toContainEqual(expect.objectContaining({ code: 'subflow-missing-flow', severity: 'error' }));
  });
});

// ---------------------------------------------------------------------------
// Servers & tools
// ---------------------------------------------------------------------------

describe('compileFlowSpec — servers and tools', () => {
  const serverSpec = (servers: NonNullable<FlowSpec['nodes'][number]['servers']>): FlowSpec => ({
    nodes: [
      { key: 's', type: 'start' },
      { key: 'p', type: 'process', model: 'model-abc', prompt: 'x', servers },
      { key: 'f', type: 'finish' },
    ],
    edges: [
      { from: 's', to: 'p' },
      { from: 'p', to: 'f' },
    ],
  });

  it('tools omitted → all known tools for the server are enabled', () => {
    const { flow } = compileFlowSpec(serverSpec([{ name: 'filesystem' }]), context);
    const mcp = flow!.nodes.find((n) => n.type === 'mcp')!;
    expect(mcp.data.properties!.enabledTools).toEqual(['read_file', 'write_file', 'list_directory']);
  });

  it('unknown server → warning, node still emitted with empty enabledTools', () => {
    const { flow, issues, errorCount } = compileFlowSpec(serverSpec([{ name: 'ghost-server' }]), context);
    expect(errorCount).toBe(0);
    expect(issues).toContainEqual(expect.objectContaining({ code: 'server-unknown', severity: 'warning' }));
    const mcp = flow!.nodes.find((n) => n.type === 'mcp')!;
    expect(mcp.data.properties).toEqual({ boundServer: 'ghost-server', enabledTools: [] });
  });

  it('unknown tool name → warning, tool kept (server may just be offline)', () => {
    const { flow, issues } = compileFlowSpec(serverSpec([{ name: 'brave-search', tools: ['web_search', 'imaginary'] }]), context);
    expect(issues).toContainEqual(expect.objectContaining({ code: 'tool-unknown', severity: 'warning' }));
    const mcp = flow!.nodes.find((n) => n.type === 'mcp')!;
    expect(mcp.data.properties!.enabledTools).toEqual(['web_search', 'imaginary']);
  });

  it('duplicate server refs on one process node are collapsed', () => {
    const { flow } = compileFlowSpec(serverSpec([{ name: 'filesystem' }, { name: 'filesystem' }]), context);
    expect(flow!.nodes.filter((n) => n.type === 'mcp')).toHaveLength(1);
  });

  it('two process nodes using the same server get their OWN mcp nodes (per-step tool subsets)', () => {
    const spec: FlowSpec = {
      nodes: [
        { key: 's', type: 'start' },
        { key: 'p1', type: 'process', model: 'model-abc', servers: [{ name: 'filesystem', tools: ['read_file'] }] },
        { key: 'p2', type: 'process', model: 'model-abc', servers: [{ name: 'filesystem', tools: ['write_file'] }] },
        { key: 'f', type: 'finish' },
      ],
      edges: [
        { from: 's', to: 'p1' },
        { from: 'p1', to: 'p2' },
        { from: 'p2', to: 'f' },
      ],
    };
    const { flow } = compileFlowSpec(spec, context);
    const mcps = flow!.nodes.filter((n) => n.type === 'mcp');
    expect(mcps).toHaveLength(2);
    expect(mcps.map((m) => m.data.properties!.enabledTools)).toEqual([['read_file'], ['write_file']]);
  });

  it('servers on a non-process node are ignored with a warning', () => {
    const spec: FlowSpec = {
      nodes: [
        { key: 's', type: 'start', servers: [{ name: 'filesystem' }] } as any,
        { key: 'f', type: 'finish' },
      ],
      edges: [{ from: 's', to: 'f' }],
    };
    const { flow, issues } = compileFlowSpec(spec, context);
    expect(issues).toContainEqual(expect.objectContaining({ code: 'servers-on-non-process' }));
    expect(flow!.nodes.filter((n) => n.type === 'mcp')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Pills are stripped from generated prompts
// ---------------------------------------------------------------------------

describe('compileFlowSpec — pill stripping', () => {
  it('replaces tool/resource pills with their plain names and warns', () => {
    const spec: FlowSpec = {
      nodes: [
        { key: 's', type: 'start' },
        {
          key: 'p',
          type: 'process',
          model: 'model-abc',
          prompt: 'Use ${tool:brave-search__web_search} and ${resource:filesystem__file:///data.txt} please.',
        },
        { key: 'f', type: 'finish' },
      ],
      edges: [
        { from: 's', to: 'p' },
        { from: 'p', to: 'f' },
      ],
    };
    const { flow, issues } = compileFlowSpec(spec, context);
    const p = flow!.nodes.find((n) => n.type === 'process')!;
    expect(p.data.properties!.promptTemplate).toBe('Use web_search and file:///data.txt please.');
    expect(issues).toContainEqual(expect.objectContaining({ code: 'pill-stripped', severity: 'warning', nodeKey: 'p' }));
  });

  it('leaves ${global:VAR} interpolation untouched', () => {
    const spec: FlowSpec = {
      nodes: [
        { key: 's', type: 'start', prompt: 'Hello ${global:USER_NAME}!' },
        { key: 'f', type: 'finish' },
      ],
      edges: [{ from: 's', to: 'f' }],
    };
    const { flow, issues } = compileFlowSpec(spec, context);
    expect(flow!.nodes.find((n) => n.type === 'start')!.data.properties!.promptTemplate).toBe('Hello ${global:USER_NAME}!');
    expect(issues.map((i) => i.code)).not.toContain('pill-stripped');
  });
});

// ---------------------------------------------------------------------------
// Flow name sanitizing + dedupe
// ---------------------------------------------------------------------------

describe('sanitizeFlowName', () => {
  it('conforms to the builder rule ^[\\w-]+$', () => {
    expect(sanitizeFlowName('My Cool Flow!', [])).toBe('My_Cool_Flow');
    expect(sanitizeFlowName('  spaced  ', [])).toBe('spaced');
    expect(sanitizeFlowName('ok-name_1', [])).toBe('ok-name_1');
  });

  it('falls back when empty or fully invalid', () => {
    expect(sanitizeFlowName(undefined, [])).toBe('generated_flow');
    expect(sanitizeFlowName('???', [])).toBe('generated_flow');
  });

  it('dedupes case-insensitively against existing flow names', () => {
    expect(sanitizeFlowName('Research', ['research'])).toBe('Research_2');
    expect(sanitizeFlowName('Research', ['research', 'research_2'])).toBe('Research_3');
  });
});

// ---------------------------------------------------------------------------
// Structural rules — nodes
// ---------------------------------------------------------------------------

describe('compileFlowSpec — node rules', () => {
  it('rejects explicit mcp nodes with guidance', () => {
    const spec = {
      nodes: [
        { key: 's', type: 'start' },
        { key: 'm', type: 'mcp' },
        { key: 'f', type: 'finish' },
      ],
      edges: [{ from: 's', to: 'f' }],
    } as unknown as FlowSpec;
    const { flow, issues } = compileFlowSpec(spec, context);
    expect(issues).toContainEqual(expect.objectContaining({ code: 'mcp-node-not-allowed', severity: 'error' }));
    expect(flow!.nodes.map((n) => n.type).sort()).toEqual(['finish', 'start']);
  });

  it('drops duplicate keys and unknown types with errors', () => {
    const spec = {
      nodes: [
        { key: 's', type: 'start' },
        { key: 's', type: 'finish' },
        { key: 'x', type: 'teleport' },
      ],
      edges: [],
    } as unknown as FlowSpec;
    const { flow, issues } = compileFlowSpec(spec, context);
    expect(issues).toContainEqual(expect.objectContaining({ code: 'node-duplicate-key' }));
    expect(issues).toContainEqual(expect.objectContaining({ code: 'unknown-node-type' }));
    expect(flow!.nodes).toHaveLength(1);
  });

  it('returns flow:null when nothing is usable', () => {
    const { flow, issues } = compileFlowSpec({ nodes: [], edges: [] }, context);
    expect(flow).toBeNull();
    expect(issues).toContainEqual(expect.objectContaining({ code: 'no-usable-nodes', severity: 'error' }));
  });

  it('invalid inputMode/outputMode values are omitted with warnings', () => {
    const spec = {
      nodes: [
        { key: 's', type: 'start' },
        { key: 'p', type: 'process', model: 'model-abc', inputMode: 'psychic' },
        { key: 'sub', type: 'subflow', flow: 'flow-1', outputMode: 'interpretive-dance' },
        { key: 'f', type: 'finish' },
      ],
      edges: [
        { from: 's', to: 'p' },
        { from: 'p', to: 'sub' },
        { from: 'sub', to: 'f' },
      ],
    } as unknown as FlowSpec;
    const { flow, issues } = compileFlowSpec(spec, context);
    expect(issues.filter((i) => i.code === 'invalid-input-mode')).toHaveLength(1);
    expect(issues.filter((i) => i.code === 'invalid-output-mode')).toHaveLength(1);
    expect(flow!.nodes.find((n) => n.type === 'process')!.data.properties).not.toHaveProperty('inputMode');
    expect(flow!.nodes.find((n) => n.type === 'subflow')!.data.properties).not.toHaveProperty('outputMode');
  });

  it('isolated process nodes carry their isolatedPrompt', () => {
    const spec: FlowSpec = {
      nodes: [
        { key: 's', type: 'start' },
        { key: 'p', type: 'process', model: 'model-abc', inputMode: 'isolated', isolatedPrompt: 'Only this.' },
        { key: 'f', type: 'finish' },
      ],
      edges: [
        { from: 's', to: 'p' },
        { from: 'p', to: 'f' },
      ],
    };
    const { flow } = compileFlowSpec(spec, context);
    const p = flow!.nodes.find((n) => n.type === 'process')!;
    expect(p.data.properties!.inputMode).toBe('isolated');
    expect(p.data.properties!.isolatedPrompt).toBe('Only this.');
  });

  it("process nodes accept outputMode 'latest-message' but reject the subflow values", () => {
    const spec = {
      nodes: [
        { key: 's', type: 'start' },
        { key: 'p1', type: 'process', model: 'model-abc', outputMode: 'latest-message' },
        // 'steps' is a SUBFLOW output mode — on a process node it must warn and be omitted.
        { key: 'p2', type: 'process', model: 'model-abc', outputMode: 'steps' },
        { key: 'f', type: 'finish' },
      ],
      edges: [
        { from: 's', to: 'p1' },
        { from: 'p1', to: 'p2' },
        { from: 'p2', to: 'f' },
      ],
    } as unknown as FlowSpec;
    const { flow, issues } = compileFlowSpec(spec, context);
    const processNodes = flow!.nodes.filter((n) => n.type === 'process');
    expect(processNodes[0].data.properties!.outputMode).toBe('latest-message');
    expect(processNodes[1].data.properties).not.toHaveProperty('outputMode');
    expect(issues.filter((i) => i.code === 'invalid-output-mode')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Generation-only defaults (generateFlow calls this; the compile API does not)
// ---------------------------------------------------------------------------

describe('applyGenerationDefaults', () => {
  it("fills inputMode/outputMode 'latest-message' on process nodes that left them unset", () => {
    const { flow } = compileFlowSpec(happySpec, context);
    applyGenerationDefaults(flow!);
    const research = flow!.nodes.find((n) => n.data.label === 'Researcher')!;
    expect(research.data.properties!.inputMode).toBe('latest-message');
    expect(research.data.properties!.outputMode).toBe('latest-message');
    // Non-process nodes are untouched.
    const sub = flow!.nodes.find((n) => n.type === 'subflow')!;
    expect(sub.data.properties!.outputMode).toBe('final-only');
    const finish = flow!.nodes.find((n) => n.type === 'finish')!;
    expect(finish.data.properties).not.toHaveProperty('inputMode');
  });

  it('never overrides modes the spec set explicitly', () => {
    const spec: FlowSpec = {
      nodes: [
        { key: 's', type: 'start' },
        {
          key: 'p',
          type: 'process',
          model: 'model-abc',
          inputMode: 'full-history',
          outputMode: 'full-conversation',
        },
        { key: 'f', type: 'finish' },
      ],
      edges: [
        { from: 's', to: 'p' },
        { from: 'p', to: 'f' },
      ],
    };
    const { flow } = compileFlowSpec(spec, context);
    applyGenerationDefaults(flow!);
    const p = flow!.nodes.find((n) => n.type === 'process')!;
    expect(p.data.properties!.inputMode).toBe('full-history');
    expect(p.data.properties!.outputMode).toBe('full-conversation');
  });
});

// ---------------------------------------------------------------------------
// Structural rules — edges
// ---------------------------------------------------------------------------

describe('compileFlowSpec — edge rules', () => {
  const nodes: FlowSpec['nodes'] = [
    { key: 's', type: 'start' },
    { key: 'p', type: 'process', model: 'model-abc' },
    { key: 'f', type: 'finish' },
  ];

  it.each([
    [{ from: 'p', to: 's' }, 'edge-into-start'],
    [{ from: 'f', to: 'p' }, 'edge-out-of-finish'],
    [{ from: 'p', to: 'p' }, 'edge-self-loop'],
    [{ from: 'ghost', to: 'p' }, 'edge-unknown-node'],
  ])('skips illegal edge %j with %s', (edge, code) => {
    const { flow, issues } = compileFlowSpec({ nodes, edges: [{ from: 's', to: 'p' }, edge as FlowSpec['edges'][number]] }, context);
    expect(issues).toContainEqual(expect.objectContaining({ code }));
    expect(flow!.edges).toHaveLength(1); // only the legal one survives
  });

  it('collapses duplicate edges with a warning', () => {
    const { flow, issues } = compileFlowSpec(
      { nodes, edges: [{ from: 's', to: 'p' }, { from: 's', to: 'p' }] },
      context
    );
    expect(issues).toContainEqual(expect.objectContaining({ code: 'edge-duplicate', severity: 'warning' }));
    expect(flow!.edges).toHaveLength(1);
  });

  it('bidirectional survives on process↔process and lands in edge.data', () => {
    const spec: FlowSpec = {
      nodes: [
        { key: 's', type: 'start' },
        { key: 'a', type: 'process', model: 'model-abc' },
        { key: 'b', type: 'process', model: 'model-abc' },
        { key: 'f', type: 'finish' },
      ],
      edges: [
        { from: 's', to: 'a' },
        { from: 'a', to: 'b', bidirectional: true },
        { from: 'a', to: 'f' },
      ],
    };
    const { flow, errorCount } = compileFlowSpec(spec, context);
    expect(errorCount).toBe(0);
    const edge = flow!.edges.find((e) => (e.data as any).bidirectional)!;
    expect(edge.data).toEqual({ edgeType: 'standard', bidirectional: true });
  });

  it('downgrades bidirectional when the reverse direction would be illegal', () => {
    const spec: FlowSpec = {
      nodes,
      edges: [
        { from: 's', to: 'p', bidirectional: true },
        { from: 'p', to: 'f', bidirectional: true },
      ],
    };
    const { flow, issues } = compileFlowSpec(spec, context);
    expect(issues.filter((i) => i.code === 'bidirectional-illegal')).toHaveLength(2);
    for (const edge of flow!.edges) {
      expect((edge.data as any).bidirectional).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// Layout of disconnected / branching shapes
// ---------------------------------------------------------------------------

describe('compileFlowSpec — layout resilience', () => {
  it('spreads same-depth siblings horizontally', () => {
    const spec: FlowSpec = {
      nodes: [
        { key: 's', type: 'start' },
        { key: 'a', type: 'process', model: 'model-abc' },
        { key: 'b', type: 'process', model: 'model-abc' },
        { key: 'f', type: 'finish' },
      ],
      edges: [
        { from: 's', to: 'a' },
        { from: 's', to: 'b' },
        { from: 'a', to: 'f' },
        { from: 'b', to: 'f' },
      ],
    };
    const { flow } = compileFlowSpec(spec, context);
    const a = byLabel(flow!, 'Process Node');
    const siblings = flow!.nodes.filter((n) => n.type === 'process');
    expect(siblings[0].position.y).toBe(siblings[1].position.y);
    expect(siblings[0].position.x).not.toBe(siblings[1].position.x);
    expect(a.position.y).toBeGreaterThan(byLabel(flow!, 'Start Node').position.y);
  });

  it('places unreachable nodes below the reachable graph instead of losing them', () => {
    const spec: FlowSpec = {
      nodes: [
        { key: 's', type: 'start' },
        { key: 'p', type: 'process', model: 'model-abc' },
        { key: 'orphan', type: 'process', model: 'model-abc', label: 'Orphan' },
        { key: 'f', type: 'finish' },
      ],
      edges: [
        { from: 's', to: 'p' },
        { from: 'p', to: 'f' },
      ],
    };
    const { flow } = compileFlowSpec(spec, context);
    const orphan = byLabel(flow!, 'Orphan');
    const finish = flow!.nodes.find((n) => n.type === 'finish')!;
    expect(flow!.nodes).toHaveLength(4);
    expect(orphan.position.y).toBeGreaterThan(finish.position.y);
  });

  it('survives a spec with no start node (validateFlow reports it; layout anchors on the first node)', () => {
    const spec: FlowSpec = {
      nodes: [
        { key: 'p', type: 'process', model: 'model-abc' },
        { key: 'f', type: 'finish' },
      ],
      edges: [{ from: 'p', to: 'f' }],
    };
    const { flow, errorCount } = compileFlowSpec(spec, context);
    expect(errorCount).toBe(0); // compiler is structural; the missing start is validateFlow's job
    expect(flow!.nodes).toHaveLength(2);
    const validation = validateFlow(flow!, {});
    expect(validation.issues.map((i) => i.code)).toContain('no-start-node');
  });
});

// ---------------------------------------------------------------------------
// Multi-level (nested subflowSpec) bundles — issue #94
// ---------------------------------------------------------------------------

function leafSpec(name?: string): FlowSpec {
  return {
    ...(name ? { name } : {}),
    nodes: [
      { key: 's', type: 'start' },
      { key: 'f', type: 'finish' },
    ],
    edges: [{ from: 's', to: 'f' }],
  };
}

describe('compileFlowSpec — nested subflows (bundle)', () => {
  const nestedSpec: FlowSpec = {
    name: 'parent_flow',
    nodes: [
      { key: 's', type: 'start' },
      {
        key: 'sub',
        type: 'subflow',
        label: 'Child',
        subflowSpec: {
          name: 'child_flow',
          nodes: [
            { key: 'cs', type: 'start' },
            { key: 'cp', type: 'process', model: 'model-abc', prompt: 'work' },
            { key: 'cf', type: 'finish' },
          ],
          edges: [
            { from: 'cs', to: 'cp' },
            { from: 'cp', to: 'cf' },
          ],
        },
      },
      { key: 'f', type: 'finish' },
    ],
    edges: [
      { from: 's', to: 'sub' },
      { from: 'sub', to: 'f' },
    ],
  };

  it('compiles one flow per level; the bundle is dependency-ordered (descendants before root)', () => {
    const result = compileFlowSpec(nestedSpec, context);
    expect(result.errorCount).toBe(0);
    expect(result.flows).toHaveLength(2);
    // Root is CompileResult.flow and is LAST in the bundle.
    expect(result.flows[result.flows.length - 1]).toBe(result.flow);
    expect(result.flows[0].name).toBe('child_flow');
    expect(result.flow!.name).toBe('parent_flow');
  });

  it("wires the parent subflow node's subflowId to the compiled child's id", () => {
    const result = compileFlowSpec(nestedSpec, context);
    const child = result.flows[0];
    const sub = result.flow!.nodes.find((n) => n.type === 'subflow')!;
    expect(sub.data.properties!.subflowId).toBe(child.id);
  });

  it('a non-nested spec yields a single-flow bundle (flows[0] === flow) — back-compat', () => {
    const result = compileFlowSpec(happySpec, context);
    expect(result.flows).toHaveLength(1);
    expect(result.flows[0]).toBe(result.flow);
  });

  it('compiles grandchildren too and dedupes generated flow names across the bundle', () => {
    const deep: FlowSpec = {
      nodes: [
        { key: 's', type: 'start' },
        {
          key: 'sub',
          type: 'subflow',
          subflowSpec: {
            nodes: [
              { key: 's', type: 'start' },
              { key: 'sub2', type: 'subflow', subflowSpec: leafSpec() },
              { key: 'f', type: 'finish' },
            ],
            edges: [
              { from: 's', to: 'sub2' },
              { from: 'sub2', to: 'f' },
            ],
          },
        },
        { key: 'f', type: 'finish' },
      ],
      edges: [
        { from: 's', to: 'sub' },
        { from: 'sub', to: 'f' },
      ],
    };
    const result = compileFlowSpec(deep, context, { maxDepth: 3 });
    expect(result.errorCount).toBe(0);
    expect(result.flows).toHaveLength(3);
    const names = result.flows.map((f) => f.name);
    expect(new Set(names.map((n) => n.toLowerCase())).size).toBe(3);
  });

  it('rejects nesting deeper than maxDepth and does not compile the child', () => {
    const result = compileFlowSpec(nestedSpec, context, { maxDepth: 0 });
    expect(result.issues).toContainEqual(expect.objectContaining({ code: 'subflow-too-deep', severity: 'error' }));
    expect(result.flows).toHaveLength(1); // only the root
  });

  it('rejects a bundle exceeding maxFlows', () => {
    const siblings: FlowSpec = {
      nodes: [
        { key: 's', type: 'start' },
        { key: 'a', type: 'subflow', subflowSpec: leafSpec() },
        { key: 'b', type: 'subflow', subflowSpec: leafSpec() },
        { key: 'c', type: 'subflow', subflowSpec: leafSpec() },
        { key: 'f', type: 'finish' },
      ],
      edges: [
        { from: 's', to: 'a' },
        { from: 'a', to: 'b' },
        { from: 'b', to: 'c' },
        { from: 'c', to: 'f' },
      ],
    };
    const result = compileFlowSpec(siblings, context, { maxDepth: 3, maxFlows: 3 });
    expect(result.issues).toContainEqual(expect.objectContaining({ code: 'subflow-too-many', severity: 'error' }));
    expect(result.flows.length).toBeLessThanOrEqual(3);
  });

  it('precedence flow > subflowSpec: uses the existing flow, warns, and skips the inline child', () => {
    const spec: FlowSpec = {
      nodes: [
        { key: 's', type: 'start' },
        { key: 'sub', type: 'subflow', flow: 'Summarizer', subflowSpec: leafSpec() },
        { key: 'f', type: 'finish' },
      ],
      edges: [
        { from: 's', to: 'sub' },
        { from: 'sub', to: 'f' },
      ],
    };
    const result = compileFlowSpec(spec, context);
    expect(result.issues).toContainEqual(expect.objectContaining({ code: 'subflow-multiple-sources', severity: 'warning' }));
    const sub = result.flow!.nodes.find((n) => n.type === 'subflow')!;
    expect(sub.data.properties!.subflowId).toBe('flow-1'); // the existing flow won
    expect(result.flows).toHaveLength(1); // inline child NOT compiled
  });

  it('flags generateSubflow as generator-only in the deterministic compiler', () => {
    const spec: FlowSpec = {
      nodes: [
        { key: 's', type: 'start' },
        { key: 'sub', type: 'subflow', generateSubflow: 'summarize the result' },
        { key: 'f', type: 'finish' },
      ],
      edges: [
        { from: 's', to: 'sub' },
        { from: 'sub', to: 'f' },
      ],
    };
    const result = compileFlowSpec(spec, context);
    expect(result.issues).toContainEqual(expect.objectContaining({ code: 'subflow-generate-unsupported', severity: 'error' }));
  });

  it('an inline child can reference an existing flow by name', () => {
    const spec: FlowSpec = {
      nodes: [
        { key: 's', type: 'start' },
        {
          key: 'sub',
          type: 'subflow',
          subflowSpec: {
            nodes: [
              { key: 's', type: 'start' },
              { key: 'inner', type: 'subflow', flow: 'Summarizer' },
              { key: 'f', type: 'finish' },
            ],
            edges: [
              { from: 's', to: 'inner' },
              { from: 'inner', to: 'f' },
            ],
          },
        },
        { key: 'f', type: 'finish' },
      ],
      edges: [
        { from: 's', to: 'sub' },
        { from: 'sub', to: 'f' },
      ],
    };
    const result = compileFlowSpec(spec, context, { maxDepth: 2 });
    expect(result.errorCount).toBe(0);
    const child = result.flows[0];
    const inner = child.nodes.find((n) => n.type === 'subflow')!;
    expect(inner.data.properties!.subflowId).toBe('flow-1');
  });
});

// ---------------------------------------------------------------------------
// Tier 1 DSL-surface fixes (FlowSpec DSL gaps plan)
// ---------------------------------------------------------------------------

// A context with several existing flows for parallel fan-out lanes.
const parallelContext: CompileContext = {
  ...context,
  flows: [
    { id: 'flow-1', name: 'Summarizer' },
    { id: 'flow-tests', name: 'run_tests' },
    { id: 'flow-lint', name: 'run_lint_typecheck' },
    { id: 'flow-sec', name: 'security_eval' },
  ],
};

function subflowWrap(subNode: Partial<FlowSpec['nodes'][number]>): FlowSpec {
  return {
    nodes: [
      { key: 's', type: 'start' },
      { key: 'gate', type: 'subflow', ...(subNode as any) },
      { key: 'f', type: 'finish' },
    ],
    edges: [
      { from: 's', to: 'gate' },
      { from: 'gate', to: 'f' },
    ],
  };
}

describe('compileFlowSpec — parallel fan-out (1a)', () => {
  it('parallelFlows resolves each lane to an existing id; sets parallelSubflowIds, no subflowId', () => {
    const spec = subflowWrap({
      parallelFlows: ['run_tests', 'run_lint_typecheck', 'security_eval'],
      concurrencyLimit: 2,
      joinSeparator: '\n\n---\n\n',
      errorStrategy: 'fail-fast',
    });
    const { flow, errorCount } = compileFlowSpec(spec, parallelContext);
    expect(errorCount).toBe(0);
    const gate = flow!.nodes.find((n) => n.type === 'subflow')!;
    expect(gate.data.properties!.parallelSubflowIds).toEqual(['flow-tests', 'flow-lint', 'flow-sec']);
    expect(gate.data.properties).not.toHaveProperty('subflowId');
    expect(gate.data.properties!.concurrencyLimit).toBe(2);
    expect(gate.data.properties!.joinSeparator).toBe('\n\n---\n\n');
    expect(gate.data.properties!.errorStrategy).toBe('fail-fast');
  });

  it('resolves lanes by id as well as name and de-duplicates', () => {
    const { flow } = compileFlowSpec(
      subflowWrap({ parallelFlows: ['flow-tests', 'run_tests', 'security_eval'] }),
      parallelContext
    );
    const gate = flow!.nodes.find((n) => n.type === 'subflow')!;
    expect(gate.data.properties!.parallelSubflowIds).toEqual(['flow-tests', 'flow-sec']);
  });

  it('errors on an unresolved lane', () => {
    const { issues } = compileFlowSpec(subflowWrap({ parallelFlows: ['run_tests', 'nope'] }), parallelContext);
    expect(issues).toContainEqual(expect.objectContaining({ code: 'parallel-flow-unresolved', severity: 'error' }));
  });

  it('errors when a lane refers to an ancestor (cycle) while keeping the others', () => {
    // Compile a parent whose inline child fans out to the parent by name.
    const spec: FlowSpec = {
      name: 'quality_gate',
      nodes: [
        { key: 's', type: 'start' },
        {
          key: 'child',
          type: 'subflow',
          subflowSpec: {
            nodes: [
              { key: 'cs', type: 'start' },
              { key: 'fanout', type: 'subflow', parallelFlows: ['run_tests', 'quality_gate'] },
              { key: 'cf', type: 'finish' },
            ],
            edges: [
              { from: 'cs', to: 'fanout' },
              { from: 'fanout', to: 'cf' },
            ],
          },
        },
        { key: 'f', type: 'finish' },
      ],
      edges: [
        { from: 's', to: 'child' },
        { from: 'child', to: 'f' },
      ],
    };
    const { issues } = compileFlowSpec(spec, parallelContext, { maxDepth: 2 });
    expect(issues).toContainEqual(expect.objectContaining({ code: 'subflow-cycle', severity: 'error' }));
  });

  it('inline parallelSubflowSpecs compile into bundle children and set the lane ids', () => {
    const spec = subflowWrap({
      parallelSubflowSpecs: [leafSpec('lane_a'), leafSpec('lane_b')],
    });
    const result = compileFlowSpec(spec, parallelContext, { maxDepth: 2 });
    expect(result.errorCount).toBe(0);
    // root + 2 lane children
    expect(result.flows).toHaveLength(3);
    const gate = result.flow!.nodes.find((n) => n.type === 'subflow')!;
    const laneIds = gate.data.properties!.parallelSubflowIds as string[];
    expect(laneIds).toHaveLength(2);
    const childIds = result.flows.filter((fl) => fl !== result.flow).map((fl) => fl.id);
    expect(laneIds.sort()).toEqual(childIds.sort());
  });

  it('inline parallel lanes honour the maxFlows cap', () => {
    const spec = subflowWrap({
      parallelSubflowSpecs: [leafSpec(), leafSpec(), leafSpec()],
    });
    // root(1) + 2 children == cap 3; the third lane cannot be compiled.
    const result = compileFlowSpec(spec, parallelContext, { maxDepth: 2, maxFlows: 3 });
    expect(result.issues).toContainEqual(expect.objectContaining({ code: 'subflow-too-many', severity: 'error' }));
    const gate = result.flow!.nodes.find((n) => n.type === 'subflow')!;
    expect((gate.data.properties!.parallelSubflowIds as string[]).length).toBe(2);
  });

  it('clamps concurrencyLimit to >= 1 and warns on a non-number', () => {
    const { flow } = compileFlowSpec(
      subflowWrap({ parallelFlows: ['run_tests'], concurrencyLimit: 0 }),
      parallelContext
    );
    const gate = flow!.nodes.find((n) => n.type === 'subflow')!;
    expect(gate.data.properties!.concurrencyLimit).toBe(1);

    const bad = compileFlowSpec(
      subflowWrap({ parallelFlows: ['run_tests'], concurrencyLimit: 'lots' as any }),
      parallelContext
    );
    expect(bad.issues).toContainEqual(expect.objectContaining({ code: 'invalid-concurrency-limit', severity: 'warning' }));
  });

  it('precedence flow > parallelFlows: uses the single flow and warns', () => {
    const { flow, issues } = compileFlowSpec(
      subflowWrap({ flow: 'Summarizer', parallelFlows: ['run_tests'] }),
      parallelContext
    );
    expect(issues).toContainEqual(expect.objectContaining({ code: 'subflow-multiple-sources', severity: 'warning' }));
    const gate = flow!.nodes.find((n) => n.type === 'subflow')!;
    expect(gate.data.properties!.subflowId).toBe('flow-1');
    expect(gate.data.properties).not.toHaveProperty('parallelSubflowIds');
  });

  it('a parallel subflow with a single outgoing edge still validates clean', () => {
    const { flow } = compileFlowSpec(
      subflowWrap({ parallelFlows: ['run_tests', 'run_lint_typecheck'] }),
      parallelContext
    );
    const validation = validateFlow(flow!, { models: context.models });
    expect(validation.issues.map((i) => i.code)).not.toContain('subflow-multiple-outgoing');
    expect(validation.isRunnable).toBe(true);
  });
});

describe('compileFlowSpec — map-over-list (Tier 2a)', () => {
  it('mapOverList decorates a single child: subflowId set, mapOverList + tuning copied', () => {
    const spec = subflowWrap({
      flow: 'run_tests',
      mapOverList: true,
      itemSplit: 'lines',
      sequential: true,
      concurrencyLimit: 3,
      joinSeparator: '\n--\n',
      errorStrategy: 'fail-fast',
    });
    const { flow, errorCount } = compileFlowSpec(spec, parallelContext);
    expect(errorCount).toBe(0);
    const gate = flow!.nodes.find((n) => n.type === 'subflow')!;
    expect(gate.data.properties!.subflowId).toBe('flow-tests');
    expect(gate.data.properties!.mapOverList).toBe(true);
    expect(gate.data.properties!.itemSplit).toBe('lines');
    expect(gate.data.properties!.sequential).toBe(true);
    expect(gate.data.properties!.concurrencyLimit).toBe(3);
    expect(gate.data.properties!.joinSeparator).toBe('\n--\n');
    expect(gate.data.properties!.errorStrategy).toBe('fail-fast');
    expect(gate.data.properties).not.toHaveProperty('parallelSubflowIds');
  });

  it('defaults: itemSplit/sequential omitted when unset (runtime defaults apply)', () => {
    const { flow } = compileFlowSpec(subflowWrap({ flow: 'run_tests', mapOverList: true }), parallelContext);
    const gate = flow!.nodes.find((n) => n.type === 'subflow')!;
    expect(gate.data.properties!.mapOverList).toBe(true);
    expect(gate.data.properties).not.toHaveProperty('itemSplit');
    expect(gate.data.properties).not.toHaveProperty('sequential');
  });

  it('warns on an invalid itemSplit and omits it', () => {
    const { flow, issues } = compileFlowSpec(
      subflowWrap({ flow: 'run_tests', mapOverList: true, itemSplit: 'csv' as any }),
      parallelContext
    );
    expect(issues).toContainEqual(expect.objectContaining({ code: 'invalid-item-split', severity: 'warning' }));
    const gate = flow!.nodes.find((n) => n.type === 'subflow')!;
    expect(gate.data.properties).not.toHaveProperty('itemSplit');
  });

  it('errors when mapOverList is combined with parallelFlows', () => {
    const { issues } = compileFlowSpec(
      subflowWrap({ mapOverList: true, parallelFlows: ['run_tests', 'run_lint_typecheck'] }),
      parallelContext
    );
    expect(issues).toContainEqual(expect.objectContaining({ code: 'subflow-map-and-parallel', severity: 'error' }));
  });

  it('errors when mapOverList has no single child to map', () => {
    const { issues } = compileFlowSpec(subflowWrap({ mapOverList: true }), parallelContext);
    expect(issues).toContainEqual(expect.objectContaining({ code: 'subflow-map-no-child', severity: 'error' }));
  });

  it('works with an inline subflowSpec child', () => {
    const spec = subflowWrap({ mapOverList: true, subflowSpec: leafSpec('mapped_child') });
    const result = compileFlowSpec(spec, parallelContext, { maxDepth: 2 });
    expect(result.errorCount).toBe(0);
    const gate = result.flow!.nodes.find((n) => n.type === 'subflow')!;
    expect(gate.data.properties!.mapOverList).toBe(true);
    expect(typeof gate.data.properties!.subflowId).toBe('string');
  });

  it('a map-over-list subflow validates clean (single outgoing edge)', () => {
    const { flow } = compileFlowSpec(subflowWrap({ flow: 'run_tests', mapOverList: true }), parallelContext);
    const validation = validateFlow(flow!, { models: context.models });
    expect(validation.issues.map((i) => i.code)).not.toContain('subflow-map-and-parallel');
    expect(validation.issues.map((i) => i.code)).not.toContain('subflow-map-no-child');
    expect(validation.isRunnable).toBe(true);
  });
});

describe('compileFlowSpec — process maxTurns / prompt flags / allowedTools (1b–1d)', () => {
  const procWrap = (over: Partial<FlowSpec['nodes'][number]>): FlowSpec => ({
    nodes: [
      { key: 's', type: 'start' },
      { key: 'p', type: 'process', model: 'model-abc', ...(over as any) },
      { key: 'f', type: 'finish' },
    ],
    edges: [
      { from: 's', to: 'p' },
      { from: 'p', to: 'f' },
    ],
  });
  const proc = (flow: NonNullable<ReturnType<typeof compileFlowSpec>['flow']>) =>
    flow.nodes.find((n) => n.type === 'process')!;

  it('maps and clamps maxTurns', () => {
    expect(proc(compileFlowSpec(procWrap({ maxTurns: 20 }), context).flow!).data.properties!.maxTurns).toBe(20);
    expect(proc(compileFlowSpec(procWrap({ maxTurns: 0 }), context).flow!).data.properties!.maxTurns).toBe(1);
    expect(proc(compileFlowSpec(procWrap({ maxTurns: 999999 }), context).flow!).data.properties!.maxTurns).toBe(1000);
  });

  it('warns and omits a non-numeric maxTurns', () => {
    const { flow, issues } = compileFlowSpec(procWrap({ maxTurns: 'many' as any }), context);
    expect(issues).toContainEqual(expect.objectContaining({ code: 'invalid-max-turns', severity: 'warning' }));
    expect(proc(flow!).data.properties).not.toHaveProperty('maxTurns');
  });

  it('copies the prompt-composition flags only when boolean', () => {
    const { flow } = compileFlowSpec(
      procWrap({ excludeModelPrompt: true, excludeStartNodePrompt: false, excludeSystemPrompt: true }),
      context
    );
    const p = proc(flow!).data.properties!;
    expect(p.excludeModelPrompt).toBe(true);
    expect(p.excludeStartNodePrompt).toBe(false);
    expect(p.excludeSystemPrompt).toBe(true);
  });

  it('copies allowedTools, dropping non-string entries', () => {
    const { flow } = compileFlowSpec(procWrap({ allowedTools: ['read_file', '', 42 as any, 'write_file'] }), context);
    expect(proc(flow!).data.properties!.allowedTools).toEqual(['read_file', 'write_file']);
  });

  it('absent Tier-1 fields leave properties byte-for-byte unchanged', () => {
    const p = proc(compileFlowSpec(procWrap({ prompt: 'x' }), context).flow!).data.properties!;
    expect(p).toEqual({ promptTemplate: 'x', boundModel: 'model-abc' });
  });
});

// ---------------------------------------------------------------------------
// Dynamic fan-out target selection (issue #130) — parallelFlowsVariable
// ---------------------------------------------------------------------------

describe('compileFlowSpec — dynamic fan-out (parallelFlowsVariable, issue #130)', () => {
  it('standalone parallelFlowsVariable compiles to parallelSubflowIdsVar (no static child)', () => {
    const { flow, errorCount } = compileFlowSpec(
      subflowWrap({ parallelFlowsVariable: 'TARGETS', concurrencyLimit: 3, errorStrategy: 'fail-fast' }),
      parallelContext
    );
    expect(errorCount).toBe(0);
    const gate = flow!.nodes.find((n) => n.type === 'subflow')!;
    expect(gate.data.properties!.parallelSubflowIdsVar).toBe('TARGETS');
    expect(gate.data.properties).not.toHaveProperty('subflowId');
    expect(gate.data.properties).not.toHaveProperty('parallelSubflowIds');
    expect(gate.data.properties!.concurrencyLimit).toBe(3);
    expect(gate.data.properties!.errorStrategy).toBe('fail-fast');
  });

  it('parallelFlowsVariable can decorate a static parallelFlows base (runtime override)', () => {
    const { flow, errorCount } = compileFlowSpec(
      subflowWrap({ parallelFlows: ['run_tests', 'security_eval'], parallelFlowsVariable: 'TARGETS' }),
      parallelContext
    );
    expect(errorCount).toBe(0);
    const gate = flow!.nodes.find((n) => n.type === 'subflow')!;
    expect(gate.data.properties!.parallelSubflowIds).toEqual(['flow-tests', 'flow-sec']);
    expect(gate.data.properties!.parallelSubflowIdsVar).toBe('TARGETS');
  });

  it('errors when parallelFlowsVariable is combined with mapOverList', () => {
    const { issues } = compileFlowSpec(
      subflowWrap({ flow: 'Summarizer', parallelFlowsVariable: 'TARGETS', mapOverList: true }),
      parallelContext
    );
    expect(issues).toContainEqual(
      expect.objectContaining({ code: 'subflow-map-and-parallel-var', severity: 'error' })
    );
  });
});
