/**
 * Issue #1408: the Claude subscription adapter with the opt-in parked process.
 * Off, nothing changes. On, a finished request parks one process with its exact
 * start-up options; the next request with the same options uses it instead of
 * starting Claude Code, and a request for another account never does.
 */
import type OpenAI from 'openai';
import type { CompletionInput } from '@/backend/services/model/adapters/types';

const queryMock = jest.fn();
const prewarmMock = jest.fn();
const sdkServers: Array<{ tools?: Array<{ name: string; handler: (args: Record<string, unknown>, extra: unknown) => Promise<unknown> }> }> = [];

jest.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (...a: unknown[]) => queryMock(...(a as [])),
  prewarm: (...a: unknown[]) => prewarmMock(...(a as [])),
  createSdkMcpServer: (cfg: (typeof sdkServers)[number]) => { sdkServers.push(cfg); return { __server: cfg }; },
  tool: (name: string, description: string, shape: unknown, handler: unknown) => ({ name, description, shape, handler }),
}));
jest.mock('@/backend/services/mcp', () => ({ mcpService: {} }));
jest.mock('@/backend/services/runResources', () => ({ getRunResourceSettings: jest.fn(async () => ({})) }));
jest.mock('@/backend/services/model/adapters/claudeRuntimeHome', () => ({
  prepareClaudeRuntimeEnvironment: jest.fn(async () => ({
    home: '/flujo/db/claude-runtime',
    workingDirectory: '/flujo/db/claude-runtime/workspace',
    // Like the real runtime, pass on this process's environment (here only the
    // variable the SDK adds on its first query).
    env: { PATH: '/usr/bin', CLAUDE_CONFIG_DIR: '/flujo/db/claude-runtime',
      ...(process.env.CLAUDE_AGENT_SDK_VERSION ? { CLAUDE_AGENT_SDK_VERSION: process.env.CLAUDE_AGENT_SDK_VERSION } : {}) },
  })),
}));
const loadItemMock = jest.fn(async () => undefined);
jest.mock('@/utils/storage/backend', () => ({
  ...jest.requireActual('@/utils/storage/backend'),
  loadItem: (...args: unknown[]) => loadItemMock(...(args as [])),
}));

import { ClaudeSubscriptionAdapter } from '@/backend/services/model/adapters/claudeSubscriptionAdapter';
import { _claudeSpareCountForTests, closeAllClaudeSpares } from '@/backend/services/model/adapters/claudeWarmProcess';

function successStream(text = 'order') {
  return (async function* () {
    yield { type: 'result', subtype: 'success', result: text, session_id: 'sess-1', usage: { input_tokens: 1, output_tokens: 1 } };
  })();
}

function fakeSpareProcess() {
  const process = {
    prompts: [] as unknown[],
    claim: jest.fn(({ prompt }: { prompt: AsyncIterable<unknown> }) => {
      void (async () => { for await (const message of prompt) { process.prompts.push(message); break; } })();
      return successStream('order (warm)');
    }),
    claimed: Promise.resolve({ cwd: '/flujo/db/claude-runtime/workspace', sessionId: 'warm', sdkMcpSettled: true }),
    exited: new Promise<void>(() => undefined),
    close: jest.fn(),
  };
  return process;
}

const input = (overrides: Partial<CompletionInput> = {}): CompletionInput => ({
  model: { id: 'm1', name: 'haiku', provider: 'claude-subscription' },
  apiKey: 'oauth-token',
  messages: [{ role: 'user', content: 'Where is my order A-1?' }] as OpenAI.ChatCompletionMessageParam[],
  systemPrompt: 'Answer with one word.',
  localToolExecutors: { lookup: jest.fn(async () => ({ success: true, content: 'shipped' })) },
  tools: [{ type: 'function', function: { name: 'lookup', description: 'Look up an order', parameters: { type: 'object', properties: {} } } }],
  ...overrides,
} as unknown as CompletionInput);

const settle = () => new Promise(resolve => setImmediate(resolve));
let spares: Array<ReturnType<typeof fakeSpareProcess>>;

beforeEach(() => {
  queryMock.mockReset().mockImplementation(() => successStream());
  spares = [];
  prewarmMock.mockReset().mockImplementation(async () => { const spare = fakeSpareProcess(); spares.push(spare); return spare; });
  sdkServers.length = 0;
  loadItemMock.mockReset().mockResolvedValue(undefined);
});
afterEach(() => {
  closeAllClaudeSpares();
});

