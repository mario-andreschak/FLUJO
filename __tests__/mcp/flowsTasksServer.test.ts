import fs from 'node:fs';
import path from 'node:path';
import { runWithWorkspace } from '@/utils/workspace';
import { getDataDir } from '@/utils/paths';
import { initializeEncryption, verifyPassword } from '@/utils/encryption/secure';
import { issueOwnerCredential, type OwnerPolicy } from '@/backend/services/security/ownerCredentials';
import { resolveOwnerRequest } from '@/backend/services/security/ownerAccess';
import { flowToolsCallTool } from '@/backend/services/mcp/flowTools';
import { serverTaskStore } from '@/backend/services/mcp/serverTasks';
import { handleModernFlowsMcpRequest, isLegacyFlowsMcpRequest } from '@/backend/services/mcp/flowsTasksServer';
import { executionExtensionAdapter, hasExecutionExtensionContext } from '@/backend/execution/extensions';
import { CallToolResultV2Schema, CreateTaskResultV2Schema, GetTaskResultV2Schema } from '@modelcontextprotocol/ext-tasks/core/v2';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

// Keep the real HTTP SDK, extension codecs, durable store and private policy.
// Controlled work makes cancellation/authorization races deterministic without
// calling a provider or executing an actual user's authored Flow.
jest.mock('@/backend/services/mcp/flowTools', () => ({
  flowToolsListTools: jest.fn(async () => ({ tools: [{ name: 'owned_flow', description: 'Owned test flow',
    inputSchema: { type: 'object', properties: { input: { type: 'string' } }, required: ['input'] } }] })),
  flowToolsCallTool: jest.fn(),
}));
jest.mock('@/backend/services/mcp/flowAuthoringTools', () => ({
  authoringToolDefinitions: () => [{ name: 'validate_flow_spec', inputSchema: { type: 'object' } }],
  isAuthoringTool: (name: string) => name === 'validate_flow_spec',
  authoringCallTool: jest.fn(async () => ({ content: [{ type: 'text', text: 'Validated.' }] })),
}));
jest.mock('@/backend/execution/extensions', () => ({
  executionExtensionAdapter: jest.fn(), hasExecutionExtensionContext: jest.fn(() => false),
}));

type RpcBody = { id?: number; result?: Record<string, unknown>; error?: { code: number; message: string } };
type RunOptions = { abortSignal: AbortSignal; assertAuthorized: () => void;
  requestInput?: (requests: Record<string, unknown>) => Promise<Record<string, unknown>> };
const mockRun = flowToolsCallTool as jest.Mock;
const scopes = ['mcp:access', 'control:admin', 'secrets:read'] as const;
const workspace = 'default-workspace';
let token: string, policy: OwnerPolicy, policyPath: string, id = 0;

