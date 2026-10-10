import { Client, InMemoryTransport, type JSONRPCMessage, type Transport } from '@modelcontextprotocol/client';
import { Server } from '@modelcontextprotocol/server';
import { taskId } from '@modelcontextprotocol/ext-tasks/core';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import {
  CreateTaskResultV2Schema,
  GetTaskResultV2Schema,
  InputResponsesV2Schema,
  type GetTaskResultV2,
} from '@modelcontextprotocol/ext-tasks/core/v2';
import {
  closeTasksExtensionSession,
  handleTasksInputRequest,
  getTasksExtensionSession,
  registerTasksExtensionClient,
  wasModernTasksExtensionClient,
  TasksExtensionRequestTimeoutError,
} from '@/backend/services/mcp/tasksExtensionSession';

const extension = 'io.modelcontextprotocol/tasks';
const clientInfo = { name: 'flujo-wire-test', version: '1' };
const clientCapabilities = { roots: { listChanged: true }, extensions: { 'test/other': {} } };
const metadata = { flowTicket: 'synthetic-owner-ticket', 'flujo/private-app': { id: 'synthetic-app' } };
const timestamp = '2026-10-09T12:00:00.000Z';
const tick = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

class ReferenceServer extends Server {
  // A serving entry binds its Server to the offered era; raw InMemoryTransport
  // has no HTTP serving entry to do so. The client still negotiates on the wire.
  serveModern(): void { this._negotiatedProtocolVersion = '2026-07-28'; }
}

/**
 * Real split-SDK negotiation and ordinary handlers over linked SDK transports,
 * with a schema-validating 2026 Tasks reference peer at the extension boundary.
 * The core SDK deliberately does not serve extension tools/call result shapes.
 */
async function connectPeer(legacy = false, authorizeLateTaskCancellation?: (taskId: string) => boolean | Promise<boolean>, isAuthorityCurrent?: () => boolean | Promise<boolean>) {
  const [transport, peer] = InMemoryTransport.createLinkedPair();
  const server = new ReferenceServer({ name: 'tasks-reference', version: '1' }, {
    capabilities: { tools: {}, extensions: { [extension]: {} } },
    supportedProtocolVersions: ['2026-07-28', '2025-11-25'],
  });
  if (!legacy) server.serveModern();
  server.setRequestHandler('tools/list', () => ({ tools: [{ name: 'ordinary', inputSchema: { type: 'object' } }] }));
  server.setRequestHandler('tools/call', () => ({ content: [{ type: 'text', text: 'ordinary SDK response' }] }));
  await server.connect(peer);
  const previous = peer.onmessage;
  const requests: JSONRPCMessage[] = [];
  const tasks = new Map<string, GetTaskResultV2>();
  const waiting: JSONRPCMessage[] = [];
  let count = 0;
  peer.onmessage = (message, extra) => {
    requests.push(message);
    if (!('method' in message) || !('id' in message)) { previous?.(message, extra); return; }
    const params = message.params ?? {};
    if (message.method === 'tools/call' && params.name === 'delayed-task') { waiting.push(message); return; }
    if (message.method === 'tools/call' && params.name === 'task') {
      const id = `task-${++count}`;
      tasks.set(id, GetTaskResultV2Schema.parse({ resultType: 'complete', taskId: id, status: 'input_required',
        createdAt: timestamp, lastUpdatedAt: timestamp, ttlMs: 60_000, pollIntervalMs: 25,
        inputRequests: { question: { method: 'elicitation/create', params: { message: 'Proceed?', requestedSchema: { type: 'object' } } } },
      }));
      if (typeof params._meta?.progressToken === 'string') void peer.send({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: params._meta.progressToken, progress: 1, total: 2, message: 'Creation admitted' } });
      const created = CreateTaskResultV2Schema.parse({ resultType: 'task', taskId: id, status: 'input_required',
        createdAt: timestamp, lastUpdatedAt: timestamp, ttlMs: 60_000, pollIntervalMs: 25 });
      void peer.send({ jsonrpc: '2.0', id: message.id, result: created });
      return;
    }
    if (message.method.startsWith('tasks/')) {
      if (params.taskId === 'wait') { waiting.push(message); return; }
      const taskId = String(params.taskId);
      const task = tasks.get(taskId);
      if (!task) { void peer.send({ jsonrpc: '2.0', id: message.id, error: { code: -32001, message: 'Unknown task' } }); return; }
      let response: Record<string, unknown>;
      if (message.method === 'tasks/update') {
        const inputs = InputResponsesV2Schema.parse(params.inputResponses);
        expect(inputs.question).toEqual({ action: 'accept', content: { answer: 'yes' } });
        tasks.set(taskId, GetTaskResultV2Schema.parse({ ...task, status: 'completed', result: { resultType: 'complete',
          content: [{ type: 'text', text: 'reference operation completed' }] } }));
        response = { resultType: 'complete' };
      } else if (message.method === 'tasks/cancel') {
        tasks.set(taskId, GetTaskResultV2Schema.parse({ ...task, status: 'cancelled' }));
        response = { resultType: 'complete' };
      } else response = task;
      void peer.send({ jsonrpc: '2.0', id: message.id, result: response });
      return;
    }
    previous?.(message, extra);
  };
  const client = new Client(clientInfo, { capabilities: clientCapabilities, versionNegotiation: { mode: legacy ? 'legacy' : 'auto' } });
  const errors = jest.fn();
  client.onerror = errors;
  registerTasksExtensionClient(client, { endpointId: 'synthetic-reference-endpoint', clientInfo, clientCapabilities, authorizeLateTaskCancellation, isAuthorityCurrent });
  await client.connect(transport);
  return { client, transport, peer, server, requests, tasks, waiting, errors,
    async close() { await closeTasksExtensionSession(client); await client.close(); await server.close(); },
  };
}

