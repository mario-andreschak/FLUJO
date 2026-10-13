jest.mock('@/backend/services/mcp', () => ({ mcpService: { getClient: jest.fn() } }));
import { mcpService } from '@/backend/services/mcp';
import { Client as SplitClient, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { Client as LegacyClient } from '@modelcontextprotocol/sdk/client/index.js';
import { createMcpHandler, Server } from '@modelcontextprotocol/server';
import { GetTaskRequestV2Schema, GetTaskResultV2Schema, hasTaskClientCapabilityV2 } from '@modelcontextprotocol/ext-tasks/core/v2';
import { callTool } from '@/backend/services/mcp/tools';
import { registerTasksExtensionClient, closeTasksExtensionSession, getTasksExtensionSession } from '@/backend/services/mcp/tasksExtensionSession';
import { fetchTaskStatus, fetchTaskPayload, cancelRemoteTask } from '@/backend/services/mcp/tasksProtocol';
import { resolveGlobalVars } from '@/backend/utils/resolveGlobalVars';
import { createRemoteTaskRecord, patchRemoteTaskRecord } from '@/backend/services/mcp/remoteTaskStore';
import { assertExecutionToolDispatch, normalizeExecutionToolArguments, executionToolRequestMeta } from '@/backend/execution/extensions';

// Exercise actual tools dispatch, negotiation, extension coordinator, lifecycle,
// split SDK HTTP codecs and response classification. Persistence projections
// and external interpolation are deterministic seams; their stores have their
// own disk/ownership suites. No provider, account or real network is involved.
jest.mock('@/backend/utils/resolveGlobalVars', () => ({ resolveGlobalVars: jest.fn(async value => value) }));
jest.mock('@/backend/services/mcp/betaClient', () => ({ isBetaClient: (client: { split?: boolean }) => client.split === true }));
jest.mock('@/backend/services/mcp/remoteTaskStore', () => ({
  resolveServerIdentity: jest.fn(async () => 'synthetic-http-identity'),
  getMcpRemoteTaskSettings: jest.fn(async () => ({ requestedTtlMs: 60000, minPollIntervalMs: 1,
    maxPollIntervalMs: 20, defaultPollIntervalMs: 5, fallbackTtlMs: 60000,
    inputRequiredTimeoutMs: 200, maxTransientPollFailures: 0 })),
  acquirePollSlot: jest.fn(async () => ({ release: jest.fn() })),
  createRemoteTaskRecord: jest.fn(async input => ({ recordId: 'synthetic-record', ...input })),
  patchRemoteTaskRecord: jest.fn(async (_id, patch) => ({ recordId: 'synthetic-record', ...patch })),
}));
jest.mock('@/backend/services/mcp/externalAuthorization', () => ({
  serverSupportsExternalAuthorization: () => false,
}));
jest.mock('@/backend/services/mcp/config', () => ({ loadServerConfigs: jest.fn(async () => [{
  name: 'srv', transport: 'streamable', serverUrl: 'http://localhost:4200/reference', disabled: false,
}]) }));
jest.mock('@/backend/execution/extensions', () => ({
  isProtectedExecutionServer: () => false, assertExecutionToolDispatch: jest.fn(async () => undefined),
  normalizeExecutionToolArguments: jest.fn((_ctx, _name, args) => args),
  executionToolRequestMeta: jest.fn(async () => ({ syntheticExecutionWitness: 'private' })),
  assertExecutionExtensionCurrent: jest.fn(async () => undefined), validateExecutionToolResult: (_ctx: unknown, _name: unknown, result: unknown) => result,
  ExecutionExtensionError: class extends Error {},
}));

type Wire = { id: string | number; method: string; params?: Record<string, unknown> };
type Mode = 'task' | 'plain' | 'malformed' | 'illegal' | 'ambiguous' | 'wait';
const extension = 'io.modelcontextprotocol/tasks';
const timestamp = new Date().toISOString();
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
async function until(test: () => boolean) {
  const end = Date.now() + 2000;
  while (!test()) { if (Date.now() > end) throw new Error('Expected dispatch did not occur'); await tick(); }
}

async function fixture(mode: Mode = 'task', advertised = true) {
  const wire: Wire[] = [];
  let sequence = 0;
  const handler = createMcpHandler(() => {
    const server = new Server({ name: 'dispatch-reference', version: '1' }, {
      capabilities: { tools: {}, ...(advertised ? { extensions: { [extension]: {} } } : {}) },
    });
    server.setRequestHandler('tools/list', () => ({ tools: [{ name: 'operation', inputSchema: { type: 'object' } }] }));
    server.fallbackRequestHandler = async (rpc, ctx) => {
      if (rpc.method !== 'tools/call') throw new Error('Unexpected extension RPC');
      if (mode === 'malformed') return { resultType: 'task', status: 'working' };
      if (mode === 'plain' || (mode !== 'illegal' && !hasTaskClientCapabilityV2({ _meta: ctx.mcpReq.envelope }))) {
        return { resultType: 'complete', content: [{ type: 'text', text: 'ordinary response' }],
          structuredContent: { task: { taskId: 'business-only', status: 'working' } } };
      }
      return { resultType: 'task', taskId: `reference-${++sequence}`, status: 'working',
        createdAt: timestamp, lastUpdatedAt: timestamp, ttlMs: 60000, pollIntervalMs: 1 };
    };
    server.setRequestHandler('tasks/get', { params: GetTaskRequestV2Schema.shape.params }, params =>
      GetTaskResultV2Schema.parse({ resultType: 'complete', taskId: params.taskId, status: 'completed',
        createdAt: timestamp, lastUpdatedAt: timestamp, ttlMs: 60000, pollIntervalMs: 1,
        result: { resultType: 'complete', content: [{ type: 'text', text: 'task result' }] },
      }));
    return server;
  }, { legacy: 'reject' });
  const transport = new StreamableHTTPClientTransport(new URL('http://localhost:4200/reference'), {
    fetch: async (input, init) => {
      const request = new Request(input, init);
      if (request.method === 'POST') {
        const frame = JSON.parse(await request.clone().text()) as Wire; wire.push(frame);
        if (frame.method === 'tools/call' && mode === 'ambiguous') throw new Error('Connection lost after submission');
        if (frame.method === 'tools/call' && mode === 'wait') return new Promise<Response>((_resolve, reject) => {
          request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true });
        });
      }
      const response = await handler.fetch(request);
      // Native undici Response.json() otherwise returns host-realm objects to
      // Jest's VM. Parse the identical wire bytes in the consumer's realm.
      response.json = async () => JSON.parse(await response.text());
      return response;
    },
  });
  const client = new SplitClient({ name: 'dispatch-host', version: '1' }, {
    versionNegotiation: { mode: { pin: '2026-07-28' } }, capabilities: {},
  });
  Object.assign(client, { split: true });
  registerTasksExtensionClient(client, { endpointId: 'reference-endpoint',
    clientInfo: { name: 'dispatch-host', version: '1' }, clientCapabilities: {},
  });
  await client.connect(transport);
  jest.mocked(mcpService.getClient).mockReturnValue(client as unknown as LegacyClient);
  return { client, legacy: client as unknown as LegacyClient, wire,
    async close() { await closeTasksExtensionSession(client); await client.close(); await handler.close(); },
  };
}

