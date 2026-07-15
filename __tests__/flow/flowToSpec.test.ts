/**
 * flowToSpec reverse-serializer tests (issue #99, AI-Improve).
 *
 * flowToSpec is the inverse of compileFlowSpec: it turns an existing Flow back into the
 * compact FlowSpec DSL so an "improve this flow" pass can show the model what it's editing.
 * The two must round-trip (compile ∘ serialize ≈ identity, modulo fresh uuids / layout), and
 * the compiler's `positions` option must pin unchanged nodes to their original coordinates.
 */
import {
  compileFlowSpec,
  flowToSpec,
  FlowSpec,
  CompileContext,
} from '@/utils/shared/flowSpecCompiler';
import { validateFlow } from '@/utils/shared/flowValidation';
import type { Flow } from '@/shared/types/flow';

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
      inputMode: 'latest-message',
      outputMode: 'latest-message',
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

function byLabel(flow: Flow, label: string) {
  const node = flow.nodes.find((n) => n.data.label === label);
  expect(node).toBeDefined();
  return node!;
}

/** Set of "sourceLabel->targetLabel" for the control edges (edgeType standard). */
function controlEdgeLabels(flow: Flow): Set<string> {
  const labelOf = (id: string) => flow.nodes.find((n) => n.id === id)?.data.label ?? id;
  return new Set(
    flow.edges
      .filter((e) => (e.data as { edgeType?: string } | undefined)?.edgeType !== 'mcp')
      .map((e) => `${labelOf(e.source)}->${labelOf(e.target)}`)
  );
}

describe('flowToSpec — structure', () => {
  const flow = compileFlowSpec(happySpec, context).flow!;
  const spec = flowToSpec(flow);

  it('keys every spec node by its original FlowNode id', () => {
    for (const specNode of spec.nodes) {
      expect(flow.nodes.some((n) => n.id === specNode.key)).toBe(true);
    }
  });

  it('never emits mcp nodes — servers are folded back onto the process node', () => {
    expect(spec.nodes.some((n) => (n.type as string) === 'mcp')).toBe(false);
    const research = spec.nodes.find((n) => n.label === 'Researcher')!;
    expect(research.servers).toEqual([{ name: 'brave-search', tools: ['web_search'] }]);
  });

  it('carries prompts, model id, modes, description, and subflow target back', () => {
    expect(spec.nodes.find((n) => n.type === 'start')!.prompt).toBe('You are a research pipeline.');
    const research = spec.nodes.find((n) => n.label === 'Researcher')!;
    expect(research.model).toBe('model-abc'); // the resolved id, not the display name
    expect(research.prompt).toBe('Research the topic thoroughly.');
    expect(research.description).toBe('Searches the web');
    expect(research.inputMode).toBe('latest-message');
    expect(research.outputMode).toBe('latest-message');
    const sub = spec.nodes.find((n) => n.type === 'subflow')!;
    expect(sub.flow).toBe('flow-1');
    expect(sub.outputMode).toBe('final-only');
  });

  it('serializes only control edges (mcp edges are rebuilt from servers)', () => {
    expect(spec.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ from: expect.any(String), to: expect.any(String) }),
      ])
    );
    expect(spec.edges).toHaveLength(3); // 3 control edges; the mcp edge is NOT serialized
  });

  it('preserves the flow name and description', () => {
    expect(spec.name).toBe('research_flow');
    expect(spec.description).toBe('Researches a topic and summarizes it');
  });
});

describe('flowToSpec — round-trips through compileFlowSpec', () => {
  const flow1 = compileFlowSpec(happySpec, context).flow!;
  const result2 = compileFlowSpec(flowToSpec(flow1), context);
  const flow2 = result2.flow!;

  it('recompiles with no errors', () => {
    expect(result2.errorCount).toBe(0);
  });

  it('reproduces the node multiset (incl. the derived mcp node)', () => {
    expect(flow2.nodes.map((n) => n.type).sort()).toEqual(flow1.nodes.map((n) => n.type).sort());
  });

  it('reproduces process bindings, mcp server/tools, and subflow target', () => {
    expect(byLabel(flow2, 'Researcher').data.properties).toEqual(
      byLabel(flow1, 'Researcher').data.properties
    );
    expect(byLabel(flow2, 'brave-search').data.properties).toEqual(
      byLabel(flow1, 'brave-search').data.properties
    );
    expect(byLabel(flow2, 'Summarize').data.properties!.subflowId).toBe('flow-1');
    expect(byLabel(flow2, 'Start').data.properties!.promptTemplate).toBe('You are a research pipeline.');
  });

  it('reproduces the control-edge topology (by label)', () => {
    expect(controlEdgeLabels(flow2)).toEqual(controlEdgeLabels(flow1));
  });

  it('still passes validateFlow clean', () => {
    const validation = validateFlow(flow2, {
      models: context.models,
      servers: context.servers!.map((s) => ({ ...s, status: 'connected' })),
      serverTools: context.serverTools,
    });
    expect(validation.issues).toEqual([]);
  });

  it('preserves a bidirectional control edge across the round-trip', () => {
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
    const flow = compileFlowSpec(spec, context).flow!;
    const reSpec = flowToSpec(flow);
    const bidi = reSpec.edges.find((e) => e.bidirectional);
    expect(bidi).toBeDefined();
    const recompiled = compileFlowSpec(reSpec, context).flow!;
    expect(recompiled.edges.some((e) => (e.data as any).bidirectional)).toBe(true);
  });
});

