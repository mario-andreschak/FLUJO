/**
 * Tests for notifications/roots/list_changed (issue 46).
 *
 * Roots never rebuild a client/connection (the roots capability is always declared and
 * roots/list resolves fresh per request). Instead, when a server's EFFECTIVE roots
 * change — a FlowBuilder node registering/clearing its overlay — a CONNECTED server is
 * told via client.sendRootsListChanged(). Not connected -> silent no-op (the next
 * connect serves fresh roots anyway); send failures are logged, never thrown.
 */

jest.mock('@/backend/utils/resolveGlobalVars', () => ({
  resolveGlobalVars: jest.fn(async (v: unknown) => v),
}));

jest.mock('@/backend/services/mcp/config', () => ({
  loadServerConfigs: jest.fn(async () => [
    { name: 'srv', transport: 'stdio', command: 'x', args: [], env: {}, disabled: false },
  ]),
  saveConfig: jest.fn(async () => ({ success: true })),
}));

jest.mock('@/backend/services/mcp/tools', () => ({
  listServerTools: jest.fn(async () => ({ tools: [] })),
  callTool: jest.fn(),
}));

jest.mock('@/backend/services/mcp/resources', () => ({
  listServerResources: jest.fn(),
  listServerResourceTemplates: jest.fn(),
  readResource: jest.fn(),
}));

const createNewClientMock = jest.fn();
const createTransportMock = jest.fn((..._args: unknown[]) => ({}));
jest.mock('@/backend/services/mcp/connection', () => ({
  createNewClient: (...args: unknown[]) => createNewClientMock(...args),
  createTransport: (...args: unknown[]) => createTransportMock(...args),
  resolveConfigHeaders: jest.fn(async (config: unknown) => config),
  shouldRecreateClient: jest.fn(() => ({ needsNewClient: false })),
  safelyCloseClient: jest.fn(async () => undefined),
}));

import { MCPService } from '@/backend/services/mcp';
import { _resetNodeRootsForTests } from '@/backend/services/mcp/roots';

const makeClient = () => ({
  connect: jest.fn(async () => undefined),
  close: jest.fn(async () => undefined),
  sendRootsListChanged: jest.fn(async () => undefined),
  transport: {},
});

beforeEach(() => {
  createNewClientMock.mockReset();
  createTransportMock.mockClear();
  global.__mcp_clients?.clear();
  _resetNodeRootsForTests();
});

describe('roots change notification (issue 46)', () => {
  it('notifies a connected server when a node registers new roots — and only on real changes', async () => {
    const svc = new MCPService();
    const client = makeClient();
    createNewClientMock.mockReturnValue(client);

    const connect = await svc.connectServer('srv');
    expect(connect.success).toBe(true);

    // First registration changes the effective roots -> one notification.
    svc.setNodeRoots('srv', 'node-1', ['/a']);
    expect(client.sendRootsListChanged).toHaveBeenCalledTimes(1);

    // Identical re-registration (the node re-runs) -> no new notification.
    svc.setNodeRoots('srv', 'node-1', ['/a']);
    expect(client.sendRootsListChanged).toHaveBeenCalledTimes(1);

    // Clearing the overlay changes the effective roots again -> second notification.
    svc.setNodeRoots('srv', 'node-1', []);
    expect(client.sendRootsListChanged).toHaveBeenCalledTimes(2);
  });

  it('is a silent no-op for a server that is not connected', () => {
    const svc = new MCPService();

    // No connect happened; must neither throw nor create a client.
    expect(() => svc.setNodeRoots('offline-srv', 'node-1', ['/a'])).not.toThrow();
    expect(createNewClientMock).not.toHaveBeenCalled();
  });

  it('survives a rejected sendRootsListChanged without throwing', async () => {
    const svc = new MCPService();
    const client = makeClient();
    client.sendRootsListChanged.mockRejectedValue(new Error('transport closed'));
    createNewClientMock.mockReturnValue(client);

    await svc.connectServer('srv');

    expect(() => svc.setNodeRoots('srv', 'node-1', ['/a'])).not.toThrow();
    // Give the fire-and-forget rejection handler a tick so an unhandled rejection
    // would surface here if the .catch() were missing.
    await new Promise((resolve) => setImmediate(resolve));
    expect(client.sendRootsListChanged).toHaveBeenCalledTimes(1);
  });
});
