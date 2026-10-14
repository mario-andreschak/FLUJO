/**
 * Issue #154 — the Claude Subscription adapter's session-RESUME + delta-send
 * path, gated by the experimental `claudeSessionResume` setting (threaded as
 * CompletionInput.sessionResume).
 *
 * The contract this test pins:
 *  - Turn 1 (no session yet): a FULL flatten is sent and NO `resume` option is
 *    passed; the SDK's session_id is recorded afterwards.
 *  - Turn 2 (session exists, prefix unchanged, history grew): the adapter passes
 *    `resume: <sessionId>` and sends ONLY the delta (the new user message), not
 *    the whole history — the whole point of #154.
 *  - With the flag OFF, the adapter never resumes and always re-flattens.
 *  - A shrunk history (client pruning/divergence) refuses reuse and re-flattens.
 *
 * The Agent SDK is mocked (its ESM load is the reason the adapter imports it
 * lazily); we assert on the options + prompt handed to query().
 */
import type OpenAI from 'openai';
import type { CompletionInput } from '@/backend/services/model/adapters/types';
import { z } from 'zod';
import { v5 as uuidv5 } from 'uuid';

const queryMock = jest.fn();

jest.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (...a: unknown[]) => queryMock(...(a as [])),
  createSdkMcpServer: (cfg: unknown) => ({ __server: cfg }),
  tool: (name: string, description: string, shape: unknown, handler: unknown) => ({
    name,
    description,
    shape,
    handler,
  }),
}));

jest.mock('@/backend/services/mcp', () => ({
  mcpService: { callTool: jest.fn() },
}));

jest.mock('@/backend/services/model/adapters/claudeRuntimeHome', () => ({
  prepareClaudeRuntimeEnvironment: jest.fn(async () => ({
    home: 'C:\\flujo\\db\\claude-runtime',
    workingDirectory: 'C:\\flujo\\db\\claude-runtime\\workspace',
    env: {
      PATH: 'C:\\Windows',
      CLAUDE_CONFIG_DIR: 'C:\\flujo\\db\\claude-runtime',
      CLAUDE_SECURESTORAGE_CONFIG_DIR: 'C:\\flujo\\db\\claude-runtime',
    },
  })),
}));
jest.mock('@/backend/services/model/adapters/claudeSessionPersistence', () => ({
  ...jest.requireActual('@/backend/services/model/adapters/claudeSessionPersistence'),
  hasClaudeSessionTranscript: jest.fn(() => true),
  captureClaudeSessionTranscript: jest.fn(() => ({ bytes: 123, records: 2, sha256: 'a'.repeat(64) })),
}));

import { ClaudeSubscriptionAdapter } from '@/backend/services/model/adapters/claudeSubscriptionAdapter';
import { _clearAllSessionsForTests } from '@/backend/services/model/adapters/claudeSessionStore';

// A terminal success `result` carrying a session_id — ends the message loop
// cleanly with no tool calls and lets the adapter capture/record the session.
function successStream(sessionId: string, result = 'ok') {
  return (async function* () {
    yield {
      type: 'result',
      subtype: 'success',
      result,
      session_id: sessionId,
      usage: { input_tokens: 1, output_tokens: 1 },
      modelUsage: { sonnet: { inputTokens: 1, outputTokens: 1 } },
    };
  })();
}

const baseInput = (overrides: Partial<CompletionInput> = {}): CompletionInput =>
  ({
    model: { id: 'm1', name: 'sonnet', provider: 'claude-subscription' },
    apiKey: 'oauth-token',
    conversationId: 'conv-1',
    nodeId: 'node-1',
    messages: [] as OpenAI.ChatCompletionMessageParam[],
    ...overrides,
  } as unknown as CompletionInput);

// Pull the single yielded user message's content out of the prompt generator the
// adapter handed to query() on the Nth call.
async function promptContentOf(callIndex: number): Promise<unknown> {
  const gen = queryMock.mock.calls[callIndex][0].prompt as AsyncGenerator<{ message: { content: unknown } }>;
  const first = await gen.next();
  return first.value?.message?.content;
}

const optionsOf = (callIndex: number) =>
  queryMock.mock.calls[callIndex][0].options as Record<string, unknown>;

beforeEach(() => {
  queryMock.mockReset();
  _clearAllSessionsForTests();
});

