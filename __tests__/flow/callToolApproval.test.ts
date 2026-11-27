/**
 * #1448: `call_tool` runs a found tool for adapters that own their tool loop
 * (Claude subscription, Codex, Antigravity). The approval gate lets the
 * wrapper through and asks once, for the real tool with its real arguments.
 */
const approvalCards: Array<{ name: string; args: Record<string, unknown> }> = [];
let approvalAnswer = true;
jest.mock('@/backend/execution/flow/toolApprovalRegistry', () => ({
  registerPendingApproval: (
    _conversationId: string,
    toolCall: { function: { name: string; arguments: string } },
    resolve: (approved: boolean) => void,
  ) => {
    approvalCards.push({ name: toolCall.function.name, args: JSON.parse(toolCall.function.arguments) });
    queueMicrotask(() => resolve(approvalAnswer));
  },
  withdrawPendingApproval: () => true,
  listPendingToolCalls: () => [],
}));

import { createLiveToolApproval } from '@/backend/execution/flow/toolApprovalGate';
import { executeToolLoadingTool, type ToolLoadingContext } from '@/backend/execution/flow/toolLoading/toolLoadingExecutors';
import { resolveStepToolName, scriptValueOf } from '@/backend/execution/flow/toolLoading/stepToolInvoker';
import type { StepToolService } from '@/backend/execution/flow/toolLoading/stepToolInvoker';

const toolNameMap = {
  mcp_create_issue_1: { server: 'github', tool: 'create_issue', presetArgs: { owner: 'flujo' } },
  mcp_search_2: { server: 'github', tool: 'search' },
  mcp_search_3: { server: 'docs', tool: 'search' },
};

function context(overrides: Partial<ToolLoadingContext> = {}) {
  const callTool = jest.fn<ReturnType<StepToolService['callTool']>, Parameters<StepToolService['callTool']>>(
    async () => ({ success: true, data: { content: [{ type: 'text', text: '{"number":12}' }] } }),
  );
  const loaded: string[] = [];
  const service: StepToolService = {
    callTool,
    getClient: () => ({}),
    getClientGeneration: () => 0,
    getToolSchemaHash: () => undefined,
  };
  const value: ToolLoadingContext = {
    catalog: {
      tools: Object.entries(toolNameMap).map(([name, entry]) => ({ name, server: entry.server, originalName: entry.tool, inputSchema: {} })),
      deferring: true,
      callThrough: true,
      codeMode: false,
    },
    toolNameMap,
    service,
    markToolsLoaded: (names) => loaded.push(...names),
    approve: createLiveToolApproval({ conversationId: 'conversation', requireApproval: true }),
    ...overrides,
  };
  return { value, callTool, loaded };
}

beforeEach(() => {
  approvalCards.length = 0;
  approvalAnswer = true;
});

describe('the approval gate and call_tool', () => {
  it('lets call_tool itself through without a card', async () => {
    const approve = createLiveToolApproval({ conversationId: 'conversation', requireApproval: true })!;
    await expect(approve({ id: 'a', name: 'call_tool', args: { name: 'x' } })).resolves.toBe(true);
    expect(approvalCards).toEqual([]);
    await expect(approve({ id: 'b', name: 'mcp_create_issue_1', args: {} })).resolves.toBe(true);
    expect(approvalCards.map((card) => card.name)).toEqual(['mcp_create_issue_1']);
  });

  it('asks once for the real tool and arguments, then runs it with its preset arguments', async () => {
    const { value, callTool, loaded } = context();
    const outcome = await executeToolLoadingTool('call_tool', { name: 'mcp_create_issue_1', arguments: { title: 'Bug' } }, value);

    expect(approvalCards).toEqual([{ name: 'mcp_create_issue_1', args: { title: 'Bug' } }]);
    expect(outcome.success).toBe(true);
    expect(JSON.parse(outcome.content)).toEqual({ content: [{ type: 'text', text: '{"number":12}' }] });
    expect(callTool.mock.calls[0].slice(0, 3)).toEqual(['github', 'create_issue', { title: 'Bug', owner: 'flujo' }]);
    expect(loaded).toEqual(['mcp_create_issue_1']);
  });

  it('does not run a tool the person rejects', async () => {
    approvalAnswer = false;
    const { value, callTool } = context();
    const outcome = await executeToolLoadingTool('call_tool', { name: 'mcp_create_issue_1', arguments: {} }, value);
    expect(outcome.success).toBe(false);
    expect(outcome.content).toMatch(/did not approve/);
    expect(callTool).not.toHaveBeenCalled();
  });

  it('refuses a tool outside the step', async () => {
    const { value, callTool } = context();
    const outcome = await executeToolLoadingTool('call_tool', { name: 'mcp_delete_everything_9' }, value);
    expect(outcome.content).toMatch(/not available in this step/);
    expect(approvalCards).toEqual([]);
    expect(callTool).not.toHaveBeenCalled();
  });

  it('runs without asking when the run needs no approval', async () => {
    const { value, callTool } = context({ approve: createLiveToolApproval({ requireApproval: false }) });
    const outcome = await executeToolLoadingTool('call_tool', { name: 'create_issue', arguments: {} }, value);
    expect(outcome.success).toBe(true);
    expect(approvalCards).toEqual([]);
    expect(callTool).toHaveBeenCalledTimes(1);
  });
});

describe('step tool names and values', () => {
  const allowed = new Set(Object.keys(toolNameMap));

  it('accepts an MCP tool name only when one server has it', () => {
    expect(resolveStepToolName('create_issue', toolNameMap, allowed)).toEqual({ name: 'mcp_create_issue_1' });
    expect(resolveStepToolName('search', toolNameMap, allowed)).toEqual({ error: expect.stringContaining('mcp_search_2, mcp_search_3') });
    expect(resolveStepToolName('mcp_search_3', toolNameMap, allowed)).toEqual({ name: 'mcp_search_3' });
  });

  it('gives a program structured results, parsed JSON text, plain text, or parts without binary data', () => {
    expect(scriptValueOf({ content: [], structuredContent: { a: 1 } })).toEqual({ a: 1 });
    expect(scriptValueOf({ content: [{ type: 'text', text: '[1,2]' }] })).toEqual([1, 2]);
    expect(scriptValueOf({ content: [{ type: 'text', text: 'hello' }, { type: 'text', text: 'world' }] })).toBe('hello\nworld');
    expect(scriptValueOf({ content: [{ type: 'text', text: '{not json' }] })).toBe('{not json');
    expect(scriptValueOf({ content: [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }] }))
      .toEqual([{ type: 'image', mimeType: 'image/png', note: 'binary content left out of the program' }]);
  });
});
