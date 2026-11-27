/**
 * #1369: a worker reports why each MCP server is not running, lets servers that
 * wait for approval stand aside, and starts them once approved without a restart.
 */
const loadConfigs = jest.fn();
const connect = jest.fn();
const getStatus = jest.fn();
const warn = jest.fn();

jest.mock('@/backend/services/mcp', () => ({
  mcpService: {
    loadServerConfigs: (...a: unknown[]) => loadConfigs(...a),
    connectServer: (...a: unknown[]) => connect(...a),
    getServerStatus: (...a: unknown[]) => getStatus(...a),
  },
}));
jest.mock('@/utils/logger', () => {
  const actual = jest.requireActual('@/utils/logger');
  return { ...actual, createLogger: (file: string, level?: number) => ({ ...actual.createLogger(file, level),
    warn: (...a: unknown[]) => warn(...a) }) };
});

import { getCurrentWorkspace } from '@/utils/workspace';
import { TrustedHostMcpError } from '@/backend/services/security/trustedHostMcp';
import { McpIsolationError } from '@/backend/services/security/isolatedMcp';
import { executionApprovalFailure } from '@/backend/services/mcp/executionApproval';
import { getWorkerBootstrapStatus, setWorkerBootstrapStatus } from '@/backend/services/workspace/workerMode';
import {
  normalizeWorkerMcpServers, workerMcpReason, workerMcpReasonCode, workerMcpServerReport,
} from '@/backend/services/workspace/workerMcpReason';
import {
  collectWorkerMcpServers, FIRST_WORKER_MCP_RECHECK_MS, publishWorkerMcpServers, recheckWorkerMcpServers,
  scheduleWorkerMcpRecheck, startApprovedWorkerServer, stopWorkerMcpRecheck,
} from '@/backend/services/workspace/workerMcpServers';
import type { WorkerMcpServerReport } from '@/backend/services/workspace/workerMode';
import { promises as fs } from 'fs';
import path from 'path';

const workspace = 'cloud-worker';
const approved = new Set<string>();
const refusal = executionApprovalFailure(new TrustedHostMcpError('HOST_CONSENT_REQUIRED'))!;

function readyWorker(names: string[]) {
  setWorkerBootstrapStatus({ state: 'ready', workspace, error: undefined,
    servers: normalizeWorkerMcpServers(names.map(name => workerMcpServerReport(name, 'HOST_CONSENT_REQUIRED'))) });
}

beforeEach(() => {
  jest.clearAllMocks();
  approved.clear();
  process.env.FLUJO_WORKER_MODE = '1';
  global.__flujo_worker_bootstrap_status = undefined;
  loadConfigs.mockImplementation(async () => ['flujo', 'filesystem', 'bash', 'browser'].map(name => ({ name, transport: 'stdio', disabled: false })));
  connect.mockImplementation(async (name: string) => approved.has(name) ? { success: true } : refusal);
});

afterEach(() => {
  stopWorkerMcpRecheck();
  jest.useRealTimers();
  delete process.env.FLUJO_WORKER_MODE;
  global.__flujo_worker_bootstrap_status = undefined;
});

it('words every reason from a fixed list and never copies error text', () => {
  const secret = new Error('token=sk-live-123 at C:\\Users\\private\\server.js');
  expect(workerMcpReasonCode(secret, 'INSTALL_FAILED')).toBe('INSTALL_FAILED');
  expect(workerMcpReasonCode(new TrustedHostMcpError('HOST_SOURCE_CHANGED'), 'PREPARE_FAILED')).toBe('HOST_SOURCE_CHANGED');
  expect(workerMcpReasonCode(new McpIsolationError('ISOLATION_UNAVAILABLE'), 'PREPARE_FAILED')).toBe('ISOLATION_UNAVAILABLE');
  const report = workerMcpServerReport('my tools', 'HOST_CONSENT_REQUIRED');
  expect(report).toMatchObject({ status: 'waiting', reason: { code: 'HOST_CONSENT_REQUIRED' } });
  expect(JSON.stringify(report)).toContain('/api/mcp/servers/my%20tools/host-consent');
  expect(workerMcpServerReport('x', 'ISOLATION_UNAVAILABLE').status).toBe('waiting');
  expect(workerMcpServerReport('x', 'CONNECT_FAILED').status).toBe('failed');
  expect(workerMcpReason('CONNECT_FAILED', 'x', { afterReady: true }).action).toContain('tries again by itself');
});

