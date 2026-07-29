/**
 * Unit tests for the Codex adapter (issue #301) — the Codex-SDK sibling of the
 * Claude Subscription adapter. The SDK and the loopback tool bridge are mocked;
 * these tests pin down the adapter's contract:
 *   - thread options harden the run (read-only sandbox, never-ask approvals,
 *     stable neutral working dir) and the API key is omitted when empty (codex login).
 *   - agent messages stream into the transcript exactly once (no duplicate
 *     final answer) and usage maps into the OpenAI shape with the cached split.
 *   - FLUJO tools are exposed through the bridge; an MCP dispatch records the
 *     assistant(tool_call)+tool(result) pair; a rejected approval never runs
 *     the tool and surfaces the #247 feedback text.
 *   - a plain handoff ends the run and surfaces as a routing tool_call.
 */
import type OpenAI from 'openai';
import type { CompletionInput } from '@/backend/services/model/adapters/types';
import type { BridgeTool } from '@/backend/services/model/adapters/codexToolBridge';
import type { FlujoChatMessage } from '@/shared/types/chat';

const codexCtorMock = jest.fn();
const startThreadMock = jest.fn();
const resumeThreadMock = jest.fn();
const runStreamedMock = jest.fn();

// `virtual: true` because the SDK is ESM-only (its exports map has no
// `require` condition), so Jest's CJS resolver can't see it. The adapter
// imports it lazily at runtime for the same reason.
jest.mock(
  '@openai/codex-sdk',
  () => ({
    Codex: class {
      constructor(opts: unknown) {
        codexCtorMock(opts);
      }
      startThread(opts: unknown) {
        startThreadMock(opts);
        return { runStreamed: runStreamedMock };
      }
      resumeThread(id: string, opts: unknown) {
        resumeThreadMock(id, opts);
        return { runStreamed: runStreamedMock };
      }
    },
  }),
  { virtual: true },
);

// Capture the tools handed to the bridge instead of opening a real socket.
const bridgeCloseMock = jest.fn(async () => undefined);
let capturedBridgeTools: BridgeTool[] = [];
let capturedBridgeInstructions: string | undefined;
jest.mock('@/backend/services/model/adapters/codexToolBridge', () => ({
  startCodexToolBridge: jest.fn(async (tools: BridgeTool[], instructions?: string) => {
    capturedBridgeTools = tools;
    capturedBridgeInstructions = instructions;
    return { url: 'http://127.0.0.1:1234/mcp/testtoken', close: bridgeCloseMock };
  }),
}));

const callToolMock = jest.fn();
const loadServerConfigsMock = jest.fn();
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
jest.mock('@/backend/services/runResources', () => ({
  getRunResourceSettings: jest.fn(async () => ({})),
}));
jest.mock('@/backend/services/runResources/boundToolResult', () => ({
  boundToolResult: jest.fn(async ({ content }: { content: string }) => ({ spilled: false, content })),
}));
jest.mock('@/backend/services/model/adapters/codexModelCatalog', () => ({
  resolveCodexModelCatalogPath: jest.fn(async () => 'C:\\Users\\test\\.codex\\models_cache.json'),
}));
jest.mock('@/backend/services/model/adapters/codexRuntimeHome', () => ({
  prepareCodexRuntimeEnvironment: jest.fn(async () => ({
    home: 'C:\\flujo\\db\\codex-runtime',
    workingDirectory: 'C:\\flujo\\db\\codex-runtime\\workspace',
    env: { PATH: 'C:\\Windows', CODEX_HOME: 'C:\\flujo\\db\\codex-runtime' },
  })),
}));

import {
  CodexAdapter,
  CODEX_FLUJO_INSTRUCTIONS,
} from '@/backend/services/model/adapters/codexAdapter';
import { _clearCodexSessionsForTests } from '@/backend/services/model/adapters/codexSessionStore';

type AnyEvent = Record<string, unknown>;

function eventStream(events: AnyEvent[]) {
  return async function* () {
    for (const e of events) yield e;
  };
}

const agentMessage = (text: string): AnyEvent => ({
  type: 'item.completed',
  item: { id: 'i1', type: 'agent_message', text },
});
const turnCompleted = (usage: Record<string, number>): AnyEvent => ({ type: 'turn.completed', usage });
const threadStarted = (threadId: string): AnyEvent => ({ type: 'thread.started', thread_id: threadId });

