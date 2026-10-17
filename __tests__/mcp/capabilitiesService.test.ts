/**
 * Tests for MCPService's resource/prompt methods (#15).
 *
 * Mirrors listServerToolsResilience: list operations self-heal a stale client with a single
 * reconnect-and-retry (via the shared listWithReconnect helper); read/get are pass-throughs.
 * The connection/config/capability layers are mocked so no real process or network runs.
 */

jest.mock('@/backend/utils/resolveGlobalVars', () => ({
  resolveGlobalVars: jest.fn(async (v: unknown) => v),
}));

const loadServerConfigsMock = jest.fn(async () => [
  {
    name: 'srv',
    transport: 'stdio',
    command: 'x',
    args: [],
    env: {},
    disabled: false,
    enableMcpApps: true,
  },
]);
jest.mock('@/backend/services/mcp/config', () => ({
  loadServerConfigs: (...args: unknown[]) => loadServerConfigsMock(...(args as [])),
  saveConfig: jest.fn(async () => ({ success: true })),
}));

const callToolMock = jest.fn();
jest.mock('@/backend/services/mcp/tools', () => ({
  listServerTools: jest.fn(),
  callTool: (...args: unknown[]) => callToolMock(...args),
}));

const listResourcesMock = jest.fn();
const listResourceTemplatesMock = jest.fn();
const readResourceMock = jest.fn();
jest.mock('@/backend/services/mcp/resources', () => ({
  listServerResources: (...a: unknown[]) => listResourcesMock(...a),
  listServerResourceTemplates: (...a: unknown[]) => listResourceTemplatesMock(...a),
  readResource: (...a: unknown[]) => readResourceMock(...a),
}));

const listPromptsMock = jest.fn();
const getPromptMock = jest.fn();
jest.mock('@/backend/services/mcp/prompts', () => ({
  listServerPrompts: (...a: unknown[]) => listPromptsMock(...a),
  getPrompt: (...a: unknown[]) => getPromptMock(...a),
}));

const createNewClientMock = jest.fn();
const safelyCloseClientMock = jest.fn();
jest.mock('@/backend/services/mcp/connection', () => ({
  McpRuntimeAuthorityRetirementError: jest.requireActual('@/backend/services/mcp/connection').McpRuntimeAuthorityRetirementError,
  assertMcpRuntimeAuthorityRetired: jest.requireActual('@/backend/services/mcp/connection').assertMcpRuntimeAuthorityRetired,
  createNewClient: (...args: unknown[]) => createNewClientMock(...args),
  createTransport: jest.fn(() => ({})),
  resolveConfigHeaders: jest.fn(async (config: unknown) => config),
  shouldRecreateClient: jest.fn(() => ({ needsNewClient: false })),
  safelyCloseClient: (...args: unknown[]) => safelyCloseClientMock(...args),
}));

import { MCPService } from '@/backend/services/mcp';
import { _resetLifecycleForTests } from '@/backend/services/mcp/lifecycleCoordinator';

const makeClient = (over: Record<string, unknown> = {}) => ({
  connect: jest.fn(async () => undefined),
  close: jest.fn(async () => undefined),
  transport: {},
  ...over,
});

beforeEach(() => {
  createNewClientMock.mockReset();
  safelyCloseClientMock.mockReset().mockResolvedValue(undefined);
  callToolMock.mockReset();
  _resetLifecycleForTests();
  listResourcesMock.mockReset();
  listResourceTemplatesMock.mockReset();
  readResourceMock.mockReset();
  listPromptsMock.mockReset();
  getPromptMock.mockReset();
  loadServerConfigsMock.mockReset();
  loadServerConfigsMock.mockResolvedValue([
    {
      name: 'srv',
      transport: 'stdio',
      command: 'x',
      args: [],
      env: {},
      disabled: false,
      enableMcpApps: true,
    },
  ]);
  global.__mcp_clients?.clear();
});

