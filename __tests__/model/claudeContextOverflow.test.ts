import type { SharedState } from '@/backend/execution/flow/types';
import type { FlujoChatMessage } from '@/shared/types/chat';

const queryMock = jest.fn();
const getModelMock = jest.fn();
const resolveKeyMock = jest.fn();
const callToolMock = jest.fn();
const writeRunResourceMock = jest.fn();

jest.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (...args: unknown[]) => queryMock(...args),
  createSdkMcpServer: (config: unknown) => ({ __server: config }),
  tool: (name: string, description: string, shape: unknown, handler: unknown) => ({
    name, description, shape, handler,
  }),
}));
jest.mock('@/backend/services/model/adapters', () => ({
  getCompletionAdapter: () => {
    const { ClaudeSubscriptionAdapter } = jest.requireActual(
      '@/backend/services/model/adapters/claudeSubscriptionAdapter',
    );
    return new ClaudeSubscriptionAdapter();
  },
}));
jest.mock('@/backend/services/model', () => ({
  modelService: {
    getModel: (...args: unknown[]) => getModelMock(...args),
    resolveAndDecryptApiKey: (...args: unknown[]) => resolveKeyMock(...args),
  },
}));
jest.mock('@/backend/services/mcp', () => ({
  mcpService: {
    callTool: (...args: unknown[]) => callToolMock(...args),
    listServerTools: jest.fn(async () => ({ tools: [] })),
  },
}));
jest.mock('@/utils/storage/backend', () => ({
  ...jest.requireActual('@/utils/storage/backend'),
  loadItem: jest.fn(async (_key: unknown, fallback: unknown) => fallback),
}));
jest.mock('@/backend/execution/flow/FlowExecutor', () => ({
  FlowExecutor: {
    get conversationStates() {
      return jest.requireActual('@/backend/execution/flow/conversationStateRegistry').getConversationStates();
    },
  },
}));
jest.mock('@/backend/execution/flow/persistConversationState', () => ({
  persistConversationState: jest.fn(async () => undefined),
}));
jest.mock('@/backend/services/runResources', () => ({
  listRunResources: jest.fn(async () => []),
  writeRunResource: (...args: unknown[]) => writeRunResourceMock(...args),
  getRunResourceSettings: jest.fn(async () => ({
    autoCaptureEnabled: true,
    textThresholdChars: 8192,
    toolResultTruncationEnabled: true,
    toolResultMaxBytes: 50_000,
    toolResultMaxLines: 2000,
    maxResourceBytes: 50 * 1024 * 1024,
    maxConversationBytes: 256 * 1024 * 1024,
  })),
}));
jest.mock('@/backend/services/model/adapters/claudeRuntimeHome', () => ({
  prepareClaudeRuntimeEnvironment: jest.fn(async () => ({
    home: 'C:\\flujo\\test-claude-runtime',
    workingDirectory: 'C:\\flujo\\test-claude-runtime\\workspace',
    env: { PATH: 'C:\\Windows', CLAUDE_CONFIG_DIR: 'C:\\flujo\\test-claude-runtime' },
  })),
}));
jest.mock('@/backend/services/model/adapters/claudeSessionPersistence', () => ({
  ...jest.requireActual('@/backend/services/model/adapters/claudeSessionPersistence'),
  hasClaudeSessionTranscript: jest.fn(async () => true),
  captureClaudeSessionTranscript: jest.fn(async () => ({ bytes: 123, records: 2, sha256: 'a'.repeat(64) })),
}));

import { ModelHandler } from '@/backend/execution/flow/handlers/ModelHandler';
import { FlowExecutor } from '@/backend/execution/flow/FlowExecutor';
import { flushConversationLog } from '@/backend/execution/flow/conversationLog';
import { _clearAllSessionsForTests } from '@/backend/services/model/adapters/claudeSessionStore';