describe('real tools.ts modern Tasks dispatch', () => {
  const savedFlag = process.env.FLUJO_MCP_TASKS_CLIENT;
  beforeAll(() => {
    // The vendor JSON predicate deliberately checks Object.prototype. Node's
    // native structuredClone crosses Jest's VM realm; keep this JSON-only seam
    // in the VM, as in the official session wire suite.
    jest.spyOn(globalThis, 'structuredClone').mockImplementation(value => JSON.parse(JSON.stringify(value)));
  });
  beforeEach(() => { process.env.FLUJO_MCP_TASKS_CLIENT = 'true'; jest.clearAllMocks(); });
  afterAll(() => { jest.restoreAllMocks();
    if (savedFlag === undefined) delete process.env.FLUJO_MCP_TASKS_CLIENT;
    else process.env.FLUJO_MCP_TASKS_CLIENT = savedFlag;
  });

  test('final normalized arguments and host metadata survive extension wire and lifecycle dispatch', async () => {
    const peer = await fixture();
    jest.mocked(resolveGlobalVars).mockResolvedValueOnce({ message: 'resolved value', itemCount: null, isReady: undefined, tags: null });
    try {
      const result = await callTool(peer.legacy, 'srv', 'operation', { message: '${synthetic}' }, 5,
        undefined, undefined, 'host', 'node-owner', 'owner-scope');
      expect(result.error).toBeUndefined();
      expect(result).toMatchObject({ success: true, data: { content: [{ text: 'task result' }] } });
      const calls = peer.wire.filter(frame => frame.method === 'tools/call');
      expect(calls).toHaveLength(1);
      expect(calls[0].params).toMatchObject({ arguments: { message: 'resolved value', itemCount: 0, isReady: false, tags: [] },
        _meta: { flujo: { callerNodeId: 'node-owner', ownerScope: 'owner-scope' },
          'io.modelcontextprotocol/clientCapabilities': { extensions: { [extension]: {} } } } });
      expect(calls[0].params).not.toHaveProperty('task');
      expect(peer.wire.some(frame => frame.method === 'tasks/get')).toBe(true);
      expect(peer.wire.some(frame => frame.method === 'tasks/result')).toBe(false);
      expect(jest.mocked(createRemoteTaskRecord).mock.calls[0][0]).toMatchObject({
        generation: '2026-07-28', ownership: { nodeId: 'node-owner', ownerScope: 'owner-scope', source: 'host' },
      });
      expect(patchRemoteTaskRecord).toHaveBeenCalled();
    } finally { await peer.close(); }
  });

  test.each([['plain' as Mode, true], ['task' as Mode, false]])('ordinary SDK responses stay synchronous (%s, advertised=%s)', async (mode, advertised) => {
    const peer = await fixture(mode, advertised);
    try {
      const result = await callTool(peer.legacy, 'srv', 'operation', {});
      expect(result.error).toBeUndefined();
      expect(result).toMatchObject({ success: true,
        data: { structuredContent: { task: { taskId: 'business-only' } } } });
      expect(peer.wire.filter(frame => frame.method.startsWith('tasks/'))).toEqual([]);
      expect(createRemoteTaskRecord).not.toHaveBeenCalled();
    } finally { await peer.close(); }
  });

  test('retains legacy per-tool augmentation and leaves forbidden tools ordinary', async () => {
    const legacy = { getServerCapabilities: () => ({ tasks: { requests: { tools: { call: {} } } } }),
      listTools: jest.fn(async () => ({ tools: [{ name: 'optional', execution: { taskSupport: 'optional' } },
        { name: 'forbidden', execution: { taskSupport: 'forbidden' } }] })),
      callTool: jest.fn(async (_params: unknown, _schema?: unknown, _options?: unknown) => ({ content: [] })),
    };
    expect((await callTool(legacy as unknown as LegacyClient, 'srv', 'optional', {})).success).toBe(true);
    expect(legacy.callTool.mock.calls[0][0]).toMatchObject({ task: { ttl: 60000 } });
    await callTool(legacy as unknown as LegacyClient, 'srv', 'forbidden', {});
    expect(legacy.callTool.mock.calls[1][0]).not.toHaveProperty('task');
  });

  test('an admitted private execution call bypasses Tasks and shared interpolation', async () => {
    const peer = await fixture();
    try {
      const ordinary = jest.spyOn(peer.client, 'callTool');
      expect((await callTool(peer.legacy, 'srv', 'operation', { input: 'private' }, 5, undefined, undefined,
        'host', undefined, undefined, {} as never)).success).toBe(true);
      expect(assertExecutionToolDispatch).toHaveBeenCalled();
      expect(normalizeExecutionToolArguments).toHaveBeenCalled();
      expect(executionToolRequestMeta).toHaveBeenCalled();
      expect(resolveGlobalVars).not.toHaveBeenCalled();
      expect(ordinary).toHaveBeenCalledTimes(1);
      expect(peer.wire.find(frame => frame.method === 'tools/call')?.params?._meta)
        .toMatchObject({ syntheticExecutionWitness: 'private' });
      expect(peer.wire.filter(frame => frame.method.startsWith('tasks/'))).toEqual([]);
    } finally { await peer.close(); }
  });

  test('malformed negotiated and unnegotiated handles fail closed without polling', async () => {
    for (const advertised of [true, false]) {
      const peer = await fixture('malformed', advertised);
      try {
        const result = await callTool(peer.legacy, 'srv', 'operation', {});
        expect(result.success).toBe(false);
        if (advertised) expect(result).toMatchObject({ statusCode: 502, errorType: 'task-protocol-invalid' });
        expect(peer.wire.filter(frame => frame.method === 'tools/call')).toHaveLength(1);
        expect(peer.wire.filter(frame => frame.method.startsWith('tasks/'))).toEqual([]);
      } finally { await peer.close(); }
    }
    expect(createRemoteTaskRecord).not.toHaveBeenCalled();
  });

  test('a valid handle without Tasks negotiation is refused without polling or persistence', async () => {
    const peer = await fixture('illegal', false);
    try {
      expect((await callTool(peer.legacy, 'srv', 'operation', {})).success).toBe(false);
      expect(peer.wire.filter(frame => frame.method === 'tools/call')).toHaveLength(1);
      expect(peer.wire.filter(frame => frame.method.startsWith('tasks/'))).toEqual([]);
      expect(createRemoteTaskRecord).not.toHaveBeenCalled();
    } finally { await peer.close(); }
  });

  test('ambiguous creation failure is never retried', async () => {
    const peer = await fixture('ambiguous');
    try {
      expect((await callTool(peer.legacy, 'srv', 'operation', {})).success).toBe(false);
      expect(peer.wire.filter(frame => frame.method === 'tools/call')).toHaveLength(1);
      expect(peer.wire.filter(frame => frame.method.startsWith('tasks/'))).toEqual([]);
    } finally { await peer.close(); }
  });

  test('caller abort stops creation and never retries it', async () => {
    const peer = await fixture('wait');
    try {
      const controller = new AbortController();
      const pending = callTool(peer.legacy, 'srv', 'operation', {}, 5, undefined, controller.signal);
      await until(() => peer.wire.some(frame => frame.method === 'tools/call')); controller.abort();
      expect(await pending).toMatchObject({ success: false, errorType: 'cancelled' });
      expect(peer.wire.filter(frame => frame.method === 'tools/call')).toHaveLength(1);
    } finally { await peer.close(); }
  });

  test('pre-aborted dispatch never submits creation', async () => {
    const peer = await fixture();
    try {
      const controller = new AbortController(); controller.abort();
      expect(await callTool(peer.legacy, 'srv', 'operation', {}, 5, undefined, controller.signal))
        .toMatchObject({ success: false, errorType: 'cancelled' });
      expect(peer.wire.filter(frame => frame.method === 'tools/call')).toEqual([]);
      expect(createRemoteTaskRecord).not.toHaveBeenCalled();
    } finally { await peer.close(); }
  });

  test.each(['session', 'transport'])('retired modern %s cannot dispatch a legacy task follow-up', async kind => {
    const peer = await fixture();
    try {
      expect(getTasksExtensionSession(peer.client)).toBeDefined();
      if (kind === 'session') await closeTasksExtensionSession(peer.client);
      else await peer.client.close();
      const request = jest.spyOn(peer.client, 'request');
      await expect(fetchTaskStatus(peer.legacy, 'existing')).rejects.toThrow(/session is unavailable/);
      await expect(fetchTaskPayload(peer.legacy, 'existing')).rejects.toThrow(/session is unavailable/);
      await cancelRemoteTask(peer.legacy, 'existing');
      expect(request).not.toHaveBeenCalled();
      expect(peer.wire.filter(frame => frame.method.startsWith('tasks/'))).toEqual([]);
    } finally { await peer.close(); }
  });
});
