/**
 * Regression test for issue #166 — the Claude Subscription / Agent SDK adapter
 * must NOT expose Claude Code's built-in tool suite (Bash, Read, Write, WebFetch,
 * …) to the model. Otherwise a tools-less Process Node is offered tools it never
 * bound, the model tries to call them, and `canUseTool` denies each with
 * "…is not permitted for this node." (the exact symptom reported in #166).
 *
 * The adapter suppresses the built-ins on the `query()` options via
 *   - `tools: []`            (SDK-documented "disable all built-ins" switch), and
 *   - `disallowedTools: […]` (explicit, drift-proof removal from the model context)
 * with `canUseTool` as a belt-and-suspenders deny gate. This test asserts the
 * options passed to the SDK carry that suppression and that the gate denies an
 * arbitrary built-in while allowing FLUJO's own `mcp__flujo__*` tools — without
 * relying on any live subscription (the SDK is mocked).
 */
import type OpenAI from 'openai';
import type { CompletionInput } from '@/backend/services/model/adapters/types';
import type { FlujoChatMessage } from '@/shared/types/chat';

// Capture the options the adapter passes to the Agent SDK's query().
const queryMock = jest.fn();
const callToolMock = jest.fn();
const loadServerConfigsMock = jest.fn();
let sdkToolsMock: Array<{
  name: string;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}> = [];

// Mock the ESM Agent SDK so it is never really loaded (that ESM load is the very
// reason the adapter imports it lazily). createSdkMcpServer/tool return inert
// stand-ins — we only care about the options handed to query().
jest.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (...a: unknown[]) => queryMock(...(a as [])),
  createSdkMcpServer: (cfg: {
    tools?: Array<{
      name: string;
      handler: (args: Record<string, unknown>) => Promise<unknown>;
    }>;
  }) => {
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

// The adapter imports mcpService at module scope; stub it (a tools-less run never
// calls it, but we must not drag in its dependency graph).
jest.mock('@/backend/services/mcp', () => ({
  mcpService: {
    callTool: (...a: unknown[]) => callToolMock(...(a as [])),
    loadServerConfigs: (...a: unknown[]) => loadServerConfigsMock(...(a as [])),
    isMcpAppAccessEnabled: async (serverName: string) => {
      const configs = await loadServerConfigsMock();
      return Array.isArray(configs)
        && configs.some((config: { name?: string; enableMcpApps?: boolean }) =>
          config.name === serverName && config.enableMcpApps === true);
    },
  },
}));

import { ClaudeSubscriptionAdapter } from '@/backend/services/model/adapters/claudeSubscriptionAdapter';

// A single terminal success `result` message ends the adapter's message loop
// cleanly with no tool calls.
function successStream() {
  return (async function* () {
    yield {
      type: 'result',
      subtype: 'success',
      result: 'done',
      session_id: 'sess-1',
      usage: { input_tokens: 1, output_tokens: 1 },
    };
  })();
}

const baseInput = (overrides: Partial<CompletionInput> = {}): CompletionInput =>
  ({
    model: { id: 'm1', name: 'haiku', provider: 'claude-subscription' },
    apiKey: 'oauth-token',
    messages: [{ role: 'user', content: 'hi' }] as OpenAI.ChatCompletionMessageParam[],
    ...overrides,
  } as unknown as CompletionInput);

const capturedOptions = () => {
  expect(queryMock).toHaveBeenCalledTimes(1);
  return queryMock.mock.calls[0][0].options as Record<string, unknown>;
};

beforeEach(() => {
  queryMock.mockReset();
  callToolMock.mockReset();
  loadServerConfigsMock.mockReset();
  loadServerConfigsMock.mockResolvedValue([
    { name: 'my-server', enableMcpApps: true },
  ]);
  sdkToolsMock = [];
  queryMock.mockImplementation(() => successStream());
});

describe('ClaudeSubscriptionAdapter — mid-run steering', () => {
  it('streams an accepted intervention into the active SDK query and records it durably', async () => {
    const streamedInputs: unknown[] = [];
    const response = (async function* () {
      // Any SDK event is a safe opportunity for the adapter to inspect FLUJO's
      // steering inbox. The real SDK also emits partial stream events here.
      yield { type: 'system', session_id: 'sess-1' };
      yield {
        type: 'assistant',
        session_id: 'sess-1',
        uuid: 'corrected-turn',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'corrected answer' }],
          usage: { input_tokens: 2, output_tokens: 2 },
        },
      };
      yield {
        type: 'result',
        subtype: 'success',
        result: 'corrected answer',
        session_id: 'sess-1',
        usage: { input_tokens: 2, output_tokens: 2 },
      };
    })() as AsyncGenerator<unknown> & { streamInput: (input: AsyncIterable<unknown>) => Promise<void> };
    response.streamInput = async (input) => {
      for await (const message of input) streamedInputs.push(message);
    };
    queryMock.mockReturnValue(response);

    const injected = {
      id: 'steer-claude-1',
      role: 'user',
      content: 'change direction now',
      timestamp: 123,
      injected: true,
    } as FlujoChatMessage;
    const consumeSteeringMessages = jest
      .fn<FlujoChatMessage[], []>()
      .mockReturnValueOnce([injected])
      .mockReturnValue([]);
    const onTranscriptMessage = jest.fn();

    const result = await new ClaudeSubscriptionAdapter().createCompletion(baseInput({
      consumeSteeringMessages,
      onTranscriptMessage,
    }));

    expect(streamedInputs).toEqual([
      expect.objectContaining({
        type: 'user',
        message: { role: 'user', content: 'change direction now' },
      }),
    ]);
    expect(result.transcript).toEqual([
      expect.objectContaining({ id: 'steer-claude-1', role: 'user', content: 'change direction now' }),
      expect.objectContaining({ role: 'assistant', content: 'corrected answer' }),
    ]);
    expect(onTranscriptMessage).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'steer-claude-1' }),
    );
  });
});

