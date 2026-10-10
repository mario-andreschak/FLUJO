/** SDK/bridge boundary tests, not proof of the native CLI's advertised tool inventory. */
import type { CompletionInput } from '@/backend/services/model/adapters/types';
import type { BridgeTool } from '@/backend/services/model/adapters/codexToolBridge';
import { CodexAdapter } from '@/backend/services/model/adapters/codexAdapter';
import { RESTRICTED_CODEX_CONFIG, RESTRICTED_CODEX_THREAD_OPTIONS } from '@/backend/services/model/adapters/codexRestrictedProfile';
import { registerExecutionExtension } from '@/backend/execution/extensions';
import { fixtureAdapter, fixtureRun, mintFixture, type FixtureRun } from './fixtureAdapter';
import { recordStatisticsEvent } from '@/backend/services/statistics';

const mockCtor = jest.fn(); const mockStart = jest.fn(); const mockResume = jest.fn(); const mockStream = jest.fn();
const mockCheckProfile = jest.fn(); const mockRuntime = jest.fn(); const mockCleanup = jest.fn();
const mockCallTool = jest.fn(); const mockBridgeClose = jest.fn();
let mockBridgeTools: BridgeTool[] = [];
const mockLog = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(), verbose: jest.fn() };
jest.mock('@/utils/logger', () => ({ createLogger: () => ({
  debug: (...args: unknown[]) => mockLog.debug(...args), info: (...args: unknown[]) => mockLog.info(...args),
  warn: (...args: unknown[]) => mockLog.warn(...args), error: (...args: unknown[]) => mockLog.error(...args),
  verbose: (...args: unknown[]) => mockLog.verbose(...args),
}) }));
jest.mock('@openai/codex-sdk', () => ({ Codex: class {
  constructor(options: unknown) { mockCtor(options); }
  startThread(options: unknown) { mockStart(options); return { runStreamed: mockStream }; }
  resumeThread(...args: unknown[]) { mockResume(...args); return { runStreamed: mockStream }; }
} }), { virtual: true });
jest.mock('@/backend/services/model/adapters/codexRestrictedProfile', () => ({
  ...jest.requireActual('@/backend/services/model/adapters/codexRestrictedProfile'),
  assertRestrictedCodexProfile: (...args: unknown[]) => mockCheckProfile(...args),
  prepareRestrictedCodexRuntimeEnvironment: (...args: unknown[]) => mockRuntime(...args),
}));
jest.mock('@/backend/services/model/adapters/codexToolBridge', () => ({ startCodexToolBridge: async (tools: BridgeTool[]) => {
  mockBridgeTools = tools; return { url: 'http://127.0.0.1:1234/fixture-only', close: mockBridgeClose };
} }));
jest.mock('@/backend/services/model/adapters/codexRuntimeHome', () => ({ prepareCodexRuntimeEnvironment: jest.fn(async () => { throw new Error('ordinary home forbidden'); }) }));
jest.mock('@/backend/services/model/adapters/codexModelCatalog', () => ({ prepareCodexModelCatalogSnapshot: jest.fn(async () => { throw new Error('ordinary catalogue forbidden'); }) }));
jest.mock('@/backend/services/model/adapters/codexContextUsage', () => ({ readCodexTokenSnapshot: jest.fn() }));
jest.mock('@/backend/services/mcp', () => ({ mcpService: {
  callTool: (...args: unknown[]) => mockCallTool(...args), loadServerConfigs: jest.fn(async () => []),
  listServerTools: jest.fn(async () => ({ tools: [] })),
} }));
jest.mock('@/backend/services/statistics', () => ({ ...jest.requireActual('@/backend/services/statistics'), recordStatisticsEvent: jest.fn() }));

