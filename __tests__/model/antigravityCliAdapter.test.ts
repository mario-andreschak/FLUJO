import type { CompletionInput, ModelSteering, SdkRequestSnapshot } from '@/backend/services/model/adapters/types';
import type { BridgeTool } from '@/backend/services/model/adapters/codexToolBridge';
import type { AntigravityCliEvent } from '@/backend/services/model/adapters/antigravityCliEvents';
import { FlowExecutionAuthorityError } from '@/backend/execution/flow/executionAuthority';
import { ExecutionExtensionError, registerExecutionExtension } from '@/backend/execution/extensions';
import { fixtureAdapter, mintFixture } from '../executionExtensions/fixtureAdapter';

const mockRun = jest.fn();
jest.mock('@/backend/services/model/adapters/antigravityCliProcess', () => ({
  ...jest.requireActual('@/backend/services/model/adapters/antigravityCliProcess'),
  runAntigravityCli: (...args: unknown[]) => mockRun(...args),
  antigravityCliAbortError: () => Object.assign(new Error('cancelled'), { name: 'AbortError' }),
}));
const mockCleanup = jest.fn(async () => {});
const mockPrepare = jest.fn(async (_options: unknown) => ({ home: 'private', workingDirectory: 'neutral', env: {}, cleanup: mockCleanup }));
jest.mock('@/backend/services/model/adapters/antigravityCliRuntime', () => ({ ANTIGRAVITY_CLI_TIMEOUT_MS: 300000, prepareAntigravityCliRuntime: (options: unknown) => mockPrepare(options) }));
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

import { AntigravityCliAdapter } from '@/backend/services/model/adapters/antigravityCliAdapter';
type RunOptions = { onEvent(event: AntigravityCliEvent): void; onStarted(): Promise<void>; signal: AbortSignal; prompt: string };
const fnTool = (name: string) => ({ type: 'function' as const, function: { name, parameters: { type: 'object', properties: {} } } });
const input = (overrides: Partial<CompletionInput> = {}): CompletionInput => ({
  model: { id: 'antigravity', name: 'default', ApiKey: '', provider: 'antigravity-cli', adapter: 'antigravity-cli' },
  apiKey: '', messages: [{ role: 'user', content: 'hello' }], ...overrides,
});
let mockSession = 0;
const sessions = new WeakMap<RunOptions, string>();
const start = async (options: RunOptions) => {
  await options.onStarted();
  const id = 'session_' + ++mockSession; sessions.set(options, id);
  options.onEvent({ event: 'init', conversation_id: id, init: { cwd: 'neutral', tools: [], permission_mode: 'request-review', agent: 'flujo' } });
};
const text = (options: RunOptions, content: string) => options.onEvent({ event: 'step_update', step_update: { conversation_id: sessions.get(options)!, step_index: 1, state: 'ACTIVE', step_type: 'agent_response', text_delta: content } });
const finish = (options: RunOptions) => {
  text(options, 'Hello'); text(options, ' world');
  options.onEvent({ event: 'result', result: { conversation_id: sessions.get(options)!, status: 'SUCCESS', response: 'Hello world', usage: { input_tokens: 20, output_tokens: 10, thinking_tokens: 4, cache_read_tokens: 80, total_tokens: 30 } } });
};
beforeEach(() => {
  jest.clearAllMocks();
  mockTools = [];
  mockRun.mockReset().mockImplementation(async (options: RunOptions) => { await start(options); finish(options); });
  mockCallTool.mockReset().mockResolvedValue({ success: true, data: { content: [{ type: 'text', text: 'tool output' }] } });
  mockBound.mockReset().mockImplementation(async ({ content }: { content: string }) => ({ spilled: false, content }));
});