describe('ClaudeSubscriptionAdapter — malformed tool-call prose quarantine (#298)', () => {
  it('keeps a contaminated SDK turn out of the transcript and live callback', async () => {
    const malformed =
      'Assistant [tool call] mcp__flujo__filesystem__read_file {"path":"secret"}\n' +
      "The model's tool call could not be parsed (retry also failed)";
    queryMock.mockImplementation(() => (async function* () {
      yield {
        type: 'assistant',
        session_id: 'sess-1',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: malformed }],
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      };
      yield {
        type: 'result',
        subtype: 'success',
        result: 'safe terminal fallback',
        session_id: 'sess-1',
        usage: { input_tokens: 1, output_tokens: 2 },
      };
    })());
    const onTranscriptMessage = jest.fn();

    const result = await new ClaudeSubscriptionAdapter().createCompletion(
      baseInput({ onTranscriptMessage }),
    );

    expect(result.transcript).toHaveLength(1);
    expect(result.transcript![0]).toMatchObject({ role: 'assistant', content: 'safe terminal fallback' });
    expect(onTranscriptMessage).toHaveBeenCalledTimes(1);
    expect(onTranscriptMessage).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'safe terminal fallback' }),
    );
    expect(JSON.stringify(result.transcript)).not.toContain('mcp__flujo__');
    expect(JSON.stringify(onTranscriptMessage.mock.calls)).not.toContain('retry also failed');
  });
});

