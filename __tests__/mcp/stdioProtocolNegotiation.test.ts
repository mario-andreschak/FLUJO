/**
 * Stdio servers negotiate the 2026-07-28 protocol by default, on FLUJO's own
 * process (spec basic/transports/stdio, "Backward compatibility"):
 * - a modern server is asked `server/discover` and speaks 2026-07-28;
 * - a classic server that answers "Method not found" falls back to
 *   `initialize` on the same process;
 * - a classic server that quits on the question is started once more with the
 *   classic handshake, and remembered so later starts skip the question.
 * Modern Tasks then work over stdio. Real child processes on purpose: the
 * point is how many processes FLUJO starts and which protocol each speaks.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { MCPServerConfig } from '@/shared/types/mcp';

jest.mock('@/backend/services/mcp/config', () => {
  const state = { configs: [] as unknown[] };
  return {
    __configState: state,
    loadServerConfigs: jest.fn(async () => state.configs),
    saveConfig: jest.fn(async () => ({ success: true })),
  };
});
jest.mock('@/backend/services/mcp/runtimeHomeIsolation', () => ({
  resolveRuntimeHomeIsolation: jest.fn(async () => false),
}));
jest.mock('@/backend/services/mcp/remoteTaskStore', () => ({
  ...jest.requireActual('@/backend/services/mcp/remoteTaskStore'),
  resolveServerIdentity: jest.fn(async () => 'stdio-fixture-identity'),
  getMcpRemoteTaskSettings: jest.fn(async () => ({ requestedTtlMs: 60000, minPollIntervalMs: 1,
    maxPollIntervalMs: 20, defaultPollIntervalMs: 5, fallbackTtlMs: 60000,
    inputRequiredTimeoutMs: 200, maxTransientPollFailures: 3 })),
  acquirePollSlot: jest.fn(async () => ({ release: jest.fn() })),
  createRemoteTaskRecord: jest.fn(async (input: object) => ({ recordId: 'stdio-record', ...input })),
  patchRemoteTaskRecord: jest.fn(async (_id: string, patch: object) => ({ recordId: 'stdio-record', ...patch })),
}));

import { MCPService } from '@/backend/services/mcp';
import { negotiatedProtocolVersion } from '@/backend/services/mcp/betaClient';
import { forgetStdioNegotiationForTests } from '@/backend/services/mcp/stdioNegotiation';
import { createRemoteTaskRecord } from '@/backend/services/mcp/remoteTaskStore';
import * as configModule from '@/backend/services/mcp/config';

const FIXTURES = path.join(__dirname, 'fixtures');

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

describe('stdio protocol negotiation through the MCP service', () => {
  let dir: string;
  let pidFile: string;
  let service: MCPService;
  const startedPids = () => fs.existsSync(pidFile)
    ? fs.readFileSync(pidFile, 'utf8').split('\n').filter(Boolean).map(Number) : [];

  function useServer(name: string, fixture: string, env: Record<string, string> = {}) {
    const config = {
      name, transport: 'stdio', command: process.execPath, args: [path.join(FIXTURES, fixture)],
      env: { PID_FILE: pidFile, ...env }, rootPath: dir, disabled: false, _buildCommand: '', _installCommand: '',
    } as MCPServerConfig;
    (configModule as unknown as { __configState: { configs: unknown[] } }).__configState.configs = [config];
    return config;
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flujo-stdio-negotiation-'));
    pidFile = path.join(dir, 'pids.txt');
    forgetStdioNegotiationForTests();
    service = new MCPService();
  });

  afterEach(async () => {
    for (const name of ['modern', 'classic', 'quitter']) await service.disconnectServer(name).catch(() => undefined);
    for (const pid of startedPids()) if (alive(pid)) process.kill(pid);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('speaks 2026-07-28 with a modern server on a single process', async () => {
    useServer('modern', 'modernStdioServer.mjs');
    expect(await service.connectServer('modern')).toMatchObject({ success: true });
    expect(negotiatedProtocolVersion(service.getClient('modern')!)).toBe('2026-07-28');
    expect(startedPids()).toHaveLength(1);
    const listed = await service.listServerTools('modern');
    expect(listed.tools?.map(tool => tool.name)).toEqual(['echo', 'slow_echo']);
    const called = await service.callTool('modern', 'echo', { text: 'hi' });
    expect(called).toMatchObject({ success: true });
    expect(JSON.stringify(called.data)).toContain('echo:hi');
  }, 30_000);

  it('runs a modern Task over stdio: durable record, polling, result', async () => {
    useServer('modern', 'modernStdioServer.mjs');
    expect(await service.connectServer('modern')).toMatchObject({ success: true });
    const called = await service.callTool('modern', 'slow_echo', { text: 'later' });
    expect(called).toMatchObject({ success: true, progressToken: 'task-1' });
    expect(JSON.stringify(called.data)).toContain('echo:later');
    expect(createRemoteTaskRecord).toHaveBeenCalledWith(expect.objectContaining({
      remoteTaskId: 'task-1', generation: '2026-07-28', serverName: 'modern',
    }));
    expect(startedPids()).toHaveLength(1);
  }, 30_000);

  it('falls back to initialize on the same process when a classic server answers Method not found', async () => {
    useServer('classic', 'classicStdioServer.mjs');
    expect(await service.connectServer('classic')).toMatchObject({ success: true });
    expect(negotiatedProtocolVersion(service.getClient('classic')!)).not.toBe('2026-07-28');
    expect(startedPids()).toHaveLength(1);
    expect((await service.listServerTools('classic')).tools?.map(tool => tool.name)).toEqual(['echo']);
  }, 30_000);

  it('restarts a server that quits on server/discover with the classic handshake and remembers it', async () => {
    useServer('quitter', 'classicStdioServer.mjs', { CLASSIC_EARLY_REQUEST: 'exit' });
    expect(await service.connectServer('quitter')).toMatchObject({ success: true });
    expect(negotiatedProtocolVersion(service.getClient('quitter')!)).not.toBe('2026-07-28');
    expect(startedPids()).toHaveLength(2);
    expect((await service.listServerTools('quitter')).tools?.map(tool => tool.name)).toEqual(['echo']);

    await service.disconnectServer('quitter');
    expect(await service.connectServer('quitter')).toMatchObject({ success: true });
    expect(startedPids()).toHaveLength(3);
  }, 45_000);

  it('Test Run gets the same classic restart without reporting a failure first', async () => {
    const config = useServer('quitter', 'classicStdioServer.mjs', { CLASSIC_EARLY_REQUEST: 'exit' });
    const events: Array<{ type: string; success?: boolean }> = [];
    const result = await service.testConnection(config, event => events.push(event));
    expect(result).toMatchObject({ success: true });
    expect(events.filter(event => event.type === 'result')).toEqual([expect.objectContaining({ success: true })]);
    expect(startedPids()).toHaveLength(2);
  }, 45_000);
});