test.each(['', 'configured-key'])('rejects direct trusted execution before CLI or tool setup with key %s', async apiKey => {
  const adapter = fixtureAdapter();
  const restore = registerExecutionExtension(adapter);
  const observed = jest.fn();
  const executor = jest.fn();
  try {
    const request = input({ apiKey, executionExtensionContext: mintFixture(adapter),
      onSdkRequest: observed, tools: [fnTool('local')], localToolExecutors: { local: executor } });
    const error = await new AntigravityCliAdapter().createCompletion(request).catch(failure => failure);
    expect(error).toBeInstanceOf(ExecutionExtensionError);
    expect(error).toMatchObject({ code: 'execution_model_adapter_forbidden', status: 403 });
    expect(mockPrepare).not.toHaveBeenCalled();
    expect(mockRun).not.toHaveBeenCalled();
    expect(mockTools).toEqual([]);
    expect(mockCallTool).not.toHaveBeenCalled();
    expect(executor).not.toHaveBeenCalled();
    expect(observed).not.toHaveBeenCalled();
  } finally { restore(); }
});

test('streams stable invocation-unique IDs, records once, archives exact stdin and maps usage', async () => {
  const deltas = jest.fn();
  const observed = jest.fn(async (_snapshot: SdkRequestSnapshot) => 'dispatch');
  const finalized = jest.fn(async () => {});
  const first = await new AntigravityCliAdapter().createCompletion(input({ onModelDelta: deltas, onSdkRequest: observed, onSdkRequestResult: finalized, messages: [{ role: 'system', content: 'system' }, { role: 'user', content: 'hello' }] }));
  const second = await new AntigravityCliAdapter().createCompletion(input());
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
    await start(options);
    options.onEvent({ event: 'step_update', step_update: { conversation_id: sessions.get(options)!, step_index: 2, state: 'ACTIVE', step_type: 'tool', tool_name: 'call_mcp_tool', tool_info: { parameters: { ServerName: 'flujo', ToolName: 'server__read', Arguments: { root: 'attempt' } } } } });
    await mockTools[0].handler({ root: 'attempt' });
    finish(options);
  });
  const result = await new AntigravityCliAdapter().createCompletion(input({
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
    await start(options);
    expect(await mockTools[0].handler({})).toMatchObject({ isError: true });
    finish(options);
  });
  const result = await new AntigravityCliAdapter().createCompletion(input({ tools: [fnTool('local')], localToolExecutors: { local: executor }, requestToolApproval: async () => false }));
  expect(executor).not.toHaveBeenCalled();
  expect(result.transcript![1]).toMatchObject({ role: 'tool', content: 'tool denied' });
});

test.each(['nonce', 42, false, null, ['nonce', 42]].map(value => [value]))('normalizes local JSON result %j for Gemini MCP without changing transcript', async value => {
  mockRun.mockImplementation(async (options: RunOptions) => {
    await start(options);
    expect(await mockTools[0].handler({})).toMatchObject({
      content: [{ type: 'text', text: JSON.stringify(value) }],
      structuredContent: { result: value },
    });
    finish(options);
  });
  const result = await new AntigravityCliAdapter().createCompletion(input({ tools: [fnTool('local')], localToolExecutors: { local: async () => value } }));
  expect(result.transcript![1]).toMatchObject({ role: 'tool', content: JSON.stringify(value) });
});

