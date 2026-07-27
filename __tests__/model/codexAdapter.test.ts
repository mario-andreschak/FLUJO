/**
 * Unit tests for the Codex adapter (issue #301) — the Codex-SDK sibling of the
 * Claude Subscription adapter. The SDK and the loopback tool bridge are mocked;
 * these tests pin down the adapter's contract:
 *   - thread options harden the run (read-only sandbox, never-ask approvals,
 *     scratch working dir) and the API key is omitted when empty (codex login).
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

const codexCtorMock = jest.fn();
const startThreadMock = jest.fn();
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
    },
  }),
  { virtual: true },
);

// Capture the tools handed to the bridge instead of opening a real socket.
const bridgeCloseMock = jest.fn(async () => undefined);
let capturedBridgeTools: BridgeTool[] = [];
jest.mock('@/backend/services/model/adapters/codexToolBridge', () => ({
  startCodexToolBridge: jest.fn(async (tools: BridgeTool[]) => {
    capturedBridgeTools = tools;
    return { url: 'http://127.0.0.1:1234/mcp/testtoken', close: bridgeCloseMock };
  }),
}));

const callToolMock = jest.fn();
jest.mock('@/backend/services/mcp', () => ({
  mcpService: { callTool: (...a: unknown[]) => callToolMock(...(a as [])) },
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

import { CodexAdapter } from '@/backend/services/model/adapters/codexAdapter';

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
  runStreamedMock.mockReset();
  callToolMock.mockReset();
  bridgeCloseMock.mockClear();
  capturedBridgeTools = [];
  runStreamedMock.mockImplementation(async () => ({
    events: eventStream([
      agentMessage('hello from codex'),
      turnCompleted({ input_tokens: 100, cached_input_tokens: 40, output_tokens: 7 }),
    ])(),
  }));
});

describe('CodexAdapter — thread setup', () => {
  it('hardens the thread: read-only sandbox, never-ask approvals, scratch cwd', async () => {
    await new CodexAdapter().createCompletion(baseInput());

    expect(startThreadMock).toHaveBeenCalledTimes(1);
    const opts = startThreadMock.mock.calls[0][0] as Record<string, unknown>;
    expect(opts.model).toBe('gpt-5.5');
    expect(opts.sandboxMode).toBe('read-only');
    expect(opts.approvalPolicy).toBe('never');
    expect(opts.skipGitRepoCheck).toBe(true);
    expect(typeof opts.workingDirectory).toBe('string');
  });

  it('passes the API key when present and omits it when empty (codex login)', async () => {
    await new CodexAdapter().createCompletion(baseInput());
    expect((codexCtorMock.mock.calls[0][0] as Record<string, unknown>).apiKey).toBe('sk-test');

    codexCtorMock.mockClear();
    await new CodexAdapter().createCompletion(baseInput({ apiKey: '' }));
    expect('apiKey' in (codexCtorMock.mock.calls[0][0] as Record<string, unknown>)).toBe(false);
  });

  it('uses Codex local model catalog to avoid a failing online refresh', async () => {
    await new CodexAdapter().createCompletion(baseInput());
    const opts = codexCtorMock.mock.calls[0][0] as Record<string, unknown>;
    expect(opts.config).toEqual({
      model_catalog_json: 'C:\\Users\\test\\.codex\\models_cache.json',
    });
    expect(capturedBridgeTools).toEqual([]);
  });

  it('prepends the system prompt to the flattened input', async () => {
    await new CodexAdapter().createCompletion(
      baseInput({
        messages: [
          { role: 'system', content: 'You are terse.' },
          { role: 'user', content: 'hi' },
        ] as OpenAI.ChatCompletionMessageParam[],
      }),
    );
    const input = runStreamedMock.mock.calls[0][0] as string;
    expect(input).toContain('<system_instructions>\nYou are terse.\n</system_instructions>');
    expect(input).toContain('hi');
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

  it('throws on turn.failed', async () => {
    runStreamedMock.mockImplementationOnce(async () => ({
      events: eventStream([{ type: 'turn.failed', error: { message: 'boom' } }])(),
    }));
    await expect(new CodexAdapter().createCompletion(baseInput())).rejects.toThrow(/boom/);
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
      model_catalog_json: 'C:\\Users\\test\\.codex\\models_cache.json',
      mcp_servers: { flujo: { url: 'http://127.0.0.1:1234/mcp/testtoken' } },
    });
    expect(capturedBridgeTools.map(t => t.name)).toEqual(['my-server__list_things']);
    // Raw JSON Schema passes through untouched (no Zod translation on this path).
    expect(capturedBridgeTools[0].inputSchema).toEqual(mcpTool.function.parameters);
    expect(bridgeCloseMock).toHaveBeenCalled();
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

    expect(callToolMock).toHaveBeenCalledWith('my-server', 'list_things', { q: 'x' }, 30, undefined, undefined);
    const roles = transcript!.map(m => m.role);
    // assistant(tool_call) + tool(result) + final assistant answer.
    expect(roles).toEqual(['assistant', 'tool', 'assistant']);
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
        toolNameMap: { mcp_hashed_name: { server: 'my-server', tool: 'list_things' } },
        requestToolApproval: approvals,
      }),
    );

    expect(callToolMock).not.toHaveBeenCalled();
    const toolMsg = transcript!.find(m => m.role === 'tool') as { content: string };
    expect(toolMsg.content).toContain('User rejected this tool call: wrong target');
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
