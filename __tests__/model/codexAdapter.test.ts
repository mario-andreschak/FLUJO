/**
 * Unit tests for the Codex adapter (issue #301) — the Codex-SDK sibling of the
 * Claude Subscription adapter. The SDK and the loopback tool bridge are mocked;
 * these tests pin down the adapter's contract:
 *   - thread options use never-ask approvals and a stable neutral working dir,
 *     and the API key is omitted when empty (codex login).
 *   - agent messages stream into the transcript exactly once (no duplicate
 *     final answer) and usage maps into the OpenAI shape with the cached split.
 *   - FLUJO tools are exposed through the bridge; an MCP dispatch records the
 *     assistant(tool_call)+tool(result) pair; a rejected approval never runs
 *     the tool and returns the fixed denial result.
 *   - a plain handoff ends the run and surfaces as a routing tool_call.
 */
import type OpenAI from 'openai';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { zstdCompressSync } from 'node:zlib';
import type { CompletionInput, SdkRequestSnapshot } from '@/backend/services/model/adapters/types';
import type { BridgeTool } from '@/backend/services/model/adapters/codexToolBridge';
import type { FlujoChatMessage } from '@/shared/types/chat';
import { FlowExecutionAuthorityError } from '@/backend/execution/flow/executionAuthority';
import { registerPendingApproval, listPendingToolCalls, clearPendingApprovals } from '@/backend/execution/flow/toolApprovalRegistry';
import { hidePresetParameters } from '@/utils/shared/toolParameterPresets';
import { executeQuestionTool } from '@/backend/execution/flow/handlers/runQuestionTool';
import { declinePendingQuestion } from '@/backend/services/questionRegistry';

const codexCtorMock = jest.fn();
jest.mock('@/backend/services/model/adapters/codexRuntimeUpdate', () => ({
  acquireOrdinaryCodexExecutable: jest.fn(async () => ({ executable: undefined, release: jest.fn(async () => {}) })),
  readOrdinaryCodexVersion: jest.fn(async () => '0.162.1'),
  readCodexRuntimeCompatibility: jest.fn(async () => ({ cliVersion: '0.162.1', sdkVersion: '0.162.1', protocolContract: 'flujo-codex-app-server-v1' })),
}));
// Existing SDK/private/native contract regressions retain the explicit fallback.
// Ordinary RPC lifecycle is exercised separately in codexAppServerThread.test.ts.
const previousAppServer = process.env.FLUJO_CODEX_APP_SERVER;
beforeEach(() => { process.env.FLUJO_CODEX_APP_SERVER = '0'; });