describe('ClaudeSubscriptionAdapter — session resume (#154)', () => {
  it('uses standard UUID v5 values for deterministic consumption identities', () => {
    expect(uuidv5('https://example.com', uuidv5.URL)).toBe('4fd35a71-71ef-5a55-a9d9-aa75c889a6d0');
  });
  it('rejects success-subtype error results, closes the query and invalidates an existing resume checkpoint', async () => {
    const adapter = new ClaudeSubscriptionAdapter();
    queryMock.mockImplementationOnce(() => successStream('previously-good', 'remembered'));
    await adapter.createCompletion(baseInput({ sessionResume: true, messages: [{ role: 'user', content: 'first' }] }));
    const close = jest.fn();
    const outcomes: unknown[] = [];
    queryMock.mockImplementationOnce(() => Object.assign((async function* () {
      yield { type: 'result', subtype: 'success', is_error: true, session_id: 'previously-good',
        result: 'Request rejected for oauth-token', usage: { input_tokens: 0, output_tokens: 0 } };
    })(), { close }));
    const history: OpenAI.ChatCompletionMessageParam[] = [
      { role: 'user', content: 'first' }, { role: 'assistant', content: 'remembered' }, { role: 'user', content: 'second' },
    ];
    await expect(adapter.createCompletion(baseInput({ sessionResume: true, messages: history,
      onSdkRequest: async () => 'failed-dispatch', onSdkRequestResult: async outcome => { outcomes.push(outcome); },
    }))).rejects.toThrow('Request rejected for [credential redacted]');
    expect(optionsOf(1).resume).toBe('previously-good');
    expect(close).toHaveBeenCalledTimes(1);
    expect(outcomes).toEqual([expect.objectContaining({ dispatchId: 'failed-dispatch', outcome: 'error' })]);
    queryMock.mockImplementationOnce(() => successStream('fresh-after-error', 'recovered'));
    await adapter.createCompletion(baseInput({ sessionResume: true, messages: [...history, { role: 'user', content: 'retry' }] }));
    expect(optionsOf(2).resume).toBeUndefined();
    expect(await promptContentOf(2)).toContain('Human: first');
  });
  it('closes a settled foreground turn with ambient watchers and refuses an uncertain resume baseline', async () => {
    const events: Array<unknown> = [];
    queryMock.mockImplementationOnce(() => (async function* () {
      yield { type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'watcher', ambient: true }] };
      yield { type: 'result', subtype: 'success', session_id: 'ambient-session', result: 'done', modelUsage: { sonnet: { inputTokens: 1, outputTokens: 1 } } };
    })());
    await new ClaudeSubscriptionAdapter().createCompletion(baseInput({ sessionResume: true,
      messages: [{ role: 'user', content: 'first' }], onSessionEvent: event => { if (event.kind === 'accounting') events.push(event.accounting); },
    }));
    expect(events).toEqual([expect.objectContaining({ partial: true })]);
    queryMock.mockImplementationOnce(() => successStream('fresh-after-ambient'));
    await new ClaudeSubscriptionAdapter().createCompletion(baseInput({ sessionResume: true,
      messages: [{ role: 'user', content: 'first' }, { role: 'assistant', content: 'done' }, { role: 'user', content: 'next' }],
    }));
    expect(optionsOf(1).resume).toBeUndefined();
  });
  it('uses a fresh custom system value on an eligible per-turn resume and sends only new conversation content', async () => {
    const adapter = new ClaudeSubscriptionAdapter();
    queryMock.mockImplementationOnce(() => successStream('dynamic-session', 'remembered'));
    await adapter.createCompletion(baseInput({ sessionResume: true, systemPromptPolicy: 'per-turn', messages: [
      { role: 'system', content: 'Answer in English' }, { role: 'user', content: 'Remember ticket 123' },
    ] }));
    queryMock.mockImplementationOnce(() => successStream('dynamic-session', 'respuesta'));
    await adapter.createCompletion(baseInput({ sessionResume: true, systemPromptPolicy: 'per-turn', messages: [
      { role: 'system', content: 'Responde en español' }, { role: 'user', content: 'Remember ticket 123' },
      { role: 'assistant', content: 'remembered' }, { role: 'user', content: 'Which ticket?' },
    ] }));
    expect(optionsOf(0).systemPrompt).toEqual({ type: 'custom', prompt: 'Answer in English', snapshot: false });
    expect(optionsOf(1).systemPrompt).toEqual({ type: 'custom', prompt: 'Responde en español', snapshot: false });
    expect(optionsOf(1).resume).toBe('dynamic-session');
    expect(await promptContentOf(1)).toBe('Which ticket?');
  });

  it('keeps literal composed syntax and explicit stable recording', async () => {
    queryMock.mockImplementationOnce(() => successStream('literal-session'));
    await new ClaudeSubscriptionAdapter().createCompletion(baseInput({ messages: [
      { role: 'system', content: 'Stable instructions' },
      { role: 'user', content: '/clear\n@path\n@server:resource\n/slash text' },
    ] }));
    expect(optionsOf(0).verbatimPrompts).toBe(true);
    expect(optionsOf(0).permissionMode).toBe('default');
    expect(optionsOf(0).systemPrompt).toEqual({ type: 'custom', prompt: 'Stable instructions', snapshot: true });
    expect(await promptContentOf(0)).toContain('/clear\n@path\n@server:resource\n/slash text');
  });

  it('checks mandatory authority when SDK auto-approval skips canUseTool and records the call once', async () => {
    const execute = jest.fn(async () => 'done');
    const fence = jest.fn(async () => undefined);
    queryMock.mockImplementationOnce(({ options }) => (async function* () {
      const hook = options.hooks.PreToolUse[0].hooks[0];
      const input = { hook_event_name: 'PreToolUse', tool_name: 'mcp__flujo__local', tool_input: {}, tool_use_id: 'call-1' };
      await hook(input, 'call-1', { signal: options.abortController.signal });
      await hook(input, 'call-1', { signal: options.abortController.signal });
      await options.mcpServers.flujo.__server.tools[0].handler({});
      yield { type: 'result', subtype: 'success', session_id: 'authority-session', result: 'done' };
    })());
    const result = await new ClaudeSubscriptionAdapter().createCompletion(baseInput({
      tools: [{ type: 'function', function: { name: 'local', parameters: { type: 'object', properties: {} } } }],
      localToolExecutors: { local: execute }, beforeToolDispatch: fence,
    }));
    expect(execute).toHaveBeenCalledTimes(1);
    expect(fence).toHaveBeenCalled();
    expect(result.transcript?.filter(message => message.role === 'assistant' && message.tool_calls?.length)).toHaveLength(1);
  });

  it('never authorizes an approved decision after cancellation', async () => {
    const controller = new AbortController();
    const execute = jest.fn(async () => 'unexpected');
    queryMock.mockImplementationOnce(({ options }) => (async function* () {
      const decision = await options.canUseTool('mcp__flujo__local', {}, { toolUseID: 'late-call', signal: options.abortController.signal });
      expect(decision.behavior).toBe('deny');
      yield { type: 'result', subtype: 'success', session_id: 'cancelled', result: 'late' };
    })());
    await expect(new ClaudeSubscriptionAdapter().createCompletion(baseInput({ signal: controller.signal,
      tools: [{ type: 'function', function: { name: 'local', parameters: { type: 'object', properties: {} } } }],
      localToolExecutors: { local: execute }, requestToolApproval: async () => { controller.abort(); return true; },
    }))).rejects.toThrow('cancelled');
    expect(execute).not.toHaveBeenCalled();
  });

  it('binds a valid hook input to the schema-parsed handler regardless of object key order', async () => {
    const execute = jest.fn(async () => 'done');
    queryMock.mockImplementationOnce(({ options }) => (async function* () {
      await options.hooks.PreToolUse[0].hooks[0]({ hook_event_name: 'PreToolUse', tool_name: 'mcp__flujo__local',
        tool_input: { b: 2, a: 1 }, tool_use_id: 'ordered-call' }, 'ordered-call', { signal: options.abortController.signal });
      const sdkTool = options.mcpServers.flujo.__server.tools[0];
      const parsed = z.object(sdkTool.shape).parse({ b: 2, a: 1 });
      expect(Object.keys(parsed)).toEqual(['a', 'b']);
      await sdkTool.handler(parsed);
      yield { type: 'result', subtype: 'success', session_id: 'ordered-session', result: 'done' };
    })());
    await new ClaudeSubscriptionAdapter().createCompletion(baseInput({
      tools: [{ type: 'function', function: { name: 'local', parameters: { type: 'object',
        properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] } } }],
      localToolExecutors: { local: execute },
    }));
    expect(execute).toHaveBeenCalledWith({ a: 1, b: 2 });
  });

  it('rejects an earlier successful result followed by outstanding background work at EOF', async () => {
    queryMock.mockImplementationOnce(() => (async function* () {
      yield { type: 'system', subtype: 'background_tasks_changed', tasks: [{ id: 'child' }] };
      yield { type: 'result', subtype: 'success', session_id: 'background-session', result: 'foreground done' };
    })());
    await expect(new ClaudeSubscriptionAdapter().createCompletion(baseInput({ sessionResume: true })))
      .rejects.toThrow('background work');
  });

  it('rejects an earlier successful result when the SDK still reports queued user turns at EOF', async () => {
    queryMock.mockImplementationOnce(() => (async function* () {
      yield { type: 'result', subtype: 'success', session_id: 'queued-session', queued_turn_count: 1, result: 'first done' };
    })());
    await expect(new ClaudeSubscriptionAdapter().createCompletion(baseInput({ sessionResume: true })))
      .rejects.toThrow('submitted turns');
  });

  it('cancels an in-flight local callback on query error and suppresses its late result', async () => {
    let completeTool!: (value: string) => void;
    let lateTool!: Promise<unknown>;
    const messages: unknown[] = [];
    queryMock.mockImplementationOnce(({ options }) => (async function* () {
      await options.hooks.PreToolUse[0].hooks[0]({ hook_event_name: 'PreToolUse', tool_name: 'mcp__flujo__local',
        tool_input: {}, tool_use_id: 'late-local' }, 'late-local', { signal: options.abortController.signal });
      lateTool = options.mcpServers.flujo.__server.tools[0].handler({});
      void lateTool.catch(() => {});
      await Promise.resolve();
      throw new Error('SDK stream failed');
    })());
    await expect(new ClaudeSubscriptionAdapter().createCompletion(baseInput({ onTranscriptMessage: message => { messages.push(message); },
      tools: [{ type: 'function', function: { name: 'local', parameters: { type: 'object', properties: {} } } }],
      localToolExecutors: { local: () => new Promise<string>(resolve => { completeTool = resolve; }) },
    }))).rejects.toThrow('SDK stream failed');
    completeTool('late output');
    await expect(lateTool).rejects.toThrow();
    expect(messages).toHaveLength(1);
    expect(optionsOf(0).abortController).toMatchObject({ signal: { aborted: true } });
  });

  it.each(['close', 'accounting'] as const)('reports an error dispatch when %s teardown fails after a successful result', async failure => {
    const receipt = jest.fn(async () => undefined);
    const accounting: unknown[] = [];
    const close = jest.fn(() => { if (failure === 'close') throw new Error('teardown failed'); });
    queryMock.mockReturnValueOnce(Object.assign(successStream('teardown-session'), { close }));
    await expect(new ClaudeSubscriptionAdapter().createCompletion(baseInput({
      onSdkRequest: async () => 'dispatch-1', onSdkRequestResult: receipt,
      onSessionEvent: event => {
        if (event.kind === 'accounting') {
          accounting.push(event.accounting);
          if (failure === 'accounting') throw new Error('teardown failed');
        }
      },
    }))).rejects.toThrow('teardown failed');
    expect(receipt).toHaveBeenCalledWith({ dispatchId: 'dispatch-1', outcome: 'error' });
    expect(close).toHaveBeenCalledTimes(1);
    expect(optionsOf(0).abortController).toMatchObject({ signal: { aborted: true } });
    if (failure === 'close') expect(accounting).toEqual([expect.objectContaining({ partial: true })]);
  });

  it('reports iterator termination and deferred work as incomplete and closes the SDK query', async () => {
    const close = jest.fn();
    const incomplete = Object.assign((async function* () { yield { type: 'system', session_id: 'incomplete' }; })(), { close });
    queryMock.mockReturnValueOnce(incomplete);
    await expect(new ClaudeSubscriptionAdapter().createCompletion(baseInput())).rejects.toThrow('before a terminal result');
    expect(close).toHaveBeenCalledTimes(1);
    queryMock.mockImplementationOnce(() => (async function* () {
      yield { type: 'result', subtype: 'success', result: '', terminal_reason: 'tool_deferred' };
    })());
    await expect(new ClaudeSubscriptionAdapter().createCompletion(baseInput())).rejects.toThrow('tool_deferred');
  });
  it('rejects a direct owner-bound call before preparing the runtime or invoking the SDK', async () => {
    const runtime = (jest.requireMock('@/backend/services/model/adapters/claudeRuntimeHome') as {
      prepareClaudeRuntimeEnvironment: jest.Mock;
    }).prepareClaudeRuntimeEnvironment;
    runtime.mockClear();

    await expect(new ClaudeSubscriptionAdapter().createCompletion(baseInput({
      model: {
        id: 'owner-model', name: 'sonnet', ApiKey: '', provider: 'claude-subscription', adapter: 'openai',
        ownerCredentialBinding: { ownerId: 'owner', credentialId: 'credential' },
      },
      apiKey: 'local-secret',
    }))).rejects.toMatchObject({ code: 'execution_owner_model_adapter_unsupported' });

    expect(runtime).not.toHaveBeenCalled();
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('resumes with only the delta on the second turn when the flag is ON', async () => {
    const adapter = new ClaudeSubscriptionAdapter();

    // ---- Turn 1: no session yet -> full flatten, no resume. ----
    queryMock.mockImplementationOnce(() => successStream('sess-A', 'first answer'));
    await adapter.createCompletion(
      baseInput({
        sessionResume: true,
        messages: [{ role: 'user', content: 'hello' }] as OpenAI.ChatCompletionMessageParam[],
      }),
    );

    expect(optionsOf(0).resume).toBeUndefined();
    expect(await promptContentOf(0)).toBe('hello'); // whole (only) message

    // ---- Turn 2: session exists; history grew by the recorded answer + a new
    // user turn. The adapter must resume 'sess-A' and send only the new turn. ----
    queryMock.mockImplementationOnce(() => successStream('sess-A', 'second answer'));
    await adapter.createCompletion(
      baseInput({
        sessionResume: true,
        messages: [
          { role: 'user', content: 'hello' },
          { role: 'assistant', content: 'first answer' },
          { role: 'user', content: 'follow-up question' },
        ] as OpenAI.ChatCompletionMessageParam[],
      }),
    );

    expect(optionsOf(1).resume).toBe('sess-A');
    // ONLY the delta (the new user turn) — not the flattened history.
    expect(await promptContentOf(1)).toBe('follow-up question');
  });

  it('resumes when the contiguous leading system-message count is unchanged', async () => {
    const adapter = new ClaudeSubscriptionAdapter();
    const system = { role: 'system', content: 'be concise' } as OpenAI.ChatCompletionMessageParam;

    queryMock.mockImplementationOnce(() => successStream('sess-system', 'first answer'));
    await adapter.createCompletion(baseInput({
      sessionResume: true,
      messages: [system, { role: 'user', content: 'hello' }] as OpenAI.ChatCompletionMessageParam[],
    }));

    queryMock.mockImplementationOnce(() => successStream('sess-system', 'second answer'));
    await adapter.createCompletion(baseInput({
      sessionResume: true,
      messages: [
        system,
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'first answer' },
        { role: 'user', content: 'follow-up' },
      ] as OpenAI.ChatCompletionMessageParam[],
    }));

    expect(optionsOf(1).resume).toBe('sess-system');
    expect(await promptContentOf(1)).toBe('follow-up');
  });

  it('falls back after an added leading system message, then records a reusable replacement', async () => {
    const adapter = new ClaudeSubscriptionAdapter();
    const system = { role: 'system', content: 'be concise' } as OpenAI.ChatCompletionMessageParam;

    queryMock.mockImplementationOnce(() => successStream('sess-no-system', 'first answer'));
    await adapter.createCompletion(baseInput({ sessionResume: true, messages: [{ role: 'user', content: 'hello' }] as OpenAI.ChatCompletionMessageParam[] }));

    queryMock.mockImplementationOnce(() => successStream('sess-with-system', 'second answer'));
    await adapter.createCompletion(baseInput({
      sessionResume: true,
      messages: [system, { role: 'user', content: 'hello' }, { role: 'assistant', content: 'first answer' }, { role: 'user', content: 'follow-up' }] as OpenAI.ChatCompletionMessageParam[],
    }));
    expect(optionsOf(1).resume).toBeUndefined();
    expect(await promptContentOf(1)).toContain('Human: hello');

    queryMock.mockImplementationOnce(() => successStream('sess-with-system', 'third answer'));
    await adapter.createCompletion(baseInput({
      sessionResume: true,
      messages: [system, { role: 'user', content: 'hello' }, { role: 'assistant', content: 'first answer' }, { role: 'user', content: 'follow-up' }, { role: 'assistant', content: 'second answer' }, { role: 'user', content: 'again' }] as OpenAI.ChatCompletionMessageParam[],
    }));
    expect(optionsOf(2).resume).toBe('sess-with-system');
    expect(await promptContentOf(2)).toBe('again');
  });

  it('falls back after a removed leading system message', async () => {
    const adapter = new ClaudeSubscriptionAdapter();
    const system = { role: 'system', content: 'be concise' } as OpenAI.ChatCompletionMessageParam;

    queryMock.mockImplementationOnce(() => successStream('sess-system', 'first answer'));
    await adapter.createCompletion(baseInput({ sessionResume: true, messages: [system, { role: 'user', content: 'hello' }] as OpenAI.ChatCompletionMessageParam[] }));

    queryMock.mockImplementationOnce(() => successStream('sess-no-system', 'second answer'));
    await adapter.createCompletion(baseInput({
      sessionResume: true,
      messages: [{ role: 'user', content: 'hello' }, { role: 'assistant', content: 'first answer' }, { role: 'user', content: 'follow-up' }] as OpenAI.ChatCompletionMessageParam[],
    }));
    expect(optionsOf(1).resume).toBeUndefined();
    expect(await promptContentOf(1)).toContain('Human: hello');
  });

  it('never resumes when the flag is OFF (always re-flattens)', async () => {
    const adapter = new ClaudeSubscriptionAdapter();

    queryMock.mockImplementationOnce(() => successStream('sess-B', 'first'));
    await adapter.createCompletion(
      baseInput({
        sessionResume: false,
        messages: [{ role: 'user', content: 'hello' }] as OpenAI.ChatCompletionMessageParam[],
      }),
    );

    // A session is still RECORDED (measurement), but the second turn must not resume.
    queryMock.mockImplementationOnce(() => successStream('sess-B', 'second'));
    await adapter.createCompletion(
      baseInput({
        sessionResume: false,
        messages: [
          { role: 'user', content: 'hello' },
          { role: 'assistant', content: 'first' },
          { role: 'user', content: 'again' },
        ] as OpenAI.ChatCompletionMessageParam[],
      }),
    );

    expect(optionsOf(1).resume).toBeUndefined();
    // Full flatten of the whole history (prefixed multi-turn form).
    const content = await promptContentOf(1);
    expect(content).toContain('Human: hello');
    expect(content).toContain('Assistant: first');
    expect(content).toContain('Human: again');
  });

  it('falls back to a full flatten when the client history shrank (divergence)', async () => {
    const adapter = new ClaudeSubscriptionAdapter();

    queryMock.mockImplementationOnce(() => successStream('sess-C'));
    await adapter.createCompletion(
      baseInput({
        sessionResume: true,
        messages: [
          { role: 'user', content: 'a' },
          { role: 'assistant', content: 'b' },
          { role: 'user', content: 'c' },
        ] as OpenAI.ChatCompletionMessageParam[],
      }),
    );

    // Next turn presents a SHORTER history than the session last saw -> refuse reuse.
    queryMock.mockImplementationOnce(() => successStream('sess-C'));
    await adapter.createCompletion(
      baseInput({
        sessionResume: true,
        messages: [{ role: 'user', content: 'fresh start' }] as OpenAI.ChatCompletionMessageParam[],
      }),
    );

    expect(optionsOf(1).resume).toBeUndefined();
    expect(await promptContentOf(1)).toBe('fresh start');
  });

  it('does not resume without a conversation/node identity even with the flag on', async () => {
    const adapter = new ClaudeSubscriptionAdapter();

    queryMock.mockImplementationOnce(() => successStream('sess-D'));
    await adapter.createCompletion(
      baseInput({
        sessionResume: true,
        conversationId: undefined,
        nodeId: undefined,
        messages: [{ role: 'user', content: 'x' }] as OpenAI.ChatCompletionMessageParam[],
      }),
    );

    expect(optionsOf(0).resume).toBeUndefined();
  });
});
