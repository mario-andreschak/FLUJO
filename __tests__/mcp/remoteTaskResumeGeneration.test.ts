jest.mock('@/utils/logger', () => ({ createLogger: () => ({ info: jest.fn(), warn: jest.fn(), debug: jest.fn() }) }));
jest.mock('@/backend/utils/sleep', () => ({ sleep: jest.fn(async () => {}) }));
jest.mock('@/backend/services/mcp', () => ({ mcpService: { loadServerConfigs: jest.fn(), getClient: jest.fn() } }));
jest.mock('@/backend/services/mcp/remoteTaskStore', () => ({ acquirePollSlot: jest.fn(), getMcpRemoteTaskSettings: jest.fn(), listResumableRemoteTaskRecords: jest.fn(), patchRemoteTaskRecord: jest.fn(), serverIdentityFingerprint: jest.fn(() => 'identity') }));
jest.mock('@/backend/services/mcp/tasksProtocol', () => ({ cancelRemoteTask: jest.fn(), discoverTaskNegotiation: jest.fn(), fetchTaskStatus: jest.fn(), getTaskNegotiation: jest.fn(), mcpTasksClientEnabled: () => true }));

import { mcpService } from '@/backend/services/mcp';
import { resumeRemoteMcpTasks } from '@/backend/services/mcp/remoteTaskResume';
import { acquirePollSlot, getMcpRemoteTaskSettings, listResumableRemoteTaskRecords, patchRemoteTaskRecord, serverIdentityFingerprint } from '@/backend/services/mcp/remoteTaskStore';
import { cancelRemoteTask, discoverTaskNegotiation, fetchTaskStatus, getTaskNegotiation } from '@/backend/services/mcp/tasksProtocol';
import { DEFAULT_MCP_REMOTE_TASK_SETTINGS, type McpRemoteTaskRecord } from '@/shared/types/mcp/taskRecords';

const client = {} as ReturnType<typeof mcpService.getClient>;
const release = jest.fn();
const record: McpRemoteTaskRecord = { version: 1, recordId: 'local', remoteTaskId: 'remote', serverName: 'synthetic', serverIdentity: 'identity', toolName: 'tool', requestFingerprint: 'opaque', ownership: {}, status: 'working', createdAt: 0, updatedAt: 0, pollIntervalMs: 1000, generation: '2026-07-28' };
const negotiation = { generation: '2026-07-28' as const, supported: true, supportsToolsCall: true, supportsCancel: true, supportsList: false };
beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(mcpService.loadServerConfigs).mockResolvedValue([{ name: 'synthetic' }] as never);
  jest.mocked(mcpService.getClient).mockReturnValue(client);
  jest.mocked(serverIdentityFingerprint).mockReturnValue('identity');
  jest.mocked(listResumableRemoteTaskRecords).mockResolvedValue([{ ...record }]);
  jest.mocked(getMcpRemoteTaskSettings).mockResolvedValue(DEFAULT_MCP_REMOTE_TASK_SETTINGS);
  jest.mocked(acquirePollSlot).mockResolvedValue({ release });
  jest.mocked(patchRemoteTaskRecord).mockResolvedValue(null);
  jest.mocked(discoverTaskNegotiation).mockResolvedValue(negotiation);
  jest.mocked(getTaskNegotiation).mockReturnValue(negotiation);
});
async function settled() { for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve)); }

it('refuses changed generation before any task request, including legacy records missing generation', async () => {
  jest.mocked(listResumableRemoteTaskRecords).mockResolvedValue([{ ...record, generation: undefined }]);
  expect(await resumeRemoteMcpTasks()).toMatchObject({ failedClosed: 1, resumed: 0 });
  expect(patchRemoteTaskRecord).toHaveBeenCalledWith('local', expect.objectContaining({ diagnostic: 'generation-mismatch' }));
  expect(fetchTaskStatus).not.toHaveBeenCalled();
});
it('rechecks identity after starting and refuses changed authority before polling', async () => {
  jest.mocked(serverIdentityFingerprint).mockReturnValueOnce('identity').mockReturnValue('changed');
  await resumeRemoteMcpTasks(); await settled();
  expect(fetchTaskStatus).not.toHaveBeenCalled();
  expect(patchRemoteTaskRecord).toHaveBeenCalledWith('local', expect.objectContaining({ diagnostic: 'identity-mismatch' }));
  expect(release).toHaveBeenCalledTimes(1);
});
it('polls original generation and cancels ownerless input once without fetching results', async () => {
  jest.mocked(fetchTaskStatus).mockResolvedValue({ ok: true, task: { taskId: 'remote', status: 'input_required', generation: '2026-07-28', createdAt: '', lastUpdatedAt: '', ttl: null } });
  await resumeRemoteMcpTasks(); await settled();
  expect(fetchTaskStatus).toHaveBeenCalledWith(client, 'remote', { timeout: 30000, generation: '2026-07-28' });
  expect(cancelRemoteTask).toHaveBeenCalledTimes(1);
  expect(cancelRemoteTask).toHaveBeenCalledWith(client, 'remote', 10000, '2026-07-28');
  expect(patchRemoteTaskRecord).toHaveBeenLastCalledWith('local', expect.objectContaining({ diagnostic: 'input-required-unattended', status: 'failed' }));
  expect(release).toHaveBeenCalledTimes(1);
});

it('keeps a retired modern connection nonterminal and skips wire dispatch until reconnect', async () => {
  const unavailable = { supported: false, supportsToolsCall: false, supportsCancel: false, supportsList: false };
  jest.mocked(discoverTaskNegotiation).mockResolvedValue(unavailable);
  expect(await resumeRemoteMcpTasks()).toMatchObject({ skipped: 1, resumed: 0, failedClosed: 0 });
  expect(patchRemoteTaskRecord).toHaveBeenCalledWith('local', { diagnostic: 'server-disconnected' });
  expect(fetchTaskStatus).not.toHaveBeenCalled();
  expect(cancelRemoteTask).not.toHaveBeenCalled();
});
