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