describe('private Codex profile cannot borrow native/local capabilities or stale context', () => {
  let restore: () => void;
  const profile = { verifiedCliVersion: '0.153.3', verifiedCliSha256: 'a'.repeat(64),
    verifiedModelCatalogPath: 'C:/fixture/verified-models.json', verifiedModelCatalogSha256: 'b'.repeat(64) };
  beforeEach(() => {
    jest.clearAllMocks(); mockBridgeTools = [];
    mockCheckProfile.mockResolvedValue('checked-codex-binary');
    mockCleanup.mockResolvedValue(undefined); mockBridgeClose.mockResolvedValue(undefined);
    mockRuntime.mockResolvedValue({ home: 'fixture-private-home', workingDirectory: 'fixture-private-cwd',
      env: { CODEX_HOME: 'fixture-private-home' }, configOverrides: ['project_root_markers=[]'],
      modelCatalogPath: 'fixture-private-home/verified-models.json', cleanup: mockCleanup });
    mockStream.mockImplementation(async () => ({ events: (async function* () {
      yield { type: 'thread.started', thread_id: 'new-private-thread' };
      yield { type: 'item.completed', item: { id: 'answer', type: 'agent_message', text: 'own reply' } };
      yield { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } };
    })() }));
    mockCallTool.mockResolvedValue({ success: true, data: { content: [{ type: 'text', text: '{"own":true}' }] } });
  });
  afterEach(() => restore?.());
  function input(run = fixtureRun(), options: Partial<CompletionInput> = {}, hasProfile = true): CompletionInput {
    const adapter = fixtureAdapter({ codexProfile: () => hasProfile ? profile : undefined });
    restore = registerExecutionExtension(adapter);
    return { model: { id: 'configured', name: 'gpt-6-sol', provider: 'codex', adapter: 'codex-cli' }, apiKey: '',
      messages: [{ role: 'user', content: 'my inquiry' }], conversationId: run.conversation, runId: run.runId,
      nodeId: 'process', executionExtensionContext: mintFixture(adapter, run), ...options } as CompletionInput;
  }
  const readTool = { type: 'function' as const, function: { name: 'private_read', parameters: { type: 'object', properties: {} } } };
  const mapped = { private_read: { server: 'protected-fixture', tool: 'read' } };

  test('missing profile, forged capability, API credential and approval request fail before SDK initialization', async () => {
    for (const options of [{}, { executionExtensionContext: {} }, { apiKey: 'fixture-api-key' },
      { requestToolApproval: async () => true }]) {
      const request = input(fixtureRun(), options as Partial<CompletionInput>, Object.keys(options).length > 0);
      await expect(new CodexAdapter().createCompletion(request)).rejects.toThrow();
      restore();
    }
    expect(mockCtor).not.toHaveBeenCalled(); expect(mockRuntime).not.toHaveBeenCalled();
  });

  test('changed/invalid binary attestation cannot create a credential-bearing runtime', async () => {
    mockCheckProfile.mockRejectedValue(new Error('binary drift'));
    await expect(new CodexAdapter().createCompletion(input())).rejects.toThrow('binary drift');
    expect(mockCtor).not.toHaveBeenCalled(); expect(mockRuntime).not.toHaveBeenCalled();
  });

  test('uses the checked binary and restricted options with a fresh thread, not an old customer session', async () => {
    const onSession = jest.fn();
    const request = input(fixtureRun(), { sessionResume: true, onCodexSessionChange: onSession,
      codexSession: { threadId: 'old-customer-thread' } as never });
    await new CodexAdapter().createCompletion(request);
    const options = mockCtor.mock.calls[0][0];
    expect(options.codexPathOverride).toBe('checked-codex-binary');
    expect(options.configOverrides).toEqual(['project_root_markers=[]']);
    expect(options.config.features).toEqual(RESTRICTED_CODEX_CONFIG.features);
    expect(options.config.tools.experimental_request_user_input).toEqual({ enabled: false });
    expect(options.config.web_search).toBe('disabled');
    expect(options.config.history.persistence).toBe('none');
    expect(options.config.model_catalog_json).toBe('fixture-private-home/verified-models.json');
    expect(mockStart.mock.calls[0][0]).toMatchObject(RESTRICTED_CODEX_THREAD_OPTIONS);
    expect(mockResume).not.toHaveBeenCalled(); expect(onSession).not.toHaveBeenCalled();
    expect(mockCleanup).toHaveBeenCalledTimes(1);
    expect(mockRuntime).toHaveBeenCalledWith(profile);
  });

  test('a runtime missing the verified catalog snapshot fails before SDK initialization and is cleaned up', async () => {
    const runtime = await mockRuntime();
    mockRuntime.mockResolvedValue({ ...runtime, modelCatalogPath: undefined });
    await expect(new CodexAdapter().createCompletion(input())).rejects.toThrow();
    expect(mockCtor).not.toHaveBeenCalled();
    expect(mockCleanup).toHaveBeenCalledTimes(1);
  });

  test('foreign offered MCP tools are rejected before SDK/bridge creation', async () => {
    await expect(new CodexAdapter().createCompletion(input(fixtureRun(), { tools: [readTool],
      toolNameMap: { private_read: { server: 'foreign', tool: 'read' } } }))).rejects.toThrow('fixture_tool_forbidden');
    expect(mockCtor).not.toHaveBeenCalled(); expect(mockRuntime).not.toHaveBeenCalled();
  });

  test('a local executor cannot override an advertised allowed MCP function', async () => {
    const local = jest.fn(async () => ({ content: [{ type: 'text', text: 'native bypass' }] }));
    await expect(new CodexAdapter().createCompletion(input(fixtureRun(), { tools: [readTool], toolNameMap: mapped,
      localToolExecutors: { private_read: local } }))).rejects.toThrow();
    expect(mockCtor).not.toHaveBeenCalled(); expect(local).not.toHaveBeenCalled();
  });

  test('revocation before streamed output prevents text/transcript publication', async () => {
    const run = fixtureRun(); const transcript = jest.fn(); const delta = jest.fn();
    mockStream.mockImplementation(async () => ({ events: (async function* () {
      run.revoked = true;
      yield { type: 'item.completed', item: { id: 'foreign', type: 'agent_message', text: 'late private result' } };
    })() }));
    await expect(new CodexAdapter().createCompletion(input(run, { onTranscriptMessage: transcript, onModelDelta: delta }))).rejects.toThrow();
    expect(transcript).not.toHaveBeenCalled(); expect(delta).not.toHaveBeenCalled();
    expect(mockCleanup).toHaveBeenCalledTimes(1);
  });

  test('revocation during an MCP call prevents its result reaching the CLI or transcript', async () => {
    const run: FixtureRun = fixtureRun(); const transcript = jest.fn();
    let resultToCli: unknown;
    const request = input(run, { tools: [readTool], toolNameMap: mapped, onTranscriptMessage: transcript });
    mockCallTool.mockImplementation(async () => {
      run.revoked = true;
      return { success: true, data: { content: [{ type: 'text', text: 'late private result' }] } };
    });
    mockStream.mockImplementation(async () => ({ events: (async function* () {
      try { resultToCli = await mockBridgeTools[0].handler({}); } catch { /* denied before result publication */ }
      yield { type: 'turn.completed', usage: {} };
    })() }));
    await expect(new CodexAdapter().createCompletion(request)).rejects.toThrow();
    expect(JSON.stringify(resultToCli ?? {})).not.toContain('late private result');
    expect(transcript.mock.calls.some(([message]) => message.role === 'tool' && message.content.includes('late private result'))).toBe(false);
    expect(mockCleanup).toHaveBeenCalledTimes(1);
  });

  test('a bound CLI connection failure is not automatically retried or resumed', async () => {
    mockStream.mockRejectedValue(new Error('connection closed before response completed'));
    await expect(new CodexAdapter().createCompletion(input())).rejects.toThrow();
    expect(mockStream).toHaveBeenCalledTimes(1); expect(mockStart).toHaveBeenCalledTimes(1);
    expect(mockResume).not.toHaveBeenCalled(); expect(mockCleanup).toHaveBeenCalledTimes(1);
  });

  test.each([
    ['request timed out', 'timeout', true],
    ['opaque native failure', 'unknown', true],
    ['opaque native failure', 'unknown', false],
  ])('a pre-handler native failure exposes only fixed diagnostics: %s / %s / known tool %s', async (prefix, category, known) => {
    const secret = 'SENSITIVE_NATIVE_CUSTOMER_TOKEN';
    const transcript = jest.fn(); const delta = jest.fn();
    mockStream.mockImplementation(async () => ({ events: (async function* () {
      const item = { id: `${secret}-item`, type: 'mcp_tool_call', status: 'failed',
        server: known ? 'flujo' : `${secret}-server`, tool: known ? mockBridgeTools[0].name : `${secret}-tool`,
        arguments: { customer: secret }, error: { message: `${prefix}: https://private.example/${secret} Authorization: Bearer ${secret}` },
        result: { content: [{ type: 'text', text: secret }], _meta: { bearer: secret } } };
      yield { type: 'item.started', item };
      yield { type: 'item.updated', item };
      yield { type: 'item.completed', item };
      yield { type: 'item.completed', item: { id: 'answer', type: 'agent_message', text: 'own reply' } };
      yield { type: 'turn.completed', usage: {} };
    })() }));
    const result = await new CodexAdapter().createCompletion(input(fixtureRun(), {
      tools: [readTool], toolNameMap: mapped, onTranscriptMessage: transcript, onModelDelta: delta,
    }));
    expect(mockLog.error).toHaveBeenCalledTimes(1);
    expect(mockLog.error).toHaveBeenCalledWith('Codex native MCP tool call failed', {
      code: 'codex_native_mcp_tool_failed', category, runId: 'run-A', nodeId: 'process',
      tool: known ? 'protected-fixture__read' : 'unknown',
    });
    expect(mockCallTool).not.toHaveBeenCalled();
    expect(jest.mocked(recordStatisticsEvent).mock.calls.filter(([event]) => event.type === 'tool.invocation')).toHaveLength(0);
    expect(result.transcript?.filter(message => message.role === 'tool')).toHaveLength(0);
    expect(JSON.stringify([mockLog.error.mock.calls, mockLog.warn.mock.calls, mockLog.debug.mock.calls,
      mockLog.info.mock.calls, result, transcript.mock.calls, delta.mock.calls, jest.mocked(recordStatisticsEvent).mock.calls]))
      .not.toContain(secret);
    expect(mockStream).toHaveBeenCalledTimes(1);
    expect(mockCleanup).toHaveBeenCalledTimes(1);
  });

  test('native MCP items do not duplicate a bridge-recorded call/result pair or invocation statistic', async () => {
    const secret = 'SENSITIVE_NATIVE_ERROR_DETAILS';
    mockStream.mockImplementation(async () => ({ events: (async function* () {
      await mockBridgeTools[0].handler({});
      yield { type: 'item.completed', item: { id: 'native-success', type: 'mcp_tool_call', status: 'completed',
        server: 'flujo', tool: mockBridgeTools[0].name, arguments: {} } };
      yield { type: 'item.completed', item: { id: 'native-failed', type: 'mcp_tool_call', status: 'failed',
        server: 'flujo', tool: mockBridgeTools[0].name, arguments: { customer: secret },
        error: { message: `${secret}: https://private.example/?token=${secret}` } } };
      yield { type: 'turn.completed', usage: {} };
    })() }));
    const result = await new CodexAdapter().createCompletion(input(fixtureRun(), { tools: [readTool], toolNameMap: mapped }));
    expect(mockCallTool).toHaveBeenCalledTimes(1);
    expect(result.transcript?.filter(message => message.role === 'assistant' && message.tool_calls?.length)).toHaveLength(1);
    expect(result.transcript?.filter(message => message.role === 'tool')).toHaveLength(1);
    expect(jest.mocked(recordStatisticsEvent).mock.calls.filter(([event]) => event.type === 'tool.invocation')).toHaveLength(1);
    expect(mockLog.error).toHaveBeenCalledTimes(1);
    expect(JSON.stringify([result, mockLog.error.mock.calls, jest.mocked(recordStatisticsEvent).mock.calls])).not.toContain(secret);
  });
});