it('starts a server approved later without a restart and leaves the others waiting', async () => {
  readyWorker(['flujo', 'filesystem']);
  approved.add('filesystem');
  const workspaces: string[] = [];
  connect.mockImplementation(async (name: string) => {
    workspaces.push(getCurrentWorkspace());
    return approved.has(name) ? { success: true } : refusal;
  });
  await expect(startApprovedWorkerServer('filesystem')).resolves.toEqual({ name: 'filesystem', status: 'ready' });
  expect(connect).toHaveBeenCalledTimes(1);
  expect(workspaces).toEqual([workspace]);
  expect(getWorkerBootstrapStatus()).toMatchObject({ state: 'ready', servers: [
    { name: 'flujo', status: 'waiting', reason: { code: 'HOST_CONSENT_REQUIRED' } }, { name: 'filesystem', status: 'ready' },
  ] });
});

it('keeps checking waiting servers in the background and stops once none are left', async () => {
  jest.useFakeTimers();
  readyWorker(['bash']);
  scheduleWorkerMcpRecheck({ reset: true });
  await jest.advanceTimersByTimeAsync(FIRST_WORKER_MCP_RECHECK_MS);
  expect(connect).toHaveBeenCalledTimes(1);
  expect(getWorkerBootstrapStatus().servers?.[0].status).toBe('waiting');
  // The wait doubles after a quiet check.
  await jest.advanceTimersByTimeAsync(FIRST_WORKER_MCP_RECHECK_MS);
  expect(connect).toHaveBeenCalledTimes(1);
  approved.add('bash');
  await jest.advanceTimersByTimeAsync(FIRST_WORKER_MCP_RECHECK_MS);
  expect(connect).toHaveBeenCalledTimes(2);
  expect(getWorkerBootstrapStatus().servers).toEqual([{ name: 'bash', status: 'ready' }]);
  expect(jest.getTimerCount()).toBe(0);
});

it('reports a server that fails after approval with a fixed reason and keeps retrying', async () => {
  jest.useFakeTimers();
  readyWorker(['browser']);
  connect.mockResolvedValueOnce({ success: false, error: 'stderr: API_KEY=sk-live-123 in C:\\Users\\private' });
  await startApprovedWorkerServer('browser');
  const [report] = getWorkerBootstrapStatus().servers ?? [];
  expect(report).toMatchObject({ name: 'browser', status: 'failed', reason: { code: 'CONNECT_FAILED' } });
  expect(getWorkerBootstrapStatus().state).toBe('ready');
  expect(JSON.stringify(getWorkerBootstrapStatus())).not.toMatch(/sk-live|private/);
  expect(JSON.stringify(warn.mock.calls)).not.toMatch(/sk-live|private/);
  expect(warn.mock.calls.some(call => String(call[0]).includes('"browser" is failed (CONNECT_FAILED)'))).toBe(true);
  approved.add('browser');
  await jest.advanceTimersByTimeAsync(FIRST_WORKER_MCP_RECHECK_MS);
  expect(getWorkerBootstrapStatus().servers).toEqual([{ name: 'browser', status: 'ready' }]);
});

it('does nothing before the worker is ready; startup reads the live state instead', async () => {
  setWorkerBootstrapStatus({ state: 'installing', workspace,
    servers: normalizeWorkerMcpServers([workerMcpServerReport('flujo', 'HOST_CONSENT_REQUIRED')]) });
  approved.add('flujo');
  await startApprovedWorkerServer('flujo');
  expect(connect).not.toHaveBeenCalled();
  getStatus.mockImplementation(async (name: string) => name === 'flujo' ? { status: 'connected' }
    : { status: 'requires_approval', requiresApproval: true, errorCode: 'HOST_SOURCE_CHANGED' });
  const servers = await collectWorkerMcpServers([workerMcpServerReport('flujo', 'HOST_CONSENT_REQUIRED')]);
  expect(servers.map(server => [server.name, server.status, 'reason' in server ? server.reason.code : undefined])).toEqual([
    ['flujo', 'ready', undefined], ['filesystem', 'waiting', 'HOST_SOURCE_CHANGED'],
    ['bash', 'waiting', 'HOST_SOURCE_CHANGED'], ['browser', 'waiting', 'HOST_SOURCE_CHANGED'],
  ]);
});