describe('flowToSpec + compile positions option — layout preservation', () => {
  it('pins nodes whose spec key has a supplied position; MCP nodes follow their process node', () => {
    const flow1 = compileFlowSpec(happySpec, context).flow!;
    // Give every node a distinctive position we can assert on.
    flow1.nodes.forEach((n, i) => {
      n.position = { x: 1000 + i * 7, y: 2000 + i * 13 };
    });

    const spec = flowToSpec(flow1);
    const positions: Record<string, { x: number; y: number }> = {};
    for (const n of flow1.nodes) {
      if (n.type !== 'mcp') positions[n.id] = { ...n.position };
    }

    const flow2 = compileFlowSpec(spec, context, { positions }).flow!;
    for (const n2 of flow2.nodes) {
      if (n2.type === 'mcp') continue;
      const n1 = flow1.nodes.find((n) => n.type === n2.type && n.data.label === n2.data.label)!;
      expect(n2.position).toEqual(n1.position);
    }
    // The mcp node was not pinned; it sits to the RIGHT of its (pinned) process node.
    const research2 = byLabel(flow2, 'Researcher');
    const mcp2 = byLabel(flow2, 'brave-search');
    expect(mcp2.position.x).toBeGreaterThan(research2.position.x);
  });

  it('new nodes (no pinned position) still get auto-layout', () => {
    const flow1 = compileFlowSpec(happySpec, context).flow!;
    const spec = flowToSpec(flow1);
    // Only pin the start node; everything else must fall back to the layered layout.
    const startNode = flow1.nodes.find((n) => n.type === 'start')!;
    const positions = { [startNode.id]: { x: 42, y: 99 } };
    const flow2 = compileFlowSpec(spec, context, { positions }).flow!;
    expect(byLabel(flow2, 'Start').position).toEqual({ x: 42, y: 99 });
    // A non-pinned node is laid out below the start (auto-layout y grows with depth).
    expect(byLabel(flow2, 'Researcher').position.y).not.toBe(99);
  });
});

describe('flowToSpec — Tier 1 fields round-trip', () => {
  const parallelContext: CompileContext = {
    ...context,
    flows: [
      { id: 'flow-1', name: 'Summarizer' },
      { id: 'flow-tests', name: 'run_tests' },
      { id: 'flow-lint', name: 'run_lint_typecheck' },
    ],
  };

  it('round-trips process maxTurns / prompt flags / allowedTools', () => {
    const spec: FlowSpec = {
      nodes: [
        { key: 's', type: 'start' },
        {
          key: 'p',
          type: 'process',
          model: 'model-abc',
          maxTurns: 25,
          excludeModelPrompt: true,
          excludeSystemPrompt: true,
          allowedTools: ['read_file', 'write_file'],
        },
        { key: 'f', type: 'finish' },
      ],
      edges: [
        { from: 's', to: 'p' },
        { from: 'p', to: 'f' },
      ],
    };
    const flow1 = compileFlowSpec(spec, parallelContext).flow!;
    const reSpec = flowToSpec(flow1);
    const p = reSpec.nodes.find((n) => n.type === 'process')!;
    expect(p.maxTurns).toBe(25);
    expect(p.excludeModelPrompt).toBe(true);
    expect(p.excludeSystemPrompt).toBe(true);
    expect(p.excludeStartNodePrompt).toBeUndefined(); // was false → not emitted
    expect(p.allowedTools).toEqual(['read_file', 'write_file']);

    const flow2 = compileFlowSpec(reSpec, parallelContext).flow!;
    const p2 = flow2.nodes.find((n) => n.type === 'process')!;
    expect(p2.data.properties).toEqual(flow1.nodes.find((n) => n.type === 'process')!.data.properties);
  });

  it('serializes a parallel subflow back to parallelFlows + tuning fields (not flow)', () => {
    const spec: FlowSpec = {
      nodes: [
        { key: 's', type: 'start' },
        {
          key: 'gate',
          type: 'subflow',
          parallelFlows: ['run_tests', 'run_lint_typecheck'],
          concurrencyLimit: 3,
          joinSeparator: '\n--\n',
          errorStrategy: 'fail-fast',
        },
        { key: 'f', type: 'finish' },
      ],
      edges: [
        { from: 's', to: 'gate' },
        { from: 'gate', to: 'f' },
      ],
    };
    const flow1 = compileFlowSpec(spec, parallelContext).flow!;
    const reSpec = flowToSpec(flow1);
    const gate = reSpec.nodes.find((n) => n.type === 'subflow')!;
    expect(gate.flow).toBeUndefined();
    expect(gate.parallelFlows).toEqual(['flow-tests', 'flow-lint']);
    expect(gate.concurrencyLimit).toBe(3);
    expect(gate.joinSeparator).toBe('\n--\n');
    expect(gate.errorStrategy).toBe('fail-fast');

    const flow2 = compileFlowSpec(reSpec, parallelContext).flow!;
    const gate2 = flow2.nodes.find((n) => n.type === 'subflow')!;
    expect(gate2.data.properties!.parallelSubflowIds).toEqual(['flow-tests', 'flow-lint']);
    expect(gate2.data.properties).not.toHaveProperty('subflowId');
  });
});

describe('flowToSpec — resilience', () => {
  it('handles a bare flow with no properties', () => {
    const flow: Flow = {
      id: 'x',
      name: 'bare',
      nodes: [
        { id: 'n1', type: 'start', position: { x: 0, y: 0 }, data: { label: 'Start', type: 'start' } },
        { id: 'n2', type: 'finish', position: { x: 0, y: 100 }, data: { label: 'End', type: 'finish' } },
      ],
      edges: [],
    };
    const spec = flowToSpec(flow);
    expect(spec.nodes.map((n) => n.type)).toEqual(['start', 'finish']);
    expect(spec.nodes[0].key).toBe('n1');
  });
});
