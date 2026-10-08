import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';

jest.mock('@/backend/services/mcp/config', () => ({
  loadServerConfigs: jest.fn(async () => [
    { name: 'srv', transport: 'stdio', command: 'private-command', args: [], env: { SECRET: 'private-token' } },
  ]),
  saveConfig: jest.fn(async () => ({ success: true })),
}));

import { MCPService } from '@/backend/services/mcp';
import { safelyCloseClient } from '@/backend/services/mcp/connection';
import { _resetLifecycleForTests, beginConnect, markConnected } from '@/backend/services/mcp/lifecycleCoordinator';

const ownedChildren: ChildProcess[] = [];
async function fixture(ignoreStdin = false) {
  const child = spawn(process.execPath, ['-e',
    `process.stdin.resume(); process.stdin.on('end', () => ${ignoreStdin ? '{}' : 'setTimeout(() => process.exit(0), 30)'}); setInterval(() => {}, 1000); console.log('ready');`,
  ], { stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32', windowsHide: true });
  ownedChildren.push(child);
  await Promise.race([
    once(child.stdout!, 'data'),
    once(child, 'exit').then(() => { throw new Error('Fixture exited before ready'); }),
  ]);
  const client = { transport: { _process: child }, close: jest.fn(async () => undefined) } as unknown as Client;
  return { child, client };
}

beforeEach(() => {
  _resetLifecycleForTests();
  global.__mcp_clients?.clear();
  global.__mcp_active_transports?.clear();
});
afterEach(async () => {
  for (const child of ownedChildren.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
    }
  }
});

it('returns the same receipt for overlapping/repeated disconnects and preserves unrelated processes', async () => {
  const target = await fixture();
  const sibling = await fixture();
  global.__mcp_clients!.set('srv', target.client);
  global.__mcp_clients!.set('sibling', sibling.client);
  markConnected('srv');
  markConnected('sibling');
  const service = new MCPService();
  const [first, second] = await Promise.all([service.disconnectServer('srv'), service.disconnectServer('srv')]);
  expect(first.success).toBe(true);
  expect(second.shutdownReceipt).toBe(first.shutdownReceipt);
  expect((await service.disconnectServer('srv')).shutdownReceipt).toBe(first.shutdownReceipt);
  expect(first.shutdownReceipt).toMatchObject({ generation: 1, processOwnership: 'owned',
    exitOutcome: 'observed_exit', forced: false, errorClassification: 'none' });
  expect(target.child.exitCode).toBe(0);
  expect(target.client.close).toHaveBeenCalledTimes(1);
  expect(service.getClient('sibling')).toBe(sibling.client);
  expect(sibling.child.exitCode).toBeNull();
  expect(sibling.child.signalCode).toBeNull();
  expect(JSON.stringify(first.shutdownReceipt)).not.toMatch(/private-command|private-token|SECRET/);
  const replacement = await fixture();
  global.__mcp_clients!.set('srv', replacement.client);
  markConnected('srv');
  expect(service.getServerShutdownReceipt('srv')).toBeUndefined();
  const fresh = await service.disconnectServer('srv');
  expect(fresh.shutdownReceipt).toMatchObject({ generation: 2, exitOutcome: 'observed_exit' });
  expect(fresh.shutdownReceipt).not.toBe(first.shutdownReceipt);
});

it('disconnects the generation registered by an already pending connect', async () => {
  const target = await fixture();
  let finishConnect!: () => void;
  const wait = new Promise<void>(resolve => { finishConnect = resolve; });
  const connect = beginConnect('srv', async () => {
    await wait;
    global.__mcp_clients!.set('srv', target.client);
    markConnected('srv');
  });
  const disconnect = new MCPService().disconnectServer('srv');
  finishConnect();
  await connect;
  expect((await disconnect).shutdownReceipt).toMatchObject({ generation: 1, exitOutcome: 'observed_exit' });
  expect(target.child.exitCode).toBe(0);
});

it('closes its actual owned process after an awaited config read fails and denies folded callers', async () => {
  const target = await fixture();
  global.__mcp_clients!.set('srv', target.client);
  markConnected('srv');
  const service = new MCPService();
  let entered!: () => void;
  const reading = new Promise<void>(resolve => { entered = resolve; });
  let rejectRead!: (error: Error) => void;
  const pendingRead = new Promise<never>((_resolve, reject) => { rejectRead = reject; });
  jest.spyOn(service, 'getServerConfig').mockImplementationOnce(async () => {
    entered();
    return pendingRead;
  });
  const first = service.disconnectServer('srv');
  await reading;
  const second = service.disconnectServer('srv');
  rejectRead(new Error('fixture config read failed'));
  const [firstResult, secondResult] = await Promise.all([first, second]);
  expect(firstResult.success).toBe(false);
  expect(secondResult.success).toBe(false);
  expect(secondResult.error).toBe('MCP_SHUTDOWN_FAILED');
  expect(secondResult.shutdownReceipt?.errorClassification).toBe('close_failed');
  expect(target.child.exitCode).toBe(0);
  expect(target.client.close).toHaveBeenCalledTimes(1);
  expect(service.getClient('srv')).toBeUndefined();
  const repeated = await service.disconnectServer('srv');
  expect(repeated.success).toBe(false);
  expect(repeated.shutdownReceipt).toBe(secondResult.shutdownReceipt);
});

it('exposes separate process observations during application-wide disconnect', async () => {
  const target = await fixture();
  global.__mcp_clients!.set('srv', target.client);
  markConnected('srv');
  const result = await new MCPService().disconnectAll('fixture shutdown');
  expect(result).toMatchObject({ closed: ['srv'], failed: [], shutdownReceipts: [
    { serverName: 'srv', generation: 1, exitOutcome: 'observed_exit' },
  ] });
});

it('observes a real forced exit after a fixture refuses graceful stdin shutdown', async () => {
  const target = await fixture(true);
  const result = await safelyCloseClient(target.client, 'srv', undefined, { gracePeriodMs: 40, killEscalationMs: 300 });
  expect(result).toMatchObject({ processOwnership: 'owned', exitOutcome: 'observed_exit', forced: true,
    errorClassification: 'none' });
  expect(target.child.exitCode !== null || target.child.signalCode !== null).toBe(true);
});

it('retains actual exit evidence when SDK close fails, with a bounded error classification', async () => {
  const target = await fixture();
  jest.mocked(target.client.close).mockRejectedValueOnce(new Error('SECRET=private-token'));
  global.__mcp_clients!.set('srv', target.client);
  markConnected('srv');
  const result = await new MCPService().disconnectServer('srv');
  expect(result.shutdownReceipt).toMatchObject({ exitOutcome: 'observed_exit', errorClassification: 'close_failed' });
  expect(target.child.exitCode).toBe(0);
  expect(JSON.stringify(result.shutdownReceipt)).not.toContain('private-token');
});

it('never reports external or missing stdio processes as observed owned exits', async () => {
  const client = { transport: {}, close: jest.fn(async () => undefined) } as unknown as Client;
  const external = await safelyCloseClient(client, 'srv', { transport: 'streamable' } as never);
  expect(external).toMatchObject({ exited: false, processOwnership: 'external', exitOutcome: 'not_applicable' });
  const missing = await safelyCloseClient(client, 'srv', { transport: 'stdio' } as never);
  expect(missing).toMatchObject({ exited: false, processOwnership: 'unknown', exitOutcome: 'unknown',
    errorClassification: 'exit_unobserved' });
});
