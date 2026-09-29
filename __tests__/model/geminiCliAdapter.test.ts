import type { CompletionInput, ModelSteering, SdkRequestSnapshot } from '@/backend/services/model/adapters/types';
import type { BridgeTool } from '@/backend/services/model/adapters/codexToolBridge';
import type { GeminiCliEvent } from '@/backend/services/model/adapters/geminiCliEvents';
import { FlowExecutionAuthorityError } from '@/backend/execution/flow/executionAuthority';

const mockRun = jest.fn();
jest.mock('@/backend/services/model/adapters/geminiCliProcess', () => ({
  ...jest.requireActual('@/backend/services/model/adapters/geminiCliProcess'),
  runGeminiCli: (...args: unknown[]) => mockRun(...args),
  geminiCliAbortError: () => Object.assign(new Error('cancelled'), { name: 'AbortError' }),
}));
const mockCleanup = jest.fn(async () => {});
const mockPrepare = jest.fn(async (_options: unknown) => ({ home: 'private', workingDirectory: 'neutral', env: {}, cleanup: mockCleanup }));
jest.mock('@/backend/services/model/adapters/geminiCliRuntime', () => ({ prepareGeminiCliRuntime: (options: unknown) => mockPrepare(options) }));
const mockClose = jest.fn(async () => {});
let mockTools: BridgeTool[] = [];
jest.mock('@/backend/services/model/adapters/codexToolBridge', () => ({
  startCodexToolBridge: jest.fn(async (tools: BridgeTool[]) => { mockTools = tools; return { url: 'http://127.0.0.1/mcp/private', close: mockClose }; }),
}));
const mockCallTool = jest.fn();
jest.mock('@/backend/services/mcp', () => ({ mcpService: { callTool: (...args: unknown[]) => mockCallTool(...args) } }));
jest.mock('@/backend/mcpApps/toolUi', () => ({ resolveInvokedToolUiLink: async () => undefined, toolCancellationReason: () => undefined }));
jest.mock('@/backend/services/runResources', () => ({ getRunResourceSettings: async () => ({}) }));
const mockBound = jest.fn(async ({ content }: { content: string }) => ({ spilled: false, content }));
jest.mock('@/backend/services/runResources/boundToolResult', () => ({ boundToolResult: (...args: unknown[]) => mockBound(...args as [{ content: string }]) }));
jest.mock('@/backend/services/statistics', () => ({ classifyStatisticsError: () => 'tool', createStatisticsEvent: (event: unknown) => event, recordStatisticsEvent: () => {} }));

import { GeminiCliAdapter } from '@/backend/services/model/adapters/geminiCliAdapter';
type RunOptions = { onEvent(event: GeminiCliEvent): void; onStarted(): Promise<void>; signal: AbortSignal; prompt: string };
const fnTool = (name: string) => ({ type: 'function' as const, function: { name, parameters: { type: 'object', properties: {} } } });
const input = (overrides: Partial<CompletionInput> = {}): CompletionInput => ({
  model: { id: 'gemini', name: 'flash', ApiKey: '', provider: 'gemini-cli', adapter: 'gemini-cli' },
  apiKey: '', messages: [{ role: 'user', content: 'hello' }], ...overrides,
});
const finish = (options: RunOptions) => {
  options.onEvent({ type: 'message', role: 'assistant', content: 'Hello', delta: true });
  options.onEvent({ type: 'message', role: 'assistant', content: ' world', delta: true });
  options.onEvent({ type: 'result', status: 'success', stats: { input_tokens: 100, output_tokens: 10, total_tokens: 110, cached: 80 } });
};
beforeEach(() => {
  jest.clearAllMocks();
  mockTools = [];
  mockRun.mockReset().mockImplementation(async (options: RunOptions) => { await options.onStarted(); finish(options); });
  mockCallTool.mockReset().mockResolvedValue({ success: true, data: { content: [{ type: 'text', text: 'tool output' }] } });
  mockBound.mockReset().mockImplementation(async ({ content }: { content: string }) => ({ spilled: false, content }));
});

