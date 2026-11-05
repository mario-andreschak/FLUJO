/**
 * A server that prints one stray line on stdout must keep its single process.
 *
 * The SDK reports an unparsable stdout line through transport.onerror and keeps reading.
 * FLUJO treated that as a dead connection: it forgot the client WITHOUT stopping the
 * child and scheduled a reconnect. The replacement printed the same line, so one server
 * turned into an ever-growing pile of identical live processes.
 *
 * Real child processes on purpose: the failure is about processes left alive.
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
jest.mock('@/backend/services/mcp/betaClient', () => ({
  ...jest.requireActual('@/backend/services/mcp/betaClient'),
  isMcpBetaProtocolEnabled: jest.fn(async () => false),
}));
jest.mock('@/backend/services/mcp/runtimeHomeIsolation', () => ({
  resolveRuntimeHomeIsolation: jest.fn(async () => false),
}));

import { MCPService } from '@/backend/services/mcp';
import * as configModule from '@/backend/services/mcp/config';

const FIXTURE = path.join(__dirname, 'fixtures', 'noisyStdoutServer.mjs');
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('stdio server that writes a non-JSON line to stdout', () => {
  let dir: string;
  let pidFile: string;
  let service: MCPService;
  const startedPids = () => fs.existsSync(pidFile)
    ? fs.readFileSync(pidFile, 'utf8').split('\n').filter(Boolean).map(Number) : [];

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flujo-noisy-'));
    pidFile = path.join(dir, 'pids.txt');
    const config: MCPServerConfig = {
      name: 'noisy',
      transport: 'stdio',
      command: process.execPath,
      args: [FIXTURE],
      env: { PID_FILE: pidFile, NOISY_STDOUT: '1' },
      cwd: dir,
      disabled: false,
    } as MCPServerConfig;
    (configModule as unknown as { __configState: { configs: unknown[] } }).__configState.configs = [config];
    service = new MCPService();
  });

  afterEach(async () => {
    await service.disconnectServer('noisy').catch(() => undefined);
    for (const pid of startedPids()) if (alive(pid)) process.kill(pid);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('keeps one process and a working connection', async () => {
    const connected = await service.connectServer('noisy');
    expect(connected).toMatchObject({ success: true });

    // Longer than the first reconnect delay (5 seconds).
    await wait(7000);

    expect(startedPids().filter(alive)).toHaveLength(1);
    expect(startedPids()).toHaveLength(1);
    const listed = await service.listServerTools('noisy');
    expect(listed.error).toBeUndefined();
    expect(listed.tools.map(tool => tool.name)).toEqual(['echo']);
  }, 30000);

  it('stops the old process before reconnecting after a real transport error', async () => {
    (configModule as unknown as { __configState: { configs: Array<{ env: Record<string, string> }> } })
      .__configState.configs[0].env.NOISY_STDOUT = '0';
    expect(await service.connectServer('noisy')).toMatchObject({ success: true });
    const [first] = startedPids();
    const transport = (service as unknown as { activeTransports: Map<string, { onerror?: (error: Error) => void }> })
      .activeTransports.get('noisy');
    transport?.onerror?.(new Error('the pipe broke'));

    await wait(7000);

    expect(alive(first)).toBe(false);
    expect(startedPids().filter(alive)).toHaveLength(1);
    expect(startedPids()).toHaveLength(2);
  }, 30000);
});