const baseInput = (overrides: Partial<CompletionInput> = {}): CompletionInput =>
  ({
    model: { id: 'm1', name: 'gpt-5.5', provider: 'codex', adapter: 'codex-cli' },
    apiKey: 'sk-test',
    messages: [{ role: 'user', content: 'hi' }] as OpenAI.ChatCompletionMessageParam[],
    ...overrides,
  } as unknown as CompletionInput);

beforeEach(() => {
  codexCtorMock.mockReset();
  startThreadMock.mockReset();
  resumeThreadMock.mockReset();
  runStreamedMock.mockReset();
  callToolMock.mockReset();
  loadServerConfigsMock.mockReset();
  loadServerConfigsMock.mockResolvedValue([
    { name: 'my-server', enableMcpApps: true },
  ]);
  bridgeCloseMock.mockClear();
  capturedBridgeTools = [];
  capturedBridgeInstructions = undefined;
  _clearCodexSessionsForTests();
  runStreamedMock.mockImplementation(async () => ({
    events: eventStream([
      agentMessage('hello from codex'),
      turnCompleted({ input_tokens: 100, cached_input_tokens: 40, output_tokens: 7 }),
    ])(),
  }));
});

describe('CodexAdapter — thread setup', () => {
  it('hardens the thread and uses the stable neutral runtime cwd', async () => {
    await new CodexAdapter().createCompletion(baseInput());

    expect(startThreadMock).toHaveBeenCalledTimes(1);
    const opts = startThreadMock.mock.calls[0][0] as Record<string, unknown>;
    expect(opts.model).toBe('gpt-5.5');
    expect(opts.sandboxMode).toBe('read-only');
    expect(opts.approvalPolicy).toBe('never');
    expect(opts.skipGitRepoCheck).toBe(true);
    expect(opts.workingDirectory).toBe('C:\\flujo\\db\\codex-runtime\\workspace');
    expect(String(opts.workingDirectory)).not.toContain('flujo-codex-');
  });

  it('passes the API key when present and omits it when empty (codex login)', async () => {
    await new CodexAdapter().createCompletion(baseInput());
    const keyed = codexCtorMock.mock.calls[0][0] as Record<string, unknown>;
    expect(keyed.apiKey).toBe('sk-test');
    expect(keyed.env).toEqual({
      PATH: 'C:\\Windows',
      CODEX_HOME: 'C:\\flujo\\db\\codex-runtime',
    });

    codexCtorMock.mockClear();
    await new CodexAdapter().createCompletion(baseInput({ apiKey: '' }));
    expect('apiKey' in (codexCtorMock.mock.calls[0][0] as Record<string, unknown>)).toBe(false);
  });

  it('disables Codex shell and uses its local model catalog', async () => {
    await new CodexAdapter().createCompletion(baseInput());
    const opts = codexCtorMock.mock.calls[0][0] as Record<string, unknown>;
    expect(opts.config).toEqual({
      service_tier: 'default',
      developer_instructions: CODEX_FLUJO_INSTRUCTIONS,
      features: { shell_tool: false },
      model_catalog_json: 'C:\\Users\\test\\.codex\\models_cache.json',
    });
    expect(capturedBridgeTools).toEqual([]);
  });

  it('maps configured effort and priority to Codex SDK options', async () => {
    await new CodexAdapter().createCompletion(
      baseInput({
        model: {
          id: 'm1',
          name: 'gpt-5.6-sol',
          ApiKey: 'sk-test',
          provider: 'codex',
          adapter: 'codex-cli',
          reasoningEffort: 'max',
          serviceTier: 'priority',
        },
      }),
    );

    expect(startThreadMock.mock.calls[0][0]).toEqual(
      expect.objectContaining({ modelReasoningEffort: 'max' }),
    );
    expect(codexCtorMock.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        config: expect.objectContaining({ service_tier: 'priority' }),
      }),
    );
  });

  it('passes the dynamic system prompt through stdin and keeps only the fixed contract in config', async () => {
    await new CodexAdapter().createCompletion(
      baseInput({
        messages: [
          { role: 'system', content: 'You are terse.' },
          { role: 'user', content: 'hi' },
        ] as OpenAI.ChatCompletionMessageParam[],
      }),
    );
    const opts = codexCtorMock.mock.calls[0][0] as {
      config: Record<string, unknown>;
    };
    expect(opts.config.developer_instructions).toBe(CODEX_FLUJO_INSTRUCTIONS);
    const input = runStreamedMock.mock.calls[0][0] as Array<{ type: string; text?: string }>;
    expect(input).toEqual([
      { type: 'text', text: '<system_instructions>\nYou are terse.\n</system_instructions>' },
      { type: 'text', text: expect.stringContaining('hi') },
    ]);
  });
});

