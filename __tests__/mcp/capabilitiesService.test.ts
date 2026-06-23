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

jest.mock('@/backend/services/mcp/config', () => ({
  loadServerConfigs: jest.fn(async () => [
    { name: 'srv', transport: 'stdio', command: 'x', args: [], env: {}, disabled: false },
  ]),
  saveConfig: jest.fn(async () => ({ success: true })),
}));

jest.mock('@/backend/services/mcp/tools', () => ({
  listServerTools: jest.fn(),
  callTool: jest.fn(),
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
jest.mock('@/backend/services/mcp/connection', () => ({
  createNewClient: (...args: unknown[]) => createNewClientMock(...args),
  createTransport: jest.fn(() => ({})),
  shouldRecreateClient: jest.fn(() => ({ needsNewClient: false })),
  safelyCloseClient: jest.fn(async () => undefined),
}));

import { MCPService } from '@/backend/services/mcp';

const makeClient = (over: Record<string, unknown> = {}) => ({
  connect: jest.fn(async () => undefined),
  close: jest.fn(async () => undefined),
  transport: {},
  ...over,
});

beforeEach(() => {
  createNewClientMock.mockReset();
  listResourcesMock.mockReset();
  listResourceTemplatesMock.mockReset();
  readResourceMock.mockReset();
  listPromptsMock.mockReset();
  getPromptMock.mockReset();
  global.__mcp_recovery?.clear();
});

describe('MCPService.listServerResources', () => {
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
});