test('streams stable invocation-unique IDs, records once, archives exact stdin and maps usage', async () => {
  const deltas = jest.fn();
  const observed = jest.fn(async (_snapshot: SdkRequestSnapshot) => 'dispatch');
  const finalized = jest.fn(async () => {});
  const first = await new GeminiCliAdapter().createCompletion(input({ onModelDelta: deltas, onSdkRequest: observed, onSdkRequestResult: finalized, messages: [{ role: 'system', content: 'system' }, { role: 'user', content: 'hello' }] }));
  const second = await new GeminiCliAdapter().createCompletion(input());
  expect(first.transcript).toHaveLength(1);
  expect(first.transcript![0].content).toBe('Hello world');
  expect(first.liveMessageId).toBe(first.transcript![0].id);
  expect(deltas.mock.calls.map(call => call[0].messageId)).toEqual([first.liveMessageId, first.liveMessageId]);
  expect(first.liveMessageId).not.toBe(second.liveMessageId);
  expect(first.contextUsage).toBeNull();
  expect(first.completion.usage).toMatchObject({ prompt_tokens: 100, completion_tokens: 10, total_tokens: 110, prompt_tokens_details: { cached_tokens: 80 } });
  expect((observed.mock.calls[0][0].request as { prompt: string }).prompt).toContain('<system_instructions>\nsystem');
  expect(finalized).toHaveBeenCalledWith({ dispatchId: 'dispatch', outcome: 'completed' });
  expect(mockCleanup).toHaveBeenCalledTimes(2);
});

test('approved bound MCP tools apply hidden presets, fences, timeout and owner/progress context', async () => {
  const before = jest.fn(async () => {});
  const after = jest.fn(async () => {});
  const authorize = jest.fn(async () => {});
  const approve = jest.fn(async () => true);
  const progress = jest.fn();
  mockRun.mockImplementation(async (options: RunOptions) => {
    await options.onStarted();
    options.onEvent({ type: 'tool_use', tool_name: 'mcp_flujo_server__read', tool_id: 'foreign-cli-id', parameters: { root: 'attempt' } });
    await mockTools[0].handler({ root: 'attempt' });
    finish(options);
  });
  const result = await new GeminiCliAdapter().createCompletion(input({
    tools: [fnTool('hashed'), fnTool('unknown')],
    toolNameMap: { hashed: { server: 'server', tool: 'read', timeout: 9, nodeId: 'tool-node', presetArgs: { root: 'trusted' } } },
    beforeToolDispatch: before, afterToolDispatch: after, authorizePersonaCoreMcp: authorize,
    requestToolApproval: approve, onToolProgress: progress, runId: 'run', conversationId: 'conversation', nodeId: 'node',
  }));
  expect(mockTools.map(tool => tool.name)).toEqual(['server__read']);
  expect(mockCallTool).toHaveBeenCalledWith('server', 'read', { root: 'trusted' }, 9, expect.any(Function), 'tool-node', expect.any(AbortSignal), 'model', 'run:run', { conversationId: 'conversation' });
  expect(before).toHaveBeenCalledTimes(1);
  expect(after).toHaveBeenCalledTimes(1);
  expect(authorize).toHaveBeenCalledWith('server', 'tool-node');
  expect(result.transcript?.map(message => message.role)).toEqual(['assistant', 'tool', 'assistant']);
  expect(result.transcript![0].tool_calls![0].id).not.toBe('foreign-cli-id');
  const toolResult = result.transcript![1];
  expect(toolResult.role === 'tool' && toolResult.tool_call_id).toBe(result.transcript![0].tool_calls![0].id);
  expect(mockClose).toHaveBeenCalledTimes(1);
});

test('denied approval has no tool side effect and closes the pending tool card', async () => {
  const executor = jest.fn();
  mockRun.mockImplementation(async (options: RunOptions) => {
    await options.onStarted();
    expect(await mockTools[0].handler({})).toMatchObject({ isError: true });
    finish(options);
  });
  const result = await new GeminiCliAdapter().createCompletion(input({ tools: [fnTool('local')], localToolExecutors: { local: executor }, requestToolApproval: async () => false }));
  expect(executor).not.toHaveBeenCalled();
  expect(result.transcript![1]).toMatchObject({ role: 'tool', content: 'tool denied' });
});

