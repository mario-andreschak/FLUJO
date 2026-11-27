/**
 * Regression test for issue #1412: the answer text of a turn that also calls a
 * plain handoff (`handoff_to_finish_node`) must not be lost.
 *
 * The Agent SDK answers tool control requests (PreToolUse, canUseTool, the
 * in-process tool handler) as soon as they arrive, apart from the message
 * stream the adapter reads. So the handoff can be recorded before the adapter
 * has read the text frame of the very turn that called it. The adapter used to
 * end the run at the next frame it read after a plain handoff, which dropped
 * that text: an empty answer with full output-token usage.
 */
import type OpenAI from 'openai';
import type { CompletionInput } from '@/backend/services/model/adapters/types';

const queryMock = jest.fn();
let sdkToolsMock: Array<{
  name: string;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}> = [];

jest.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (...a: unknown[]) => queryMock(...(a as [])),
  createSdkMcpServer: (cfg: { tools?: typeof sdkToolsMock }) => {
    sdkToolsMock = cfg.tools ?? [];
    return { __server: cfg };
  },
  tool: (name: string, description: string, shape: unknown, handler: unknown) => ({
    name,
    description,
    shape,
    handler,
  }),
}));

jest.mock('@/backend/services/mcp', () => ({
  mcpService: {
    callTool: jest.fn(),
    getClient: jest.fn(() => ({})),
    getClientGeneration: jest.fn(() => 1),
    getToolSchemaHash: jest.fn(() => 'schema'),
    loadServerConfigs: jest.fn(async () => []),
    isMcpAppAccessEnabled: jest.fn(async () => false),
  },
}));

jest.mock('@/backend/services/runResources', () => ({
  getRunResourceSettings: jest.fn(async () => ({})),
}));

jest.mock('@/backend/services/model/adapters/claudeRuntimeHome', () => ({
  prepareClaudeRuntimeEnvironment: jest.fn(async () => ({
    home: 'C:\\flujo\\db\\claude-runtime',
    workingDirectory: 'C:\\flujo\\db\\claude-runtime\\workspace',
    env: { PATH: 'C:\\Windows' },
  })),
}));

import { ClaudeSubscriptionAdapter } from '@/backend/services/model/adapters/claudeSubscriptionAdapter';

const ANSWER = 'The pharmacy is open from 8:00 to 18:00.';
const NARRATION = 'Handed off to Finish.';

const tools: OpenAI.ChatCompletionFunctionTool[] = [
  { type: 'function', function: { name: 'lookup', description: 'Look something up',
    parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'handoff_to_finish_node', description: 'Finish the flow',
    parameters: { type: 'object', properties: {} } } },
];

const input = (): CompletionInput => ({
  model: { id: 'm1', name: 'sonnet', provider: 'claude-subscription', adapter: 'claude-cli' },
  apiKey: 'oauth-token',
  messages: [{ role: 'user', content: 'When are you open?' }],
  tools,
  localToolExecutors: {
    lookup: async () => ({ content: [{ type: 'text', text: 'opening hours: 8-18' }] }),
  },
} as unknown as CompletionInput);

type PreToolUseHook = (
  input: { hook_event_name: 'PreToolUse'; tool_name: string; tool_input: Record<string, unknown>; tool_use_id: string },
  id: string,
  options: { signal: AbortSignal },
) => Promise<unknown>;

/** What the SDK does for one tool call: the PreToolUse hook, then the handler. */
async function runSdkTool(options: Record<string, unknown>, name: string, toolUseId: string): Promise<void> {
  const hook = (options.hooks as { PreToolUse: Array<{ hooks: PreToolUseHook[] }> }).PreToolUse[0].hooks[0];
  await hook({ hook_event_name: 'PreToolUse', tool_name: `mcp__flujo__${name}`, tool_input: {}, tool_use_id: toolUseId },
    toolUseId, { signal: (options.abortController as AbortController).signal });
  await sdkToolsMock.find(sdkTool => sdkTool.name === name)!.handler({});
}

const frame = { session_id: 'sess-1', parent_tool_use_id: null };
const assistantFrame = (uuid: string, apiId: string, block: Record<string, unknown>) => ({
  ...frame, type: 'assistant', uuid, message: { id: apiId, role: 'assistant', content: [block] },
});
const toolResultFrame = (uuid: string, toolUseId: string, text: string) => ({
  ...frame, type: 'user', uuid, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: text }] },
});

/** A tool round (like the report's MCP tool), then one turn with the answer AND the Finish handoff. */
function answerAndHandoffStream(handoffRunsBeforeTurnIsRead: boolean, handoffUseFrame = true) {
  return ({ options }: { options: Record<string, unknown> }) => (async function* () {
    yield assistantFrame('a1', 'msg_1', { type: 'tool_use', id: 'toolu_lookup', name: 'mcp__flujo__lookup', input: {} });
    await runSdkTool(options, 'lookup', 'toolu_lookup');
    yield toolResultFrame('u1', 'toolu_lookup', 'opening hours: 8-18');

    if (handoffRunsBeforeTurnIsRead) await runSdkTool(options, 'handoff_to_finish_node', 'toolu_handoff');
    yield assistantFrame('a2', 'msg_2', { type: 'text', text: ANSWER });
    if (handoffUseFrame) {
      yield assistantFrame('a3', 'msg_2', { type: 'tool_use', id: 'toolu_handoff', name: 'mcp__flujo__handoff_to_finish_node', input: {} });
    }
    if (!handoffRunsBeforeTurnIsRead) await runSdkTool(options, 'handoff_to_finish_node', 'toolu_handoff');
    yield toolResultFrame('u2', 'toolu_handoff', 'Handing off.');

    // A further model turn after the handoff must never become the answer.
    yield assistantFrame('a4', 'msg_3', { type: 'text', text: NARRATION });
    yield { ...frame, type: 'result', subtype: 'success', result: NARRATION, usage: { input_tokens: 1, output_tokens: 1 } };
  })();
}