test('MCP JSON primitive normalization preserves media and existing structured records', async () => {
  const image = { type: 'image' as const, data: 'aGVsbG8=', mimeType: 'image/png' };
  const content = [{ type: 'text' as const, text: 'null' }, image];
  const structuredContent = { receipt: 'existing' };
  mockCallTool.mockResolvedValueOnce({ success: true, data: { content } });
  mockCallTool.mockResolvedValueOnce({ success: true, data: { content, structuredContent } });
  mockRun.mockImplementation(async (options: RunOptions) => {
    await start(options);
    const normalized = await mockTools[0].handler({});
    expect(normalized.content).toBe(content);
    expect(normalized.structuredContent).toEqual({ result: null });
    const existing = await mockTools[0].handler({});
    expect(existing.content).toBe(content);
    expect(existing.structuredContent).toBe(structuredContent);
    finish(options);
  });
  await new AntigravityCliAdapter().createCompletion(input({ tools: [fnTool('bound')], toolNameMap: { bound: { server: 'server', tool: 'read' } } }));
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
    await start(options);
    const result = await mockTools[0].handler({});
    expect(result.content).toEqual([image, { type: 'text', text: 'flujo://run/resource' }]);
    expect(result).not.toHaveProperty('structuredContent');
    finish(options);
  });
  const result = await new AntigravityCliAdapter().createCompletion(input({ tools: [fnTool('bound')], toolNameMap: { bound: { server: 'server', tool: 'read' } }, conversationId: 'conversation', onToolProgress: progress }));
  expect(progress).toHaveBeenCalledWith(expect.objectContaining({ name: 'server__read', progress: 1, total: 2 }));
  expect(result.transcript![1].content).toBe('flujo://run/resource');
});

test('MCP exposure avoids collisions with caller-defined virtual names', async () => {
  await new AntigravityCliAdapter().createCompletion(input({ tools: [fnTool('server__read'), fnTool('bound')], localToolExecutors: { server__read: async () => 'local' }, toolNameMap: { bound: { server: 'server', tool: 'read' } } }));
  expect(mockTools.map(tool => tool.name)).toEqual(['server__read', 'server__read_2']);
});

test('lost authority in a tool handler aborts the model run and escapes the bridge error conversion', async () => {
  const error = new FlowExecutionAuthorityError('authority lost');
  mockRun.mockImplementation(async (options: RunOptions) => {
    await start(options);
    await expect(mockTools[0].handler({})).rejects.toBe(error);
    expect(options.signal.aborted).toBe(true);
    finish(options);
  });
  await expect(new AntigravityCliAdapter().createCompletion(input({ tools: [fnTool('local')], localToolExecutors: { local: async () => 'no' }, beforeToolDispatch: async () => { throw error; } }))).rejects.toBe(error);
  expect(mockCleanup).toHaveBeenCalledTimes(1);
  expect(mockClose).toHaveBeenCalledTimes(1);
});

test('plain handoff preserves terminal answer and usage while closing later tool dispatch', async () => {
  const executor = jest.fn();
  const delta = jest.fn();
  mockRun.mockImplementation(async (options: RunOptions) => {
    await start(options);
    await mockTools[0].handler({ task: 'route' });
    expect(options.signal.aborted).toBe(false);
    expect(await mockTools[1].handler({})).toMatchObject({ isError: true,
      content: [{ type: 'text', text: expect.stringContaining('turn has ended') }] });
    text(options, 'Final receipt');
    options.onEvent({ event: 'result', result: { conversation_id: sessions.get(options)!, status: 'SUCCESS', response: 'Final receipt',
      usage: { input_tokens: 20, cache_read_tokens: 5, output_tokens: 7, thinking_tokens: 2 } } });
  });
  const result = await new AntigravityCliAdapter().createCompletion(input({ tools: [fnTool('handoff_to_next'), fnTool('local')],
    localToolExecutors: { local: executor }, onModelDelta: delta }));
  expect(result.completion.choices[0].finish_reason).toBe('tool_calls');
  expect(result.completion.choices[0].message.content).toBe('Final receipt');
  expect(result.completion.choices[0].message.tool_calls![0]).toMatchObject({ function: { name: 'handoff_to_next', arguments: '{"task":"route"}' } });
  expect(result.completion.usage).toMatchObject({ prompt_tokens: 25, completion_tokens: 7, total_tokens: 32,
    completion_tokens_details: { reasoning_tokens: 2 } });
  expect(result.transcript?.filter(message => message.role === 'assistant' && message.content === 'Final receipt')).toHaveLength(1);
  expect(delta).toHaveBeenCalledWith({ messageId: result.liveMessageId, contentDelta: 'Final receipt' });
  expect(executor).not.toHaveBeenCalled();
  expect(mockCleanup).toHaveBeenCalledTimes(1);
});