it('cancels only a direct question approval when its individual request is revoked', async () => {
  const controller = new AbortController(), conversationId = 'direct-question-approval';
  const sibling = { id: 'sibling', type: 'function' as const, function: { name: 'sibling', arguments: '{}' } };
  const siblingResolved = jest.fn(), execute = jest.fn();
  const transcript: FlujoChatMessage[] = [];
  let registered!: () => void; const seen = new Promise<void>(resolve => { registered = resolve; });
  registerPendingApproval(conversationId, sibling, siblingResolved);
  runStreamedMock.mockImplementationOnce(async () => ({ events: (async function* () {
    await capturedBridgeTools[0].handler({ questions: [{ prompt: 'Color?', options: ['Blue'] }] }, undefined, controller.signal);
  })() }));
  const running = new CodexAdapter().createCompletion(baseInput({ conversationId,
    onTranscriptMessage: message => { transcript.push(message); },
    tools: [{ type: 'function', function: { name: 'question', description: 'Ask', parameters: { type: 'object' } } }],
    localToolExecutors: { question: execute },
    requestToolApproval: call => new Promise<boolean>(resolve => {
      registerPendingApproval(conversationId, { id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } }, resolve);
      registered();
    }),
  }));
  try {
    await seen;
    expect(listPendingToolCalls(conversationId)).toHaveLength(2);
    controller.abort();
    await expect(running).rejects.toThrow();
    expect(execute).not.toHaveBeenCalled();
    expect(transcript.filter(message => message.role === 'tool')).toHaveLength(1);
    expect(transcript.find(message => message.role === 'tool')?.content).toContain('no answer was submitted');
    expect(listPendingToolCalls(conversationId)).toEqual([sibling]);
    expect(siblingResolved).not.toHaveBeenCalled();
  } finally { clearPendingApprovals(conversationId); }
});
afterAll(() => {
  if (previousAppServer === undefined) delete process.env.FLUJO_CODEX_APP_SERVER;
  else process.env.FLUJO_CODEX_APP_SERVER = previousAppServer;
});
jest.mock('@/backend/services/model/adapters/codexSessionStore', () => ({
  ...jest.requireActual('@/backend/services/model/adapters/codexSessionStore'),
  codexSessionAccountScope: jest.fn(async () => 'test-account'),
}));
const startThreadMock = jest.fn();
const resumeThreadMock = jest.fn();
const runStreamedMock = jest.fn();
const appServerThreadMock = jest.fn();
jest.mock('@/backend/services/model/adapters/codexAppServerThread', () => ({
  createCodexAppServerThread: (...args: unknown[]) => appServerThreadMock(...args),
}));
const readTokenSnapshotMock = jest.fn();
jest.mock('@/backend/services/model/adapters/codexContextUsage', () => ({
  readCodexTokenSnapshot: (...args: unknown[]) => readTokenSnapshotMock(...args),
}));

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
const listServerToolsMock = jest.fn();
const getClientMock = jest.fn();
const getClientGenerationMock = jest.fn();
const getToolSchemaHashMock = jest.fn();
jest.mock('@/backend/execution/flow/loadConversationState', () => ({
  loadConversationState: jest.fn(async () => null),
}));
jest.mock('@/backend/services/mcp', () => ({
  mcpService: {
    callTool: (...a: unknown[]) => callToolMock(...(a as [])),
    loadServerConfigs: (...a: unknown[]) => loadServerConfigsMock(...(a as [])),
    listServerTools: (...a: unknown[]) => listServerToolsMock(...(a as [])),
    getClient: (...a: unknown[]) => getClientMock(...(a as [])),
    getClientGeneration: (...a: unknown[]) => getClientGenerationMock(...(a as [])),
    getToolSchemaHash: (...a: unknown[]) => getToolSchemaHashMock(...(a as [])),
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
const boundToolResultMock = jest.fn(async ({ content }: { content: string }) => ({ spilled: false, content }));
jest.mock('@/backend/services/runResources/boundToolResult', () => ({
  boundToolResult: (...args: unknown[]) => boundToolResultMock(...(args as [{ content: string }])),
}));
const modelCatalogCleanupMock = jest.fn();
const prepareModelCatalogMock = jest.fn();
jest.mock('@/backend/services/model/adapters/codexModelCatalog', () => ({
  prepareCodexModelCatalogSnapshot: (...args: unknown[]) => prepareModelCatalogMock(...args),
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
import { prepareCodexRuntimeEnvironment } from '@/backend/services/model/adapters/codexRuntimeHome';
import { _setNativeToolJournalRootForTests, prepareNativeInvocation, submitNativeInvocation } from '@/backend/execution/flow/handlers/nativeToolJournal';
import { createNativeBrokerAuthority, createNativeToolPort, nativeToolInventoryDigest } from '@/backend/execution/flow/handlers/nativeToolBroker';

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
  appServerThreadMock.mockReset().mockImplementation(() => ({
    runStreamed: runStreamedMock, close: jest.fn(async () => {}),
    usage: () => undefined, canSteer: () => false, steer: jest.fn(async () => false),
  }));
  readTokenSnapshotMock.mockReset().mockResolvedValue(undefined);
  modelCatalogCleanupMock.mockReset().mockResolvedValue(undefined);
  prepareModelCatalogMock.mockReset().mockResolvedValue({
    path: 'C:\\flujo\\db\\codex-model-catalog-fixture\\models_cache.json', cleanup: modelCatalogCleanupMock,
  });
  callToolMock.mockReset();
  loadServerConfigsMock.mockReset();
  listServerToolsMock.mockReset();
  getClientMock.mockReset().mockReturnValue({});
  getClientGenerationMock.mockReset().mockReturnValue(1);
  getToolSchemaHashMock.mockReset().mockReturnValue('advertised-schema');
  loadServerConfigsMock.mockResolvedValue([
    { name: 'my-server', enableMcpApps: true },
  ]);
  listServerToolsMock.mockResolvedValue({ tools: [] });
  bridgeCloseMock.mockClear();
  boundToolResultMock.mockReset();
  boundToolResultMock.mockImplementation(async ({ content }: { content: string }) => ({ spilled: false, content }));
  capturedBridgeTools = [];
  capturedBridgeInstructions = undefined;
  _clearCodexSessionsForTests();
  runStreamedMock.mockImplementation(async () => ({
    events: eventStream([
      agentMessage('hello from codex'),
      turnCompleted({
        input_tokens: 100,
        cached_input_tokens: 40,
        cache_write_input_tokens: 25,
        output_tokens: 7,
      }),
    ])(),
  }));
});

it.each([false, true])('allows the MCP computation host while denying native operations with ordinary questions enabled=%s', async enabled => {
  process.env.FLUJO_CODEX_APP_SERVER = '1';
  await new CodexAdapter().createCompletion(baseInput({ apiKey: '',
    ...(enabled ? {
      tools: [{ type: 'function', function: { name: 'question', description: 'Ask', parameters: { type: 'object' } } }],
      localToolExecutors: { question: jest.fn(async () => 'Blue') },
    } : {}),
  }));
  expect(codexCtorMock).not.toHaveBeenCalled();
  const options = appServerThreadMock.mock.calls[0][0];
  expect(options.config.features).toMatchObject({ shell_tool: false, unified_exec: false,
    code_mode_host: true, code_mode: false, multi_agent: false,
    default_mode_request_user_input: enabled });
  expect(options.config.tools).toMatchObject({ view_image: false,
    experimental_request_user_input: { enabled } });
  expect(options.config.web_search).toBe('disabled');
  expect(typeof options.onQuestion === 'function').toBe(enabled);
  expect(typeof options.onAsyncQuestion === 'function').toBe(enabled);
});

describe('CodexAdapter — catalog snapshot lifetime', () => {
  it.each(['pacing', 'fence'])('settles an individually cancelled question once during %s', async phase => {
    process.env.FLUJO_CODEX_APP_SERVER = '1';
    const controller = new AbortController(), transcript: FlujoChatMessage[] = [], execute = jest.fn();
    appServerThreadMock.mockImplementationOnce(options => ({
      runStreamed: async () => ({ events: (async function* () {
        await options.onQuestion([{ id: 'choice', header: 'Color', question: 'Choose a color. ' + 'x'.repeat(500),
          isSecret: false, isOther: true, options: [{ label: 'Blue' }, { label: 'Green' }] }], controller.signal);
      })() }), close: jest.fn(async () => {}), canSteer: () => false, usage: () => undefined,
    }));
    await expect(new CodexAdapter().createCompletion(baseInput({ apiKey: '',
      tools: [{ type: 'function', function: { name: 'question', description: 'Ask', parameters: { type: 'object' } } }],
      localToolExecutors: { question: execute }, requestToolApproval: async () => true,
      beforeToolDispatch: async () => { if (phase === 'fence') controller.abort(); },
      onModelDelta: delta => { if (phase === 'pacing' && delta.toolCallDelta?.argumentsDelta) controller.abort(); },
      onTranscriptMessage: message => { transcript.push(message); },
    }))).rejects.toBeDefined();
    expect(execute).not.toHaveBeenCalled();
    expect(transcript.filter(message => message.tool_calls?.length)).toHaveLength(1);
    const results = transcript.filter(message => message.role === 'tool');
    expect(results).toHaveLength(1); expect(results[0].content).toContain('no answer was submitted');
  });

  it('invalidates the reusable session when an async question is explicitly declined', async () => {
    process.env.FLUJO_CODEX_APP_SERVER = '1';
    const conversationId = 'declined-native-session', onCodexSessionChange = jest.fn();
    appServerThreadMock.mockImplementationOnce(options => ({
      runStreamed: async () => ({ events: (async function* () {
        yield { type: 'thread.started', thread_id: 'declined-thread' };
        expect(await options.onAsyncQuestion([{ title: 'Which color?', options: ['Blue', 'Green'] }], new AbortController().signal))
          .toEqual({ action: 'decline' });
        yield turnCompleted({ input_tokens: 100, output_tokens: 20 });
      })() }), close: jest.fn(async () => {}), canSteer: () => false, usage: () => ({ input_tokens: 100, output_tokens: 20 }),
    }));
    await new CodexAdapter().createCompletion(baseInput({ apiKey: '', conversationId, nodeId: 'process',
      sessionResume: true, onCodexSessionChange,
      tools: [{ type: 'function', function: { name: 'question', description: 'Ask', parameters: { type: 'object' } } }],
      localToolExecutors: { question: args => executeQuestionTool(args, { conversationId,
        emit: event => { if (event.type === 'run:awaiting_question') declinePendingQuestion(conversationId, event.questionId); },
      }) },
    }));
    expect(onCodexSessionChange).toHaveBeenLastCalledWith(undefined);
  });

  it('retains executable and snapshot until a failed ordinary close receives actual close proof', async () => {
    process.env.FLUJO_CODEX_APP_SERVER = '1';
    let closed!: () => void;
    const proof = new Promise<void>(resolve => { closed = resolve; });
    const failure = new Error('Owned closure remains unconfirmed');
    appServerThreadMock.mockReturnValueOnce({ runStreamed: runStreamedMock,
      close: jest.fn(async () => { throw failure; }), whenClosed: () => proof,
      canSteer: () => false, usage: () => undefined });
    await expect(new CodexAdapter().createCompletion(baseInput({ apiKey: '' }))).rejects.toBe(failure);
    const acquired = await jest.requireMock('@/backend/services/model/adapters/codexRuntimeUpdate').acquireOrdinaryCodexExecutable.mock.results.at(-1).value;
    expect(modelCatalogCleanupMock).not.toHaveBeenCalled(); expect(acquired.release).not.toHaveBeenCalled();
    closed();
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(modelCatalogCleanupMock).toHaveBeenCalledTimes(1); expect(acquired.release).toHaveBeenCalledTimes(1);
  });

  it('passes the current model-dispatch fence into ordinary answer continuations', async () => {
    process.env.FLUJO_CODEX_APP_SERVER = '1';
    const beforeModelDispatch = jest.fn(async () => {});
    await new CodexAdapter().createCompletion(baseInput({ apiKey: '', beforeModelDispatch }));
    expect(appServerThreadMock.mock.calls[0][0].beforeContinuation).toBe(beforeModelDispatch);
  });

  it('keeps the snapshot through lazy SDK iteration and cleans up only after termination', async () => {
    runStreamedMock.mockImplementationOnce(async () => ({ events: (async function* () {
      expect(modelCatalogCleanupMock).not.toHaveBeenCalled();
      yield agentMessage('snapshot is still owned');
      expect(modelCatalogCleanupMock).not.toHaveBeenCalled();
      yield turnCompleted({ input_tokens: 1, output_tokens: 1 });
    })() }));
    await new CodexAdapter().createCompletion(baseInput());
    expect(modelCatalogCleanupMock).toHaveBeenCalledTimes(1);
    expect(prepareModelCatalogMock).toHaveBeenCalledWith(expect.any(AbortSignal), undefined);
  });

  it('cleans up a snapshot when runtime preparation refuses the run', async () => {
    const error = new Error('runtime unavailable');
    (prepareCodexRuntimeEnvironment as jest.Mock).mockRejectedValueOnce(error);
    await expect(new CodexAdapter().createCompletion(baseInput())).rejects.toBe(error);
    expect(codexCtorMock).not.toHaveBeenCalled();
    expect(modelCatalogCleanupMock).toHaveBeenCalledTimes(1);
  });

  it('cleans up a snapshot when SDK construction refuses the run', async () => {
    const error = new Error('constructor unavailable');
    codexCtorMock.mockImplementationOnce(() => { throw error; });
    await expect(new CodexAdapter().createCompletion(baseInput())).rejects.toBe(error);
    expect(runStreamedMock).not.toHaveBeenCalled();
    expect(modelCatalogCleanupMock).toHaveBeenCalledTimes(1);
  });

  it('cleans up a snapshot when lazy SDK spawn or iteration refuses the run', async () => {
    runStreamedMock.mockImplementationOnce(async () => ({ events: (async function* () {
      expect(modelCatalogCleanupMock).not.toHaveBeenCalled();
      throw new Error('spawn refused');
    })() }));
    await expect(new CodexAdapter().createCompletion(baseInput())).rejects.toThrow('spawn refused');
    expect(modelCatalogCleanupMock).toHaveBeenCalledTimes(1);
  });

  it('preserves the SDK failure when snapshot cleanup also fails', async () => {
    runStreamedMock.mockRejectedValueOnce(new Error('original SDK failure'));
    modelCatalogCleanupMock.mockRejectedValueOnce(new Error('cleanup failure'));
    await expect(new CodexAdapter().createCompletion(baseInput())).rejects.toThrow('original SDK failure');
    expect(modelCatalogCleanupMock).toHaveBeenCalledTimes(1);
  });

  it('cleans up a successful run even if snapshot cleanup cannot complete', async () => {
    modelCatalogCleanupMock.mockRejectedValueOnce(new Error('cleanup failure'));
    const result = await new CodexAdapter().createCompletion(baseInput());
    expect(result.completion.choices[0].message.content).toBe('hello from codex');
    expect(modelCatalogCleanupMock).toHaveBeenCalledTimes(1);
  });

  it('refuses SDK construction after cancellation during snapshot preparation', async () => {
    const controller = new AbortController();
    prepareModelCatalogMock.mockImplementationOnce(async () => {
      controller.abort();
      return { path: 'private-snapshot.json', cleanup: modelCatalogCleanupMock };
    });
    await expect(new CodexAdapter().createCompletion(baseInput({ signal: controller.signal })))
      .rejects.toThrow('Codex run cancelled by user.');
    expect(codexCtorMock).not.toHaveBeenCalled();
    expect(modelCatalogCleanupMock).toHaveBeenCalledTimes(1);
  });

  it('refuses SDK spawn and cleans up after cancellation while archiving its request', async () => {
    const controller = new AbortController();
    await expect(new CodexAdapter().createCompletion(baseInput({ signal: controller.signal,
      onSdkRequest: async () => { controller.abort(); return 'cancelled-dispatch'; },
    }))).rejects.toThrow('Codex run cancelled by user.');
    expect(runStreamedMock).not.toHaveBeenCalled();
    expect(modelCatalogCleanupMock).toHaveBeenCalledTimes(1);
  });
});

describe('CodexAdapter — thread setup', () => {
  it('rejects a direct owner-bound call before runtime setup or SDK construction', async () => {
    const runtime = (jest.requireMock('@/backend/services/model/adapters/codexRuntimeHome') as {
      prepareCodexRuntimeEnvironment: jest.Mock;
    }).prepareCodexRuntimeEnvironment;
    const catalog = prepareModelCatalogMock;
    runtime.mockClear();
    catalog.mockClear();

    await expect(new CodexAdapter().createCompletion(baseInput({
      model: {
        id: 'owner-model', name: 'gpt-5.5', ApiKey: '', provider: 'codex', adapter: 'openai',
        ownerCredentialBinding: { ownerId: 'owner', credentialId: 'credential' },
      },
      apiKey: 'local-secret',
    }))).rejects.toMatchObject({ code: 'execution_owner_model_adapter_unsupported' });

    expect(runtime).not.toHaveBeenCalled();
    expect(catalog).not.toHaveBeenCalled();
    expect(codexCtorMock).not.toHaveBeenCalled();
    expect(startThreadMock).not.toHaveBeenCalled();
    expect(runStreamedMock).not.toHaveBeenCalled();
  });

  it('does not call or retry the SDK after archive authority is lost', async () => {
    const lost = new FlowExecutionAuthorityError('Persona was deleted');
    await expect(new CodexAdapter().createCompletion(baseInput({
      onSdkRequest: async () => { throw lost; },
    }))).rejects.toBe(lost);
    expect(runStreamedMock).not.toHaveBeenCalled();
    expect(startThreadMock).toHaveBeenCalledTimes(1);
  });

  it('propagates authority loss from SDK outcome persistence', async () => {
    const lost = new FlowExecutionAuthorityError('Lease expired');
    await expect(new CodexAdapter().createCompletion(baseInput({
      onSdkRequest: async () => 'dispatch_lost',
      onSdkRequestResult: async () => { throw lost; },
    }))).rejects.toBe(lost);
    expect(runStreamedMock).toHaveBeenCalledTimes(1);
  });

  it('configures the thread without forcing a sandbox mode', async () => {
    await new CodexAdapter().createCompletion(baseInput());

    expect(startThreadMock).toHaveBeenCalledTimes(1);
    const opts = startThreadMock.mock.calls[0][0] as Record<string, unknown>;
    expect(opts.model).toBe('gpt-5.5');
    expect(opts).not.toHaveProperty('sandboxMode');
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
      model_catalog_json: 'C:\\flujo\\db\\codex-model-catalog-fixture\\models_cache.json',
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

it('routes a native Codex callback through the durable Worker port without host tool fallback', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-codex-native-port-'));
  _setNativeToolJournalRootForTests(directory);
  try {
    const tools: OpenAI.ChatCompletionFunctionTool[] = [{
      type: 'function', function: { name: 'worker_search', description: 'Search',
        parameters: { type: 'object', properties: {} } },
    }];
    const executor = jest.fn(async () => ({ found: true }));
    const executors = { worker_search: executor };
    const receipt = await prepareNativeInvocation({
      conversationId: 'native-codex', runId: 'run-1', nodeId: 'node-1', modelId: 'm1',
      leaseEpoch: 'lease-1', inputDigest: 'input-1', attemptOrdinal: 1,
      inventoryDigest: nativeToolInventoryDigest(tools, undefined, executors),
    });
    await submitNativeInvocation(receipt);
    const port = createNativeToolPort({ receipt, tools, localToolExecutors: executors,
      service: {} as Parameters<typeof createNativeToolPort>[0]['service'],
      authority: createNativeBrokerAuthority('lease-1', async () => undefined),
      signal: new AbortController().signal });
    const observedLive = jest.fn(async () => undefined);
    callToolMock.mockImplementation(() => { throw new Error('host MCP fallback called'); });
    await new CodexAdapter().createCompletion(baseInput({ tools, nativeToolPort: port,
      onSdkRequest: async () => receipt.invocationId,
      onNativeSdkLive: observedLive,
      onSdkRequestResult: async () => undefined }));
    expect(observedLive).toHaveBeenCalledTimes(1);
    const result = await capturedBridgeTools[0].handler({ q: 'test' }, 'model-call-1');
    expect(result.isError).not.toBe(true);
    expect(executor).toHaveBeenCalledTimes(1);
    expect(callToolMock).not.toHaveBeenCalled();
    expect(startThreadMock).toHaveBeenCalledTimes(1);
    await expect(capturedBridgeTools[0].handler({ q: 'without-id' })).rejects.toThrow(/identity/);
    expect(executor).toHaveBeenCalledTimes(1);
  } finally {
    _setNativeToolJournalRootForTests(undefined);
    await fs.rm(directory, { recursive: true, force: true });
  }
});

it.each([
  ['terminal-only', [turnCompleted({ input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 })]],
  ['failed-first', [{ type: 'turn.failed', error: { message: 'fixture failure' } }]],
] as const)('does not call a native Codex stream live after %s events', async (_name, events) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-codex-native-terminal-'));
  _setNativeToolJournalRootForTests(directory);
  try {
    const tools: OpenAI.ChatCompletionFunctionTool[] = [];
    const receipt = await prepareNativeInvocation({
      conversationId: `native-codex-${_name}`, runId: 'run-1', nodeId: 'node-1', modelId: 'm1',
      leaseEpoch: 'lease-1', inputDigest: 'input-1', attemptOrdinal: 1,
      inventoryDigest: nativeToolInventoryDigest(tools),
    });
    await submitNativeInvocation(receipt);
    const port = createNativeToolPort({ receipt, tools,
      service: {} as Parameters<typeof createNativeToolPort>[0]['service'],
      authority: createNativeBrokerAuthority('lease-1', async () => undefined),
      signal: new AbortController().signal });
    const observedLive = jest.fn(async () => undefined);
    const observedFinished = jest.fn();
    runStreamedMock.mockResolvedValueOnce({ events: eventStream([...events])() });
    await new CodexAdapter().createCompletion(baseInput({ tools, nativeToolPort: port,
      onSdkRequest: async () => receipt.invocationId,
      onNativeSdkLive: observedLive,
      onNativeSdkFinished: observedFinished,
      onSdkRequestResult: async () => undefined })).catch(() => undefined);
    expect(observedLive).not.toHaveBeenCalled();
    expect(observedFinished).toHaveBeenCalledTimes(1);
    expect(runStreamedMock).toHaveBeenCalledTimes(1);
  } finally {
    _setNativeToolJournalRootForTests(undefined);
    await fs.rm(directory, { recursive: true, force: true });
  }
});

describe('CodexAdapter — transcript & usage', () => {
  it('returns real context separately from millions of accumulated input tokens', async () => {
    runStreamedMock.mockResolvedValueOnce({ events: eventStream([
      threadStarted('01a0ba76-e5e0-7a12-823b-5eed320794ca'),
      agentMessage('done'),
      turnCompleted({ input_tokens: 5606187, cached_input_tokens: 5432064, output_tokens: 27510 }),
    ])() });
    const contextUsage = { promptTokens: 165897, completionTokens: 390, totalTokens: 166287, contextWindow: 258400 };
    readTokenSnapshotMock.mockImplementation(async () => ({
      timestamp: Date.now(), contextUsage,
      totalUsage: { input_tokens: 5606187, cached_input_tokens: 5432064, output_tokens: 27510 },
    }));
    const result = await new CodexAdapter().createCompletion(baseInput());
    expect(result.contextUsage).toEqual(contextUsage);
    expect(result.completion.usage?.prompt_tokens).toBe(5606187);
  });

  it('reports context as unavailable when the runtime snapshot is missing or stale', async () => {
    runStreamedMock.mockResolvedValueOnce({ events: eventStream([
      threadStarted('01a0ba76-e5e0-7a12-823b-5eed320794ca'), agentMessage('done'),
      turnCompleted({ input_tokens: 5606187, output_tokens: 27510 }),
    ])() });
    readTokenSnapshotMock.mockResolvedValue({ timestamp: 1, contextUsage: { promptTokens: 5, contextWindow: 100 } });
    expect((await new CodexAdapter().createCompletion(baseInput())).contextUsage).toBeNull();
    expect((await new CodexAdapter().createCompletion(baseInput())).contextUsage).toBeNull();
  });

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
    expect(completion.usage?.prompt_tokens_details?.cache_write_tokens).toBe(25);

    // The assistant text streamed live is the SAME (single) transcript entry —
    // no duplicate final message.
    expect(transcript).toHaveLength(1);
    expect(streamed).toHaveLength(1);
    expect((transcript![0] as { content?: string }).content).toBe('hello from codex');
  });

  it('restarts the same SDK thread with a mid-run user intervention and persists it', async () => {
    runStreamedMock
      .mockImplementationOnce(async () => ({
        events: eventStream([
          { type: 'item.updated', item: { id: 'draft', type: 'agent_message', text: 'going the wrong way' } },
          agentMessage('this must not finish'),
        ])(),
      }))
      .mockImplementationOnce(async () => ({
        events: eventStream([
          agentMessage('corrected answer'),
          turnCompleted({ input_tokens: 2, cached_input_tokens: 0, output_tokens: 2 }),
        ])(),
      }));
    const injected = {
      id: 'steer-1',
      role: 'user',
      content: 'stop and use the other approach',
      timestamp: 123,
      injected: true,
    } as FlujoChatMessage;
    const consumeSteeringMessages = jest
      .fn<FlujoChatMessage[], []>()
      .mockReturnValueOnce([injected])
      .mockReturnValue([]);
    const streamed: FlujoChatMessage[] = [];
    const sdkRequests: SdkRequestSnapshot[] = [];

    const { completion, transcript } = await new CodexAdapter().createCompletion(baseInput({
      consumeSteeringMessages,
      onTranscriptMessage: message => streamed.push(message),
      onSdkRequest: async snapshot => {
        sdkRequests.push(snapshot);
        return `dispatch-${sdkRequests.length}`;
      },
    }));

    expect(runStreamedMock).toHaveBeenCalledTimes(2);
    expect(runStreamedMock.mock.calls[1][0]).toBe('stop and use the other approach');
    expect(transcript).toEqual([
      expect.objectContaining({ role: 'assistant', content: 'going the wrong way' }),
      expect.objectContaining({ id: 'steer-1', role: 'user', content: 'stop and use the other approach' }),
      expect.objectContaining({ role: 'assistant', content: 'corrected answer' }),
    ]);
    expect(streamed).toEqual(transcript);
    expect(completion.choices[0].message.content).toBe('corrected answer');
    expect(sdkRequests).toHaveLength(2);
    expect(sdkRequests[0].wireMessages).toBeUndefined();
    expect(sdkRequests[1].wireMessages).toEqual([
      expect.objectContaining({ id: 'steer-1', role: 'user', content: 'stop and use the other approach' }),
    ]);
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

    const streamedMessageId = (deltas[0] as { messageId: string }).messageId;
    expect(streamedMessageId).toMatch(/^stream_codex_\d+_[0-9a-f-]+_a1$/);
    expect(deltas).toEqual([
      expect.objectContaining({ messageId: streamedMessageId, contentDelta: 'hel' }),
      expect.objectContaining({ messageId: streamedMessageId, contentDelta: 'lo' }),
    ]);
    expect(transcript?.[0].id).toBe(streamedMessageId);
  });

  it('namespaces reused SDK item ids across model calls', async () => {
    const first = await new CodexAdapter().createCompletion(baseInput());
    const second = await new CodexAdapter().createCompletion(baseInput());

    expect(first.transcript?.[0].id).toMatch(/^stream_codex_/);
    expect(second.transcript?.[0].id).toMatch(/^stream_codex_/);
    expect(second.transcript?.[0].id).not.toBe(first.transcript?.[0].id);
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
    const tc = (call as { tool_calls: OpenAI.ChatCompletionMessageFunctionToolCall[] }).tool_calls[0];
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
    expect(runStreamedMock).not.toHaveBeenCalled();
    expect(modelCatalogCleanupMock).toHaveBeenCalledTimes(1);
  });

  it('throws on turn.failed', async () => {
    runStreamedMock.mockImplementationOnce(async () => ({
      events: eventStream([{ type: 'turn.failed', error: { message: 'boom' } }])(),
    }));
    await expect(new CodexAdapter().createCompletion(baseInput())).rejects.toThrow(/boom/);
  });

  it('preserves the model rejection when the CLI exits after turn.failed', async () => {
    const message = "The 'gpt-6-astra' model requires a newer version of Codex.";
    runStreamedMock.mockImplementationOnce(async () => ({
      events: (async function* () {
        yield { type: 'turn.failed', error: { message } };
        throw new Error('Codex Exec exited with code 1: Reading prompt from stdin...');
      })(),
    }));

    await expect(new CodexAdapter().createCompletion(baseInput())).rejects.toThrow(message);
    expect(runStreamedMock).toHaveBeenCalledTimes(1);
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

const mcpTool: OpenAI.ChatCompletionFunctionTool = {
  type: 'function',
  function: {
    name: 'mcp_hashed_name',
    description: 'Lists things',
    parameters: { type: 'object', properties: { q: { type: 'string' } } },
  },
};

describe('CodexAdapter — cooperative terminal controls', () => {
  it('stops before another SDK turn can narrate after a terminal local control', async () => {
    let turnEnded = false;
    runStreamedMock.mockImplementationOnce(async () => ({
      events: (async function* () {
        yield threadStarted('thread-terminal-control');
        turnEnded = true;
        yield agentMessage('This narration must not escape.');
        yield turnCompleted({ input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 });
      })(),
    }));

    const result = await new CodexAdapter().createCompletion(baseInput({
      shouldEndAgenticTurn: () => turnEnded,
    }));

    expect(result.transcript).toEqual([]);
    expect(result.completion.choices[0].message.content).toBeNull();
    const options = runStreamedMock.mock.calls[0][1] as { signal: AbortSignal };
    expect(options.signal.aborted).toBe(true);
  });
});

describe('CodexAdapter — tool bridging', () => {
  it('rejects an MCP client replaced while bridge approval was pending', async () => {
    const approve = jest.fn(async () => {
      getClientGenerationMock.mockReturnValue(2);
      return true;
    });
    let sdkResult: unknown;
    runStreamedMock.mockImplementationOnce(async () => ({ events: (async function* () {
      sdkResult = await capturedBridgeTools[0].handler({ q: 'recent' });
      yield turnCompleted({ input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 });
    })() }));

    const { transcript } = await new CodexAdapter().createCompletion(baseInput({
      tools: [mcpTool],
      toolNameMap: { mcp_hashed_name: {
        server: 'my-server', tool: 'list_things', clientGeneration: 1, schemaHash: 'advertised-schema',
      } },
      requestToolApproval: approve,
    }));

    expect(approve).toHaveBeenCalledTimes(1);
    expect(callToolMock).not.toHaveBeenCalled();
    expect(sdkResult).toMatchObject({ isError: true, content: [{ type: 'text', text: expect.stringContaining('re-registered') }] });
    expect(transcript?.filter(message => message.role === 'tool')).toHaveLength(1);
  });

  it('checks MCP identity again after the asynchronous dispatch fence', async () => {
    let sdkResult: unknown;
    runStreamedMock.mockImplementationOnce(async () => ({ events: (async function* () {
      sdkResult = await capturedBridgeTools[0].handler({ q: 'recent' });
      yield turnCompleted({ input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 });
    })() }));
    await new CodexAdapter().createCompletion(baseInput({
      tools: [mcpTool],
      toolNameMap: { mcp_hashed_name: {
        server: 'my-server', tool: 'list_things', clientGeneration: 1,
      } },
      beforeToolDispatch: async () => { getClientGenerationMock.mockReturnValue(2); },
    }));
    expect(callToolMock).not.toHaveBeenCalled();
    expect(sdkResult).toMatchObject({ isError: true });
  });

  it('hides preset identity fields and overrides forged bridge arguments before MCP dispatch', async () => {
    const presetArgs = { customer_id: 'fixed-customer-a', conversation_id: '@conversation.id' };
    const originalSchema = {
      type: 'object', properties: { q: { type: 'string' }, customer_id: { type: 'string' }, conversation_id: { type: 'string' } },
      required: ['q', 'customer_id', 'conversation_id'],
    };
    const tool = { ...mcpTool, function: { ...mcpTool.function, parameters: hidePresetParameters(originalSchema, presetArgs) } };
    callToolMock.mockResolvedValueOnce({ success: true, data: { content: [{ type: 'text', text: 'ok' }] } });
    runStreamedMock.mockImplementationOnce(async () => ({ events: (async function* () {
      await capturedBridgeTools[0].handler({ q: 'recent', customer_id: 'customer-b', conversation_id: 'foreign-chat' });
      yield agentMessage('done');
      yield turnCompleted({ input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 });
    })() }));
    const { transcript } = await new CodexAdapter().createCompletion(baseInput({
      conversationId: 'slack-team-thread-a', tools: [tool],
      toolNameMap: { mcp_hashed_name: { server: 'my-server', tool: 'list_things', presetArgs,
        context: { conversationId: 'slack-team-thread-a' } } },
    }));
    expect(capturedBridgeTools[0].inputSchema).toEqual({ type: 'object', properties: { q: { type: 'string' } }, required: ['q'] });
    expect(callToolMock.mock.calls[0][2]).toEqual({ q: 'recent', customer_id: 'fixed-customer-a', conversation_id: 'slack-team-thread-a' });
    expect(JSON.stringify(transcript)).not.toContain('fixed-customer-a');
  });

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
      model_catalog_json: 'C:\\flujo\\db\\codex-model-catalog-fixture\\models_cache.json',
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
        conversationId: 'conversation-current',
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
      'conversation:conversation-current',
      { conversationId: 'conversation-current' },
    );
    const roles = transcript!.map(m => m.role);
    // assistant(tool_call) + tool(result) + final assistant answer.
    expect(roles).toEqual(['assistant', 'tool', 'assistant']);
  });

  it('forwards MCP progress from a bridged tool to FLUJO live progress', async () => {
    const onToolProgress = jest.fn();
    callToolMock.mockImplementationOnce(async (...args: unknown[]) => {
      const report = args[4] as ((value: { progress: number; total?: number; message?: string }) => void);
      report({ progress: 7, total: 10, message: 'building' });
      return { success: true, data: { content: [{ type: 'text', text: 'ok' }] } };
    });
    runStreamedMock.mockImplementationOnce(async () => ({
      events: (async function* () {
        await capturedBridgeTools[0].handler({ q: 'x' });
        yield agentMessage('done');
        yield turnCompleted({ input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 });
      })(),
    }));

    await new CodexAdapter().createCompletion(baseInput({
      tools: [mcpTool],
      toolNameMap: { mcp_hashed_name: { server: 'my-server', tool: 'list_things' } },
      onToolProgress,
    }));

    expect(onToolProgress).toHaveBeenCalledWith({
      toolCallId: expect.any(String),
      name: 'my-server__list_things',
      progress: 7,
      total: 10,
      message: 'building',
    });
  });

  it('preserves native media when oversized text is replaced by a bounded preview', async () => {
    const image = { type: 'image' as const, data: 'BASE64_IMAGE', mimeType: 'image/png' };
    callToolMock.mockResolvedValueOnce({
      success: true,
      data: { content: [{ type: 'text', text: 'x'.repeat(60_000) }, image] },
    });
    boundToolResultMock.mockResolvedValueOnce({ spilled: true, content: '[bounded text preview]' });
    let bridgeResult: unknown;
    runStreamedMock.mockImplementationOnce(async () => ({
      events: (async function* () {
        bridgeResult = await capturedBridgeTools[0].handler({ q: 'x' });
        yield agentMessage('done');
        yield turnCompleted({ input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 });
      })(),
    }));

    const { transcript } = await new CodexAdapter().createCompletion(
      baseInput({
        conversationId: 'conv-1',
        tools: [mcpTool],
        toolNameMap: { mcp_hashed_name: { server: 'my-server', tool: 'list_things' } },
      }),
    );

    expect(bridgeResult).toMatchObject({
      content: [image, { type: 'text', text: '[bounded text preview]' }],
    });
    const toolMessage = transcript!.find(message => message.role === 'tool');
    expect(toolMessage?.content).toContain('[bounded text preview]');
    expect(toolMessage?.content).not.toContain('BASE64_IMAGE');
    expect(boundToolResultMock).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.not.stringContaining('BASE64_IMAGE'),
    }));
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
      tool_calls: OpenAI.ChatCompletionMessageFunctionToolCall[];
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

  it('paces the assembled tool arguments as deltas under the pending card id (#337)', async () => {
    const payload = 'x'.repeat(2_000);
    callToolMock.mockResolvedValueOnce({ success: true, data: { content: [{ type: 'text', text: 'ok' }] } });
    runStreamedMock.mockImplementationOnce(async () => ({
      events: (async function* () {
        await capturedBridgeTools[0].handler({ payload });
        yield agentMessage('done');
        yield turnCompleted({ input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 });
      })(),
    }));
    const streamed: FlujoChatMessage[] = [];
    const deltas: Array<{ messageId: string; toolCallDelta?: { id?: string; nameDelta?: string; argumentsDelta?: string } }> = [];

    await new CodexAdapter().createCompletion(
      baseInput({
        tools: [mcpTool],
        toolNameMap: { mcp_hashed_name: { server: 'my-server', tool: 'list_things' } },
        onTranscriptMessage: message => streamed.push(message),
        onModelDelta: delta => deltas.push(delta),
      }),
    );

    const pendingCall = streamed.find(message =>
      Array.isArray((message as { tool_calls?: unknown[] }).tool_calls)) as FlujoChatMessage & {
        tool_calls: OpenAI.ChatCompletionMessageFunctionToolCall[];
      };
    const toolDeltas = deltas.filter(delta => delta.toolCallDelta);

    // The name arrives first, then the arguments in several visible fragments.
    expect(toolDeltas[0].toolCallDelta).toMatchObject({
      id: pendingCall.tool_calls[0].id,
      nameDelta: pendingCall.tool_calls[0].function.name,
    });
    expect(toolDeltas.length).toBeGreaterThan(2);
    expect(toolDeltas.map(delta => delta.toolCallDelta?.argumentsDelta ?? '').join(''))
      .toBe(pendingCall.tool_calls[0].function.arguments);
    // Same message id as the durable pending card, so the draft reconciles
    // instead of leaving a duplicate tool call in the transcript.
    expect(new Set(toolDeltas.map(delta => delta.messageId))).toEqual(new Set([pendingCall.id]));
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

  it('renders the downstream MCP App when the trusted FLUJO control tool forwards the call', async () => {
    loadServerConfigsMock.mockResolvedValue([
      {
        name: 'control-plane',
        source: { type: 'marketplace', id: '@mario.andreschak/mcp-flujo' },
        enableMcpApps: false,
      },
      { name: 'mcp-cad-studio', enableMcpApps: true },
    ]);
    listServerToolsMock.mockResolvedValue({
      tools: [{
        name: 'studio_ui',
        _meta: { ui: { resourceUri: 'ui://cad-studio/main' } },
      }],
    });
    callToolMock.mockResolvedValueOnce({
      success: true,
      data: { content: [{ type: 'text', text: 'Opened CAD Studio with Pipe 2.' }] },
    });
    runStreamedMock.mockImplementationOnce(async () => ({
      events: (async function* () {
        await capturedBridgeTools[0].handler({
          server: 'mcp-cad-studio',
          tool: 'studio_ui',
          args: { pipe: 2 },
        });
        yield agentMessage('done');
        yield turnCompleted({ input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 });
      })(),
    }));

    const { transcript } = await new CodexAdapter().createCompletion(
      baseInput({
        tools: [mcpTool],
        toolNameMap: {
          mcp_hashed_name: {
            server: 'control-plane',
            tool: 'call_mcp_tool',
          },
        },
      }),
    );

    expect(listServerToolsMock).toHaveBeenCalledWith('mcp-cad-studio', 'model');
    const toolMsg = transcript!.find(m => m.role === 'tool');
    expect(toolMsg?.ui).toEqual({
      uri: 'ui://cad-studio/main',
      serverName: 'mcp-cad-studio',
      toolName: 'studio_ui',
      toolArgs: '{"pipe":2}',
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

  it('a rejected approval never dispatches and returns the fixed denial result', async () => {
    const approvals = jest.fn(async () => false);
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
      tool_calls: OpenAI.ChatCompletionMessageFunctionToolCall[];
    }) | undefined;
    const toolMsg = transcript!.find(m => m.role === 'tool')!;
    expect(callMsg?.tool_calls).toHaveLength(1);
    expect(toolMsg.role === 'tool' ? toolMsg.tool_call_id : undefined).toBe(callMsg?.tool_calls?.[0].id);
    expect(toolMsg.content).toBe('tool denied');
    expect(toolMsg.ui).toEqual({
      uri: 'ui://advertised-dashboard',
      serverName: 'my-server',
      toolName: 'list_things',
      cancelledReason: 'tool denied',
      isError: true,
    });
  });

  it('a plain handoff ends the run and surfaces as a routing tool_call', async () => {
    const handoffTool: OpenAI.ChatCompletionFunctionTool = {
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
    expect(completion.choices[0].message.tool_calls?.[0]).toMatchObject({
      type: 'function',
      function: { name: 'handoff_to_finish' },
    });
    expect(completion.choices[0].message.content).toBeNull();
  });
});

describe('CodexAdapter — SDK thread reuse', () => {
  it.each(['known', 'missing', 'corrupt', 'oversized', 'incomplete', 'regressed', 'changed thread',
    'invalid completed plain event', 'invalid completed compressed event'])
  ('preserves the answer/context and reports only known invocation usage (%s baseline)', async (condition) => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-sdk-compressed-usage-'));
    const directory = path.join(home, 'sessions/2026/10/13');
    await fs.mkdir(directory, { recursive: true });
    const threadId = '01a0ba76-e5e0-7a12-823b-5eed320794ca';
    const secondId = condition === 'changed thread' ? '01a0ba76-e5e0-7a12-823b-5eed320794cb' : threadId;
    const rollout = (id: string) => path.join(directory, `rollout-2026-10-13T00-00-00-${id}.jsonl`);
    const firstUsage = { input_tokens: 10, output_tokens: 2, cached_input_tokens: 3,
      cache_write_input_tokens: 0, reasoning_output_tokens: 1 };
    const secondUsage = { input_tokens: 30, output_tokens: 6, cached_input_tokens: 9,
      cache_write_input_tokens: 0, reasoning_output_tokens: 2 };
    const line = (total: Record<string, number>, prompt: number, output: number) => JSON.stringify({
      timestamp: new Date().toISOString(), type: 'event_msg', payload: { type: 'token_count', info: {
        total_token_usage: total, last_token_usage: { input_tokens: prompt, output_tokens: output,
          total_tokens: prompt + output }, model_context_window: 258400,
      } },
    }) + '\n';
    const reader = jest.requireActual<typeof import('@/backend/services/model/adapters/codexContextUsage')>(
      '@/backend/services/model/adapters/codexContextUsage').readCodexTokenSnapshot;
    readTokenSnapshotMock.mockImplementation((_runtimeHome: string, id: string) => reader(home, id));
    runStreamedMock
      .mockImplementationOnce(async () => {
        await fs.writeFile(rollout(threadId), line(firstUsage, 10, 2));
        return { events: eventStream([threadStarted(threadId), agentMessage('FIRST'), turnCompleted(firstUsage)])() };
      })
      .mockImplementationOnce(async () => {
        await fs.writeFile(rollout(secondId), line(secondUsage, 20, 4));
        return { events: eventStream([threadStarted(secondId), agentMessage('SECOND'), turnCompleted(secondUsage)])() };
      });
    const identity = { conversationId: 'compressed-usage-' + condition, nodeId: 'process', sessionResume: true };
    try {
      const first = await new CodexAdapter().createCompletion(baseInput(identity));
      expect(first.completion.usage).toMatchObject({ prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 });
      let encoded = zstdCompressSync(await fs.readFile(rollout(threadId)));
      if (condition === 'corrupt') encoded = Buffer.from('corrupt');
      if (condition === 'oversized') encoded = Buffer.alloc(8 * 1024 * 1024 + 1);
      if (condition === 'incomplete') encoded = zstdCompressSync(line({ input_tokens: 10 }, 10, 2));
      if (condition === 'regressed') encoded = zstdCompressSync(line({ ...firstUsage, input_tokens: 31, output_tokens: 7 }, 10, 2));
      if (condition.startsWith('invalid completed')) {
        const invalid = JSON.parse(line({ ...firstUsage, input_tokens: 20, output_tokens: 4 }, 20, 4));
        invalid.payload.info.last_token_usage.total_tokens = 1;
        const body = (await fs.readFile(rollout(threadId), 'utf8')) + JSON.stringify(invalid) + '\n';
        if (condition === 'invalid completed plain event') await fs.writeFile(rollout(threadId), body);
        else encoded = zstdCompressSync(body);
      }
      if (condition !== 'invalid completed plain event') {
        if (condition !== 'missing') await fs.writeFile(rollout(threadId) + '.zst', encoded);
        await fs.rm(rollout(threadId));
      }
      const result = await new CodexAdapter().createCompletion(baseInput({ ...identity, messages: [
        { role: 'user', content: 'hi' }, { role: 'assistant', content: 'FIRST' }, { role: 'user', content: 'next' },
      ] }));
      expect(resumeThreadMock).toHaveBeenCalledTimes(1);
      expect(result.transcript?.some(message => message.role === 'assistant' && message.content === 'SECOND')).toBe(true);
      expect(result.completion.choices[0].message.content).toBe('SECOND');
      expect(result.contextUsage).toMatchObject({ promptTokens: 20, completionTokens: 4, totalTokens: 24,
        contextWindow: 258400, contextWindowSource: 'runtime' });
      if (condition === 'known') expect(result.completion.usage).toMatchObject({
        prompt_tokens: 20, completion_tokens: 4, total_tokens: 24,
        prompt_tokens_details: { cached_tokens: 6, cache_write_tokens: 0 },
        completion_tokens_details: { reasoning_tokens: 1 },
      });
      else expect(result.completion).not.toHaveProperty('usage');
    } finally { await fs.rm(home, { recursive: true, force: true }); }
  });

  it.each([false, true])('subtracts previous native totals on resume (final snapshot missing: %s)', async (missingFinalSnapshot) => {
    const threadId = '01a0ba76-e5e0-7a12-823b-5eed320794ca';
    const firstUsage = { input_tokens: 5000, cached_input_tokens: 4000, output_tokens: 100 };
    const secondUsage = { input_tokens: 12000, cached_input_tokens: 10000, output_tokens: 300 };
    runStreamedMock
      .mockResolvedValueOnce({ events: eventStream([threadStarted(threadId), agentMessage('first answer'), turnCompleted(firstUsage)])() })
      .mockResolvedValueOnce({ events: eventStream([threadStarted(threadId), agentMessage('second answer'), turnCompleted(secondUsage)])() });
    const snapshot = (totalUsage: typeof firstUsage, promptTokens: number) => ({
      timestamp: Date.now(), totalUsage, contextUsage: { promptTokens, contextWindow: 258400 },
    });
    readTokenSnapshotMock
      .mockImplementationOnce(async () => snapshot(firstUsage, 1000))
      .mockImplementationOnce(async () => snapshot(firstUsage, 1000))
      .mockImplementationOnce(async () => missingFinalSnapshot ? undefined : snapshot(secondUsage, 1500));
    const identity = { conversationId: 'conversation-usage', nodeId: 'process-usage', sessionResume: true };
    await new CodexAdapter().createCompletion(baseInput(identity));
    const result = await new CodexAdapter().createCompletion(baseInput({
      ...identity,
      messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'first answer' }, { role: 'user', content: 'next' }],
    }));
    expect(resumeThreadMock).toHaveBeenCalledTimes(1);
    expect(result.completion.usage).toMatchObject({
      prompt_tokens: 7000, completion_tokens: 200, total_tokens: 7200,
      prompt_tokens_details: { cached_tokens: 6000 },
    });
    expect(result.contextUsage).toEqual(missingFinalSnapshot ? null : { promptTokens: 1500, contextWindow: 258400 });
  });

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
      }),
    );
    expect(resumeThreadMock.mock.calls[0][1]).not.toHaveProperty('sandboxMode');
    expect(runStreamedMock.mock.calls[1][0]).toBe('next');
  });

  it.each([false, true])('honors the API endpoint and fences endpoint changes with durable=%s', async durable => {
    let persisted: CompletionInput['codexSession'];
    const identity = { conversationId: 'endpoint-conversation', nodeId: 'process-endpoint', sessionResume: true,
      onCodexSessionChange: (session: CompletionInput['codexSession']) => { persisted = session; } };
    runStreamedMock.mockImplementation(async () => ({
      events: eventStream([threadStarted('endpoint-thread'), agentMessage('first answer'),
        turnCompleted({ input_tokens: 2, cached_input_tokens: 0, output_tokens: 1 })])(),
    }));
    const model = { ...baseInput().model, baseUrl: 'https://openrouter.ai/api/v1' };
    await new CodexAdapter().createCompletion(baseInput({ ...identity, model }));
    expect(codexCtorMock).toHaveBeenLastCalledWith(expect.objectContaining({
      apiKey: 'sk-test', baseUrl: model.baseUrl,
      config: expect.objectContaining({ model_provider: 'flujo_api', model_providers: {
        flujo_api: { name: 'FLUJO API', base_url: model.baseUrl, env_key: 'CODEX_API_KEY',
          wire_api: 'responses', requires_openai_auth: false, supports_websockets: false },
      } }),
    }));
    const messages = [{ role: 'user' as const, content: 'hi' },
      { role: 'assistant' as const, content: 'first answer' }, { role: 'user' as const, content: 'next' }];
    if (durable) _clearCodexSessionsForTests();
    await new CodexAdapter().createCompletion(baseInput({ ...identity, model, messages,
      ...(durable ? { codexSession: persisted } : {}) }));
    expect(resumeThreadMock).toHaveBeenCalledTimes(1);
    if (durable) _clearCodexSessionsForTests();
    await new CodexAdapter().createCompletion(baseInput({ ...identity,
      model: { ...model, baseUrl: 'https://other-endpoint.example/v1' },
      messages: [...messages, { role: 'assistant', content: 'first answer' }, { role: 'user', content: 'again' }],
      ...(durable ? { codexSession: persisted } : {}) }));
    expect(startThreadMock).toHaveBeenCalledTimes(2);
    expect(resumeThreadMock).toHaveBeenCalledTimes(1);
    expect(codexCtorMock).toHaveBeenLastCalledWith(expect.objectContaining({
      baseUrl: 'https://other-endpoint.example/v1',
    }));
  });

  it.each(['0', '1'])('keeps subscription credentials on their managed route with app-server=%s', async appServer => {
    process.env.FLUJO_CODEX_APP_SERVER = appServer;
    await new CodexAdapter().createCompletion(baseInput({ apiKey: '',
      model: { ...baseInput().model, baseUrl: 'https://other-endpoint.example/v1' } }));
    if (appServer === '1') {
      expect(codexCtorMock).not.toHaveBeenCalled();
      expect(appServerThreadMock).toHaveBeenCalledTimes(1);
      expect(appServerThreadMock.mock.calls[0][0].config).not.toHaveProperty('openai_base_url');
      expect(appServerThreadMock.mock.calls[0][0].config).not.toHaveProperty('model_provider');
    } else {
      expect(codexCtorMock).toHaveBeenCalledTimes(1);
      expect(codexCtorMock.mock.calls[0][0]).not.toHaveProperty('baseUrl');
      expect(codexCtorMock.mock.calls[0][0].config).not.toHaveProperty('model_provider');
    }
  });

  it('resumes from durable metadata after the process-local cache is cleared', async () => {
    let persisted: CompletionInput['codexSession'];
    const onCodexSessionChange = (session: CompletionInput['codexSession']) => { persisted = session; };
    runStreamedMock
      .mockImplementationOnce(async () => ({
        events: eventStream([
          threadStarted('thread-durable'),
          agentMessage('first answer'),
          turnCompleted({ input_tokens: 2, cached_input_tokens: 0, output_tokens: 1 }),
        ])(),
      }))
      .mockImplementationOnce(async () => ({
        events: eventStream([
          threadStarted('thread-durable'),
          agentMessage('second answer'),
          turnCompleted({ input_tokens: 2, cached_input_tokens: 0, output_tokens: 1 }),
        ])(),
      }));

    const identity = { conversationId: 'durable-conversation', nodeId: 'process-1', sessionResume: true };
    await new CodexAdapter().createCompletion(baseInput({ ...identity, onCodexSessionChange }));
    expect(persisted?.threadId).toBe('thread-durable');
    _clearCodexSessionsForTests();

    await new CodexAdapter().createCompletion(baseInput({
      ...identity,
      codexSession: persisted,
      onCodexSessionChange,
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'first answer' },
        { role: 'user', content: 'next' },
      ] as OpenAI.ChatCompletionMessageParam[],
    }));

    expect(startThreadMock).toHaveBeenCalledTimes(1);
    expect(resumeThreadMock).toHaveBeenCalledWith('thread-durable', expect.any(Object));
    expect(runStreamedMock.mock.calls[1][0]).toBe('next');
  });

  it('invalidates a stale resumed thread and retries the same request fresh once', async () => {
    let persisted: CompletionInput['codexSession'];
    const updates: Array<string | undefined> = [];
    const onCodexSessionChange = (session: CompletionInput['codexSession']) => {
      persisted = session;
      updates.push(session?.threadId);
    };
    runStreamedMock
      .mockImplementationOnce(async () => ({
        events: eventStream([
          threadStarted('thread-stale'),
          agentMessage('first answer'),
          turnCompleted({ input_tokens: 2, cached_input_tokens: 0, output_tokens: 1 }),
        ])(),
      }))
      .mockRejectedValueOnce(new Error('thread not found'))
      .mockImplementationOnce(async () => ({
        events: eventStream([
          threadStarted('thread-replacement'),
          agentMessage('recovered answer'),
          turnCompleted({ input_tokens: 2, cached_input_tokens: 0, output_tokens: 1 }),
        ])(),
      }));

    const identity = { conversationId: 'stale-conversation', nodeId: 'process-1', sessionResume: true };
    await new CodexAdapter().createCompletion(baseInput({ ...identity, onCodexSessionChange }));
    await new CodexAdapter().createCompletion(baseInput({
      ...identity,
      codexSession: persisted,
      onCodexSessionChange,
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'first answer' },
        { role: 'user', content: 'do not lose this request' },
      ] as OpenAI.ChatCompletionMessageParam[],
    }));

    expect(resumeThreadMock).toHaveBeenCalledTimes(1);
    expect(startThreadMock).toHaveBeenCalledTimes(2);
    expect(runStreamedMock.mock.calls[2][0]).toEqual(expect.stringContaining('do not lose this request'));
    expect(updates).toEqual(['thread-stale', undefined, 'thread-replacement']);
  });

  it('does not retry a cancelled resumed thread as a fresh SDK run', async () => {
    const controller = new AbortController();
    let persisted: CompletionInput['codexSession'];
    const onCodexSessionChange = jest.fn((session: CompletionInput['codexSession']) => {
      persisted = session;
    });
    runStreamedMock
      .mockImplementationOnce(async () => ({
        events: eventStream([
          threadStarted('thread-cancelled'),
          agentMessage('first answer'),
          turnCompleted({ input_tokens: 2, cached_input_tokens: 0, output_tokens: 1 }),
        ])(),
      }))
      .mockImplementationOnce(async () => ({
        events: (async function* () {
          yield threadStarted('thread-cancelled');
          controller.abort();
          yield agentMessage('This cancelled answer must not escape.');
        })(),
      }));

    const identity = { conversationId: 'cancelled-conversation', nodeId: 'process-1', sessionResume: true };
    await new CodexAdapter().createCompletion(baseInput({ ...identity, onCodexSessionChange }));
    const onTranscriptMessage = jest.fn();
    await expect(new CodexAdapter().createCompletion(baseInput({
      ...identity,
      codexSession: persisted,
      onCodexSessionChange,
      onTranscriptMessage,
      signal: controller.signal,
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'first answer' },
        { role: 'user', content: 'next' },
      ] as OpenAI.ChatCompletionMessageParam[],
    }))).rejects.toThrow('Codex run cancelled by user.');

    expect(resumeThreadMock).toHaveBeenCalledTimes(1);
    expect(startThreadMock).toHaveBeenCalledTimes(1);
    expect(runStreamedMock).toHaveBeenCalledTimes(2);
    const resumedOptions = runStreamedMock.mock.calls[1][1] as { signal: AbortSignal };
    expect(resumedOptions.signal.aborted).toBe(true);
    expect(onTranscriptMessage).not.toHaveBeenCalled();
    expect(onCodexSessionChange).toHaveBeenLastCalledWith(undefined);
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