beforeEach(() => {
  queryMock.mockReset();
  sdkToolsMock = [];
});

describe('ClaudeSubscriptionAdapter — answer text in the handoff turn (#1412)', () => {
  it.each([
    ['the handoff runs before the turn is read', true, true],
    ['the turn is read before the handoff runs', false, true],
    ['the handoff runs first and its tool_use frame never arrives', true, false],
  ])('keeps the answer and ends at the handoff when %s', async (_label, handoffRunsBeforeTurnIsRead, handoffUseFrame) => {
    queryMock.mockImplementation(answerAndHandoffStream(handoffRunsBeforeTurnIsRead, handoffUseFrame));

    const { completion, transcript } = await new ClaudeSubscriptionAdapter().createCompletion(input());

    const message = completion.choices[0].message;
    expect(message.content).toBe(ANSWER);
    expect(message.tool_calls).toEqual([
      expect.objectContaining({ id: 'toolu_handoff', function: expect.objectContaining({ name: 'handoff_to_finish_node' }) }),
    ]);
    const toolName = (entry: object) =>
      (entry as { tool_calls?: Array<{ function?: { name?: string } }> }).tool_calls?.[0]?.function?.name ?? null;
    expect(transcript?.map(entry => [entry.role, entry.content ?? null, toolName(entry)]))
      .toEqual([
        ['assistant', '', 'lookup'],
        ['tool', expect.any(String), null],
        ['assistant', ANSWER, null],
        ['assistant', null, 'handoff_to_finish_node'],
      ]);
    expect(JSON.stringify(transcript)).not.toContain(NARRATION);
  });
});

/**
 * #1414: after a plain handoff, Claude Code stops by itself (PostToolBatch
 * hook). The adapter must not stop it first, or Claude Code drops the hook's
 * answer and asks the model for one more turn. The real process is covered by
 * claudeHandoffModelRequests.test.ts; these cover the adapter's three ways out.
 */
describe('ClaudeSubscriptionAdapter — end after a plain handoff (#1414)', () => {
  const streamEvent = (type: string) => ({ ...frame, type: 'stream_event', uuid: `s-${type}`, event: { type } });
  /** The handoff turn, its tool result, then what Claude Code does next. */
  function handoffThen(next: (signal: AbortSignal) => AsyncGenerator<Record<string, unknown>>) {
    const seen = { abortedBeforeNext: false };
    const implementation = ({ options }: { options: Record<string, unknown> }) => (async function* () {
      const signal = (options.abortController as AbortController).signal;
      yield assistantFrame('a1', 'msg_1', { type: 'text', text: ANSWER });
      await runSdkTool(options, 'handoff_to_finish_node', 'toolu_handoff');
      yield assistantFrame('a2', 'msg_1', { type: 'tool_use', id: 'toolu_handoff', name: 'mcp__flujo__handoff_to_finish_node', input: {} });
      yield streamEvent('message_delta');
      yield streamEvent('message_stop');
      yield toolResultFrame('u1', 'toolu_handoff', 'Handing off.');
      yield { ...frame, type: 'system', subtype: 'session_state_changed', state: 'running' };
      seen.abortedBeforeNext = signal.aborted;
      yield* next(signal);
    })();
    return { seen, implementation };
  }
  async function expectHandoffAnswer() {
    const { completion, transcript } = await new ClaudeSubscriptionAdapter().createCompletion(input());
    expect(completion.choices[0].message.content).toBe(ANSWER);
    expect(completion.choices[0].message.tool_calls).toEqual([
      expect.objectContaining({ id: 'toolu_handoff', function: expect.objectContaining({ name: 'handoff_to_finish_node' }) }),
    ]);
    expect(JSON.stringify(transcript)).not.toContain(NARRATION);
  }

  it('reads on to the result Claude Code sends when it stops by itself', async () => {
    let readResult = false;
    const { seen, implementation } = handoffThen(async function* () {
      readResult = true;
      yield { ...frame, type: 'result', subtype: 'success', is_error: false, result: '', terminal_reason: 'hook_stopped',
        stop_reason: 'tool_use', usage: { input_tokens: 1, output_tokens: 1 } };
    });
    queryMock.mockImplementation(implementation);

    await expectHandoffAnswer();
    expect(seen.abortedBeforeNext).toBe(false);
    expect(readResult).toBe(true);
  });

  it('stops Claude Code at once when it starts another model turn anyway', async () => {
    let abortedAtNewTurn: boolean | undefined;
    const { implementation } = handoffThen(async function* (signal) {
      try {
        yield streamEvent('message_start');
        yield assistantFrame('a3', 'msg_2', { type: 'text', text: NARRATION });
      } finally {
        abortedAtNewTurn = signal.aborted;
      }
    });
    queryMock.mockImplementation(implementation);

    await expectHandoffAnswer();
    expect(abortedAtNewTurn).toBe(true);
  });

  it('stops Claude Code itself when no result comes after the handoff', async () => {
    const startedAt = Date.now();
    const { implementation } = handoffThen(async function* (signal) {
      // Claude Code goes quiet; like the real SDK, the stream ends once it is stopped.
      await new Promise<void>(resolve => {
        if (signal.aborted) resolve();
        else signal.addEventListener('abort', () => resolve(), { once: true });
      });
    });
    queryMock.mockImplementation(implementation);

    await expectHandoffAnswer();
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(2_500);
  }, 20_000);
});