const conversationStates = FlowExecutor.conversationStates as Map<string, SharedState>;
type SdkTool = { name: string; handler: (args: Record<string, unknown>) => Promise<unknown> };
type QueryInput = {
  prompt: AsyncGenerator<{ message: { content: unknown } }>;
  options: {
    abortController: AbortController;
    canUseTool: (name: string, args: Record<string, unknown>, options: { toolUseID: string; signal: AbortSignal }) => Promise<{ behavior: string }>;
    mcpServers: { flujo: { __server: { tools: SdkTool[] } } };
  };
};

let prompts: string[];

function history(): FlujoChatMessage[] {
  return [
    { id: 'original-user', role: 'user', content: 'Preserve the receipt and never repeat a completed action.', timestamp: 1 },
    ...Array.from({ length: 12 }, (_, index) => ({
      id: `old-assistant-${index}`, role: 'assistant' as const,
      content: `Historical observation ${index}: ${'x'.repeat(4_000)}`, timestamp: index + 2,
    })),
    { id: 'current-user', role: 'user', content: 'Continue the current task.', timestamp: 20 },
  ];
}

function seedState(conversationId: string, messages: FlujoChatMessage[]): SharedState & { conversationId: string } {
  const state = {
    trackingInfo: { executionId: 'execution-1', startTime: 1, nodeExecutionTracker: [] },
    messages: structuredClone(messages), flowId: 'flow-1', conversationId,
    status: 'running', title: 'Claude overflow fixture', createdAt: 1, updatedAt: 1,
  } as unknown as SharedState & { conversationId: string };
  conversationStates.set(conversationId, state);
  return state;
}

const complete = (conversationId: string, messages: FlujoChatMessage[],
  overrides: Partial<Parameters<typeof ModelHandler.callModel>[0]> = {}) => ModelHandler.callModel({
  modelId: 'claude-model', prompt: '', messages, iteration: 1, maxIterations: 1,
  nodeName: 'Claude', nodeId: 'node-1', conversationId,
  compactionMode: 'off', archiveModelTurns: false, ...overrides,
});

function assistantFrame(text: string, error?: string) {
  return {
    type: 'assistant', uuid: 'sdk-assistant-frame', session_id: 'session-1',
    ...(error ? { error } : {}),
    message: { id: 'api-assistant-frame', role: 'assistant', content: [{ type: 'text', text }] },
  };
}

function terminal(result = 'recovered') {
  return {
    type: 'result', subtype: 'success', result, session_id: 'session-1',
    usage: { input_tokens: 10, output_tokens: 1 },
    modelUsage: { sonnet: { inputTokens: 10, outputTokens: 1 } },
  };
}

function stream(frames: unknown[], beforeFrames?: (input: QueryInput) => Promise<void>) {
  return (input: QueryInput) => (async function* () {
    const first = await input.prompt.next();
    prompts.push(JSON.stringify(first.value?.message.content));
    await beforeFrames?.(input);
    yield* frames;
  })();
}

beforeEach(() => {
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  queryMock.mockReset();
  getModelMock.mockReset().mockResolvedValue({
    id: 'claude-model', name: 'sonnet', provider: 'claude-subscription', adapter: 'claude-cli',
    // Intentionally overstated: a provider rejection must still force a smaller retry.
    contextWindow: 1_000_000,
  });
  resolveKeyMock.mockReset().mockResolvedValue('fixture-oauth-token');
  callToolMock.mockReset().mockResolvedValue({
    success: true, data: { content: [{ type: 'text', text: 'Committed receipt exact-receipt-123.' }] },
  });
  writeRunResourceMock.mockReset().mockResolvedValue({
    uri: 'flujo://run/test-conversation/test-resource', kind: 'text', size: 1,
  });
  conversationStates.clear();
  _clearAllSessionsForTests();
  prompts = [];
});

afterEach(async () => {
  await Promise.all([...conversationStates.keys()].map(id => flushConversationLog(id)));
  conversationStates.clear();
  jest.restoreAllMocks();
});