describe('ClaudeSubscriptionAdapter — built-in tool suppression (#166)', () => {
  it('disables all built-in tools on the query options for a tools-less node', async () => {
    const adapter = new ClaudeSubscriptionAdapter();
    await adapter.createCompletion(baseInput({ tools: [] }));

    const options = capturedOptions();
    // `tools: []` is the SDK's "disable all built-ins" switch.
    expect(options.tools).toEqual([]);
    // …plus an explicit, drift-proof disallow list covering the built-in suite.
    const disallowed = options.disallowedTools as string[];
    expect(Array.isArray(disallowed)).toBe(true);
    for (const name of ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebFetch', 'WebSearch']) {
      expect(disallowed).toContain(name);
    }
    // The adapter must NOT auto-allow anything (allowedTools bypasses canUseTool).
    expect(options.allowedTools).toBeUndefined();
  });

  it('passes the configured reasoning effort to the Agent SDK', async () => {
    const adapter = new ClaudeSubscriptionAdapter();
    await adapter.createCompletion(
      baseInput({
        model: {
          id: 'm1',
          name: 'sonnet',
          ApiKey: 'oauth-token',
          provider: 'claude-subscription',
          adapter: 'claude-cli',
          reasoningEffort: 'high',
        },
      }),
    );

    expect(capturedOptions().effort).toBe('high');
  });

  it('enables partial SDK events and reconciles streamed text with the final transcript id', async () => {
    queryMock.mockImplementation(() => (async function* () {
      yield {
        type: 'stream_event',
        uuid: 'assistant-1',
        session_id: 'sess-1',
        parent_tool_use_id: null,
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'hel' },
        },
      };
      yield {
        type: 'stream_event',
        uuid: 'assistant-1',
        session_id: 'sess-1',
        parent_tool_use_id: null,
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'lo' },
        },
      };
      yield {
        type: 'assistant',
        uuid: 'assistant-1',
        session_id: 'sess-1',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'hello' }],
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      };
      yield {
        type: 'result',
        subtype: 'success',
        result: 'hello',
        session_id: 'sess-1',
        usage: { input_tokens: 1, output_tokens: 1 },
      };
    })());
    const deltas: unknown[] = [];
    const { transcript } = await new ClaudeSubscriptionAdapter().createCompletion(
      baseInput({ onModelDelta: delta => deltas.push(delta) }),
    );

    expect(capturedOptions().includePartialMessages).toBe(true);
    expect(deltas).toEqual([
      expect.objectContaining({ messageId: 'stream_claude_assistant-1', contentDelta: 'hel' }),
      expect.objectContaining({ messageId: 'stream_claude_assistant-1', contentDelta: 'lo' }),
    ]);
    expect(transcript?.[0]).toMatchObject({
      id: 'stream_claude_assistant-1',
      role: 'assistant',
      content: 'hello',
    });
  });

  it('merges an aborted assistant frame with its continuation into ONE message id', async () => {
    // SDK >= 0.3.220: an interrupted/max-output-tokens turn arrives as an
    // assistant frame with wrapper-level `aborted: true` whose content ends
    // mid-word; the SDK continues the SAME prose in a follow-up assistant
    // frame with a NEW uuid. The adapter must reconcile both onto one stable
    // message id — otherwise the UI shows a mid-word bubble split
    // ("Toolchain conf" / "irmed. Now building…").
    queryMock.mockImplementation(() => (async function* () {
      yield {
        type: 'stream_event',
        uuid: 'frame-a',
        session_id: 'sess-1',
        parent_tool_use_id: null,
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'Toolchain conf' },
        },
      };
      yield {
        type: 'assistant',
        uuid: 'frame-a',
        session_id: 'sess-1',
        aborted: true,
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Toolchain conf' }],
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      };
      yield {
        type: 'stream_event',
        uuid: 'frame-b',
        session_id: 'sess-1',
        parent_tool_use_id: null,
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'irmed.' },
        },
      };
      yield {
        type: 'assistant',
        uuid: 'frame-b',
        session_id: 'sess-1',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'irmed.' }],
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      };
      yield {
        type: 'result',
        subtype: 'success',
        result: 'Toolchain confirmed.',
        session_id: 'sess-1',
        usage: { input_tokens: 1, output_tokens: 1 },
      };
    })());

    const deltas: Array<{ messageId: string; contentDelta?: string }> = [];
    const streamed: FlujoChatMessage[] = [];
    const { transcript } = await new ClaudeSubscriptionAdapter().createCompletion(
      baseInput({
        onModelDelta: (delta: { messageId: string; contentDelta?: string }) => deltas.push(delta),
        onTranscriptMessage: (message: FlujoChatMessage) => streamed.push(message),
      } as Partial<CompletionInput>),
    );

    // Continuation deltas keep the FIRST frame's stable id, so the live view
    // appends into the same bubble instead of opening a new draft.
    expect(deltas).toEqual([
      expect.objectContaining({ messageId: 'stream_claude_frame-a', contentDelta: 'Toolchain conf' }),
      expect.objectContaining({ messageId: 'stream_claude_frame-a', contentDelta: 'irmed.' }),
    ]);
    // Exactly ONE durable assistant prose message, holding the merged text.
    const prose = (transcript ?? []).filter(m => m.role === 'assistant');
    expect(prose).toHaveLength(1);
    expect(prose[0]).toMatchObject({
      id: 'stream_claude_frame-a',
      role: 'assistant',
      content: 'Toolchain confirmed.',
    });
    // The merged continuation was re-emitted live under the SAME id, so the
    // frontend's id-keyed upsert replaces the truncated bubble in place.
    const liveUnderStableId = streamed.filter(m => m.id === 'stream_claude_frame-a');
    expect(liveUnderStableId.length).toBeGreaterThanOrEqual(2);
    expect(liveUnderStableId[liveUnderStableId.length - 1].content).toBe('Toolchain confirmed.');
  });

  it('canUseTool DENIES an arbitrary built-in tool with the #166 message', async () => {
    const adapter = new ClaudeSubscriptionAdapter();
    await adapter.createCompletion(baseInput({ tools: [] }));

    const canUseTool = capturedOptions().canUseTool as (
      toolName: string,
      input: unknown,
      opts: { toolUseID: string },
    ) => Promise<{ behavior: string; message?: string }>;

    const bash = await canUseTool('Bash', { command: 'ls' }, { toolUseID: 't1' });
    expect(bash.behavior).toBe('deny');
    expect(bash.message).toContain('is not permitted for this node');

    const webfetch = await canUseTool('WebFetch', {}, { toolUseID: 't2' });
    expect(webfetch.behavior).toBe('deny');
  });

  it("canUseTool ALLOWS FLUJO's own mcp__flujo__* tools (no approval gate wired)", async () => {
    const adapter = new ClaudeSubscriptionAdapter();
    await adapter.createCompletion(baseInput({ tools: [] }));

    const canUseTool = capturedOptions().canUseTool as (
      toolName: string,
      input: unknown,
      opts: { toolUseID: string },
    ) => Promise<{ behavior: string }>;

    const allowed = await canUseTool('mcp__flujo__handoff_to_finish_node', {}, { toolUseID: 't3' });
    expect(allowed.behavior).toBe('allow');
  });

  it('still disables built-ins when the node HAS bound (handoff) tools', async () => {
    const adapter = new ClaudeSubscriptionAdapter();
    const tools: OpenAI.ChatCompletionFunctionTool[] = [
      {
        type: 'function',
        function: {
          name: 'handoff_to_finish_node',
          description: 'Finish the flow',
          parameters: { type: 'object', properties: {} },
        },
      },
    ];
    await adapter.createCompletion(baseInput({ tools }));

    const options = capturedOptions();
    expect(options.tools).toEqual([]);
    expect(options.disallowedTools as string[]).toContain('Bash');
    // The node's own tools ARE exposed via the in-process MCP server.
    expect(options.mcpServers).toBeDefined();
  });
});