describe('CodexAdapter — transcript & usage', () => {
  it('streams the answer once and maps usage with the cached split', async () => {
    const streamed: unknown[] = [];
    const { completion, transcript } = await new CodexAdapter().createCompletion(
      baseInput({ onTranscriptMessage: m => streamed.push(m) }),
    );

    expect(completion.choices[0].message.content).toBe('hello from codex');
    expect(completion.choices[0].finish_reason).toBe('stop');
    expect(completion.usage?.prompt_tokens).toBe(100);
    expect(completion.usage?.completion_tokens).toBe(7);
    expect(completion.usage?.prompt_tokens_details?.cached_tokens).toBe(40);

    // The assistant text streamed live is the SAME (single) transcript entry —
    // no duplicate final message.
    expect(transcript).toHaveLength(1);
    expect(streamed).toHaveLength(1);
    expect((transcript![0] as { content?: string }).content).toBe('hello from codex');
  });

  it('emits item.updated text as append-only deltas and reconciles the transcript id', async () => {
    runStreamedMock.mockImplementationOnce(async () => ({
      events: eventStream([
        { type: 'item.started', item: { id: 'a1', type: 'agent_message', text: '' } },
        { type: 'item.updated', item: { id: 'a1', type: 'agent_message', text: 'hel' } },
        { type: 'item.updated', item: { id: 'a1', type: 'agent_message', text: 'hello' } },
        { type: 'item.completed', item: { id: 'a1', type: 'agent_message', text: 'hello' } },
        turnCompleted({ input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 }),
      ])(),
    }));
    const deltas: unknown[] = [];
    const { transcript } = await new CodexAdapter().createCompletion(
      baseInput({ onModelDelta: delta => deltas.push(delta) }),
    );

    expect(deltas).toEqual([
      expect.objectContaining({ messageId: 'stream_codex_a1', contentDelta: 'hel' }),
      expect.objectContaining({ messageId: 'stream_codex_a1', contentDelta: 'lo' }),
    ]);
    expect(transcript?.[0].id).toBe('stream_codex_a1');
  });

  it("surfaces the built-in shell's command executions as synthetic tool pairs", async () => {
    runStreamedMock.mockImplementationOnce(async () => ({
      events: eventStream([
        {
          type: 'item.completed',
          item: { id: 'c1', type: 'command_execution', command: 'ls', aggregated_output: 'file.txt', status: 'completed' },
        },
        agentMessage('done'),
        turnCompleted({ input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 }),
      ])(),
    }));
    const { transcript } = await new CodexAdapter().createCompletion(baseInput());
    const call = transcript!.find(m => (m as { tool_calls?: unknown[] }).tool_calls);
    expect(call).toBeDefined();
    const tc = (call as { tool_calls: OpenAI.ChatCompletionMessageToolCall[] }).tool_calls[0];
    expect(tc.function.name).toBe('shell');
    expect(tc.function.arguments).toContain('ls');
  });

  it('continues the same thread once after the exact mid-response connection close', async () => {
    const close = 'Connection closed mid-response. The response above may be incomplete.';
    runStreamedMock
      .mockImplementationOnce(async () => ({
        events: eventStream([agentMessage('partial'), { type: 'turn.failed', error: { message: close } }])(),
      }))
      .mockImplementationOnce(async () => ({
        events: eventStream([agentMessage('continued'), turnCompleted({ input_tokens: 2, cached_input_tokens: 0, output_tokens: 2 })])(),
      }));

    const { completion, transcript } = await new CodexAdapter().createCompletion(baseInput());

    expect(startThreadMock).toHaveBeenCalledTimes(1);
    expect(runStreamedMock).toHaveBeenCalledTimes(2);
    expect(runStreamedMock.mock.calls[1][0]).toContain('Continue the interrupted response');
    expect(completion.choices[0].message.content).toBe('partial\n\ncontinued');
    expect(transcript).toHaveLength(2);
  });

  it('does not continue a second matching close or unrelated failures', async () => {
    const close = 'Connection closed mid-response. The response above may be incomplete.';
    runStreamedMock
      .mockImplementationOnce(async () => ({
        events: eventStream([{ type: 'turn.failed', error: { message: close } }])(),
      }))
      .mockImplementationOnce(async () => ({
        events: eventStream([{ type: 'turn.failed', error: { message: close } }])(),
      }));

    await expect(new CodexAdapter().createCompletion(baseInput())).rejects.toThrow(close);
    expect(runStreamedMock).toHaveBeenCalledTimes(2);

    runStreamedMock.mockReset();
    runStreamedMock.mockImplementationOnce(async () => ({
      events: eventStream([{ type: 'turn.failed', error: { message: 'authentication failed' } }])(),
    }));
    await expect(new CodexAdapter().createCompletion(baseInput())).rejects.toThrow('authentication failed');
    expect(runStreamedMock).toHaveBeenCalledTimes(1);
  });

  it('does not continue after cancellation', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(new CodexAdapter().createCompletion(baseInput({ signal: controller.signal }))).rejects.toThrow(
      'Codex run cancelled by user.',
    );
    expect(runStreamedMock).toHaveBeenCalledTimes(1);
  });

  it('throws on turn.failed', async () => {
    runStreamedMock.mockImplementationOnce(async () => ({
      events: eventStream([{ type: 'turn.failed', error: { message: 'boom' } }])(),
    }));
    await expect(new CodexAdapter().createCompletion(baseInput())).rejects.toThrow(/boom/);
  });

  it('does not fail a successful turn because of a non-fatal error item', async () => {
    runStreamedMock.mockImplementationOnce(async () => ({
      events: eventStream([
        {
          type: 'item.completed',
          item: { id: 'warning-1', type: 'error', message: 'Optional service tier was omitted.' },
        },
        agentMessage('done'),
        turnCompleted({ input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 }),
      ])(),
    }));

    await expect(new CodexAdapter().createCompletion(baseInput())).resolves.toMatchObject({
      completion: {
        choices: [{ message: { content: 'done' } }],
      },
    });
  });
});