test('plain handoff finalization still aborts immediately on external cancellation', async () => {
  const controller = new AbortController();
  const delta = jest.fn();
  mockRun.mockImplementation(async (options: RunOptions) => {
    await start(options);
    await mockTools[0].handler({});
    expect(options.signal.aborted).toBe(false);
    controller.abort();
    expect(options.signal.aborted).toBe(true);
    throw Object.assign(new Error('cancelled'), { name: 'AbortError' });
  });
  await expect(new AntigravityCliAdapter().createCompletion(input({ tools: [fnTool('handoff_to_next')],
    signal: controller.signal, onModelDelta: delta }))).rejects.toMatchObject({ name: 'AbortError' });
  expect(delta).not.toHaveBeenCalled();
  expect(mockCleanup).toHaveBeenCalledTimes(1);
  expect(mockClose).toHaveBeenCalledTimes(1);
});

test('plain handoff with a lost execution fence cannot enter finalization', async () => {
  const error = new FlowExecutionAuthorityError('lease replaced');
  const delta = jest.fn();
  mockRun.mockImplementation(async (options: RunOptions) => {
    await start(options);
    await expect(mockTools[0].handler({})).rejects.toBe(error);
    expect(options.signal.aborted).toBe(true);
  });
  await expect(new AntigravityCliAdapter().createCompletion(input({ tools: [fnTool('handoff_to_next')],
    beforeToolDispatch: async () => { throw error; }, onModelDelta: delta }))).rejects.toBe(error);
  expect(delta).not.toHaveBeenCalled();
  expect(mockCleanup).toHaveBeenCalledTimes(1);
  expect(mockClose).toHaveBeenCalledTimes(1);
});

test.each(['missing', 'error', 'identity', 'deadline'])('plain handoff finalization rejects %s native completion', async mode => {
  mockRun.mockImplementation(async (options: RunOptions) => {
    await start(options);
    await mockTools[0].handler({});
    if (mode === 'deadline') throw new Error('execution deadline exceeded');
    if (mode !== 'missing') options.onEvent({ event: 'result', result: {
      conversation_id: mode === 'identity' ? 'unexpected' : sessions.get(options)!,
      status: mode === 'error' ? 'ERROR' : 'SUCCESS', response: '',
    } });
  });
  await expect(new AntigravityCliAdapter().createCompletion(input({ tools: [fnTool('handoff_to_next')] })))
    .rejects.toThrow(mode === 'deadline' ? /deadline/ : mode === 'identity' ? /identity/ : /failed to complete/);
  expect(mockCleanup).toHaveBeenCalledTimes(1);
  expect(mockClose).toHaveBeenCalledTimes(1);
});

test('plain handoff finalization honors an explicit caller stop before terminal text', async () => {
  let ended = false;
  const delta = jest.fn();
  mockRun.mockImplementation(async (options: RunOptions) => {
    await start(options);
    await mockTools[0].handler({});
    expect(options.signal.aborted).toBe(false);
    ended = true;
    text(options, 'Suppressed terminal text');
    expect(options.signal.aborted).toBe(true);
    throw Object.assign(new Error('cancelled'), { name: 'AbortError' });
  });
  const result = await new AntigravityCliAdapter().createCompletion(input({ tools: [fnTool('handoff_to_next')],
    shouldEndAgenticTurn: () => ended, onModelDelta: delta }));
  expect(result.completion.choices[0].finish_reason).toBe('tool_calls');
  expect(result.completion.choices[0].message.content).toBeNull();
  expect(delta).not.toHaveBeenCalled();
});