test.each(['nonce', 42, false, null, ['nonce', 42]].map(value => [value]))('normalizes local JSON result %j for Gemini MCP without changing transcript', async value => {
  mockRun.mockImplementation(async (options: RunOptions) => {
    await options.onStarted();
    expect(await mockTools[0].handler({})).toMatchObject({
      content: [{ type: 'text', text: JSON.stringify(value) }],
      structuredContent: { result: value },
    });
    finish(options);
  });
  const result = await new GeminiCliAdapter().createCompletion(input({ tools: [fnTool('local')], localToolExecutors: { local: async () => value } }));
  expect(result.transcript![1]).toMatchObject({ role: 'tool', content: JSON.stringify(value) });
});

test('MCP JSON primitive normalization preserves media and existing structured records', async () => {
  const image = { type: 'image' as const, data: 'aGVsbG8=', mimeType: 'image/png' };
  const content = [{ type: 'text' as const, text: 'null' }, image];
  const structuredContent = { receipt: 'existing' };
  mockCallTool.mockResolvedValueOnce({ success: true, data: { content } });
  mockCallTool.mockResolvedValueOnce({ success: true, data: { content, structuredContent } });
  mockRun.mockImplementation(async (options: RunOptions) => {
    await options.onStarted();
    const normalized = await mockTools[0].handler({});
    expect(normalized.content).toBe(content);
    expect(normalized.structuredContent).toEqual({ result: null });
    const existing = await mockTools[0].handler({});
    expect(existing.content).toBe(content);
    expect(existing.structuredContent).toBe(structuredContent);
    finish(options);
  });
  await new GeminiCliAdapter().createCompletion(input({ tools: [fnTool('bound')], toolNameMap: { bound: { server: 'server', tool: 'read' } } }));
});

test('bounds oversized tool text while forwarding media unchanged and preserving progress', async () => {
  const image = { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' };
  const progress = jest.fn();
  mockBound.mockResolvedValue({ spilled: true, content: 'flujo://run/resource' });
  mockCallTool.mockImplementation(async (_server, _tool, _args, _timeout, report) => {
    report({ progress: 1, total: 2, message: 'working' });
    return { success: true, data: { content: [{ type: 'text', text: 'oversized'.repeat(1000) }, image], structuredContent: { original: 'oversized'.repeat(1000) } } };
  });
  mockRun.mockImplementation(async (options: RunOptions) => {
    await options.onStarted();
    const result = await mockTools[0].handler({});
    expect(result.content).toEqual([image, { type: 'text', text: 'flujo://run/resource' }]);
    expect(result).not.toHaveProperty('structuredContent');
    finish(options);
  });
  const result = await new GeminiCliAdapter().createCompletion(input({ tools: [fnTool('bound')], toolNameMap: { bound: { server: 'server', tool: 'read' } }, conversationId: 'conversation', onToolProgress: progress }));
  expect(progress).toHaveBeenCalledWith(expect.objectContaining({ name: 'server__read', progress: 1, total: 2 }));
  expect(result.transcript![1].content).toBe('flujo://run/resource');
});

test('MCP exposure avoids collisions with caller-defined virtual names', async () => {
  await new GeminiCliAdapter().createCompletion(input({ tools: [fnTool('server__read'), fnTool('bound')], localToolExecutors: { server__read: async () => 'local' }, toolNameMap: { bound: { server: 'server', tool: 'read' } } }));
  expect(mockTools.map(tool => tool.name)).toEqual(['server__read', 'server__read_2']);
});

test('lost authority in a tool handler aborts the model run and escapes the bridge error conversion', async () => {
  const error = new FlowExecutionAuthorityError('authority lost');
  mockRun.mockImplementation(async (options: RunOptions) => {
    await options.onStarted();
    await expect(mockTools[0].handler({})).rejects.toBe(error);
    expect(options.signal.aborted).toBe(true);
    finish(options);
  });
  await expect(new GeminiCliAdapter().createCompletion(input({ tools: [fnTool('local')], localToolExecutors: { local: async () => 'no' }, beforeToolDispatch: async () => { throw error; } }))).rejects.toBe(error);
  expect(mockCleanup).toHaveBeenCalledTimes(1);
  expect(mockClose).toHaveBeenCalledTimes(1);
});

test('plain handoff stops cleanly and returns routing calls', async () => {
  mockRun.mockImplementation(async (options: RunOptions) => {
    await options.onStarted();
    await mockTools[0].handler({ task: 'route' });
    expect(options.signal.aborted).toBe(true);
    throw Object.assign(new Error('cancelled'), { name: 'AbortError' });
  });
  const result = await new GeminiCliAdapter().createCompletion(input({ tools: [fnTool('handoff_to_next')] }));
  expect(result.completion.choices[0].finish_reason).toBe('tool_calls');
  expect(result.completion.choices[0].message.tool_calls![0]).toMatchObject({ function: { name: 'handoff_to_next', arguments: '{"task":"route"}' } });
});

test('external cancellation stops the active child and always cleans resources', async () => {
  const controller = new AbortController();
  mockRun.mockImplementation(async (options: RunOptions) => {
    await options.onStarted();
    const cancelled = new Promise<void>((_, reject) => options.signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { name: 'AbortError' })), { once: true }));
    controller.abort();
    return cancelled;
  });
  await expect(new GeminiCliAdapter().createCompletion(input({ signal: controller.signal }))).rejects.toMatchObject({ name: 'AbortError' });
  expect(mockCleanup).toHaveBeenCalledTimes(1);
});

