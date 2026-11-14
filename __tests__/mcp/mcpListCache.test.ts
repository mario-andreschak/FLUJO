/**
 * Issue #1408: opt-in reuse of MCP tool and resource lists. Off, every call
 * lists. On, a list is reused only for a server that announces changes, on
 * the same connection, and is dropped on a change notice or after 60 s.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const loadItemMock = jest.fn();
jest.mock('@/utils/storage/backend', () => ({
  loadItem: (...args: unknown[]) => loadItemMock(...args),
}));

import {
  MCP_LIST_CACHE_MAX_AGE_MS,
  _resetMcpListCacheSettingForTests,
  cachedMcpList,
  invalidateMcpLists,
  isMcpListCacheEnabled,
} from '@/backend/services/mcp/listCache';
import { registerToolListChangedHandler } from '@/backend/services/mcp/resourceNotifications';

const announcing = (listChanged = true) => ({
  getServerCapabilities: () => ({ tools: { listChanged }, resources: { listChanged } }),
});

beforeEach(() => {
  _resetMcpListCacheSettingForTests();
  loadItemMock.mockReset().mockResolvedValue(undefined);
  process.env.FLUJO_MCP_LIST_CACHE = '1';
});
afterEach(() => {
  delete process.env.FLUJO_MCP_LIST_CACHE;
  jest.useRealTimers();
});

describe('MCP list reuse switch', () => {
  it('is off unless the setting or the environment turns it on', async () => {
    delete process.env.FLUJO_MCP_LIST_CACHE;
    await expect(isMcpListCacheEnabled()).resolves.toBe(false);
    _resetMcpListCacheSettingForTests();
    loadItemMock.mockResolvedValue({ experimental: { mcpListCache: true } });
    await expect(isMcpListCacheEnabled()).resolves.toBe(true);
    process.env.FLUJO_MCP_LIST_CACHE = '0';
    await expect(isMcpListCacheEnabled()).resolves.toBe(false);
  });

  it('lists every time when off', async () => {
    process.env.FLUJO_MCP_LIST_CACHE = '0';
    const client = announcing();
    const load = jest.fn(async () => ({ tools: [{ name: 'a' }] }));
    await cachedMcpList(client, 'tools', 'model', load);
    await cachedMcpList(client, 'tools', 'model', load);
    expect(load).toHaveBeenCalledTimes(2);
  });
});

describe('MCP list reuse', () => {
  it('reuses a list for a server that announces changes, as a separate copy', async () => {
    const client = announcing();
    const load = jest.fn(async () => ({ tools: [{ name: 'a' }] }));
    const first = await cachedMcpList(client, 'tools', 'model', load);
    first.tools.push({ name: 'changed by a caller' });
    const second = await cachedMcpList(client, 'tools', 'model', load);
    expect(load).toHaveBeenCalledTimes(1);
    expect(second).toEqual({ tools: [{ name: 'a' }] });
  });

  it('keeps audiences and list kinds apart', async () => {
    const client = announcing();
    const load = jest.fn(async () => ({ items: [] as string[] }));
    await cachedMcpList(client, 'tools', 'model', load);
    await cachedMcpList(client, 'tools', 'all', load);
    await cachedMcpList(client, 'resources', 'resources', load);
    await cachedMcpList(client, 'resources', 'templates', load);
    expect(load).toHaveBeenCalledTimes(4);
  });

  it('always lists for a server that does not announce changes', async () => {
    const client = announcing(false);
    const load = jest.fn(async () => ({ tools: [] }));
    await cachedMcpList(client, 'tools', 'model', load);
    await cachedMcpList(client, 'tools', 'model', load);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('never keeps a failed listing', async () => {
    const client = announcing();
    const load = jest.fn()
      .mockResolvedValueOnce({ tools: [], error: 'offline' })
      .mockResolvedValue({ tools: [{ name: 'a' }] });
    await expect(cachedMcpList(client, 'tools', 'model', load)).resolves.toMatchObject({ error: 'offline' });
    await cachedMcpList(client, 'tools', 'model', load);
    await cachedMcpList(client, 'tools', 'model', load);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('starts empty for a new connection', async () => {
    const load = jest.fn(async () => ({ tools: [] }));
    await cachedMcpList(announcing(), 'tools', 'model', load);
    await cachedMcpList(announcing(), 'tools', 'model', load);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('drops only the announced kind on a change notice', async () => {
    const client = announcing();
    const tools = jest.fn(async () => ({ tools: [] }));
    const resources = jest.fn(async () => ({ resources: [] }));
    await cachedMcpList(client, 'tools', 'model', tools);
    await cachedMcpList(client, 'resources', 'resources', resources);
    invalidateMcpLists(client, 'tools');
    await cachedMcpList(client, 'tools', 'model', tools);
    await cachedMcpList(client, 'resources', 'resources', resources);
    expect(tools).toHaveBeenCalledTimes(2);
    expect(resources).toHaveBeenCalledTimes(1);
  });

  it('lists again after the maximum age, in case a notice was lost', async () => {
    jest.useFakeTimers({ now: 1_000_000 });
    const client = announcing();
    const load = jest.fn(async () => ({ tools: [] }));
    await cachedMcpList(client, 'tools', 'model', load);
    jest.setSystemTime(1_000_000 + MCP_LIST_CACHE_MAX_AGE_MS - 1);
    await cachedMcpList(client, 'tools', 'model', load);
    expect(load).toHaveBeenCalledTimes(1);
    jest.setSystemTime(1_000_000 + MCP_LIST_CACHE_MAX_AGE_MS + 1);
    await cachedMcpList(client, 'tools', 'model', load);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('lists again after a real server announces a tool change', async () => {
    let tools = [{ name: 'lookup_order', inputSchema: { type: 'object' as const } }];
    const server = new Server({ name: 'changing', version: '1.0.0' }, { capabilities: { tools: { listChanged: true } } });
    server.setRequestHandler(ListToolsRequestSchema, () => ({ tools }));
    const client = new Client({ name: 'flujo-test', version: '1.0.0' });
    const changed = new Promise<void>(resolve => {
      registerToolListChangedHandler(client, 'changing', () => { invalidateMcpLists(client, 'tools'); resolve(); });
    });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
    const list = jest.fn(async () => ({ tools: (await client.listTools()).tools.map(tool => tool.name) }));

    await expect(cachedMcpList(client, 'tools', 'model', list)).resolves.toEqual({ tools: ['lookup_order'] });
    await expect(cachedMcpList(client, 'tools', 'model', list)).resolves.toEqual({ tools: ['lookup_order'] });
    expect(list).toHaveBeenCalledTimes(1);

    tools = [...tools, { name: 'refund', inputSchema: { type: 'object' as const } }];
    await server.sendToolListChanged();
    await changed;
    await expect(cachedMcpList(client, 'tools', 'model', list)).resolves.toEqual({ tools: ['lookup_order', 'refund'] });
    expect(list).toHaveBeenCalledTimes(2);
    await client.close();
  });
});
