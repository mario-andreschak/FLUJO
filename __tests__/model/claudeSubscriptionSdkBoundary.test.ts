/**
 * The Claude subscription adapter at the Agent SDK boundary, driven with
 * recorded SDK frames and control callbacks instead of a Claude process.
 *
 *  - FLUJO's approval is the only gate: a tool handler that starts without a
 *    FLUJO decision (the SDK skipped canUseTool because of a permission mode,
 *    rule or saved consent) asks FLUJO itself before anything runs.
 *  - Frames Claude Code writes itself ("Prompt is too long", "Invalid API
 *    key", the output-token notice) are diagnostics, never the answer.
 */
import type OpenAI from 'openai';
import type { CompletionInput } from '@/backend/services/model/adapters/types';

const queryMock = jest.fn();

jest.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (...a: unknown[]) => queryMock(...(a as [])),
  createSdkMcpServer: (cfg: unknown) => ({ __server: cfg }),
  tool: (name: string, description: string, shape: unknown, handler: unknown) => ({ name, description, shape, handler }),
}));
jest.mock('@/backend/services/mcp', () => ({ mcpService: { callTool: jest.fn() } }));
jest.mock('@/backend/services/model/adapters/claudeRuntimeHome', () => ({
  prepareClaudeRuntimeEnvironment: jest.fn(async () => ({
    home: 'C:\\flujo\\db\\claude-runtime',
    workingDirectory: 'C:\\flujo\\db\\claude-runtime\\workspace',
    env: { PATH: 'C:\\Windows' },
  })),
}));

import { ClaudeSubscriptionAdapter } from '@/backend/services/model/adapters/claudeSubscriptionAdapter';

type SdkTool = { name: string; handler: (args: Record<string, unknown>) => Promise<{ isError?: boolean; content: Array<{ text?: string }> }> };
type SdkOptions = {
  hooks: { PreToolUse: Array<{ hooks: Array<(input: unknown, id: string, options: { signal: AbortSignal }) => Promise<unknown>> }> };
  canUseTool: (name: string, input: Record<string, unknown>, options: { toolUseID: string; signal: AbortSignal }) => Promise<{ behavior: string }>;
  mcpServers: { flujo: { __server: { tools: SdkTool[] } } };
  abortController: AbortController;
};

const baseInput = (overrides: Partial<CompletionInput> = {}): CompletionInput => ({
  model: { id: 'm1', name: 'sonnet', provider: 'claude-subscription' },
  apiKey: 'oauth-token',
  messages: [{ role: 'user', content: 'hello' }] as OpenAI.ChatCompletionMessageParam[],
  ...overrides,
} as CompletionInput);

const localTool = (name = 'local'): OpenAI.ChatCompletionFunctionTool[] => [{
  type: 'function', function: { name, parameters: { type: 'object', properties: {} } },
}];

const preToolUse = (options: SdkOptions, toolName: string, toolUseId: string) =>
  options.hooks.PreToolUse[0].hooks[0]({
    hook_event_name: 'PreToolUse', tool_name: `mcp__flujo__${toolName}`, tool_input: {}, tool_use_id: toolUseId,
  }, toolUseId, { signal: options.abortController.signal });

const handlerOf = (options: SdkOptions, name: string) =>
  options.mcpServers.flujo.__server.tools.find(tool => tool.name === name)!.handler;

const success = (result = 'done') => ({ type: 'result', subtype: 'success', session_id: 'boundary-session', result });

beforeEach(() => queryMock.mockReset());