test('parallel spawn handoffs still stop before post-spawn narration', async () => {
  const delta = jest.fn();
  const tool = fnTool('handoff_to_worker');
  tool.function.parameters.properties = { task: { type: 'string' } };
  mockRun.mockImplementation(async (options: RunOptions) => {
    await start(options);
    await mockTools[0].handler({ task: 'one' });
    await mockTools[0].handler({ task: 'two' });
    expect(options.signal.aborted).toBe(false);
    text(options, 'Post-spawn narration');
    expect(options.signal.aborted).toBe(true);
    throw Object.assign(new Error('cancelled'), { name: 'AbortError' });
  });
  const result = await new AntigravityCliAdapter().createCompletion(input({ tools: [tool], onModelDelta: delta }));
  expect(result.completion.choices[0].message.tool_calls).toHaveLength(2);
  expect(result.completion.choices[0].message.content).toBeNull();
  expect(delta).not.toHaveBeenCalled();
});

test('external cancellation stops the active child and always cleans resources', async () => {
  const controller = new AbortController();
  mockRun.mockImplementation(async (options: RunOptions) => {
    await start(options);
    const cancelled = new Promise<void>((_, reject) => options.signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { name: 'AbortError' })), { once: true }));
    controller.abort();
    return cancelled;
  });
  await expect(new AntigravityCliAdapter().createCompletion(input({ signal: controller.signal }))).rejects.toMatchObject({ name: 'AbortError' });
  expect(mockCleanup).toHaveBeenCalledTimes(1);
});

test.each(['missing', 'error'])('rejects %s final result instead of returning successful empty output', async mode => {
  mockRun.mockImplementation(async (options: RunOptions) => {
    await start(options);
    if (mode === 'error') options.onEvent({ event: 'result', result: { conversation_id: sessions.get(options)!, status: 'ERROR', response: '' } });
  });
  await expect(new AntigravityCliAdapter().createCompletion(input())).rejects.toThrow(/failed to complete/);
  expect(mockCleanup).toHaveBeenCalledTimes(1);
});

test.each(['', ' \n\t'])('rejects native SUCCESS with only %j text and no useful dispatch', async response => {
  mockRun.mockImplementation(async (options: RunOptions) => {
    await start(options);
    options.onEvent({ event: 'result', result: { conversation_id: sessions.get(options)!, status: 'SUCCESS', response, usage: {} } });
  });
  await expect(new AntigravityCliAdapter().createCompletion(input())).rejects.toThrow(/no assistant output or tool dispatch/);
  expect(mockCleanup).toHaveBeenCalledTimes(1);
});

test('native SUCCESS can preserve a legitimate tool-only transcript', async () => {
  const executor = jest.fn(async () => 'tool receipt');
  mockRun.mockImplementation(async (options: RunOptions) => {
    await start(options);
    await mockTools[0].handler({});
    options.onEvent({ event: 'result', result: { conversation_id: sessions.get(options)!, status: 'SUCCESS', response: '', usage: {} } });
  });
  const result = await new AntigravityCliAdapter().createCompletion(input({ tools: [fnTool('local')], localToolExecutors: { local: executor } }));
  expect(result.transcript?.map(message => message.role)).toEqual(['assistant', 'tool']);
  expect(executor).toHaveBeenCalledTimes(1);
  expect(result.completion.choices[0].message.content).toBeNull();
});

test('native SUCCESS can preserve an intentional handoff-only route', async () => {
  mockRun.mockImplementation(async (options: RunOptions) => {
    await start(options);
    await mockTools[0].handler({});
    options.onEvent({ event: 'result', result: { conversation_id: sessions.get(options)!, status: 'SUCCESS', response: '', usage: {} } });
  });
  const result = await new AntigravityCliAdapter().createCompletion(input({ tools: [fnTool('handoff_to_next')] }));
  expect(result.completion.choices[0].finish_reason).toBe('tool_calls');
  expect(result.completion.choices[0].message.tool_calls![0].function.name).toBe('handoff_to_next');
  expect(result.completion.choices[0].message.content).toBeNull();
});