describe('MCPService.getServerProxyCapabilities', () => {
  it('reads both negotiated extensions behind one fresh connection check', async () => {
    const svc = new MCPService();
    const connect = jest.spyOn(svc, 'connectServer').mockResolvedValue({ success: true });
    jest.spyOn(svc, 'getClient').mockReturnValue(makeClient({
      getServerCapabilities: () => ({ extensions: {
        'io.modelcontextprotocol/skills': { directoryRead: true },
        'io.modelcontextprotocol/ui': { mimeTypes: ['text/html;profile=mcp-app'] },
      } }),
    }) as never);
    const configs = await loadServerConfigsMock();
    loadServerConfigsMock.mockResolvedValue(configs.map(config => ({ ...config, enableMcpSkills: true })));
    expect(await svc.getServerProxyCapabilities('srv')).toEqual({
      skillsCapability: { directoryRead: true },
      appsCapability: { mimeTypes: ['text/html;profile=mcp-app'] },
    });
    expect(connect).toHaveBeenCalledTimes(1);
    loadServerConfigsMock.mockResolvedValue(configs);
    expect((await svc.getServerProxyCapabilities('srv')).skillsCapability).toBeUndefined();
    connect.mockResolvedValue({ success: false, error: 'retired' });
    expect(await svc.getServerProxyCapabilities('srv')).toEqual({});
    connect.mockRestore();
    jest.restoreAllMocks();
  });
});