test.each(['missing', 'error'])('rejects %s final result instead of returning successful empty output', async mode => {
  mockRun.mockImplementation(async (options: RunOptions) => {
    await options.onStarted();
    if (mode === 'error') options.onEvent({ type: 'result', status: 'error' });
  });
  await expect(new GeminiCliAdapter().createCompletion(input())).rejects.toThrow(/failed to complete/);
  expect(mockCleanup).toHaveBeenCalledTimes(1);
});

test('steering interrupts the current child, replays settled history and acknowledges once', async () => {
  let notify: (() => void) | undefined;
  let deliveryTaken = false;
  const acknowledge = jest.fn(async () => {});
  const beforeSend = jest.fn(async () => {});
  const requeue = jest.fn();
  const source: ModelSteering = {
    take: async () => { if (deliveryTaken) return undefined; deliveryTaken = true; return { messages: [{ id: 'steering', role: 'user', content: 'change course', timestamp: 1 }], acknowledge, beforeSend, requeue }; },
    subscribe: listener => { notify = listener; return () => {}; },
  };
  mockRun.mockImplementationOnce(async (options: RunOptions) => {
    await options.onStarted();
    options.onEvent({ type: 'message', role: 'assistant', content: 'First attempt', delta: true });
    const cancelled = new Promise<void>((_, reject) => options.signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { name: 'AbortError' })), { once: true }));
    notify!();
    return cancelled;
  });
  const result = await new GeminiCliAdapter().createCompletion(input({ steering: source }));
  expect(mockRun).toHaveBeenCalledTimes(2);
  expect(mockRun.mock.calls[1][0].prompt).toContain('First attempt');
  expect(mockRun.mock.calls[1][0].prompt).toContain('change course');
  expect(acknowledge).toHaveBeenCalledTimes(1);
  expect(requeue).not.toHaveBeenCalled();
  expect(result.transcript?.map(message => message.content)).toEqual(['First attempt', 'change course', 'Hello world']);
});

test('unsupported attachments fail explicitly before opening a runtime', async () => {
  await expect(new GeminiCliAdapter().createCompletion(input({ messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,YQ==' } }] }] }))).rejects.toThrow(/text input only/);
  expect(mockPrepare).not.toHaveBeenCalled();
});