describe('ClaudeSubscriptionAdapter — FLUJO approval is the only gate', () => {
  it.each([false, true])('asks FLUJO inside the handler when the SDK skips canUseTool (approved: %s)', async approved => {
    const execute = jest.fn(async () => 'ran');
    const approvals: string[] = [];
    let toolResult: Awaited<ReturnType<SdkTool['handler']>> | undefined;
    queryMock.mockImplementationOnce(({ options }: { options: SdkOptions }) => (async function* () {
      await preToolUse(options, 'local', 'skipped-call');
      // An SDK allow rule, auto mode or saved consent resolves the call
      // without asking canUseTool and starts the handler at once.
      toolResult = await handlerOf(options, 'local')({});
      yield success();
    })());
    const result = await new ClaudeSubscriptionAdapter().createCompletion(baseInput({
      tools: localTool(), localToolExecutors: { local: execute },
      requestToolApproval: async call => { approvals.push(call.id); return approved; },
    }));
    expect(approvals).toEqual(['skipped-call']);
    expect(execute).toHaveBeenCalledTimes(approved ? 1 : 0);
    expect(toolResult?.isError ?? false).toBe(!approved);
    const toolMessages = result.transcript?.filter(message => message.role === 'tool') ?? [];
    expect(toolMessages).toHaveLength(1);
    if (!approved) expect(toolMessages[0]).toMatchObject({ tool_call_id: 'skipped-call', content: 'tool denied' });
  });

  it('asks only once when canUseTool already decided', async () => {
    const execute = jest.fn(async () => 'ran');
    const approval = jest.fn(async () => true);
    queryMock.mockImplementationOnce(({ options }: { options: SdkOptions }) => (async function* () {
      await preToolUse(options, 'local', 'asked-call');
      const decision = await options.canUseTool('mcp__flujo__local', {}, { toolUseID: 'asked-call', signal: options.abortController.signal });
      expect(decision.behavior).toBe('allow');
      await handlerOf(options, 'local')({});
      yield success();
    })());
    await new ClaudeSubscriptionAdapter().createCompletion(baseInput({
      tools: localTool(), localToolExecutors: { local: execute }, requestToolApproval: approval,
    }));
    expect(approval).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('does not route a handoff the person rejected inside the handler', async () => {
    queryMock.mockImplementationOnce(({ options }: { options: SdkOptions }) => (async function* () {
      await preToolUse(options, 'handoff_to_next', 'handoff-call');
      const result = await handlerOf(options, 'handoff_to_next')({});
      expect(result.isError).toBe(true);
      yield success('stayed here');
    })());
    const result = await new ClaudeSubscriptionAdapter().createCompletion(baseInput({
      tools: localTool('handoff_to_next'), requestToolApproval: async () => false,
    }));
    expect(result.completion.choices[0].finish_reason).toBe('stop');
    expect(result.completion.choices[0].message.tool_calls).toBeUndefined();
  });

  it('fails the run when the approval service fails inside the handler', async () => {
    const execute = jest.fn(async () => 'ran');
    queryMock.mockImplementationOnce(({ options }: { options: SdkOptions }) => (async function* () {
      await preToolUse(options, 'local', 'broken-approval');
      // The SDK turns a handler error into an ordinary tool error and goes on.
      await handlerOf(options, 'local')({}).catch(() => undefined);
      yield success('SDK continued');
    })());
    await expect(new ClaudeSubscriptionAdapter().createCompletion(baseInput({
      tools: localTool(), localToolExecutors: { local: execute },
      requestToolApproval: async () => { throw new Error('Approval service failed'); },
    }))).rejects.toThrow('Approval service failed');
    expect(execute).not.toHaveBeenCalled();
  });
});

describe('ClaudeSubscriptionAdapter — frames Claude Code writes itself', () => {
  const synthetic = (uuid: string, text: string, error?: string) => ({
    type: 'assistant', uuid, parent_tool_use_id: null, session_id: 'boundary-session', ...(error ? { error } : {}),
    message: { id: `synthetic-${uuid}`, model: '<synthetic>', role: 'assistant', content: [{ type: 'text', text }],
      usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
  });
  const genuine = (uuid: string, text: string) => ({
    type: 'assistant', uuid, parent_tool_use_id: null, session_id: 'boundary-session',
    message: { id: `msg_${uuid}`, model: 'claude-sonnet', role: 'assistant', content: [{ type: 'text', text }],
      usage: { input_tokens: 120, output_tokens: 1 } },
  });

  it('never records an API error as the answer', async () => {
    const live: unknown[] = [];
    const events: Array<{ kind: string; state?: string }> = [];
    queryMock.mockImplementationOnce(() => (async function* () {
      yield synthetic('too-long', 'Prompt is too long', 'invalid_request');
      yield { type: 'result', subtype: 'success', is_error: true, session_id: 'boundary-session', result: 'Prompt is too long' };
    })());
    await expect(new ClaudeSubscriptionAdapter().createCompletion(baseInput({
      onTranscriptMessage: message => { live.push(message); },
      onSessionEvent: event => { events.push(event); },
    }))).rejects.toThrow('Prompt is too long');
    expect(live).toEqual([]);
    expect(events).toContainEqual(expect.objectContaining({ kind: 'api_error', state: 'invalid_request' }));
  });

  it('keeps a notice out of the answer and the context meter', async () => {
    queryMock.mockImplementationOnce(() => (async function* () {
      yield genuine('first', 'Part one. ');
      yield genuine('second', 'Part two.');
      yield synthetic('notice', "Claude's response exceeded the output token maximum.", 'max_output_tokens');
      yield { ...success('Part two.'), modelUsage: { sonnet: { inputTokens: 240, outputTokens: 2 } } };
    })());
    const result = await new ClaudeSubscriptionAdapter().createCompletion(baseInput());
    const prose = (result.transcript ?? []).map(message => message.content).join('');
    expect(prose).toBe('Part one. Part two.');
    expect(result.contextUsage).toMatchObject({ promptTokens: 120 });
  });

  it('names the API error when the stream ends without a result', async () => {
    queryMock.mockImplementationOnce(() => (async function* () {
      yield synthetic('login', 'Invalid API key · Please run /login', 'authentication_failed');
    })());
    await expect(new ClaudeSubscriptionAdapter().createCompletion(baseInput()))
      .rejects.toThrow('Invalid API key · Please run /login');
  });
});
