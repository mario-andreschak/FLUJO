import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { McpTask } from '@/shared/types/mcp/tasks';
import { Client as LegacyClient } from '@modelcontextprotocol/sdk/client/index.js';
import { Server as LegacyServer } from '@modelcontextprotocol/sdk/server/index.js';
import { InMemoryTransport as LegacyTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { GetTaskRequestSchema, GetTaskPayloadRequestSchema } from '@modelcontextprotocol/sdk/types.js';

jest.mock('@/utils/logger', () => ({ createLogger: () => ({ info: jest.fn(), warn: jest.fn() }) }));
jest.mock('@/backend/services/mcp/remoteTaskStore', () => ({
  acquirePollSlot: jest.fn(), createRemoteTaskRecord: jest.fn(), getMcpRemoteTaskSettings: jest.fn(), patchRemoteTaskRecord: jest.fn(),
}));
jest.mock('@/backend/services/mcp/tasksProtocol', () => ({ cancelRemoteTask: jest.fn(), fetchTaskPayload: jest.fn(), fetchTaskStatus: jest.fn(), updateRemoteTask: jest.fn(async (client, taskId, responses, options) => {
  const session = jest.requireMock('@/backend/services/mcp/tasksExtensionSession').getTasksExtensionSession(client);
  return session.updateTask(taskId, responses, { signal: options.signal, context: { requestTimeoutMs: options.timeout } });
}) }));
jest.mock('@/backend/services/mcp/elicitationContext', () => ({ getElicitationContext: jest.fn() }));
jest.mock('@/backend/services/mcp/taskInputRegistry', () => ({ clearTaskInputState: jest.fn(), getTaskInputState: jest.fn(), outstandingTaskInputKeys: () => [] }));
jest.mock('@/backend/services/mcp/tasksExtensionSession', () => ({ getTasksExtensionSession: jest.fn(), handleTasksInputRequest: jest.fn(), wasModernTasksExtensionClient: () => false }));

import { runRemoteTaskLifecycle } from '@/backend/services/mcp/clientTasks';
import { acquirePollSlot, createRemoteTaskRecord, getMcpRemoteTaskSettings, patchRemoteTaskRecord } from '@/backend/services/mcp/remoteTaskStore';
import { cancelRemoteTask, fetchTaskPayload, fetchTaskStatus } from '@/backend/services/mcp/tasksProtocol';
import { getElicitationContext } from '@/backend/services/mcp/elicitationContext';
import { getTasksExtensionSession, handleTasksInputRequest } from '@/backend/services/mcp/tasksExtensionSession';

const release = jest.fn();
const updateTask = jest.fn();
const transport = {};
const client = { transport } as unknown as Client;
const attended = { conversationId: 'conversation-owner', getUnattended: () => false };
const baseTask: McpTask = { generation: '2026-07-28', taskId: 'remote-task', status: 'working', ttl: null, pollInterval: 10 };
const inputTask: McpTask = { ...baseTask, status: 'input_required', inputRequests: {
  question: { method: 'elicitation/create', params: { message: 'Synthetic question', requestedSchema: { type: 'object' } } },
} };
const result = { resultType: 'complete', content: [{ type: 'text', text: 'Synthetic result' }] };

function run(task: McpTask = baseTask, extra: Partial<Parameters<typeof runRemoteTaskLifecycle>[0]> = {}) {
  return runRemoteTaskLifecycle({ client, serverName: 'synthetic-server', serverIdentity: 'stable-config', toolName: 'task-tool',
    task, timeoutMs: 10_000, ownership: { conversationId: attended.conversationId }, persist: true, supportsCancel: true, ...extra });
}
async function advance(ms = 50) { await jest.advanceTimersByTimeAsync(ms); }

beforeEach(() => {
  jest.clearAllMocks(); jest.useFakeTimers();
  Object.assign(client, { transport });
  jest.mocked(acquirePollSlot).mockResolvedValue({ release });
  jest.mocked(getMcpRemoteTaskSettings).mockResolvedValue({ minPollIntervalMs: 1, maxPollIntervalMs: 100,
    defaultPollIntervalMs: 10, fallbackTtlMs: 10_000, inputRequiredTimeoutMs: 200,
    maxTransientPollFailures: 2 } as never);
  jest.mocked(createRemoteTaskRecord).mockResolvedValue({ recordId: 'record', status: 'working' } as never);
  jest.mocked(patchRemoteTaskRecord).mockImplementation(async (_id, patch) => ({ recordId: 'record', ...patch } as never));
  jest.mocked(cancelRemoteTask).mockResolvedValue(undefined);
  jest.mocked(fetchTaskPayload).mockImplementation(async (_client, _id, options) => options?.generation === '2026-07-28' ? options.terminalTask?.result : result);
  jest.mocked(fetchTaskStatus).mockResolvedValue({ ok: true, task: { ...baseTask, status: 'completed', result } });
  jest.mocked(getElicitationContext).mockReturnValue(attended);
  jest.mocked(getTasksExtensionSession).mockReturnValue({ updateTask } as never);
  updateTask.mockResolvedValue(undefined);
  jest.mocked(handleTasksInputRequest).mockResolvedValue({ action: 'accept', content: { answer: 'synthetic' } });
});
afterEach(() => { jest.useRealTimers(); });

test('modern terminal results use inline tasks/get payload; legacy terminal results retain tasks/result', async () => {
  expect(await run({ ...baseTask, status: 'completed', result })).toMatchObject({ success: true, data: result });
  expect(jest.mocked(fetchTaskPayload).mock.calls.every(([, , options]) => options?.generation === '2026-07-28')).toBe(true);
  expect(await run({ taskId: 'legacy-task', status: 'completed' })).toMatchObject({ success: true, data: result });
  expect(fetchTaskPayload).toHaveBeenCalledTimes(2);
  expect(release).toHaveBeenCalledTimes(2);
});

test('a modern already-terminal creation fetches detailed status once without legacy tasks/result', async () => {
  expect(await run({ ...baseTask, status: 'completed' })).toMatchObject({ success: true, data: result });
  expect(fetchTaskStatus).toHaveBeenCalledTimes(1);
  expect(jest.mocked(fetchTaskPayload).mock.calls.every(([, , options]) => options?.generation === '2026-07-28')).toBe(true);
});

test('structured modern task failures preserve code/message/data without persisting response data', async () => {
  const error = { code: -32050, message: 'Synthetic failure PRIVATE_MESSAGE_SENTINEL', data: { private: 'PRIVATE_DATA_SENTINEL' } };
  expect(await run({ ...baseTask, status: 'failed', statusMessage: 'PRIVATE_STATUS_SENTINEL', error })).toMatchObject({ success: false, error: error.message, taskError: error });
  const ledger = JSON.stringify([...jest.mocked(createRemoteTaskRecord).mock.calls, ...jest.mocked(patchRemoteTaskRecord).mock.calls]);
  expect(ledger).not.toContain('PRIVATE_MESSAGE_SENTINEL'); expect(ledger).not.toContain('PRIVATE_DATA_SENTINEL'); expect(ledger).not.toContain('PRIVATE_STATUS_SENTINEL');
  expect(jest.mocked(patchRemoteTaskRecord).mock.calls[0][1]).toMatchObject({ errorMessage: 'Remote MCP task failed.' });
});

test('polling persists ownership before wire follow-up and delivers the modern result', async () => {
  const pending = run(); await advance();
  expect(await pending).toMatchObject({ success: true, data: result });
  expect(jest.mocked(createRemoteTaskRecord).mock.invocationCallOrder[0]).toBeLessThan(jest.mocked(fetchTaskStatus).mock.invocationCallOrder[0]);
  expect(jest.mocked(fetchTaskPayload).mock.calls.every(([, , options]) => options?.generation === '2026-07-28')).toBe(true); expect(release).toHaveBeenCalledTimes(1);
});

test('attended embedded input is answered and updated once across repeated snapshots, with no payload persistence', async () => {
  jest.mocked(fetchTaskStatus).mockResolvedValueOnce({ ok: true, task: inputTask }).mockResolvedValueOnce({ ok: true, task: { ...baseTask, status: 'completed', result } });
  const pending = run(inputTask); await advance();
  expect(await pending).toMatchObject({ success: true, data: result });
  expect(handleTasksInputRequest).toHaveBeenCalledTimes(1);
  expect(updateTask).toHaveBeenCalledTimes(1);
  expect(jest.mocked(handleTasksInputRequest).mock.calls[0][1]).toMatchObject({ params: { _meta: { 'io.modelcontextprotocol/related-task': { taskId: 'remote-task' } } } });
  const persisted = JSON.stringify([...jest.mocked(createRemoteTaskRecord).mock.calls, ...jest.mocked(patchRemoteTaskRecord).mock.calls]);
  expect(persisted).not.toContain('Synthetic question'); expect(persisted).not.toContain('Synthetic result'); expect(persisted).not.toContain('answer');
});

test('input-key reuse with different input fails closed without requesting another answer', async () => {
  const changed: McpTask = { ...inputTask, inputRequests: { question: { method: 'elicitation/create', params: { message: 'Changed question', requestedSchema: { type: 'object' } } } } };
  jest.mocked(fetchTaskStatus).mockResolvedValue({ ok: true, task: changed });
  const pending = run(inputTask); await advance();
  expect(await pending).toMatchObject({ success: false, errorType: 'task-protocol-invalid' });
  expect(handleTasksInputRequest).toHaveBeenCalledTimes(1); expect(cancelRemoteTask).toHaveBeenCalledTimes(1);
});

test.each(['unattended', 'missing', 'different-conversation'])('input fails closed for %s run context', async context => {
  jest.mocked(getElicitationContext).mockReturnValue(context === 'missing' ? undefined : { conversationId: context === 'different-conversation' ? 'other' : attended.conversationId,
    getUnattended: () => context === 'unattended' });
  expect(await run(inputTask)).toMatchObject({ success: false, errorType: 'task-input-required-unattended' });
  expect(handleTasksInputRequest).not.toHaveBeenCalled(); expect(updateTask).not.toHaveBeenCalled();
  expect(cancelRemoteTask).toHaveBeenCalledTimes(1); expect(release).toHaveBeenCalledTimes(1);
});

test('abort interrupts a sleeping poll immediately and cancels only once', async () => {
  const controller = new AbortController();
  const pending = run(baseTask, { signal: controller.signal });
  await advance(0); controller.abort(); await advance(0);
  expect(await pending).toMatchObject({ errorType: 'cancelled' });
  expect(fetchTaskStatus).not.toHaveBeenCalled(); expect(cancelRemoteTask).toHaveBeenCalledTimes(1); expect(release).toHaveBeenCalledTimes(1);
});

test('abort interrupts the actual in-flight status request instead of waiting for its timeout', async () => {
  let requestSignal: AbortSignal | undefined;
  jest.mocked(fetchTaskStatus).mockImplementation((_client, _taskId, options) => new Promise((_resolve, reject) => {
    requestSignal = options?.signal;
    requestSignal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
  }));
  const controller = new AbortController(); const pending = run(baseTask, { signal: controller.signal });
  await advance(11); expect(requestSignal?.aborted).toBe(false);
  controller.abort(); await advance(0);
  expect(await pending).toMatchObject({ errorType: 'cancelled' }); expect(requestSignal?.aborted).toBe(true);
  expect(cancelRemoteTask).toHaveBeenCalledTimes(1); expect(release).toHaveBeenCalledTimes(1);
});

test('caller deadline aborts an in-flight request and returns timeout with a single cooperative cancel', async () => {
  jest.mocked(fetchTaskStatus).mockImplementation((_client, _taskId, options) => new Promise((_resolve, reject) => {
    options?.signal?.addEventListener('abort', () => reject(new DOMException('deadline', 'AbortError')), { once: true });
  }));
  const pending = run(baseTask, { timeoutMs: 30 }); await advance(31);
  expect(await pending).toMatchObject({ errorType: 'timeout', statusCode: 408 });
  expect(cancelRemoteTask).toHaveBeenCalledTimes(1); expect(release).toHaveBeenCalledTimes(1);
});

test('failed durable creation prevents polling and releases the acquired slot', async () => {
  jest.mocked(createRemoteTaskRecord).mockResolvedValue(null);
  expect(await run()).toMatchObject({ errorType: 'task-persistence-error' });
  expect(fetchTaskStatus).not.toHaveBeenCalled(); expect(cancelRemoteTask).toHaveBeenCalledTimes(1); expect(release).toHaveBeenCalledTimes(1);
});

test('replacement transport receives no cancellation intended for the old task session', async () => {
  const controller = new AbortController(); const pending = run(baseTask, { signal: controller.signal });
  await advance(0); Object.assign(client, { transport: {} }); controller.abort(); await advance(0);
  expect(await pending).toMatchObject({ errorType: 'cancelled' }); expect(cancelRemoteTask).not.toHaveBeenCalled();
});

test('embedded input has a bounded deadline and cannot send an answer after that deadline', async () => {
  let requestSignal: AbortSignal | undefined;
  jest.mocked(handleTasksInputRequest).mockImplementation((_client, _request, signal) => new Promise((_resolve, reject) => {
    requestSignal = signal;
    signal?.addEventListener('abort', () => reject(new DOMException('input deadline', 'AbortError')), { once: true });
  }));
  const pending = run(inputTask); await advance(201);
  expect(await pending).toMatchObject({ errorType: 'task-input-timeout' });
  expect(requestSignal?.aborted).toBe(true); expect(updateTask).not.toHaveBeenCalled();
  expect(cancelRemoteTask).toHaveBeenCalledTimes(1); expect(release).toHaveBeenCalledTimes(1);
});

test('an attended conversation replacement while awaiting input cannot update the remote task', async () => {
  jest.mocked(handleTasksInputRequest).mockImplementation(async () => {
    jest.mocked(getElicitationContext).mockReturnValue({ conversationId: 'different-owner', getUnattended: () => false });
    return { action: 'accept' };
  });
  expect(await run(inputTask)).toMatchObject({ errorType: 'task-input-required-unattended' });
  expect(updateTask).not.toHaveBeenCalled(); expect(cancelRemoteTask).toHaveBeenCalledTimes(1);
});

test('unexpected durable persistence exceptions also release admission and prevent unrecorded polling', async () => {
  jest.mocked(createRemoteTaskRecord).mockRejectedValue(new Error('Synthetic storage failure'));
  expect(await run()).toMatchObject({ errorType: 'task-persistence-error' });
  expect(fetchTaskStatus).not.toHaveBeenCalled(); expect(release).toHaveBeenCalledTimes(1);
});

test('modern session retirement aborts a sleeping poll immediately and preserves a recoverable nonterminal record', async () => {
  const connection = new AbortController();
  jest.mocked(getTasksExtensionSession).mockReturnValue({ updateTask, signal: connection.signal } as never);
  const pending = run(); await advance(0); connection.abort(); await advance(0);
  expect(await pending).toMatchObject({ errorType: 'task-transport-error' });
  expect(fetchTaskStatus).not.toHaveBeenCalled(); expect(cancelRemoteTask).not.toHaveBeenCalled();
  expect(jest.mocked(patchRemoteTaskRecord).mock.calls.some(([, patch]) => patch.status === 'failed' || patch.status === 'cancelled')).toBe(false);
  expect(release).toHaveBeenCalledTimes(1);
});

test('a newer run for the same conversation cannot consume input belonging to the captured originating run', async () => {
  jest.mocked(getElicitationContext).mockReturnValue({ ...attended });
  expect(await run(inputTask, { originatingInputContext: attended })).toMatchObject({ errorType: 'task-input-required-unattended' });
  expect(handleTasksInputRequest).not.toHaveBeenCalled(); expect(updateTask).not.toHaveBeenCalled();
});

test.each([{}, { resultType: 'input_required', requestState: 'opaque' }, { resultType: 'complete', content: 'malformed' }])('modern completed tasks reject a non-complete tools/call payload %j', async malformed => {
  expect(await run({ ...baseTask, status: 'completed', result: malformed })).toMatchObject({ success: false,
    errorType: 'task-protocol-invalid', statusCode: 502 });
  expect(jest.mocked(fetchTaskPayload).mock.calls.every(([, , options]) => options?.generation === '2026-07-28')).toBe(true);
});

test('real legacy SDK wire retains get → completed → tasks/result lifecycle', async () => {
  const actual = jest.requireActual<typeof import('@/backend/services/mcp/tasksProtocol')>('@/backend/services/mcp/tasksProtocol');
  jest.mocked(fetchTaskStatus).mockImplementation(actual.fetchTaskStatus);
  jest.mocked(fetchTaskPayload).mockImplementation(actual.fetchTaskPayload);
  jest.mocked(getTasksExtensionSession).mockReturnValue(undefined);
  const [clientTransport, peerTransport] = LegacyTransport.createLinkedPair();
  const legacyClient = new LegacyClient({ name: 'legacy-wire-client', version: '1' });
  const legacyServer = new LegacyServer({ name: 'legacy-wire-server', version: '1' }, { capabilities: { tasks: { requests: { tools: { call: {} } } } } });
  const legacyTask = { taskId: 'legacy-wire-task', status: 'working' as const, ttl: null, pollInterval: 10,
    createdAt: new Date().toISOString(), lastUpdatedAt: new Date().toISOString() };
  let polls = 0;
  const methods: string[] = [];
  legacyServer.setRequestHandler(GetTaskRequestSchema, () => {
    methods.push('tasks/get'); return { ...legacyTask, status: ++polls >= 2 ? 'completed' : 'working' };
  });
  legacyServer.setRequestHandler(GetTaskPayloadRequestSchema, () => {
    methods.push('tasks/result'); return { content: [{ type: 'text', text: 'actual legacy payload' }] };
  });
  await legacyServer.connect(peerTransport); await legacyClient.connect(clientTransport);
  try {
    const pending = run(legacyTask, { client: legacyClient }); await advance(31);
    expect(await pending).toMatchObject({ success: true, data: { content: [{ text: 'actual legacy payload' }] } });
    expect(methods).toEqual(['tasks/get', 'tasks/get', 'tasks/result']);
  } finally { await legacyClient.close(); await legacyServer.close(); }
});

test('legacy poll sleep is abort-aware and preserves the once-only cancellation guard', async () => {
  const controller = new AbortController();
  const pending = run({ taskId: 'legacy-pending', status: 'working', ttl: null, pollInterval: 100 }, { signal: controller.signal });
  await advance(0); controller.abort(); await advance(0);
  expect(await pending).toMatchObject({ errorType: 'cancelled' });
  expect(fetchTaskStatus).not.toHaveBeenCalled(); expect(cancelRemoteTask).toHaveBeenCalledTimes(1); expect(release).toHaveBeenCalledTimes(1);
});

test('a completed tool-level error preserves ordinary RPC success and the original isError/content payload', async () => {
  const failedTool = { ...result, isError: true };
  expect(await run({ ...baseTask, status: 'completed', result: failedTool })).toMatchObject({ success: true, data: failedTool });
});