it('shows a waiting server as disabled once someone turns it off', async () => {
  readyWorker(['bash']);
  loadConfigs.mockResolvedValue([{ name: 'bash', transport: 'stdio', disabled: true }]);
  await recheckWorkerMcpServers();
  expect(connect).not.toHaveBeenCalled();
  expect(getWorkerBootstrapStatus().servers).toEqual([{ name: 'bash', status: 'disabled' }]);
});

it('publishes only the fixed wording, whatever text a caller copied into a report', () => {
  setWorkerBootstrapStatus({ state: 'installing', workspace });
  const leaky = 'stderr: API_KEY=sk-live-123 at C:\\Users\\private\\server.js';
  // Shaped like data read back from somewhere else, so the type check cannot help.
  const reports: WorkerMcpServerReport[] = JSON.parse(JSON.stringify([
    { name: 'tools', status: 'failed', error: leaky,
      reason: { code: 'INSTALL_FAILED', message: leaky, action: leaky } },
    { name: 'files', status: 'waiting', error: leaky,
      reason: { code: 'NOT_A_REAL_CODE', message: leaky, action: leaky } },
    { name: 'shell', status: 'failed', error: leaky,
      reason: { code: 'NOT_A_REAL_CODE', message: leaky, action: leaky } },
    { name: 'web', status: 'ready', error: leaky },
  ]));
  const published = publishWorkerMcpServers(reports);
  expect(published).toEqual([
    workerMcpServerReport('tools', 'INSTALL_FAILED'),
    workerMcpServerReport('files', 'HOST_CONSENT_REQUIRED'),
    workerMcpServerReport('shell', 'PREPARE_FAILED'),
    { name: 'web', status: 'ready' },
  ]);
  expect(JSON.stringify(getWorkerBootstrapStatus())).not.toMatch(/sk-live|private/);
  expect(JSON.stringify(warn.mock.calls)).not.toMatch(/sk-live|private/);
});

it('words retry advice for a worker that is already running', () => {
  readyWorker([]);
  const [report] = publishWorkerMcpServers([workerMcpServerReport('tools', 'CONNECT_FAILED')]);
  expect(report).toMatchObject({ status: 'failed', reason: { action: expect.stringContaining('tries again by itself') } });
});

it('does not arm another check after a stop while a check was running', async () => {
  jest.useFakeTimers();
  readyWorker(['bash']);
  let finish: (value: unknown) => void = () => undefined;
  connect.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  scheduleWorkerMcpRecheck({ reset: true });
  await jest.advanceTimersByTimeAsync(FIRST_WORKER_MCP_RECHECK_MS);
  expect(connect).toHaveBeenCalledTimes(1);
  stopWorkerMcpRecheck();
  finish(refusal);
  await jest.advanceTimersByTimeAsync(0);
  expect(getWorkerBootstrapStatus().servers?.[0].status).toBe('waiting');
  expect(jest.getTimerCount()).toBe(0);
});

it('builds published server lists only in workerMcpReason.ts', async () => {
  const root = path.join(process.cwd(), 'src');
  const offenders: string[] = [];
  async function visit(directory: string): Promise<void> {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(file);
      else if (/\.tsx?$/.test(entry.name) && (await fs.readFile(file, 'utf8')).includes('as PublishedWorkerMcpServers')) {
        offenders.push(path.relative(root, file).split(path.sep).join('/'));
      }
    }
  }
  await visit(root);
  // Build the list with normalizeWorkerMcpServers instead of a cast.
  expect(offenders).toEqual(['backend/services/workspace/workerMcpReason.ts']);
});