describe('Claude SDK context rejection through ModelHandler', () => {
  it.each(['assistant diagnostic', 'terminal reason'] as const)(
    'shrinks the rejected wire and recovers from an SDK %s without publishing diagnostic prose', async variant => {
      const messages = history();
      const original = structuredClone(messages);
      const state = seedState(`overflow-${variant.replaceAll(' ', '-')}`, messages);
      const rejectedTerminal = { ...terminal(''), terminal_reason: 'prompt_too_long' };
      queryMock.mockImplementationOnce(stream(variant === 'assistant diagnostic'
        ? [assistantFrame('Prompt is too long', 'invalid_request'), rejectedTerminal]
        : [rejectedTerminal]));
      queryMock.mockImplementationOnce(stream([terminal()]));

      const result = await complete(state.conversationId, messages);

      expect(result.success).toBe(true);
      expect(queryMock).toHaveBeenCalledTimes(2);
      expect(prompts[1].length).toBeLessThan(prompts[0].length);
      expect(prompts[1]).toContain('[FLUJO emergency context compaction]');
      expect(prompts[1]).toContain('never repeat a completed action');
      expect(prompts[1]).toContain('Continue the current task.');
      expect(messages).toEqual(original);
      expect(state.messages.some(message => message.content === 'Prompt is too long')).toBe(false);
      if (!result.success) throw new Error('Expected recovered completion');
      expect(result.value.content).toBe('recovered');
      expect(result.value.messages.slice(0, messages.length)).toEqual(original);
      expect(result.value.messages.slice(messages.length).some(message => message.content === 'Prompt is too long')).toBe(false);
      expect(callToolMock).not.toHaveBeenCalled();
    },
  );

  it('retains an executed tool pair and never replays the SDK invocation after a later overflow', async () => {
    const messages = history();
    const original = structuredClone(messages);
    const state = seedState('overflow-after-effect', messages);
    queryMock.mockImplementationOnce(stream([
      assistantFrame('Prompt is too long', 'invalid_request'),
      { ...terminal(''), terminal_reason: 'prompt_too_long' },
    ], async ({ options }) => {
      const decision = await options.canUseTool('mcp__flujo__ledger__commit', {}, {
        toolUseID: 'executed-call', signal: options.abortController.signal,
      });
      expect(decision.behavior).toBe('allow');
      const tool = options.mcpServers.flujo.__server.tools.find(entry => entry.name === 'ledger__commit');
      expect(tool).toBeDefined();
      await tool!.handler({});
    }));

    const result = await complete(state.conversationId, messages, {
      tools: [{ type: 'function', function: { name: 'commit_effect', parameters: { type: 'object', properties: {} } } }],
      toolNameMap: { commit_effect: { server: 'ledger', tool: 'commit' } },
    });

    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected the original provider rejection');
    expect(result.error.message).toContain('Prompt is too long');
    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(callToolMock).toHaveBeenCalledTimes(1);
    expect(callToolMock).toHaveBeenCalledWith('ledger', 'commit', {}, expect.anything(),
      expect.anything(), undefined, expect.any(AbortSignal), 'model', expect.anything(),
      { conversationId: state.conversationId });
    expect(messages).toEqual(original);
    expect(state.messages.filter(message => message.role === 'assistant' && message.tool_calls?.some(call => call.id === 'executed-call'))).toHaveLength(1);
    const results = state.messages.filter(message => message.role === 'tool' && message.tool_call_id === 'executed-call');
    expect(results).toHaveLength(1);
    expect(results[0].content).toContain('exact-receipt-123');
    expect(state.messages.some(message => message.content === 'Prompt is too long')).toBe(false);
  });

  it('retains genuine assistant text with the same wording when the SDK does not mark it as an error', async () => {
    const messages = history();
    const state = seedState('ordinary-text', messages);
    queryMock.mockImplementationOnce(stream([assistantFrame('Prompt is too long'), terminal('Prompt is too long')]));

    const result = await complete(state.conversationId, messages);

    expect(result.success).toBe(true);
    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(state.messages.filter(message => message.role === 'assistant' && message.content === 'Prompt is too long')).toHaveLength(1);
    if (!result.success) throw new Error('Expected ordinary assistant prose');
    expect(result.value.content).toBe('Prompt is too long');
    expect(result.value.messages.some(message => message.role === 'assistant' && message.content === 'Prompt is too long')).toBe(true);
  });
});