describe('2026 MCP Tasks extension session', () => {
  beforeAll(() => {
    // Node's native structuredClone returns host-realm objects into Jest's VM;
    // upstream rejects those against this VM's Object.prototype. These values
    // are JSON-only. Real Node metadata framing is independently tested below.
    jest.spyOn(globalThis, 'structuredClone').mockImplementation(value => JSON.parse(JSON.stringify(value)));
  });
  afterAll(() => { jest.restoreAllMocks(); });
  test('real split SDK generic requests reject extension task creation before custom result validation', async () => {
    const fixture = await connectPeer();
    try {
      await expect(fixture.client.request({ method: 'tools/call', params: { name: 'task' } }, CreateTaskResultV2Schema))
        .rejects.toThrow(/Unsupported result type 'task'/);
      const progress = jest.fn();
      expect(await getTasksExtensionSession(fixture.client)!.callTool({ name: 'task' }, { context: { onprogress: progress } }))
        .toMatchObject({ resultType: 'task', taskId: 'task-2' });
      expect(progress).toHaveBeenCalledWith({ progress: 1, total: 2, message: 'Creation admitted' });
      expect(fixture.requests.filter(message => 'method' in message && message.method === 'tools/call')).toHaveLength(2);
    } finally { await fixture.close(); }
  });

  test('negotiates a real SDK connection, preserves metadata, and multiplexes ordinary calls without ID collisions', async () => {
    const fixture = await connectPeer();
    try {
      expect(fixture.client.getProtocolEra()).toBe('modern');
      const bundle = getTasksExtensionSession(fixture.client)!;
      expect(getTasksExtensionSession(fixture.client)).toBe(bundle);
      expect(bundle.session.capabilities.inputResponses).toBe(true);
      const [created, ordinary] = await Promise.all([
        bundle.callTool({ name: 'task', arguments: {}, _meta: metadata }, { context: { headers: { 'X-Owner': 'synthetic' } } }),
        fixture.client.callTool({ name: 'ordinary', arguments: {} }),
      ]);
      expect(created).toMatchObject({ resultType: 'task', taskId: 'task-1' });
      expect(ordinary.content).toEqual([{ type: 'text', text: 'ordinary SDK response' }]);
      const calls = fixture.requests.filter(message => 'method' in message && message.method === 'tools/call');
      expect(calls.map(message => 'id' in message ? typeof message.id : undefined).sort()).toEqual(['number', 'string']);
      const taskCall = calls.find(message => 'id' in message && typeof message.id === 'string')!;
      expect('params' in taskCall && taskCall.params?._meta).toMatchObject({
        ...metadata,
        'io.modelcontextprotocol/protocolVersion': '2026-07-28',
        'io.modelcontextprotocol/clientInfo': clientInfo,
        'io.modelcontextprotocol/clientCapabilities': { roots: { listChanged: true }, extensions: { [extension]: {}, 'test/other': {} } },
      });
      expect(fixture.errors).not.toHaveBeenCalled();
    } finally { await fixture.close(); }
  });

  test('validates the complete input/update/result/cancel wire lifecycle against the reference peer', async () => {
    const fixture = await connectPeer();
    try {
      const bundle = getTasksExtensionSession(fixture.client)!;
      await bundle.callTool({ name: 'task' });
      expect(await bundle.getTask('task-1')).toMatchObject({ status: 'input_required', inputRequests: { question: { method: 'elicitation/create' } } });
      await bundle.updateTask('task-1', { question: { action: 'accept', content: { answer: 'yes' } } });
      expect(await bundle.getTask('task-1')).toMatchObject({ status: 'completed', result: { content: [{ text: 'reference operation completed' }] } });
      await bundle.cancelTask('task-1');
      expect(await bundle.getTask('task-1')).toMatchObject({ status: 'cancelled' });
      await expect(bundle.getTask('missing')).rejects.toMatchObject({ code: -32001, message: 'Unknown task' });
      await expect(bundle.updateTask('task-1', { question: {} } as never)).rejects.toThrow();
      expect(fixture.errors).not.toHaveBeenCalled();
    } finally { await fixture.close(); }
  });

  test('an explicit legacy connection stays byte-compatible and never creates an extension session', async () => {
    const fixture = await connectPeer(true);
    try {
      expect(fixture.client.getProtocolEra()).toBe('legacy');
      expect(getTasksExtensionSession(fixture.client)).toBeUndefined();
      await fixture.client.callTool({ name: 'ordinary' });
      const call = fixture.requests.find(message => 'method' in message && message.method === 'tools/call');
      expect(call && 'params' in call && call.params?._meta).toBeUndefined();
    } finally { await fixture.close(); }
  });

  test('aborting raw dispatch rejects promptly and absorbs late replies without corrupting ordinary SDK state', async () => {
    const fixture = await connectPeer();
    try {
      const bundle = getTasksExtensionSession(fixture.client)!;
      const controller = new AbortController();
      const pending = bundle.getTask('wait', { signal: controller.signal });
      const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
      await tick();
      controller.abort();
      await rejected;
      const request = fixture.waiting[0];
      expect('id' in request).toBe(true);
      if ('id' in request && request.id !== undefined) await fixture.peer.send({ jsonrpc: '2.0', id: request.id, result: { resultType: 'complete' } });
      await fixture.client.listTools();
      expect(fixture.errors).not.toHaveBeenCalled();
    } finally { await fixture.close(); }
  });

  test.each(['depth', 'size', 'entries'])('rejects %s bounds before recursive vendor parsing and retains ordinary traffic', async kind => {
    const fixture = await connectPeer();
    try {
      const pending = getTasksExtensionSession(fixture.client)!.getTask('wait');
      const rejected = expect(pending).rejects.toThrow(/bounded JSON/);
      await tick();
      let value: unknown = kind === 'size' ? 'x'.repeat(1024 * 1024 + 1) : null;
      if (kind === 'entries') value = Array.from({ length: 10_001 }, () => null);
      if (kind === 'depth') for (let i = 0; i < 40; i++) value = { nested: value };
      const request = fixture.waiting[0];
      if ('id' in request && request.id !== undefined) await fixture.peer.send({ jsonrpc: '2.0', id: request.id, result: { resultType: 'complete', value } });
      await rejected;
      await fixture.client.listTools();
      expect(fixture.errors).not.toHaveBeenCalled();
    } finally { await fixture.close(); }
  });

  test('pre-aborted requests and malformed input never send a frame', async () => {
    const fixture = await connectPeer();
    try {
      const bundle = getTasksExtensionSession(fixture.client)!;
      const before = fixture.requests.length;
      const controller = new AbortController(); controller.abort();
      await expect(bundle.getTask('wait', { signal: controller.signal })).rejects.toThrow();
      await expect(bundle.getTask('wait', { context: { requestTimeoutMs: -1 } })).rejects.toThrow();
      expect(fixture.requests).toHaveLength(before);
    } finally { await fixture.close(); }
  });

  test('retiring the extension rejects in-flight operations but leaves the sole ordinary transport alive', async () => {
    const fixture = await connectPeer();
    try {
      const bundle = getTasksExtensionSession(fixture.client)!;
      const previousClose = fixture.client.onclose;
      const pending = bundle.getTask('wait');
      const rejected = expect(pending).rejects.toThrow(/retired/);
      await tick();
      await closeTasksExtensionSession(fixture.client);
      await rejected;
      expect(getTasksExtensionSession(fixture.client)).toBeUndefined();
      expect(fixture.client.transport).toBe(fixture.transport);
      expect(fixture.client.onclose).not.toBe(previousClose); // official port restores its prior callback
      const request = fixture.waiting[0];
      if ('id' in request && request.id !== undefined) await fixture.peer.send({ jsonrpc: '2.0', id: request.id, result: { resultType: 'complete' } });
      await fixture.client.listTools();
      await expect(bundle.getTask('wait')).rejects.toThrow(/authority.*current/);
      expect(fixture.errors).not.toHaveBeenCalled();
    } finally { await fixture.close(); }
  });

  test('a transport disconnect retires pending dispatch and its official session', async () => {
    const fixture = await connectPeer();
    const bundle = getTasksExtensionSession(fixture.client)!;
    const pending = bundle.getTask('wait');
    const rejected = expect(pending).rejects.toThrow(/closed/);
    await tick();
    await fixture.peer.close();
    await rejected;
    expect(getTasksExtensionSession(fixture.client)).toBeUndefined();
    expect(bundle.signal.aborted).toBe(true);
    expect(wasModernTasksExtensionClient(fixture.client)).toBe(true);
    expect(() => bundle.session.task(taskId('wait'))).toThrow();
    await fixture.close();
  });

  test('preserves exact transport headers, abort signal, stream-end retirement, and Mcp-Name routing', async () => {
    const fixture = await connectPeer();
    try {
      const send = fixture.transport.send.bind(fixture.transport);
      const sends: Array<{ message: JSONRPCMessage; options?: Parameters<Transport['send']>[1] }> = [];
      fixture.transport.send = async (message, options) => { sends.push({ message, options }); await send(message); };
      const bundle = getTasksExtensionSession(fixture.client)!;
      const pending = bundle.getTask('wait', { context: { headers: { 'mcp-name': 'wrong', 'X-Authority': 'retained' } } });
      const rejected = expect(pending).rejects.toThrow(/stream ended/);
      await tick();
      const options = sends.find(send => 'method' in send.message && send.message.method === 'tasks/get')!.options!;
      expect(options.headers).toEqual({ 'Mcp-Name': 'wait', 'X-Authority': 'retained' });
      expect(options.requestSignal?.aborted).toBe(false);
      options.onRequestStreamEnd?.();
      await rejected;
      expect(options.requestSignal?.aborted).toBe(true);
    } finally { await fixture.close(); }
  });

  test('correlated progress resets the request timeout; unrelated progress cannot extend it', async () => {
    jest.useFakeTimers();
    const fixture = await connectPeer();
    try {
      const bundle = getTasksExtensionSession(fixture.client)!;
      const pending = bundle.getTask('wait', { context: { requestTimeoutMs: 100, resetTimeoutOnProgress: true } });
      const rejected = expect(pending).rejects.toBeInstanceOf(TasksExtensionRequestTimeoutError);
      await Promise.resolve();
      const request = fixture.waiting[0];
      jest.advanceTimersByTime(80);
      if ('params' in request) await fixture.peer.send({ jsonrpc: '2.0', method: 'notifications/progress', params: {
        progressToken: (request.params?._meta as { progressToken: string }).progressToken, progress: 1,
      } });
      jest.advanceTimersByTime(80);
      let settled = false; void pending.catch(() => { settled = true; }); await Promise.resolve();
      expect(settled).toBe(false);
      await fixture.peer.send({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: 'unrelated', progress: 2 } });
      jest.advanceTimersByTime(21);
      await rejected;
    } finally { await fixture.close(); jest.useRealTimers(); }
  });

  test.each([true, false])('cancels a late creation once only while current host authority is %s', async authorized => {
    const authorize = jest.fn(() => authorized);
    const fixture = await connectPeer(false, authorize);
    try {
      const bundle = getTasksExtensionSession(fixture.client)!;
      const controller = new AbortController();
      const pending = bundle.callTool({ name: 'delayed-task', arguments: { secret: 'never-retained' }, _meta: metadata }, { signal: controller.signal });
      const rejected = expect(pending).rejects.toThrow();
      await tick(); controller.abort(); await rejected;
      const request = fixture.waiting[0];
      const result = CreateTaskResultV2Schema.parse({ resultType: 'task', taskId: 'late-task', status: 'working',
        createdAt: timestamp, lastUpdatedAt: timestamp, ttlMs: 60_000 });
      fixture.tasks.set('late-task', GetTaskResultV2Schema.parse({ ...result, resultType: 'complete' }));
      if ('id' in request && request.id !== undefined) {
        await fixture.peer.send({ jsonrpc: '2.0', id: request.id, result });
        await fixture.peer.send({ jsonrpc: '2.0', id: request.id, result });
      }
      await tick();
      expect(authorize).toHaveBeenCalledTimes(1);
      expect(fixture.requests.filter(message => 'method' in message && message.method === 'tasks/cancel')).toHaveLength(authorized ? 1 : 0);
      expect(fixture.errors).not.toHaveBeenCalled();
    } finally { await fixture.close(); }
  });

  test('revoked authority prevents dispatch without retiring the host-owned ordinary transport', async () => {
    const fixture = await connectPeer(false, undefined, () => false);
    try {
      const bundle = getTasksExtensionSession(fixture.client)!;
      await expect(bundle.callTool({ name: 'task' })).rejects.toThrow(/authority/);
      expect(fixture.requests.filter(message => 'method' in message && message.method === 'tools/call')).toHaveLength(0);
      expect(getTasksExtensionSession(fixture.client)).toBeUndefined();
      expect(fixture.client.transport).toBe(fixture.transport);
      expect(fixture.errors).not.toHaveBeenCalled();
    } finally { await fixture.close(); }
  });

  test('authority is checked again before returning a real remote result', async () => {
    const authority = jest.fn().mockResolvedValueOnce(true).mockResolvedValue(false);
    const fixture = await connectPeer(false, undefined, authority);
    try {
      const bundle = getTasksExtensionSession(fixture.client)!;
      await expect(bundle.callTool({ name: 'task' })).rejects.toThrow(/authority/);
      expect(authority).toHaveBeenCalledTimes(2);
      expect(fixture.requests.filter(message => 'method' in message && message.method === 'tools/call')).toHaveLength(1);
      expect(fixture.requests.filter(message => 'method' in message && message.method === 'tasks/cancel')).toHaveLength(0);
      expect(getTasksExtensionSession(fixture.client)).toBeUndefined();
    } finally { await fixture.close(); }
  });

  test('a task snapshot for another identity is rejected before host lifecycle delivery', async () => {
    const fixture = await connectPeer();
    try {
      const bundle = getTasksExtensionSession(fixture.client)!;
      await bundle.callTool({ name: 'task' });
      fixture.tasks.set('task-1', { ...fixture.tasks.get('task-1')!, taskId: 'another-task' });
      await expect(bundle.getTask('task-1')).rejects.toThrow(/identity mismatch/);
    } finally { await fixture.close(); }
  });

  test('native Node ESM framing preserves every host capability and ordinary concurrent SDK calls', () => {
    const moduleUrl = pathToFileURL(path.resolve('src/backend/services/mcp/tasksExtensionSession.ts')).href;
    const script = `
      import assert from 'node:assert/strict';
      import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
      import { Server } from '@modelcontextprotocol/server';
      import { registerTasksExtensionClient, getTasksExtensionSession, closeTasksExtensionSession } from ${JSON.stringify(moduleUrl)};
      class ModernServer extends Server { constructor() { super({name:'native-reference',version:'1'}, {capabilities:{tools:{},extensions:{'io.modelcontextprotocol/tasks':{}}},supportedProtocolVersions:['2026-07-28']}); this._negotiatedProtocolVersion='2026-07-28'; } }
      const [clientTransport, peerTransport] = InMemoryTransport.createLinkedPair();
      const server = new ModernServer();
      server.setRequestHandler('tools/list', () => ({tools:[]}));
      server.setRequestHandler('tools/call', () => ({content:[{type:'text',text:'ordinary'}]}));
      await server.connect(peerTransport);
      const prior = peerTransport.onmessage;
      const wire = [];
      peerTransport.onmessage = message => {
        wire.push(message);
        if (message.method==='tools/call' && message.params.name==='native-task') {
          assert.deepEqual(message.params._meta['io.modelcontextprotocol/clientCapabilities'].extensions, {'host/other':{}, 'io.modelcontextprotocol/tasks':{}});
          assert.deepEqual(message.params._meta['flowTicket'], {id:'synthetic'});
          void peerTransport.send({jsonrpc:'2.0',id:message.id,result:{resultType:'task',taskId:'native-task',status:'working',createdAt:'2026-10-09T12:00:00.000Z',lastUpdatedAt:'2026-10-09T12:00:00.000Z',ttlMs:60000}});
          return;
        }
        prior(message);
      };
      const capabilities = {roots:{listChanged:true},extensions:{'host/other':{}}};
      const info = {name:'native-flujo-test',version:'1'};
      const client = new Client(info,{capabilities,versionNegotiation:{mode:'auto'},supportedProtocolVersions:['2026-07-28']});
      client.onerror = error => { throw error; };
      registerTasksExtensionClient(client,{endpointId:'native-test',clientInfo:info,clientCapabilities:capabilities});
      await client.connect(clientTransport);
      assert.equal(client.getProtocolEra(),'modern');
      const session=getTasksExtensionSession(client);
      const [task, ordinary] = await Promise.all([session.callTool({name:'native-task',_meta:{flowTicket:{id:'synthetic'}}}), client.callTool({name:'ordinary'})]);
      assert.equal(task.resultType,'task'); assert.equal(ordinary.content[0].text,'ordinary');
      assert.deepEqual(wire.filter(message=>message.method==='tools/call').map(message=>typeof message.id).sort(),['number','string']);
      await closeTasksExtensionSession(client); await client.close(); await server.close();
      process.stdout.write('NATIVE_TASKS_INTEROP_PASS');
    `;
    const result = spawnSync(process.execPath, ['--experimental-transform-types', '--input-type=module', '--eval', script], {
      cwd: process.cwd(), encoding: 'utf8', timeout: 20_000,
    });
    expect({ status: result.status, error: result.error?.message, stderr: result.stderr }).toMatchObject({ status: 0, error: undefined });
    expect(result.stdout).toContain('NATIVE_TASKS_INTEROP_PASS');
  });

  test('revoked input authority prevents invoking a host handler or provider', async () => {
    const client = {};
    const handler = jest.fn();
    registerTasksExtensionClient(client, { endpointId: 'input-revoked', clientInfo, clientCapabilities,
      isAuthorityCurrent: () => false, handleInputRequest: handler });
    await expect(handleTasksInputRequest(client, { method: 'roots/list' })).rejects.toThrow(/authority/);
    expect(handler).not.toHaveBeenCalled();
  });

  test('authority loss while input is pending withholds the answer and forwards expected conversation identity', async () => {
    const client = {};
    let current = true;
    let reply: ((value: { action: 'accept' }) => void) | undefined;
    const handler = jest.fn(() => new Promise<{ action: 'accept' }>(resolve => { reply = resolve; }));
    registerTasksExtensionClient(client, { endpointId: 'input-changed', clientInfo, clientCapabilities,
      isAuthorityCurrent: () => current, handleInputRequest: handler });
    const pending = handleTasksInputRequest(client, { method: 'elicitation/create', params: { message: 'Synthetic', requestedSchema: { type: 'object' } } }, undefined, 'originating-conversation');
    const rejected = expect(pending).rejects.toThrow(/authority/);
    await tick();
    expect(handler).toHaveBeenCalledWith(expect.anything(), undefined, 'originating-conversation');
    current = false; reply?.({ action: 'accept' });
    await rejected;
  });
});
