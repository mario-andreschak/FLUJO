/**
 * Regression tests for the MCP restart death-spiral (MCPService half).
 *
 * The loop: a transport's onclose fired for ANY instance — a zombie process exiting
 * minutes after it was replaced, or a close FLUJO itself initiated — and unconditionally
 * deleted the CURRENT client and scheduled a reconnect. The reconnect then tore down the
 * healthy server it raced with, whose close scheduled the next reconnect, forever.
 *
 * Fixed semantics under test:
 *  - close/error events from a transport that is no longer the registered one are ignored
 *  - FLUJO-initiated closes (disconnect/reconnect) deregister first, so they never
 *    schedule a reconnect against themselves
 *  - an UNEXPECTED close of the live transport still schedules a reconnect
 *  - a successful (re)connection cancels any pending retry timer
 */
import { MCPServerConfig } from '@/shared/types/mcp';

jest.mock('@/backend/services/mcp/config', () => {
  const state = {
    configs: [] as unknown[],
  };
  return {
    __configState: state,
    loadServerConfigs: jest.fn(async () => state.configs),
    saveConfig: jest.fn(async () => ({ success: true })),
  };
});

jest.mock('@/backend/services/mcp/connection', () => ({
  McpRuntimeAuthorityRetirementError: jest.requireActual('@/backend/services/mcp/connection').McpRuntimeAuthorityRetirementError,
  assertMcpRuntimeAuthorityRetired: jest.requireActual('@/backend/services/mcp/connection').assertMcpRuntimeAuthorityRetired,
  createNewClient: jest.fn(),
  createTransport: jest.fn(),
  resolveConfigHeaders: jest.fn(async (config: unknown) => config),
  shouldRecreateClient: jest.fn(() => ({ needsNewClient: false })),
  safelyCloseClient: jest.fn(async () => {}),
}));

// The experimental beta-protocol gate reads the Settings blob from on-disk
// storage on every connect (betaClient.ts). Mock it to pure, no-I/O behavior
// so the gate resolves
// within advanceTimersByTimeAsync — and so this suite is hermetic against the
// developer's local settings.
jest.mock('@/backend/services/mcp/betaClient', () => ({
  isMcpBetaProtocolEnabled: jest.fn(async () => false),
  createNewBetaClient: jest.fn(),
  createBetaTransport: jest.fn(),
  isBetaClient: jest.fn(() => false),
  negotiatedProtocolVersion: jest.fn(() => undefined),
}));

// This second connection preference also reads workspace Settings. Keep real
// filesystem I/O outside the fake-timer reconnect test; the policy itself is
// covered by runtimeHomeIsolation.test.ts.
jest.mock('@/backend/services/mcp/runtimeHomeIsolation', () => ({
  resolveRuntimeHomeIsolation: jest.fn(async () => false),
}));

import { MCPService } from '@/backend/services/mcp';
import {
  createNewClient,
  createTransport,
  shouldRecreateClient,
} from '@/backend/services/mcp/connection';
import * as configModule from '@/backend/services/mcp/config';
import { TrustedHostMcpError } from '@/backend/services/security/trustedHostMcp';
import { runWithWorkspace } from '@/utils/workspace';

interface FakeTransport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  start: jest.Mock;
  close: jest.Mock;
  send: jest.Mock;
}

function makeTransport(): FakeTransport {
  return { start: jest.fn(), close: jest.fn(), send: jest.fn() };
}

function makeClient() {
  return {
    connect: jest.fn(async () => {}),
    close: jest.fn(async () => {}),
    ping: jest.fn(async () => ({})),
  };
}

const SERVER: MCPServerConfig = {
  name: 'srv',
  transport: 'stdio',
  command: 'node',
  args: ['dist/index.js'],
  env: {},
  disabled: false,
  rootPath: '',
  _buildCommand: '',
  _installCommand: '',
} as unknown as MCPServerConfig;

const mockCreateNewClient = createNewClient as jest.Mock;
const mockCreateTransport = createTransport as jest.Mock;
const mockShouldRecreate = shouldRecreateClient as jest.Mock;
const configState = (configModule as unknown as { __configState: { configs: unknown[] } }).__configState;