const mcpAppTool: OpenAI.ChatCompletionFunctionTool = {
  type: 'function',
  function: {
    name: 'mcp_hashed_name',
    description: 'Lists things',
    parameters: { type: 'object', properties: { q: { type: 'string' } } },
  },
};

describe('ClaudeSubscriptionAdapter — MCP App transcript lifecycle', () => {
  it('surfaces a tool call before its handler begins execution', async () => {
    const order: string[] = [];
    callToolMock.mockImplementationOnce(async () => {
      order.push('execute');
      return { success: true, data: { content: [{ type: 'text', text: 'ok' }] } };
    });
    queryMock.mockImplementation(({ options }: {
      options: {
        canUseTool: (
          toolName: string,
          input: unknown,
          opts: { toolUseID: string },
        ) => Promise<{ behavior: string }>;
      };
    }) => (async function* () {
      await options.canUseTool(
        `mcp__flujo__${sdkToolsMock[0].name}`,
        { q: 'x' },
        { toolUseID: 'call-live-1' },
      );
      order.push('allowed');
      await sdkToolsMock[0].handler({ q: 'x' });
      yield {
        type: 'result',
        subtype: 'success',
        result: 'done',
        session_id: 'sess-1',
        usage: { input_tokens: 1, output_tokens: 1 },
      };
    })());

    const { transcript } = await new ClaudeSubscriptionAdapter().createCompletion(
      baseInput({
        tools: [mcpAppTool],
        toolNameMap: {
          mcp_hashed_name: { server: 'my-server', tool: 'list_things' },
        },
        onTranscriptMessage: message => {
          if (message.role === 'assistant' && message.tool_calls?.length) {
            order.push('call-visible');
          }
        },
      }),
    );

    expect(order).toEqual(['call-visible', 'allowed', 'execute']);
    expect(transcript?.[0]).toMatchObject({
      role: 'assistant',
      tool_calls: [{ id: 'call-live-1' }],
    });
    expect(transcript?.[1]).toMatchObject({ role: 'tool', tool_call_id: 'call-live-1' });
  });

  it('preserves the advertised UI, ignores a result redirect, and propagates abort', async () => {
    callToolMock.mockResolvedValueOnce({
      success: true,
      data: {
        content: [{ type: 'text', text: 'ok' }],
        _meta: { ui: { resourceUri: 'ui://unadvertised-redirect' } },
      },
    });
    queryMock.mockImplementation(() => (async function* () {
      await sdkToolsMock[0].handler({ q: 'x' });
      yield {
        type: 'result',
        subtype: 'success',
        result: 'done',
        session_id: 'sess-1',
        usage: { input_tokens: 1, output_tokens: 1 },
      };
    })());

    const { transcript } = await new ClaudeSubscriptionAdapter().createCompletion(
      baseInput({
        tools: [mcpAppTool],
        toolNameMap: {
          mcp_hashed_name: {
            server: 'my-server',
            tool: 'list_things',
            timeout: 30,
            uiResourceUri: 'ui://advertised-dashboard',
          },
        },
      }),
    );

    expect(callToolMock).toHaveBeenCalledWith(
      'my-server',
      'list_things',
      { q: 'x' },
      30,
      undefined,
      undefined,
      expect.any(AbortSignal),
      'model',
    );
    const toolMsg = transcript!.find(message => message.role === 'tool');
    expect(toolMsg?.ui).toEqual({
      uri: 'ui://advertised-dashboard',
      serverName: 'my-server',
      toolName: 'list_things',
    });
  });

  it('records approval rejection as an MCP App cancellation', async () => {
    queryMock.mockImplementation(({ options }: {
      options: {
        canUseTool: (
          toolName: string,
          input: unknown,
          opts: { toolUseID: string },
        ) => Promise<{ behavior: string }>;
      };
    }) => (async function* () {
      const denied = await options.canUseTool(
        `mcp__flujo__${sdkToolsMock[0].name}`,
        { q: 'x' },
        { toolUseID: 'approval-call-1' },
      );
      expect(denied.behavior).toBe('deny');
      yield {
        type: 'result',
        subtype: 'success',
        result: 'adjusted',
        session_id: 'sess-1',
        usage: { input_tokens: 1, output_tokens: 1 },
      };
    })());

    const { transcript } = await new ClaudeSubscriptionAdapter().createCompletion(
      baseInput({
        tools: [mcpAppTool],
        toolNameMap: {
          mcp_hashed_name: {
            server: 'my-server',
            tool: 'list_things',
            uiResourceUri: 'ui://advertised-dashboard',
          },
        },
        requestToolApproval: jest.fn(async () => ({
          approved: false,
          feedback: 'wrong target',
        })),
      }),
    );

    expect(callToolMock).not.toHaveBeenCalled();
    const toolMsg = transcript!.find(message => message.role === 'tool');
    expect(toolMsg?.ui).toEqual({
      uri: 'ui://advertised-dashboard',
      serverName: 'my-server',
      toolName: 'list_things',
      cancelledReason: 'User rejected this tool call: wrong target',
      isError: true,
    });
  });
});
