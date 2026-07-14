/**
 * Quick-Chats (issue #61): the pure synthesizer that turns SELECTIONS (one model
 * + optional MCP servers/tool subsets) into an ephemeral flow. Security-relevant
 * behavior: unknown model/server ids are rejected, requested tools are
 * intersected with what the server exposes, and the flow id is namespaced.
 */
import {
  synthesizeQuickChatFlow,
  quickChatFlowId,
} from '@/utils/shared/quickChat';

const context = {
  models: [
    { id: 'model-1', name: 'gpt', displayName: 'GPT' },
    { id: 'model-2', name: 'claude', displayName: 'Claude' },
  ],
  servers: [{ name: 'filesystem' }, { name: 'github' }],
  serverTools: {
    filesystem: ['read_file', 'write_file', 'list_dir'],
    github: ['search', 'create_issue'],
  },
};

/** Find the process (chat) node in a synthesized flow. */
function chatNode(flow: NonNullable<ReturnType<typeof synthesizeQuickChatFlow>['flow']>) {
  return flow.nodes.find((n) => n.type === 'process')!;
}
function mcpNodes(flow: NonNullable<ReturnType<typeof synthesizeQuickChatFlow>['flow']>) {
  return flow.nodes.filter((n) => n.type === 'mcp');
}

describe('quickChatFlowId', () => {
  it('namespaces by conversation id', () => {
    expect(quickChatFlowId('abc')).toBe('quickchat-abc');
  });
});

describe('synthesizeQuickChatFlow', () => {
  it('builds a start→process→finish flow bound to the model, with the namespaced id', () => {
    const { flow, error } = synthesizeQuickChatFlow(
      { conversationId: 'conv-1', modelId: 'model-1' },
      context
    );
    expect(error).toBeUndefined();
    expect(flow).not.toBeNull();
    expect(flow!.id).toBe('quickchat-conv-1');
    expect(flow!.nodes.map((n) => n.type).sort()).toEqual(['finish', 'process', 'start']);
    expect(chatNode(flow!).data.properties?.boundModel).toBe('model-1');
    // No servers selected → no MCP nodes.
    expect(mcpNodes(flow!)).toHaveLength(0);
  });

  it('resolves a model given by display name to its id', () => {
    const { flow } = synthesizeQuickChatFlow(
      { conversationId: 'c', modelId: 'Claude' },
      context
    );
    expect(chatNode(flow!).data.properties?.boundModel).toBe('model-2');
  });

  it('rejects an unknown model', () => {
    const { flow, error } = synthesizeQuickChatFlow(
      { conversationId: 'c', modelId: 'nope' },
      context
    );
    expect(flow).toBeNull();
    expect(error).toMatch(/unknown model/i);
  });

  it('requires a model', () => {
    const { flow, error } = synthesizeQuickChatFlow(
      { conversationId: 'c', modelId: '' },
      context
    );
    expect(flow).toBeNull();
    expect(error).toMatch(/model is required/i);
  });

  it('attaches a selected server as an MCP node with all its tools when none are specified', () => {
    const { flow } = synthesizeQuickChatFlow(
      { conversationId: 'c', modelId: 'model-1', servers: [{ name: 'filesystem' }] },
      context
    );
    const mcp = mcpNodes(flow!);
    expect(mcp).toHaveLength(1);
    expect(mcp[0].data.properties?.boundServer).toBe('filesystem');
    expect(mcp[0].data.properties?.enabledTools).toEqual(['read_file', 'write_file', 'list_dir']);
  });

  it('intersects requested tools with what the server exposes', () => {
    const { flow } = synthesizeQuickChatFlow(
      {
        conversationId: 'c',
        modelId: 'model-1',
        servers: [{ name: 'filesystem', enabledTools: ['read_file', 'not_a_tool'] }],
      },
      context
    );
    const mcp = mcpNodes(flow!);
    // 'not_a_tool' is dropped — a caller cannot enable a tool the server lacks.
    expect(mcp[0].data.properties?.enabledTools).toEqual(['read_file']);
  });

  it('rejects an unknown server', () => {
    const { flow, error } = synthesizeQuickChatFlow(
      { conversationId: 'c', modelId: 'model-1', servers: [{ name: 'ghost' }] },
      context
    );
    expect(flow).toBeNull();
    expect(error).toMatch(/unknown mcp server/i);
  });

  it('de-duplicates a server selected twice', () => {
    const { flow } = synthesizeQuickChatFlow(
      {
        conversationId: 'c',
        modelId: 'model-1',
        servers: [{ name: 'github' }, { name: 'github' }],
      },
      context
    );
    expect(mcpNodes(flow!)).toHaveLength(1);
  });

  it('carries a system prompt onto the start node', () => {
    const { flow } = synthesizeQuickChatFlow(
      { conversationId: 'c', modelId: 'model-1', systemPrompt: 'Be terse.' },
      context
    );
    const start = flow!.nodes.find((n) => n.type === 'start')!;
    expect(start.data.properties?.promptTemplate).toBe('Be terse.');
  });

  it('wires start→process→finish control edges plus one mcp edge per server', () => {
    const { flow } = synthesizeQuickChatFlow(
      { conversationId: 'c', modelId: 'model-1', servers: [{ name: 'github' }] },
      context
    );
    const control = flow!.edges.filter((e) => (e.data as any)?.edgeType === 'standard');
    const mcp = flow!.edges.filter((e) => (e.data as any)?.edgeType === 'mcp');
    expect(control).toHaveLength(2);
    expect(mcp).toHaveLength(1);
  });
});