function request(method: string, params: Record<string, unknown> = {}, options: {
  tasks?: boolean; form?: boolean; bearer?: string | null; workspace?: string; signal?: AbortSignal;
} = {}) {
  const body = { jsonrpc: '2.0', id: ++id, method, params: { ...params, _meta: {
    'io.modelcontextprotocol/protocolVersion': '2026-07-28',
    'io.modelcontextprotocol/clientInfo': { name: 'flows-tasks-test', version: '1.0.0' },
    'io.modelcontextprotocol/clientCapabilities': {
      extensions: options.tasks ? { 'io.modelcontextprotocol/tasks': {} } : {},
      ...(options.form ? { elicitation: { form: {} } } : {}),
    },
  } } };
  const bearer = options.bearer === undefined ? token : options.bearer;
  return new Request(`http://localhost:4200/mcp-flows?workspace=${options.workspace ?? workspace}`, {
    method: 'POST', headers: { host: 'localhost:4200', 'content-type': 'application/json',
      accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2026-07-28', 'mcp-method': method,
      ...(typeof params.name === 'string' ? { 'mcp-name': params.name }
        : typeof params.taskId === 'string' ? { 'mcp-name': params.taskId } : {}),
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
    body: JSON.stringify(body), signal: options.signal,
  });
}
async function dispatch(method: string, params: Record<string, unknown> = {}, options: Parameters<typeof request>[2] = {}) {
  const response = await runWithWorkspace(options.workspace ?? workspace,
    () => handleModernFlowsMcpRequest(request(method, params, options)));
  const body = JSON.parse(await response.text()) as RpcBody;
  return { status: response.status, body };
}
function persist() {
  fs.writeFileSync(`${policyPath}.new`, JSON.stringify(policy), { mode: 0o600 });
  fs.renameSync(`${policyPath}.new`, policyPath);
}
async function waitFor(taskId: string, status: string, form = false): Promise<Record<string, unknown>> {
  const until = Date.now() + 7000;
  while (Date.now() < until) {
    const value = await dispatch('tasks/get', { taskId }, { tasks: true, form });
    if (value.body.error) throw new Error(value.body.error.message);
    if (value.body.result?.status === status) return value.body.result;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`Task did not reach ${status}`);
}
function deferred<T>() { let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }

describe('modern Flows Tasks through actual SDK HTTP serving', () => {
  const saved = Object.fromEntries(['FLUJO_OWNER_AUTH_FILE', 'FLUJO_WORKER_MODE', 'FLUJO_MCP_TASKS_SERVER'].map(key => [key, process.env[key]]));
  let createdIds: string[] = [];
  beforeAll(async () => {
    expect(await runWithWorkspace(workspace, () => initializeEncryption('isolated-test-passphrase'))).toBe(true);
  });
  beforeEach(async () => {
    expect((await runWithWorkspace(workspace, () => verifyPassword('isolated-test-passphrase'))).valid).toBe(true);
    policyPath = path.join(getDataDir(), 'flows-tasks-test-owner.json');
    const issued = issueOwnerCredential(scopes, Date.now() + 3600000);
    token = issued.token;
    policy = { schemaVersion: 1, ownerId: 'test-owner', credentials: [issued.record] };
    persist();
    process.env.FLUJO_OWNER_AUTH_FILE = policyPath;
    delete process.env.FLUJO_WORKER_MODE;
    process.env.FLUJO_MCP_TASKS_SERVER = 'true';
    createdIds = [];
    jest.mocked(executionExtensionAdapter).mockReturnValue(undefined);
    jest.mocked(hasExecutionExtensionContext).mockReturnValue(false);
    mockRun.mockReset().mockImplementation(async (_name, _args, options: RunOptions) => {
      options.assertAuthorized();
      return { content: [{ type: 'text', text: 'Flow result.' }] };
    });
  });
  afterEach(async () => {
    // Restore the exact original policy only to drain this test's owned jobs.
    for (const record of policy.credentials) record.revokedAt = null;
    persist();
    const resolved = resolveOwnerRequest(request('ping'), scopes, { requireBearer: true });
    if (resolved.ok) for (const taskId of createdIds) {
      await runWithWorkspace(workspace, () => serverTaskStore.cancel(resolved.authorization, workspace, taskId)).catch(() => undefined);
    }
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  async function create(params: Record<string, unknown> = { name: 'owned_flow', arguments: { input: 'work' } }, form = false, signal?: AbortSignal) {
    const response = await dispatch('tools/call', params, { tasks: true, form, signal });
    expect(response.status).toBe(200);
    expect(response.body.error).toBeUndefined();
    const task = CreateTaskResultV2Schema.parse(response.body.result);
    createdIds.push(task.taskId);
    return task;
  }

  it('classifies legacy using the SDK and leaves its original body readable', async () => {
    const legacy = new Request('http://localhost/mcp-flows', { method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
        protocolVersion: '2025-11-25', clientInfo: { name: 'legacy', version: '1' }, capabilities: {},
      } }),
    });
    expect(await isLegacyFlowsMcpRequest(legacy)).toBe(true);
    expect((await legacy.json()).method).toBe('initialize');
    expect(await isLegacyFlowsMcpRequest(request('server/discover'))).toBe(false);
  });

  it('denies anonymous and insufficient scopes before modern body parsing', async () => {
    const incoming = request('tools/call', { name: 'owned_flow' }, { bearer: null });
    const text = jest.spyOn(incoming, 'text'), json = jest.spyOn(incoming, 'json');
    expect((await handleModernFlowsMcpRequest(incoming)).status).toBe(401);
    expect(text).not.toHaveBeenCalled(); expect(json).not.toHaveBeenCalled();
    const limited = issueOwnerCredential(['openai:execute'], Date.now() + 60000);
    policy.credentials.push(limited.record); persist();
    expect((await dispatch('tools/call', { name: 'owned_flow' }, { bearer: limited.token })).status).toBe(403);
    expect(mockRun).not.toHaveBeenCalled();
  });

  it('advertises only enabled ordinary Tasks and leaves synchronous results intact', async () => {
    const discover = await dispatch('server/discover');
    expect((discover.body.result?.capabilities as { extensions: Record<string, unknown> }).extensions)
      .toHaveProperty(['io.modelcontextprotocol/tasks']);
    const sync = await dispatch('tools/call', { name: 'owned_flow', arguments: { input: 'sync' } });
    expect(CallToolResultV2Schema.parse(sync.body.result).resultType).toBe('complete');
    expect(sync.body.result).not.toHaveProperty('taskId');
    process.env.FLUJO_MCP_TASKS_SERVER = 'false';
    const disabled = await dispatch('server/discover');
    expect((disabled.body.result?.capabilities as { extensions?: unknown }).extensions).toBeUndefined();
    const unaware = await dispatch('tools/call', { name: 'owned_flow' }, { tasks: true });
    expect(unaware.body.result?.resultType).toBe('complete');
  });

  it('never interprets task-shaped synchronous content or authoring calls as Tasks', async () => {
    mockRun.mockResolvedValue({ content: [{ type: 'text', text: 'ordinary' }], structuredContent: {
      task: { taskId: 'ordinary-business-data', status: 'working' },
    } });
    const sync = await dispatch('tools/call', { name: 'owned_flow' });
    expect(sync.body.result?.resultType).toBe('complete');
    expect(sync.body.result?.structuredContent).toEqual({ task: { taskId: 'ordinary-business-data', status: 'working' } });
    const authored = await dispatch('tools/call', { name: 'validate_flow_spec' }, { tasks: true });
    expect(authored.body.result?.resultType).toBe('complete');
    expect(authored.body.result).not.toHaveProperty('taskId');
    expect((await dispatch('tools/call', { name: 5 })).body.error?.code).toBe(-32602);
  });

  it('refuses unnegotiated confirmation without creating or starting a job', async () => {
    const result = await dispatch('tools/call', { name: 'owned_flow', arguments: { input: 'work', confirm: true } }, { tasks: true });
    expect(result.body.result).toMatchObject({ resultType: 'complete', isError: true });
    expect(result.body.result).not.toHaveProperty('taskId');
    expect(mockRun).not.toHaveBeenCalled();
  });

  it('uses synchronous unknown-tool errors and requires opt-in on task access', async () => {
    mockRun.mockResolvedValueOnce({ content: [{ type: 'text', text: 'Unknown flow.' }], isError: true });
    const unknown = await dispatch('tools/call', { name: 'unknown_flow' }, { tasks: true });
    expect(unknown.body.result).toMatchObject({ resultType: 'complete', isError: true });
    expect(unknown.body.result).not.toHaveProperty('taskId');
    const task = await create();
    const unaware = await dispatch('tasks/get', { taskId: task.taskId });
    expect(unaware.body.error?.message).toBe('Task is unavailable.');
    expect(unaware.body.result).toBeUndefined();
  });

  it('retains SDK header/body and size checks before executing a tool', async () => {
    const mismatch = request('tools/call', { name: 'owned_flow' }, { tasks: true });
    mismatch.headers.set('mcp-name', 'different_tool');
    const denied = await runWithWorkspace(workspace, () => handleModernFlowsMcpRequest(mismatch));
    expect(denied.status).toBe(400);
    const huge = await dispatch('tools/call', { name: 'owned_flow', arguments: { input: 'x'.repeat(256 * 1024) } }, { tasks: true });
    expect(huge.status).toBe(413);
    const nonlocal = request('tools/call', { name: 'owned_flow' }, { tasks: true });
    nonlocal.headers.set('host', 'untrusted.example');
    expect((await handleModernFlowsMcpRequest(nonlocal)).status).toBe(403);
    expect(mockRun).not.toHaveBeenCalled();
  });

  it('interoperates with the actual modern SDK client fetch transport', async () => {
    const transport = new StreamableHTTPClientTransport(new URL('http://localhost:4200/mcp-flows'), {
      requestInit: { headers: { authorization: `Bearer ${token}`, host: 'localhost:4200' } },
      fetch: async (input, init) => runWithWorkspace(workspace,
        () => handleModernFlowsMcpRequest(new Request(input, init))),
    });
    const client = new Client({ name: 'actual-sdk-test', version: '1.0.0' }, {
      versionNegotiation: { mode: { pin: '2026-07-28' } }, capabilities: {},
    });
    try {
      await client.connect(transport);
      expect((await client.listTools()).tools.map(tool => tool.name)).toEqual(['validate_flow_spec', 'owned_flow']);
      expect(await client.callTool({ name: 'owned_flow', arguments: { input: 'synchronous SDK call' } }))
        .toMatchObject({ content: [{ text: 'Flow result.' }] });
    } finally { await client.close(); }
  });

  it('survives creation request close and returns a durable terminal payload on later HTTP requests', async () => {
    const gate = deferred<void>();
    mockRun.mockImplementation(async (_name, _args, options: RunOptions) => {
      await gate.promise; options.assertAuthorized();
      return { content: [{ type: 'text', text: 'private detached result' }] };
    });
    const creation = new AbortController();
    const task = await create(undefined, false, creation.signal);
    creation.abort();
    expect(task.resultType).toBe('task'); expect(task).not.toHaveProperty('task');
    expect((await waitFor(task.taskId, 'working')).status).toBe('working');
    expect((mockRun.mock.calls[0][2] as RunOptions).abortSignal.aborted).toBe(false);
    gate.resolve();
    const complete = GetTaskResultV2Schema.parse(await waitFor(task.taskId, 'completed'));
    expect(complete.status).toBe('completed');
    expect(complete).toMatchObject({ result: { content: [{ text: 'private detached result' }] } });
    const ledger = fs.readFileSync(path.join(getDataDir(), '.mcp-server-tasks', 'ledger.json'), 'utf8');
    expect(ledger).not.toContain('private detached result');
  });

  it('denies another credential and another selected workspace without disclosing a task result', async () => {
    const second = issueOwnerCredential(scopes, Date.now() + 3600000);
    policy.credentials.push(second.record); persist();
    const task = await create(); await waitFor(task.taskId, 'completed');
    const otherCredential = await dispatch('tasks/get', { taskId: task.taskId }, { tasks: true, bearer: second.token });
    expect(otherCredential.body.error?.message).toBe('Task is unavailable.');
    const otherWorkspace = await dispatch('tasks/get', { taskId: task.taskId }, { tasks: true, workspace: 'other-workspace' });
    expect(otherWorkspace.body.error?.message).toBe('Task is unavailable.');
    expect(JSON.stringify(otherWorkspace.body)).not.toContain('Flow result.');
  });

  it('cooperatively cancels once and does not publish a late result', async () => {
    const gate = deferred<void>();
    mockRun.mockImplementation(async (_name, _args, options: RunOptions) => {
      await gate.promise; options.assertAuthorized(); return { content: [{ type: 'text', text: 'late' }] };
    });
    const task = await create();
    expect((await dispatch('tasks/cancel', { taskId: task.taskId }, { tasks: true })).body.result?.resultType).toBe('complete');
    expect((mockRun.mock.calls[0][2] as RunOptions).abortSignal.aborted).toBe(true);
    gate.resolve();
    expect((await waitFor(task.taskId, 'cancelled')).result).toBeUndefined();
    expect((await dispatch('tasks/cancel', { taskId: task.taskId }, { tasks: true })).body.error).toBeUndefined();
  });

  it('updates actual input-required Tasks over HTTP and keeps repeat responses idempotent', async () => {
    mockRun.mockImplementation(async (_name, _args, options: RunOptions) => {
      const responses = await options.requestInput!({ approval: { method: 'elicitation/create', params: {
        mode: 'form', message: 'Approve test work', requestedSchema: { type: 'object', properties: {} },
      } } });
      options.assertAuthorized();
      return { content: [{ type: 'text', text: String((responses.approval as { action: string }).action) }] };
    });
    const task = await create(undefined, true);
    expect((await waitFor(task.taskId, 'input_required', true)).inputRequests).toHaveProperty('approval');
    const unsupported = await dispatch('tasks/get', { taskId: task.taskId }, { tasks: true });
    expect(unsupported.body.error?.code).toBe(-32021);
    expect(unsupported.body.result).toBeUndefined();
    expect((await dispatch('tasks/get', { taskId: task.taskId }, { tasks: true, form: true })).body.result)
      .toMatchObject({ status: 'input_required', inputRequests: { approval: { method: 'elicitation/create' } } });
    const invalid = await dispatch('tasks/update', { taskId: task.taskId,
      inputResponses: { approval: { method: 'elicitation/create', result: { action: 'accept' } } } }, { tasks: true });
    expect(invalid.body.error?.code).toBe(-32602);
    const responses = { approval: { action: 'accept' } };
    expect((await dispatch('tasks/update', { taskId: task.taskId, inputResponses: responses }, { tasks: true })).body.error).toBeUndefined();
    await waitFor(task.taskId, 'completed', true);
    expect((await dispatch('tasks/update', { taskId: task.taskId, inputResponses: responses }, { tasks: true })).body.error).toBeUndefined();
    expect((await dispatch('tasks/update', { taskId: task.taskId, inputResponses: { unknown: { action: 'decline' } } }, { tasks: true })).body.error).toBeUndefined();
  });

  it('revokes detached authority and refuses later HTTP access', async () => {
    const gate = deferred<void>(); let ranEffect = false;
    mockRun.mockImplementation(async (_name, _args, options: RunOptions) => {
      await gate.promise; options.assertAuthorized(); ranEffect = true; return { content: [] };
    });
    const task = await create();
    policy.credentials[0].revokedAt = Date.now(); persist();
    expect((await dispatch('tasks/get', { taskId: task.taskId }, { tasks: true })).status).toBe(401);
    gate.resolve(); await new Promise(resolve => setTimeout(resolve, 150));
    expect(ranEffect).toBe(false);
  });

  it('does not grant Tasks through worker, execution-extension or inherited private context', async () => {
    for (const kind of ['worker', 'adapter', 'context']) {
      process.env.FLUJO_WORKER_MODE = kind === 'worker' ? '1' : '0';
      jest.mocked(executionExtensionAdapter).mockReturnValue(kind === 'adapter' ? {} as never : undefined);
      jest.mocked(hasExecutionExtensionContext).mockReturnValue(kind === 'context');
      const discover = await dispatch('server/discover');
      expect((discover.body.result?.capabilities as { extensions?: unknown }).extensions).toBeUndefined();
      const call = await dispatch('tools/call', { name: 'owned_flow' }, { tasks: true });
      expect(call.body.result?.resultType).toBe('complete');
    }
  });
});