it('reuses a parked process only for the same start-up options', async () => {
  const adapter = new ClaudeSubscriptionAdapter();

  const first = await adapter.createCompletion(input());
  expect(first.completion.choices[0].message.content).toBe('order');
  expect(queryMock).toHaveBeenCalledTimes(1);
  expect(prewarmMock).toHaveBeenCalledTimes(1);

  // The parked process gets the same options a normal start would, except
  // that its callbacks belong to no request yet.
  const coldOptions = queryMock.mock.calls[0][0].options as Record<string, unknown>;
  const parkedOptions = prewarmMock.mock.calls[0][0].options as Record<string, unknown>;
  for (const name of ['model', 'env', 'cwd', 'systemPrompt', 'tools', 'disallowedTools', 'settingSources', 'permissionMode', 'maxTurns']) {
    expect(parkedOptions[name]).toEqual(coldOptions[name]);
  }
  expect((coldOptions.env as Record<string, string>).ENABLE_CLAUDEAI_MCP_SERVERS).toBe('false');
  // The same hook events, so a parked process also stops after a hand-off (#1414).
  expect(Object.keys(coldOptions.hooks as object).sort()).toEqual(['PostToolBatch', 'PreToolUse']);
  expect(Object.keys(parkedOptions.hooks as object).sort()).toEqual(['PostToolBatch', 'PreToolUse']);
  expect(parkedOptions.canUseTool).not.toBe(coldOptions.canUseTool);
  expect(parkedOptions.abortController).not.toBe(coldOptions.abortController);
  const parkedTool = sdkServers.at(-1)!.tools!.find(tool => tool.name === 'lookup')!;
  await expect(parkedTool.handler({}, {})).resolves.toMatchObject({ isError: true });
  await expect((parkedOptions.canUseTool as (n: string, i: object, o: object) => Promise<unknown>)(
    'mcp__flujo__lookup', {}, { signal: new AbortController().signal, toolUseID: 'x' },
  )).resolves.toMatchObject({ behavior: 'deny' });

  const second = await adapter.createCompletion(input());
  await settle();
  expect(second.completion.choices[0].message.content).toBe('order (warm)');
  expect(queryMock).toHaveBeenCalledTimes(1);
  expect(spares[0].claim).toHaveBeenCalledTimes(1);
  expect(spares[0].claim.mock.calls[0][0]).toMatchObject({ options: { cwd: '/flujo/db/claude-runtime/workspace' } });
  expect(spares[0].prompts).toEqual([expect.objectContaining({
    type: 'user', message: expect.objectContaining({ content: 'Where is my order A-1?' }),
  })]);
  // The next request of this shape gets a new process, never the used one.
  expect(prewarmMock).toHaveBeenCalledTimes(2);

  // Another account has a different key: it starts Claude Code itself.
  await adapter.createCompletion(input({ apiKey: 'another-account' }));
  expect(queryMock).toHaveBeenCalledTimes(2);
  expect(spares[1].claim).not.toHaveBeenCalled();
});

it('starts Claude Code normally when the parked process refuses the claim', async () => {
  prewarmMock.mockImplementationOnce(async () => {
    const spare = fakeSpareProcess();
    const refused = Promise.reject(new Error('cwd_not_found'));
    refused.catch(() => undefined);
    Object.assign(spare, { claimed: refused });
    spares.push(spare);
    return spare;
  });
  const adapter = new ClaudeSubscriptionAdapter();
  await adapter.createCompletion(input());
  const result = await adapter.createCompletion(input());
  await settle();
  expect(result.completion.choices[0].message.content).toBe('order');
  expect(queryMock).toHaveBeenCalledTimes(2);
  expect(spares[0].prompts).toEqual([]);
  expect(spares[0].close).toHaveBeenCalled();
});

function streamThatWaitsForExit(exit: Promise<void>) {
  const returned = jest.fn(() => exit.then(() => ({ done: true as const, value: undefined })));
  const inner = (async function* () {
    yield { type: 'result', subtype: 'success', result: 'order', session_id: 'sess-1', usage: { input_tokens: 1, output_tokens: 1 } };
    await new Promise(() => undefined);
  })();
  return { returned, stream: { [Symbol.asyncIterator]: () => ({ next: () => inner.next(), return: returned }) } };
}

it('answers without waiting for the used process to exit', async () => {
  const { returned, stream } = streamThatWaitsForExit(new Promise(() => undefined));
  queryMock.mockImplementation(() => stream);
  const result = await new ClaudeSubscriptionAdapter().createCompletion(input());
  expect(result.completion.choices[0].message.content).toBe('order');
  expect(returned).toHaveBeenCalledTimes(1);
});

it('uses the first parked process although the SDK adds its version to the environment', async () => {
  delete process.env.CLAUDE_AGENT_SDK_VERSION;
  queryMock.mockImplementation(() => { process.env.CLAUDE_AGENT_SDK_VERSION = '0.3.312'; return successStream(); });
  try {
    const adapter = new ClaudeSubscriptionAdapter();
    await adapter.createCompletion(input());
    const second = await adapter.createCompletion(input());
    expect(second.completion.choices[0].message.content).toBe('order (warm)');
    expect(queryMock).toHaveBeenCalledTimes(1);
  } finally {
    delete process.env.CLAUDE_AGENT_SDK_VERSION;
  }
});