it('steers a quiet Codex turn and requeues if its replacement turn rejects the input', async () => {
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  runStreamedMock.mockImplementationOnce(async (_text: unknown, { signal }: { signal: AbortSignal }) => ({
    events: (async function* () {
      yield { type: 'thread.started', thread_id: 'quiet-thread' };
      entered();
      await new Promise<void>(resolve => {
        if (signal.aborted) resolve(); else signal.addEventListener('abort', () => resolve(), { once: true });
      });
      throw new Error('interrupted');
    })(),
  })).mockRejectedValueOnce(new Error('replacement input rejected'));
  let pending = false;
  let notify!: () => void;
  const batch = {
    messages: [{ id: 'quiet-correction', role: 'user' as const, content: 'Change direction', timestamp: 1, injected: true }],
    beforeSend: jest.fn(async () => undefined), acknowledge: jest.fn(async () => undefined), requeue: jest.fn(),
  };
  const running = new CodexAdapter().createCompletion(baseInput({ steering: {
    take: async () => { if (!pending) return undefined; pending = false; return batch; },
    subscribe: listener => { notify = listener; return () => {}; },
  } }));
  const rejected = expect(running).rejects.toThrow('replacement input rejected');
  await started; pending = true; notify();
  await rejected;
  expect(runStreamedMock).toHaveBeenCalledTimes(2);
  expect(startThreadMock).toHaveBeenCalledTimes(1);
  expect(batch.requeue).toHaveBeenCalledTimes(1);
  expect(batch.acknowledge).not.toHaveBeenCalled();
});
