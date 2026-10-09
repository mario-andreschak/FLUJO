jest.mock('@/utils/logger', () => ({ createLogger: () => ({ info: jest.fn(), warn: jest.fn(), debug: jest.fn() }) }));
jest.mock('@/backend/utils/sleep', () => ({ sleep: jest.fn(async () => {}) }));
jest.mock('@/backend/services/mcp/remoteTaskStore', () => ({
  acquirePollSlot: jest.fn(), createRemoteTaskRecord: jest.fn(), getMcpRemoteTaskSettings: jest.fn(), patchRemoteTaskRecord: jest.fn(),
}));
jest.mock('@/backend/services/mcp/tasksProtocol', () => ({ cancelRemoteTask: jest.fn(), fetchTaskPayload: jest.fn(), fetchTaskStatus: jest.fn(), updateRemoteTask: jest.fn() }));
jest.mock('@/backend/services/mcp/elicitationContext', () => ({ getElicitationContext: jest.fn() }));
jest.mock('@/backend/services/mcp/taskInputRegistry', () => ({ clearTaskInputState: jest.fn(), getTaskInputState: jest.fn(), outstandingTaskInputKeys: jest.fn(() => []) }));

import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { runRemoteTaskLifecycle, type RemoteTaskLifecycleOptions } from '@/backend/services/mcp/clientTasks';
import { acquirePollSlot, createRemoteTaskRecord, getMcpRemoteTaskSettings, patchRemoteTaskRecord } from '@/backend/services/mcp/remoteTaskStore';
import { cancelRemoteTask, fetchTaskPayload, fetchTaskStatus, updateRemoteTask } from '@/backend/services/mcp/tasksProtocol';
import { getElicitationContext } from '@/backend/services/mcp/elicitationContext';
import { DEFAULT_MCP_REMOTE_TASK_SETTINGS, type McpRemoteTaskRecord } from '@/shared/types/mcp/taskRecords';

const release = jest.fn();
function options(extra: Partial<RemoteTaskLifecycleOptions> = {}): RemoteTaskLifecycleOptions {
  return { client: {} as Client, serverName: 'synthetic', serverIdentity: 'identity', toolName: 'tool',
    task: { taskId: 'task', status: 'working', createdAt: new Date().toISOString(), lastUpdatedAt: new Date().toISOString(), ttl: 60000, generation: '2026-07-28' },
    generation: '2026-07-28', timeoutMs: 60000, ownership: { conversationId: 'owner' }, persist: true, supportsCancel: true, ...extra };
}
beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(getMcpRemoteTaskSettings).mockResolvedValue(DEFAULT_MCP_REMOTE_TASK_SETTINGS);
  jest.mocked(acquirePollSlot).mockResolvedValue({ release });
  let record: McpRemoteTaskRecord;
  jest.mocked(createRemoteTaskRecord).mockImplementation(async input => {
    record = { ...input, version: 1, recordId: 'local', requestFingerprint: 'opaque', createdAt: 0, updatedAt: 0 };
    return record;
  });
  jest.mocked(patchRemoteTaskRecord).mockImplementation(async (_id, patch) => {
    // Mirror first-terminal-wins storage behavior, including repeated terminal status rejection.
    if (['completed', 'failed', 'cancelled'].includes(record.status) && patch.status) return record;
    record = { ...record, ...patch }; return record;
  });
  jest.mocked(getElicitationContext).mockReturnValue({ conversationId: 'owner', getUnattended: () => false });
  jest.mocked(fetchTaskPayload).mockImplementation(async (_client, _id, opts) => opts?.terminalTask?.result);
});

it('persists generation before polling and retrieves inline modern result with terminal bookkeeping', async () => {
  const payload = { content: [{ type: 'text', text: 'offline' }] };
  jest.mocked(fetchTaskStatus).mockResolvedValue({ ok: true, task: { ...options().task, status: 'completed', result: payload } });
  const guard = jest.fn();
  const result = await runRemoteTaskLifecycle(options({ assertCurrent: guard }));
  expect(result).toMatchObject({ success: true, data: payload });
  expect(createRemoteTaskRecord).toHaveBeenCalledWith(expect.objectContaining({ generation: '2026-07-28' }));
  expect(jest.mocked(createRemoteTaskRecord).mock.invocationCallOrder[0]).toBeLessThan(jest.mocked(fetchTaskStatus).mock.invocationCallOrder[0]);
  expect(fetchTaskStatus).toHaveBeenCalledWith(expect.anything(), 'task', expect.objectContaining({ generation: '2026-07-28' }));
  expect(patchRemoteTaskRecord).toHaveBeenLastCalledWith('local', { resultRetrieved: true });
  expect(guard).toHaveBeenCalledTimes(4);
  expect(release).toHaveBeenCalledTimes(1);
});

it('preserves structured modern failures without storing payloads', async () => {
  const error = { code: -32001, message: 'Rejected', data: { retryable: false } };
  const result = await runRemoteTaskLifecycle(options({ task: { ...options().task, status: 'failed', error } }));
  expect(result).toMatchObject({ success: false, error: 'Rejected', data: error });
  expect(JSON.stringify(jest.mocked(createRemoteTaskRecord).mock.calls)).not.toContain('retryable');
  expect(fetchTaskPayload).not.toHaveBeenCalled();
});

