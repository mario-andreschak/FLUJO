/**
 * Static node (issue #358/#380) in the FlowSpec codec.
 *
 * Pins: compile emits the static FlowNode inline with STANDARD control edges (a static
 * node is a pass-through control node, not an attachment); malformed/missing entries are
 * sanitized rather than trusted verbatim; and — the AI-Improve data-loss guard —
 * flowToSpec round-trips the static node's entries/injectOnce instead of dropping it
 * (this is the bug issue #380 formalizes the fix for).
 */
import { compileFlowSpec, flowToSpec, FlowSpec } from '@/utils/shared/flowSpecCompiler';

const context = { models: [{ id: 'model-1', displayName: 'GPT' }], servers: [], serverTools: {} };

const staticSpec = (staticNode: Record<string, unknown>): FlowSpec => ({
  name: 'static_flow',
  nodes: [
    { key: 'start', type: 'start', prompt: 'sys' },
    { key: 'st', type: 'static', ...staticNode } as never,
    { key: 'end', type: 'finish' },
  ],
  edges: [
    { from: 'start', to: 'st' },
    { from: 'st', to: 'end' },
  ],
});

describe('compile: static nodes', () => {
  it('compiles a static node with a message entry and a toolCall entry, and preserves injectOnce', () => {
    const result = compileFlowSpec(
      staticSpec({
        entries: [
          { kind: 'message', role: 'system', content: 'Few-shot example.' },
          { kind: 'toolCall', toolName: 'search', argumentsJson: '{"q":"flujo"}', result: 'ok' },
        ],
        injectOnce: true,
      }),
      context
    );
    expect(result.errorCount).toBe(0);
    const flow = result.flow!;
    const st = flow.nodes.find((n) => n.type === 'static')!;
    expect(st.data!.properties!.entries).toEqual([
      { kind: 'message', role: 'system', content: 'Few-shot example.' },
      { kind: 'toolCall', toolName: 'search', argumentsJson: '{"q":"flujo"}', result: 'ok' },
    ]);
    expect(st.data!.properties!.injectOnce).toBe(true);

    // Incoming/outgoing edges are normal control edges, NOT resource/mcp attachments.
    const incoming = flow.edges.find((e) => e.target === st.id)!;
    const outgoing = flow.edges.find((e) => e.source === st.id)!;
    expect((incoming.data as { edgeType?: string })?.edgeType).toBe('standard');
    expect((outgoing.data as { edgeType?: string })?.edgeType).toBe('standard');
    expect(outgoing.sourceHandle).toBe('static-bottom');
    expect(incoming.targetHandle).toBe('static-top');
  });

  it('warns and compiles with no properties when entries are missing/empty', () => {
    const missing = compileFlowSpec(staticSpec({}), context);
    expect(missing.errorCount).toBe(0);
    expect(missing.issues.some((i) => i.code === 'static-no-entries')).toBe(true);
    expect(missing.flow!.nodes.find((n) => n.type === 'static')!.data!.properties!.entries).toBeUndefined();

    const empty = compileFlowSpec(staticSpec({ entries: [] }), context);
    expect(empty.issues.some((i) => i.code === 'static-no-entries')).toBe(true);
  });

  it('drops a malformed entry (bad kind/role/content) and does not copy unknown keys through', () => {
    const result = compileFlowSpec(
      staticSpec({
        entries: [
          { kind: 'message', role: 'assistant', content: 'kept' },
          { kind: 'message', role: 'not-a-role', content: 'dropped: bad role' },
          { kind: 'message', role: 'user', content: 42 },
          { kind: 'weird', foo: 'bar' },
          { kind: 'toolCall', toolName: '', argumentsJson: '{}', result: 'x' },
          { kind: 'message', role: 'user', content: 'kept too', extraUnknownKey: 'should be stripped' },
        ],
      }),
      context
    );
    expect(result.issues.filter((i) => i.code === 'static-invalid-entry').length).toBeGreaterThanOrEqual(4);
    const st = result.flow!.nodes.find((n) => n.type === 'static')!;
    const entries = st.data!.properties!.entries as Array<Record<string, unknown>>;
    // Only the two well-formed message entries survive, rebuilt field-by-field.
    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual({ kind: 'message', role: 'assistant', content: 'kept' });
    expect(entries[1]).toEqual({ kind: 'message', role: 'user', content: 'kept too' });
    expect(Object.keys(entries[1]).sort()).toEqual(['content', 'kind', 'role']);
  });

  it('warns on invalid toolCall argumentsJson but still keeps the entry', () => {
    const result = compileFlowSpec(
      staticSpec({
        entries: [{ kind: 'toolCall', toolName: 'search', argumentsJson: '{not json', result: 'ok' }],
      }),
      context
    );
    expect(result.issues.some((i) => i.code === 'static-toolcall-invalid-json')).toBe(true);
    const st = result.flow!.nodes.find((n) => n.type === 'static')!;
    expect(st.data!.properties!.entries).toHaveLength(1);
  });

  it('creates one MCP attachment for real static calls and round-trips its enabled tools', () => {
    const realContext = {
      ...context,
      servers: [{ name: 'files' }],
      serverTools: { files: ['read_file', 'write_file'] },
    } as any;
    const result = compileFlowSpec(staticSpec({
      entries: [
        { kind: 'toolCall', executionMode: 'real', serverName: 'files', toolName: 'read_file', argumentsJson: '{"path":"a"}', result: '' },
        { kind: 'toolCall', executionMode: 'real', serverName: 'files', toolName: 'write_file', argumentsJson: '{"path":"b"}', result: '' },
      ],
    }), realContext);

    const flow = result.flow!;
    const stat = flow.nodes.find((node) => node.type === 'static')!;
    const mcp = flow.nodes.find((node) => node.type === 'mcp')!;
    expect(mcp.data.properties).toMatchObject({ boundServer: 'files', enabledTools: ['read_file', 'write_file'] });
    expect(flow.edges.filter((edge) => edge.data?.edgeType === 'mcp')).toEqual([
      expect.objectContaining({
        source: stat.id,
        sourceHandle: 'static-right-mcp',
        target: mcp.id,
        targetHandle: 'mcp-left',
      }),
    ]);

    const back = flowToSpec(flow);
    const backStatic = back.nodes.find((node) => node.type === 'static')!;
    expect(backStatic.servers).toEqual([{ name: 'files', tools: ['read_file', 'write_file'] }]);
    expect(backStatic.entries).toEqual((stat.data.properties as any).entries);

    const reversed = {
      ...flow,
      edges: flow.edges.map((edge) => edge.data?.edgeType === 'mcp'
        ? { ...edge, source: edge.target, target: edge.source }
        : edge),
    };
    expect(flowToSpec(reversed).nodes.find((node) => node.type === 'static')?.servers).toEqual([
      { name: 'files', tools: ['read_file', 'write_file'] },
    ]);
  });

  it('keeps the required real tool enabled when an offline server ref omits its tools', () => {
    const result = compileFlowSpec(staticSpec({
      servers: [{ name: 'offline-files' }],
      entries: [
        { kind: 'toolCall', executionMode: 'real', serverName: 'offline-files', toolName: 'read_file', argumentsJson: '{}', result: '' },
      ],
    }), context);

    const mcp = result.flow!.nodes.find((node) => node.type === 'mcp')!;
    expect(mcp.data.properties).toMatchObject({
      boundServer: 'offline-files',
      enabledTools: ['read_file'],
    });
  });

  it('downgrades malformed real calls without a server to safe mocks', () => {
    const result = compileFlowSpec(staticSpec({
      entries: [{ kind: 'toolCall', executionMode: 'real', toolName: 'search', argumentsJson: '{}', result: 'captured' }],
    }), context);

    expect(result.issues.some((issue) => issue.code === 'static-real-toolcall-missing-server')).toBe(true);
    expect(result.flow!.nodes.find((node) => node.type === 'static')!.data.properties?.entries).toEqual([{
      kind: 'toolCall', executionMode: 'mock', toolName: 'search', argumentsJson: '{}', result: 'captured',
    }]);
  });

  it('flowToSpec round-trips a static node (AI-Improve data-loss guard)', () => {
    const entries = [
      { kind: 'message', role: 'system', content: 'Prime the model.' },
      { kind: 'toolCall', toolName: 'lookup', argumentsJson: '{"id":1}', result: 'found' },
    ];
    const flow = compileFlowSpec(staticSpec({ entries, injectOnce: true }), context).flow!;
    const back = flowToSpec(flow);
    const st = back.nodes.find((n) => n.type === 'static')!;
    expect(st.entries).toEqual(entries);
    expect(st.injectOnce).toBe(true);

    // Full round-trip: re-compiling the decompiled spec keeps the node and its properties.
    const recompiled = compileFlowSpec(back, context).flow!;
    const recompiledStatic = recompiled.nodes.find((n) => n.type === 'static')!;
    expect(recompiledStatic).toBeDefined();
    expect(recompiledStatic.data!.properties!.entries).toEqual(entries);
    expect(recompiledStatic.data!.properties!.injectOnce).toBe(true);
  });

  it('warns when injectOnce is not a boolean and drops the value', () => {
    const result = compileFlowSpec(staticSpec({
      entries: [{ kind: 'message', role: 'user', content: 'kept' }],
      injectOnce: 'yes',
    }), context);
    expect(result.issues.some((issue) => issue.code === 'static-invalid-injectonce')).toBe(true);
    expect(result.flow!.nodes.find((node) => node.type === 'static')!.data!.properties!.injectOnce).toBeUndefined();
  });

  it('does not emit injectOnce when it is false or omitted', () => {
    const flow = compileFlowSpec(staticSpec({ entries: [{ kind: 'message', role: 'user', content: 'kept' }], injectOnce: false }), context).flow!;
    const staticNode = flowToSpec(flow).nodes.find((node) => node.type === 'static')!;
    expect(staticNode.injectOnce).toBeUndefined();
  });

  it('does not round-trip entries when the array is empty', () => {
    const flow = compileFlowSpec(staticSpec({ entries: [] }), context).flow!;
    const back = flowToSpec(flow);
    const st = back.nodes.find((n) => n.type === 'static')!;
    expect(st.entries).toBeUndefined();
  });
});