describe('MCPService.listServerResources', () => {
  it('cold discovery cannot disconnect a concurrently authorizing tool or repeat its effect', async () => {
    loadServerConfigsMock.mockResolvedValue((await loadServerConfigsMock()).map(config => ({
      ...config, transport: 'streamable', serverUrl: 'http://127.0.0.1:54880/mcp',
    })));
    const closed = new Set<unknown>();
    createNewClientMock.mockImplementation(() => makeClient());
    safelyCloseClientMock.mockImplementation(async (client: unknown) => { closed.add(client); });
    const svc = new MCPService();
    let releaseAuthorization!: () => void;
    const authorizationGate = new Promise<void>(resolve => { releaseAuthorization = resolve; });
    let enteredAuthorization!: () => void;
    const authorizationStarted = new Promise<void>(resolve => { enteredAuthorization = resolve; });
    let effects = 0;
    callToolMock.mockImplementation(async (client: unknown) => {
      enteredAuthorization();
      await authorizationGate;
      if (closed.has(client)) return { success: false, error: 'Not connected' };
      effects++;
      return { success: true, data: { receipt: 'genuine-once' } };
    });
    let dispatch: ReturnType<MCPService['callTool']> | undefined;
    listResourcesMock.mockImplementation(async (client: unknown) => {
      dispatch ??= svc.callTool('srv', 'commit_action', { actionId: 'once' });
      await Promise.race([authorizationStarted, dispatch.then(result => {
        throw new Error('Tool dispatch ended before authorization: ' + JSON.stringify(result));
      })]);
      return client ? { resources: [] } : { resources: [], error: 'Server not connected' };
    });
    try {
      await expect(svc.listServerResources('srv')).resolves.toEqual({ resources: [] });
      releaseAuthorization();
      await expect(dispatch).resolves.toMatchObject({ success: true });
      expect(effects).toBe(1);
      expect(callToolMock).toHaveBeenCalledTimes(1);
      expect(safelyCloseClientMock).not.toHaveBeenCalled();
      expect(createNewClientMock).toHaveBeenCalledTimes(1);
    } finally {
      releaseAuthorization();
      await dispatch;
    }
  });

  it('failed discovery preserves a client held by another borrower and retries after release', async () => {
    createNewClientMock.mockImplementation(() => makeClient());
    const svc = new MCPService();
    const held = await svc.acquireServerLease('srv');
    expect(held.lease).toBeDefined();
    listResourcesMock.mockResolvedValue({ resources: [], error: 'fetch failed' });
    try {
      const result = await svc.listServerResources('srv');
      expect(result.error).toBeDefined();
      expect(safelyCloseClientMock).not.toHaveBeenCalled();
      expect(svc.getClient('srv')).toBe(held.lease!.client);
    } finally {
      held.lease!.release();
    }
    listResourcesMock.mockResolvedValueOnce({ resources: [], error: 'fetch failed' })
      .mockResolvedValueOnce({ resources: [{ uri: 'file://recovered', name: 'Recovered' }] });
    await expect(svc.listServerResources('srv')).resolves.toMatchObject({ resources: [{ name: 'Recovered' }] });
    expect(safelyCloseClientMock).toHaveBeenCalledTimes(1);
  });

  it('does not publish an old catalog or close the replacement after a connection change', async () => {
    createNewClientMock.mockImplementation(() => makeClient());
    const svc = new MCPService();
    await svc.connectServer('srv');
    listResourcesMock.mockImplementationOnce(async () => {
      // An explicit owner/config reconnect is allowed to replace the client.
      // The finishing discovery must then lease that replacement for its retry.
      await svc.forceReconnect('srv');
      return { resources: [{ uri: 'file://stale', name: 'Stale' }] };
    }).mockResolvedValueOnce({ resources: [{ uri: 'file://current', name: 'Current' }] });
    await expect(svc.listServerResources('srv')).resolves.toEqual({ resources: [{ uri: 'file://current', name: 'Current' }] });
    expect(safelyCloseClientMock).toHaveBeenCalledTimes(1);
    expect(createNewClientMock).toHaveBeenCalledTimes(2);
  });

  it('keeps a pinned App connection intact when discovery fails', async () => {
    createNewClientMock.mockImplementation(() => makeClient());
    const svc = new MCPService();
    await svc.connectServer('srv');
    svc.pinServer('srv', 'active-app');
    listResourcesMock.mockResolvedValue({ resources: [], error: 'fetch failed' });
    try {
      await expect(svc.listServerResources('srv')).resolves.toMatchObject({ error: expect.any(String) });
      expect(safelyCloseClientMock).not.toHaveBeenCalled();
    } finally {
      svc.unpinServer('srv', 'active-app');
    }
  });

  it('returns resources directly when the connection is healthy', async () => {
    createNewClientMock.mockReturnValue(makeClient());
    const svc = new MCPService();
    await svc.connectServer('srv');

    listResourcesMock.mockResolvedValueOnce({ resources: [{ uri: 'file://a', name: 'A' }] });

    const result = await svc.listServerResources('srv');
    expect(result.error).toBeUndefined();
    expect(result.resources).toHaveLength(1);
    expect(createNewClientMock).toHaveBeenCalledTimes(1); // only the seed
  });

  it('reconnects and retries once when the cached client is stale', async () => {
    createNewClientMock.mockReturnValue(makeClient());
    const svc = new MCPService();
    await svc.connectServer('srv');

    listResourcesMock
      .mockResolvedValueOnce({ resources: [], error: 'fetch failed' })
      .mockResolvedValueOnce({ resources: [{ uri: 'file://a', name: 'A' }] });

    const result = await svc.listServerResources('srv');
    expect(result.error).toBeUndefined();
    expect(result.resources).toHaveLength(1);
    expect(createNewClientMock).toHaveBeenCalledTimes(2); // seed + reconnect
    expect(listResourcesMock).toHaveBeenCalledTimes(2);
  });

  it('does NOT reconnect when the server simply has no resources (empty, no error)', async () => {
    createNewClientMock.mockReturnValue(makeClient());
    const svc = new MCPService();
    await svc.connectServer('srv');

    listResourcesMock.mockResolvedValueOnce({ resources: [] });

    const result = await svc.listServerResources('srv');
    expect(result.resources).toEqual([]);
    expect(result.error).toBeUndefined();
    expect(createNewClientMock).toHaveBeenCalledTimes(1); // no reconnect
    expect(listResourcesMock).toHaveBeenCalledTimes(1);
  });
});