const mcpTool: OpenAI.ChatCompletionTool = {
  type: 'function',
  function: {
    name: 'mcp_hashed_name',
    description: 'Lists things',
    parameters: { type: 'object', properties: { q: { type: 'string' } } },
  },
};

describe('CodexAdapter — tool bridging', () => {
  it('exposes MCP tools on the bridge under readable names and wires the config', async () => {
    await new CodexAdapter().createCompletion(
      baseInput({
        tools: [mcpTool],
        toolNameMap: { mcp_hashed_name: { server: 'my-server', tool: 'list_things' } },
      }),
    );
    const cfg = (codexCtorMock.mock.calls[0][0] as { config: Record<string, unknown> }).config;
    expect(cfg).toEqual({
      service_tier: 'default',
      developer_instructions: CODEX_FLUJO_INSTRUCTIONS,
      features: { shell_tool: false },
      model_catalog_json: 'C:\\Users\\test\\.codex\\models_cache.json',
      mcp_servers: {
        flujo: {
          url: 'http://127.0.0.1:1234/mcp/testtoken',
          default_tools_approval_mode: 'approve',
        },
      },
    });
    expect(capturedBridgeTools.map(t => t.name)).toEqual(['my-server__list_things']);
    expect(capturedBridgeInstructions).toBe(CODEX_FLUJO_INSTRUCTIONS);
    // Raw JSON Schema passes through untouched (no Zod translation on this path).
    expect(capturedBridgeTools[0].inputSchema).toEqual(mcpTool.function.parameters);
    expect(bridgeCloseMock).toHaveBeenCalled();
  });

  it('preserves MCP annotations on the bridged tool', async () => {
    const annotations = {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    };
    await new CodexAdapter().createCompletion(
      baseInput({
        tools: [mcpTool],
        toolNameMap: {
          mcp_hashed_name: {
            server: 'filesystem',
            tool: 'list_things',
            annotations,
          },
        },
      }),
    );

    expect(capturedBridgeTools[0].annotations).toEqual(annotations);
  });

  it('dispatches a bridge call to mcpService and records the tool pair', async () => {
    callToolMock.mockResolvedValueOnce({ success: true, data: { content: [{ type: 'text', text: 'ok' }] } });
    runStreamedMock.mockImplementationOnce(async () => ({
      events: (async function* () {
        // Simulate the CLI calling the bridged tool mid-turn.
        yield { type: 'turn.started' };
        await capturedBridgeTools[0].handler({ q: 'x' });
        yield agentMessage('done');
        yield turnCompleted({ input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 });
      })(),
    }));

    const { transcript } = await new CodexAdapter().createCompletion(
      baseInput({
        tools: [mcpTool],
        toolNameMap: { mcp_hashed_name: { server: 'my-server', tool: 'list_things', timeout: 30 } },
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
    const roles = transcript!.map(m => m.role);
    // assistant(tool_call) + tool(result) + final assistant answer.
    expect(roles).toEqual(['assistant', 'tool', 'assistant']);
  });

  it('streams a pending tool call before the bridge result resolves', async () => {
    let resolveTool!: (value: { success: true; data: { content: Array<{ type: 'text'; text: string }> } }) => void;
    const toolResult = new Promise<{ success: true; data: { content: Array<{ type: 'text'; text: string }> } }>(
      resolve => { resolveTool = resolve; },
    );
    let notifyToolStarted!: () => void;
    const toolStarted = new Promise<void>(resolve => { notifyToolStarted = resolve; });
    callToolMock.mockImplementationOnce(async () => {
      notifyToolStarted();
      return toolResult;
    });
    runStreamedMock.mockImplementationOnce(async () => ({
      events: (async function* () {
        await capturedBridgeTools[0].handler({ payload: 'large value' });
        yield agentMessage('done');
        yield turnCompleted({ input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 });
      })(),
    }));
    const streamed: FlujoChatMessage[] = [];

    const completionPromise = new CodexAdapter().createCompletion(
      baseInput({
        tools: [mcpTool],
        toolNameMap: { mcp_hashed_name: { server: 'my-server', tool: 'list_things' } },
        onTranscriptMessage: message => streamed.push(message),
      }),
    );

    await toolStarted;
    expect(streamed.map(message => message.role)).toEqual(['assistant']);
    const pendingCall = streamed[0] as FlujoChatMessage & {
      tool_calls: OpenAI.ChatCompletionMessageToolCall[];
    };
    expect(pendingCall.tool_calls[0].function.arguments).toBe('{"payload":"large value"}');

    resolveTool({ success: true, data: { content: [{ type: 'text', text: 'ok' }] } });
    const { transcript } = await completionPromise;
    expect(streamed.map(message => message.role)).toEqual(['assistant', 'tool', 'assistant']);
    expect(transcript?.[1].role).toBe('tool');
    if (transcript?.[1].role === 'tool') {
      expect(transcript[1].tool_call_id).toBe(pendingCall.tool_calls[0].id);
    }
  });

  it('records the definition-advertised MCP App UI and ignores a result redirect', async () => {
    callToolMock.mockResolvedValueOnce({
      success: true,
      data: {
        content: [{ type: 'text', text: 'ok' }],
        _meta: { ui: { resourceUri: 'ui://unadvertised-redirect' } },
      },
    });
    runStreamedMock.mockImplementationOnce(async () => ({
      events: (async function* () {
        await capturedBridgeTools[0].handler({ q: 'x' });
        yield agentMessage('done');
        yield turnCompleted({ input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 });
      })(),
    }));

    const { transcript } = await new CodexAdapter().createCompletion(
      baseInput({
        tools: [mcpTool],
        toolNameMap: {
          mcp_hashed_name: {
            server: 'my-server',
            tool: 'list_things',
            uiResourceUri: 'ui://advertised-dashboard',
          },
        },
      }),
    );

    const toolMsg = transcript!.find(m => m.role === 'tool');
    expect(toolMsg?.ui).toEqual({
      uri: 'ui://advertised-dashboard',
      serverName: 'my-server',
      toolName: 'list_things',
    });
  });

  it('does not let result metadata introduce an unadvertised MCP App UI', async () => {
    callToolMock.mockResolvedValueOnce({
      success: true,
      data: {
        content: [{ type: 'text', text: 'ok' }],
        _meta: { ui: { resourceUri: 'ui://result-only-dashboard' } },
      },
    });
    runStreamedMock.mockImplementationOnce(async () => ({
      events: (async function* () {
        await capturedBridgeTools[0].handler({ q: 'x' });
        yield agentMessage('done');
        yield turnCompleted({ input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 });
      })(),
    }));

    const { transcript } = await new CodexAdapter().createCompletion(
      baseInput({
        tools: [mcpTool],
        toolNameMap: {
          mcp_hashed_name: {
            server: 'my-server',
            tool: 'list_things',
          },
        },
      }),
    );

    const toolMsg = transcript!.find(m => m.role === 'tool');
    expect(toolMsg?.ui).toBeUndefined();
    expect(loadServerConfigsMock).not.toHaveBeenCalled();
  });

  it('marks a timed-out MCP App invocation as cancelled in the transcript', async () => {
    callToolMock.mockResolvedValueOnce({
      success: false,
      error: 'Tool execution timed out after 30 seconds',
      errorType: 'timeout',
    });
    runStreamedMock.mockImplementationOnce(async () => ({
      events: (async function* () {
        await capturedBridgeTools[0].handler({ q: 'x' });
        yield agentMessage('done');
        yield turnCompleted({ input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 });
      })(),
    }));

    const { transcript } = await new CodexAdapter().createCompletion(
      baseInput({
        tools: [mcpTool],
        toolNameMap: {
          mcp_hashed_name: {
            server: 'my-server',
            tool: 'list_things',
            uiResourceUri: 'ui://advertised-dashboard',
          },
        },
      }),
    );

    const toolMsg = transcript!.find(m => m.role === 'tool');
    expect(toolMsg?.ui).toEqual({
      uri: 'ui://advertised-dashboard',
      serverName: 'my-server',
      toolName: 'list_things',
      cancelledReason: 'Tool execution timed out after 30 seconds',
      isError: true,
    });
  });

  it('does not duplicate a completed bridged tool pair when continuing', async () => {
    const close = 'Connection closed mid-response. The response above may be incomplete.';
    callToolMock.mockResolvedValueOnce({ success: true, data: { content: [{ type: 'text', text: 'ok' }] } });
    runStreamedMock
      .mockImplementationOnce(async () => ({
        events: (async function* () {
          await capturedBridgeTools[0].handler({ q: 'x' });
          yield { type: 'turn.failed', error: { message: close } };
        })(),
      }))
      .mockImplementationOnce(async () => ({
        events: eventStream([agentMessage('continued'), turnCompleted({ input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 })])(),
      }));

    const { transcript } = await new CodexAdapter().createCompletion(
      baseInput({ tools: [mcpTool], toolNameMap: { mcp_hashed_name: { server: 'my-server', tool: 'list_things' } } }),
    );

    expect(callToolMock).toHaveBeenCalledTimes(1);
    expect(transcript!.filter(m => m.role === 'tool')).toHaveLength(1);
  });

  it('a rejected approval never dispatches and surfaces the feedback (#247)', async () => {
    const approvals = jest.fn(async () => ({ approved: false, feedback: 'wrong target' }));
    runStreamedMock.mockImplementationOnce(async () => ({
      events: (async function* () {
        const res = await capturedBridgeTools[0].handler({ q: 'x' });
        expect(res.isError).toBe(true);
        yield agentMessage('adjusted');
        yield turnCompleted({ input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 });
      })(),
    }));

    const { transcript } = await new CodexAdapter().createCompletion(
      baseInput({
        tools: [mcpTool],
        toolNameMap: {
          mcp_hashed_name: {
            server: 'my-server',
            tool: 'list_things',
            uiResourceUri: 'ui://advertised-dashboard',
          },
        },
        requestToolApproval: approvals,
      }),
    );

    expect(callToolMock).not.toHaveBeenCalled();
    const callMsg = transcript!.find(
      m => m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0,
    ) as (FlujoChatMessage & {
      role: 'assistant';
      tool_calls: OpenAI.ChatCompletionMessageToolCall[];
    }) | undefined;
    const toolMsg = transcript!.find(m => m.role === 'tool')!;
    expect(callMsg?.tool_calls).toHaveLength(1);
    expect(toolMsg.role === 'tool' ? toolMsg.tool_call_id : undefined).toBe(callMsg?.tool_calls?.[0].id);
    expect(toolMsg.content).toContain('User rejected this tool call: wrong target');
    expect(toolMsg.ui).toEqual({
      uri: 'ui://advertised-dashboard',
      serverName: 'my-server',
      toolName: 'list_things',
      cancelledReason: 'User rejected this tool call: wrong target',
      isError: true,
    });
  });

  it('a plain handoff ends the run and surfaces as a routing tool_call', async () => {
    const handoffTool: OpenAI.ChatCompletionTool = {
      type: 'function',
      function: { name: 'handoff_to_finish', description: 'Finish', parameters: { type: 'object', properties: {} } },
    };
    runStreamedMock.mockImplementationOnce(async () => ({
      events: (async function* () {
        await capturedBridgeTools[0].handler({});
        // Post-handoff narration must NOT become the node's answer.
        yield agentMessage('now handing off…');
        yield turnCompleted({ input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 });
      })(),
    }));

    const { completion } = await new CodexAdapter().createCompletion(baseInput({ tools: [handoffTool] }));
    expect(completion.choices[0].finish_reason).toBe('tool_calls');
    expect(completion.choices[0].message.tool_calls?.[0].function.name).toBe('handoff_to_finish');
    expect(completion.choices[0].message.content).toBeNull();
  });
});

describe('CodexAdapter — SDK thread reuse', () => {
  it('resumes the same conversation/node with only the appended message delta', async () => {
    runStreamedMock
      .mockImplementationOnce(async () => ({
        events: eventStream([
          threadStarted('thread-123'),
          agentMessage('first answer'),
          turnCompleted({ input_tokens: 2, cached_input_tokens: 0, output_tokens: 1 }),
        ])(),
      }))
      .mockImplementationOnce(async () => ({
        events: eventStream([
          threadStarted('thread-123'),
          agentMessage('second answer'),
          turnCompleted({ input_tokens: 2, cached_input_tokens: 0, output_tokens: 1 }),
        ])(),
      }));

    await new CodexAdapter().createCompletion(
      baseInput({
        conversationId: 'conversation-1',
        nodeId: 'process-1',
        sessionResume: true,
      }),
    );
    await new CodexAdapter().createCompletion(
      baseInput({
        conversationId: 'conversation-1',
        nodeId: 'process-1',
        sessionResume: true,
        messages: [
          { role: 'user', content: 'hi' },
          { role: 'assistant', content: 'first answer' },
          { role: 'user', content: 'next' },
        ] as OpenAI.ChatCompletionMessageParam[],
      }),
    );

    expect(startThreadMock).toHaveBeenCalledTimes(1);
    expect(resumeThreadMock).toHaveBeenCalledWith(
      'thread-123',
      expect.objectContaining({
        workingDirectory: 'C:\\flujo\\db\\codex-runtime\\workspace',
        sandboxMode: 'read-only',
      }),
    );
    expect(runStreamedMock.mock.calls[1][0]).toBe('next');
  });

  it('starts fresh when FLUJO history diverges from the stored thread watermark', async () => {
    runStreamedMock
      .mockImplementationOnce(async () => ({
        events: eventStream([
          threadStarted('thread-original'),
          agentMessage('original answer'),
          turnCompleted({ input_tokens: 2, cached_input_tokens: 0, output_tokens: 1 }),
        ])(),
      }))
      .mockImplementationOnce(async () => ({
        events: eventStream([
          threadStarted('thread-rebuilt'),
          agentMessage('rebuilt answer'),
          turnCompleted({ input_tokens: 2, cached_input_tokens: 0, output_tokens: 1 }),
        ])(),
      }));

    const identity = {
      conversationId: 'conversation-diverged',
      nodeId: 'process-1',
      sessionResume: true,
    };
    await new CodexAdapter().createCompletion(baseInput(identity));
    await new CodexAdapter().createCompletion(
      baseInput({
        ...identity,
        messages: [
          { role: 'user', content: 'hi' },
          { role: 'assistant', content: 'rewritten answer' },
          { role: 'user', content: 'next' },
        ] as OpenAI.ChatCompletionMessageParam[],
      }),
    );

    expect(startThreadMock).toHaveBeenCalledTimes(2);
    expect(resumeThreadMock).not.toHaveBeenCalled();
    expect(runStreamedMock.mock.calls[1][0]).toEqual(
      expect.stringContaining('rewritten answer'),
    );
  });
});
