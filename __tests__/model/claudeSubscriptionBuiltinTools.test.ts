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

// Capture the options the adapter passes to the Agent SDK's query().
const queryMock = jest.fn();

// Mock the ESM Agent SDK so it is never really loaded (that ESM load is the very
// reason the adapter imports it lazily). createSdkMcpServer/tool return inert
// stand-ins — we only care about the options handed to query().
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

// The adapter imports mcpService at module scope; stub it (a tools-less run never
// calls it, but we must not drag in its dependency graph).
jest.mock('@/backend/services/mcp', () => ({
  mcpService: { callTool: jest.fn() },
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
  queryMock.mockImplementation(() => successStream());
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
    const tools: OpenAI.ChatCompletionTool[] = [
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