describe('MCPService.listServerPrompts', () => {
  it('reconnects and retries once when the cached client is stale', async () => {
    createNewClientMock.mockReturnValue(makeClient());
    const svc = new MCPService();
    await svc.connectServer('srv');

    listPromptsMock
      .mockResolvedValueOnce({ prompts: [], error: 'fetch failed' })
      .mockResolvedValueOnce({ prompts: [{ name: 'greet' }] });

    const result = await svc.listServerPrompts('srv');
    expect(result.error).toBeUndefined();
    expect(result.prompts).toHaveLength(1);
    expect(createNewClientMock).toHaveBeenCalledTimes(2);
  });
});

describe('MCPService.readResource / getPrompt pass-through', () => {
  for (const kind of ['native resource', 'prompt'] as const) {
    it(`preserves an active ${kind} read when concurrent discovery fails`, async () => {
      createNewClientMock.mockImplementation(() => makeClient());
      const svc = new MCPService();
      await svc.connectServer('srv');
      let finishRead!: () => void;
      const readGate = new Promise<void>(resolve => { finishRead = resolve; });
      let startedRead!: () => void;
      const readStarted = new Promise<void>(resolve => { startedRead = resolve; });
      const reader = kind === 'native resource' ? readResourceMock : getPromptMock;
      reader.mockImplementation(async () => {
        startedRead();
        await readGate;
        return { success: true, data: kind === 'native resource' ? { contents: [] } : { messages: [] } };
      });
      const pending = kind === 'native resource' ? svc.readResource('srv', 'file://original') : svc.getPrompt('srv', 'original');
      try {
        await readStarted;
        listResourcesMock.mockResolvedValue({ resources: [], error: 'fetch failed' });
        await expect(svc.listServerResources('srv')).resolves.toMatchObject({ error: expect.any(String) });
        expect(safelyCloseClientMock).not.toHaveBeenCalled();
      } finally {
        finishRead();
        await expect(pending).resolves.toMatchObject({ success: true });
      }
    });
  }

  it('readResource forwards to the resources layer', async () => {
    createNewClientMock.mockReturnValue(makeClient());
    const svc = new MCPService();
    await svc.connectServer('srv');

    readResourceMock.mockResolvedValueOnce({ success: true, data: { contents: [] } });
    const result = await svc.readResource('srv', 'file://a');
    expect(result.success).toBe(true);
    expect(readResourceMock).toHaveBeenCalledTimes(1);
  });

  it('getPrompt forwards to the prompts layer', async () => {
    createNewClientMock.mockReturnValue(makeClient());
    const svc = new MCPService();
    await svc.connectServer('srv');

    getPromptMock.mockResolvedValueOnce({ success: true, data: { messages: [] } });
    const result = await svc.getPrompt('srv', 'greet', { who: 'world' });
    expect(result.success).toBe(true);
    expect(getPromptMock).toHaveBeenCalledTimes(1);
  });

  it('re-checks enableMcpApps for every app-originated resource read', async () => {
    loadServerConfigsMock.mockResolvedValue([
      {
        name: 'srv',
        transport: 'stdio',
        command: 'x',
        args: [],
        env: {},
        disabled: false,
        enableMcpApps: false,
      },
    ]);
    const svc = new MCPService();

    const result = await svc.readResourceFromApp('srv', 'ui://dashboard');

    expect(result).toMatchObject({ success: false, statusCode: 403 });
    expect(readResourceMock).not.toHaveBeenCalled();
  });

  it('does not exempt a stored server merely because it shadows a built-in name', async () => {
    loadServerConfigsMock.mockResolvedValue([
      {
        name: 'filesystem',
        transport: 'stdio',
        command: 'x',
        args: [],
        env: {},
        disabled: false,
        enableMcpApps: false,
      },
    ]);
    const svc = new MCPService();

    await expect(svc.isMcpAppAccessEnabled('filesystem')).resolves.toBe(false);
  });
});