test('tool dispatch budget ends the run before another executor side effect', async () => {
  const executor = jest.fn(async () => 'receipt');
  mockRun.mockImplementation(async (options: RunOptions) => {
    await start(options);
    await mockTools[0].handler({});
    await expect(mockTools[0].handler({})).rejects.toThrow(/dispatch budget/);
    expect(options.signal.aborted).toBe(true);
  });
  await expect(new AntigravityCliAdapter().createCompletion(input({ maxTurns: 1, tools: [fnTool('local')], localToolExecutors: { local: executor } }))).rejects.toThrow(/dispatch budget/);
  expect(executor).toHaveBeenCalledTimes(1); expect(mockCleanup).toHaveBeenCalledTimes(1);
});

test('native or foreign MCP steps cannot silently complete as successful provider calls', async () => {
  mockRun.mockImplementation(async (options: RunOptions) => {
    await start(options);
    options.onEvent({ event: 'step_update', step_update: { conversation_id: sessions.get(options)!, step_index: 2, state: 'ACTIVE', step_type: 'tool', tool_name: 'view_file' } });
  });
  await expect(new AntigravityCliAdapter().createCompletion(input())).rejects.toThrow(/unbound native tool/);
  expect(mockCleanup).toHaveBeenCalledTimes(1);
});

test('terminal text fallback records once and preserves aggregate usage without context claims', async () => {
  mockRun.mockImplementation(async (options: RunOptions) => {
    await start(options);
    options.onEvent({ event: 'result', result: { conversation_id: sessions.get(options)!, status: 'SUCCESS', response: 'Fallback', usage: { input_tokens: 5, cache_read_tokens: 7, output_tokens: 4, thinking_tokens: 3 } } });
  });
  const result = await new AntigravityCliAdapter().createCompletion(input());
  expect(result.transcript).toHaveLength(1); expect(result.transcript![0].content).toBe('Fallback');
  expect(result.completion.usage).toMatchObject({ prompt_tokens: 12, completion_tokens: 4, total_tokens: 16, completion_tokens_details: { reasoning_tokens: 3 } });
  expect(result.contextUsage).toBeNull();
});

test('step budget prevents unbounded model-only cycles and a changed conversation identity fails', async () => {
  mockRun.mockImplementation(async (options: RunOptions) => {
    await start(options);
    for (let step = 0; step < 25; step++) options.onEvent({ event: 'step_update', step_update: { conversation_id: sessions.get(options)!, step_index: step, state: 'DONE', step_type: 'checkpoint' } });
  });
  await expect(new AntigravityCliAdapter().createCompletion(input({ maxTurns: 1 }))).rejects.toThrow(/step budget/);
  mockRun.mockImplementation(async (options: RunOptions) => {
    await start(options);
    options.onEvent({ event: 'result', result: { conversation_id: 'foreign', status: 'SUCCESS', response: 'Foreign' } });
  });
  await expect(new AntigravityCliAdapter().createCompletion(input())).rejects.toThrow(/conversation identity/);
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
    await start(options);
    text(options, 'First attempt');
    const cancelled = new Promise<void>((_, reject) => options.signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { name: 'AbortError' })), { once: true }));
    notify!();
    return cancelled;
  });
  const result = await new AntigravityCliAdapter().createCompletion(input({ steering: source }));
  expect(mockRun).toHaveBeenCalledTimes(2);
  expect(mockRun.mock.calls[1][0].prompt).toContain('First attempt');
  expect(mockRun.mock.calls[1][0].prompt).toContain('change course');
  expect(acknowledge).toHaveBeenCalledTimes(1);
  expect(requeue).not.toHaveBeenCalled();
  expect(result.transcript?.map(message => message.content)).toEqual(['First attempt', 'change course', 'Hello world']);
});

test('unsupported attachments fail explicitly before opening a runtime', async () => {
  await expect(new AntigravityCliAdapter().createCompletion(input({ messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,YQ==' } }] }] }))).rejects.toThrow(/text input only/);
  expect(mockPrepare).not.toHaveBeenCalled();
});