it('answers keyed requests through attended policy once, then updates on the same generation', async () => {
  const input = { ...options().task, status: 'input_required' as const, inputRequests: { key: { method: 'elicitation/create' as const, params: { message: 'offline' } } } };
  jest.mocked(fetchTaskStatus).mockResolvedValueOnce({ ok: true, task: input }).mockResolvedValueOnce({ ok: true, task: input }).mockResolvedValueOnce({ ok: true, task: { ...input, status: 'completed', result: { content: [] } } });
  const handler = jest.fn(async () => ({ action: 'accept', content: { allowed: true } }));
  await runRemoteTaskLifecycle(options({ handleInputRequest: handler }));
  expect(handler).toHaveBeenCalledTimes(1);
  expect(updateRemoteTask).toHaveBeenCalledTimes(1);
  expect(updateRemoteTask).toHaveBeenCalledWith(expect.anything(), 'task', { key: { action: 'accept', content: { allowed: true } } }, expect.objectContaining({ generation: '2026-07-28' }));
});

it('does not answer another conversation and sends cancellation only once on abort', async () => {
  jest.mocked(getElicitationContext).mockReturnValue({ conversationId: 'different', getUnattended: () => false });
  jest.mocked(fetchTaskStatus).mockResolvedValue({ ok: true, task: { ...options().task, status: 'input_required', inputRequests: { key: { method: 'roots/list' } } } });
  const handler = jest.fn();
  await runRemoteTaskLifecycle(options({ handleInputRequest: handler }));
  expect(handler).not.toHaveBeenCalled();
  expect(updateRemoteTask).not.toHaveBeenCalled();
  expect(cancelRemoteTask).toHaveBeenCalledTimes(1);
  jest.clearAllMocks();
  const controller = new AbortController(); controller.abort();
  await runRemoteTaskLifecycle(options({ signal: controller.signal }));
  expect(cancelRemoteTask).toHaveBeenCalledTimes(1);
  expect(fetchTaskStatus).not.toHaveBeenCalled();
});

it('bounds an aborting attended handler that never settles and never submits its answer', async () => {
  const controller = new AbortController();
  jest.mocked(fetchTaskStatus).mockResolvedValue({ ok: true, task: { ...options().task, status: 'input_required', inputRequests: { key: { method: 'elicitation/create' } } } });
  const handler = jest.fn(() => { controller.abort(); return new Promise<unknown>(() => {}); });
  const result = await runRemoteTaskLifecycle(options({ signal: controller.signal, handleInputRequest: handler }));
  expect(result.errorType).toBe('cancelled');
  expect(cancelRemoteTask).toHaveBeenCalledTimes(1);
  expect(updateRemoteTask).not.toHaveBeenCalled();
  expect(release).toHaveBeenCalledTimes(1);
});

it('retains legacy result retrieval for historical handles without generation', async () => {
  jest.mocked(fetchTaskPayload).mockResolvedValue({ content: [] });
  const result = await runRemoteTaskLifecycle(options({ generation: undefined, task: { ...options().task, generation: undefined, status: 'completed' } }));
  expect(result.success).toBe(true);
  expect(fetchTaskPayload).toHaveBeenCalledWith(expect.anything(), 'task', expect.objectContaining({ generation: '2025-11-25' }));
});

it('never dispatches poll or cancel after the freshness guard rejects', async () => {
  jest.mocked(getMcpRemoteTaskSettings).mockResolvedValue({ ...DEFAULT_MCP_REMOTE_TASK_SETTINGS, maxTransientPollFailures: 1 });
  await expect(runRemoteTaskLifecycle(options({ assertCurrent: () => { throw new Error('stale caller'); } }))).rejects.toThrow('stale caller');
  expect(fetchTaskStatus).not.toHaveBeenCalled();
  expect(cancelRemoteTask).not.toHaveBeenCalled();
  expect(release).toHaveBeenCalledTimes(1);
});

it('releases poll ownership when durable record creation throws', async () => {
  jest.mocked(createRemoteTaskRecord).mockRejectedValue(new Error('storage failure'));
  await expect(runRemoteTaskLifecycle(options())).rejects.toThrow('storage failure');
  expect(release).toHaveBeenCalledTimes(1);
  expect(fetchTaskStatus).not.toHaveBeenCalled();
});

it('rejects a result when authority changed during its retrieval', async () => {
  let current = true;
  jest.mocked(fetchTaskPayload).mockImplementation(async () => { current = false; return { content: [] }; });
  const result = await runRemoteTaskLifecycle(options({ task: { ...options().task, status: 'completed', result: { content: [] } }, assertCurrent: () => { if (!current) throw new Error('stale'); } }));
  expect(result.success).toBe(false);
  expect(patchRemoteTaskRecord).not.toHaveBeenCalledWith('local', expect.objectContaining({ resultRetrieved: true }));
  expect(release).toHaveBeenCalledTimes(1);
});

it('does not retrieve an initially terminal result for an already aborted caller', async () => {
  const controller = new AbortController(); controller.abort();
  const result = await runRemoteTaskLifecycle(options({ signal: controller.signal, task: { ...options().task, status: 'completed' } }));
  expect(result.errorType).toBe('cancelled');
  expect(fetchTaskPayload).not.toHaveBeenCalled();
});