describe('MCPService restart-loop protection', () => {
  let service: MCPService;
  let transports: FakeTransport[];

  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    global.__mcp_clients?.clear();
    global.__mcp_connecting?.clear();
    global.__mcp_active_transports?.clear();
    global.__mcp_approval_failures?.clear();
    global.__mcp_workspace_registries?.delete('approval-status-workspace');
    global.__mcp_starting_up = false;

    configState.configs = [SERVER];
    transports = [];
    mockCreateTransport.mockImplementation(() => {
      const t = makeTransport();
      transports.push(t);
      return t;
    });
    mockCreateNewClient.mockImplementation(() => makeClient());
    mockShouldRecreate.mockReturnValue({ needsNewClient: false });

    service = new MCPService();
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
    global.__mcp_approval_failures?.clear();
    global.__mcp_workspace_registries?.delete('approval-status-workspace');
  });

  it('stops reconnect timers and exposes approval failures as user action', async () => {
    await service.connectServer('srv');
    transports[0].onclose?.();
    mockCreateTransport.mockImplementation(() => { throw new TrustedHostMcpError('HOST_CONSENT_REQUIRED'); });
    await jest.advanceTimersByTimeAsync(5000);
    const attempts = mockCreateTransport.mock.calls.length;
    await jest.advanceTimersByTimeAsync(300000);
    expect(mockCreateTransport).toHaveBeenCalledTimes(attempts);
    expect(await service.getServerStatus('srv')).toMatchObject({
      status: 'requires_approval', requiresApproval: true, errorCode: 'HOST_CONSENT_REQUIRED',
    });
  });

  it.each([true, false])('shares approval status across service instances when startup is %s', async startingUp => {
    global.__mcp_starting_up = startingUp;
    mockCreateTransport.mockImplementationOnce(() => { throw new TrustedHostMcpError('HOST_CONSENT_REQUIRED'); });
    expect(await service.connectServer('srv')).toMatchObject({ requiresApproval: true });

    const statusService = new MCPService();
    expect(await statusService.getServerStatus('srv')).toMatchObject({
      status: 'requires_approval', requiresApproval: true, errorCode: 'HOST_CONSENT_REQUIRED',
    });

    expect(await statusService.connectServer('srv')).toMatchObject({ success: true });
    await statusService.disconnectServer('srv');
    global.__mcp_starting_up = false;
    expect(await new MCPService().getServerStatus('srv')).toMatchObject({ status: 'error' });
  });

  it('keeps a shared approval failure in its own workspace', async () => {
    mockCreateTransport.mockImplementationOnce(() => { throw new TrustedHostMcpError('HOST_CONSENT_REQUIRED'); });
    await runWithWorkspace('approval-status-workspace', () => service.connectServer('srv'));

    const statusService = new MCPService();
    expect(await statusService.getServerStatus('srv')).toMatchObject({ status: 'error' });
    expect(await runWithWorkspace('approval-status-workspace', () => statusService.getServerStatus('srv')))
      .toMatchObject({ status: 'requires_approval', errorCode: 'HOST_CONSENT_REQUIRED' });

    expect(await statusService.connectServer('srv')).toMatchObject({ success: true });
    expect(await runWithWorkspace('approval-status-workspace', () => service.getServerStatus('srv')))
      .toMatchObject({ status: 'requires_approval', errorCode: 'HOST_CONSENT_REQUIRED' });
  });

  it('stops reconnect timers and exposes approval failures as user action', async () => {
    await service.connectServer('srv');
    transports[0].onclose?.();
    mockCreateTransport.mockImplementation(() => { throw new TrustedHostMcpError('HOST_CONSENT_REQUIRED'); });
    await jest.advanceTimersByTimeAsync(5000);
    const attempts = mockCreateTransport.mock.calls.length;
    await jest.advanceTimersByTimeAsync(300000);
    expect(mockCreateTransport).toHaveBeenCalledTimes(attempts);
    expect(await service.getServerStatus('srv')).toMatchObject({
      status: 'requires_approval', requiresApproval: true, errorCode: 'HOST_CONSENT_REQUIRED',
    });
  });

  it('ignores a late close event from a replaced (zombie) transport', async () => {
    // Connect, then force a recreate so transport[0] becomes a "zombie" replaced by [1].
    await service.connectServer('srv');
    mockShouldRecreate.mockReturnValueOnce({ needsNewClient: true, reason: 'test' });
    await service.connectServer('srv');
    expect(transports).toHaveLength(2);
    const healthyClient = service.getClient('srv');
    expect(healthyClient).toBeDefined();

    // The zombie finally exits, minutes later. Its close event must not delete the
    // healthy client or schedule a reconnect against it.
    transports[0].onclose?.();
    await jest.advanceTimersByTimeAsync(60000);

    expect(service.getClient('srv')).toBe(healthyClient);
    expect(mockCreateNewClient).toHaveBeenCalledTimes(2); // no third connection spawned
  });

  it('does not schedule a reconnect for a FLUJO-initiated disconnect', async () => {
    await service.connectServer('srv');
    await service.disconnectServer('srv');

    // The real transport fires onclose while being closed; simulate that.
    transports[0].onclose?.();
    await jest.advanceTimersByTimeAsync(60000);

    expect(service.getClient('srv')).toBeUndefined();
    expect(mockCreateNewClient).toHaveBeenCalledTimes(1); // never reconnected
  });

  it('still schedules a reconnect for an unexpected close of the live transport', async () => {
    await service.connectServer('srv');
    expect(mockCreateNewClient).toHaveBeenCalledTimes(1);

    transports[0].onclose?.(); // process died on its own
    await jest.advanceTimersByTimeAsync(6000); // first retry fires at 5s

    expect(mockCreateNewClient).toHaveBeenCalledTimes(2);
    expect(service.getClient('srv')).toBeDefined();
  });

  it('cancels a pending retry once a connection is re-established through any path', async () => {
    await service.connectServer('srv');
    transports[0].onclose?.(); // unexpected close schedules a retry in 5s
    await jest.advanceTimersByTimeAsync(0);

    // Something else reconnects first (e.g. a tool call's force-reconnect).
    await service.connectServer('srv');
    expect(mockCreateNewClient).toHaveBeenCalledTimes(2);

    // Even if the config comparison were to misfire (the Finding A false-positive),
    // the stale retry timer must be gone and never tear down the fresh connection.
    mockShouldRecreate.mockReturnValue({ needsNewClient: true, reason: 'false positive' });
    await jest.advanceTimersByTimeAsync(600000);

    expect(mockCreateNewClient).toHaveBeenCalledTimes(2);
  });

  it('a retry firing against a live, responsive connection is a no-op (ping guard)', async () => {
    await service.connectServer('srv');
    const healthyClient = service.getClient('srv');

    // A stray retry timer exists (scheduled by some earlier failure) while the current
    // connection is healthy. When it fires, the ping succeeds and nothing is torn down.
    (service as unknown as { scheduleConnectionRetry(name: string, config: MCPServerConfig): void })
      .scheduleConnectionRetry('srv', SERVER);
    await jest.advanceTimersByTimeAsync(600000);

    expect(service.getClient('srv')).toBe(healthyClient);
    expect(mockCreateNewClient).toHaveBeenCalledTimes(1); // never reconnected
  });

  it('a retry firing against a dead-but-registered client reconnects from scratch', async () => {
    await service.connectServer('srv');
    const deadClient = service.getClient('srv') as unknown as { ping: jest.Mock };
    deadClient.ping.mockRejectedValue(new Error('connection lost'));

    (service as unknown as { scheduleConnectionRetry(name: string, config: MCPServerConfig): void })
      .scheduleConnectionRetry('srv', SERVER);
    await jest.advanceTimersByTimeAsync(6000);

    expect(mockCreateNewClient).toHaveBeenCalledTimes(2);
    expect(service.getClient('srv')).toBeDefined();
    expect(service.getClient('srv')).not.toBe(deadClient);
  });
});
