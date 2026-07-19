/**
 * Tests for the built-in internal server's integration into MCPService:
 * synthetic config injection (stored config wins), connect/status short-circuits,
 * CRUD guards, tool dispatch, and the never-persist rule in saveConfig.
 */

// Self-contained factories (no closing over outer consts — see jest-test-harness notes).
jest.mock('@/utils/storage/backend', () => ({
  loadItem: jest.fn(async () => ({})),
  saveItem: jest.fn(async () => undefined),
}));
// The dispatcher module reaches into runFlow/authoring/scheduler; MCPService loads
// it via dynamic import, which jest.mock intercepts all the same.
jest.mock('@/backend/services/mcp/internalTools', () => ({
  internalToolDefinitions: () => [
    { name: 'ping', description: 'test tool', inputSchema: { type: 'object', properties: {} } },
  ],
  internalCallTool: jest.fn(async () => ({ content: [{ type: 'text', text: 'pong' }] })),
}));

import { promises as fsp } from 'fs';
import os from 'os';
import path from 'path';
import { mcpService } from '@/backend/services/mcp';
import { saveConfig } from '@/backend/services/mcp/config';
import { INTERNAL_SERVER_NAME, internalServerConfig } from '@/backend/services/mcp/internalServerConfig';
import { _setRunResourcesDirForTests } from '@/backend/services/runResources';
import { loadItem, saveItem } from '@/utils/storage/backend';
import { MCPServerConfig } from '@/shared/types/mcp';

const loadItemMock = loadItem as jest.Mock;
const saveItemMock = saveItem as jest.Mock;
const internalCallToolMock = (jest.requireMock('@/backend/services/mcp/internalTools') as { internalCallTool: jest.Mock }).internalCallTool;

beforeEach(() => {
  jest.clearAllMocks();
  loadItemMock.mockResolvedValue({});
  saveItemMock.mockResolvedValue(undefined);
});

describe('loadServerConfigs injection', () => {
  it('appends the synthetic built-in config when no stored server claims the name', async () => {
    loadItemMock.mockResolvedValue({ other: { transport: 'stdio', command: 'x' } });
    const configs = await mcpService.loadServerConfigs();
    expect(Array.isArray(configs)).toBe(true);
    const list = configs as MCPServerConfig[];
    const internal = list.find((c) => c.name === INTERNAL_SERVER_NAME);
    expect(internal).toBeDefined();
    expect(internal!.builtIn).toBe(true);
    expect(internal!.disabled).toBe(false);
    expect(internal!.exposeAsMcpServer).toBe(true);
    expect(list.some((c) => c.name === 'other')).toBe(true);
  });

  it('lets a stored server of the same name shadow the built-in one', async () => {
    loadItemMock.mockResolvedValue({ [INTERNAL_SERVER_NAME]: { transport: 'stdio', command: 'x' } });
    const configs = (await mcpService.loadServerConfigs()) as MCPServerConfig[];
    const matches = configs.filter((c) => c.name === INTERNAL_SERVER_NAME);
    expect(matches).toHaveLength(1);
    expect(matches[0].builtIn).toBeUndefined();
  });
});

describe('connection short-circuits', () => {
  it('connectServer succeeds instantly without creating a client', async () => {
    const result = await mcpService.connectServer(INTERNAL_SERVER_NAME);
    expect(result.success).toBe(true);
    expect((global as { __mcp_clients?: Map<string, unknown> }).__mcp_clients?.has(INTERNAL_SERVER_NAME)).toBe(false);
  });

  it('getServerStatus reports connected', async () => {
    const status = await mcpService.getServerStatus(INTERNAL_SERVER_NAME);
    expect(status.status).toBe('connected');
  });

  it('disconnectServer and forceReconnect are successful no-ops', async () => {
    expect((await mcpService.disconnectServer(INTERNAL_SERVER_NAME)).success).toBe(true);
    expect((await mcpService.forceReconnect(INTERNAL_SERVER_NAME)).success).toBe(true);
  });

  it('does not short-circuit when a stored server shadows the name', async () => {
    loadItemMock.mockResolvedValue({ [INTERNAL_SERVER_NAME]: { transport: 'stdio', command: 'x' } });
    // A shadowed name takes the normal path: no client exists and no live connect
    // is attempted here, so the status is the regular "configured but not
    // connected" error rather than the built-in's synthetic "connected".
    const status = await mcpService.getServerStatus(INTERNAL_SERVER_NAME);
    expect(status.status).not.toBe('connected');
  });
});

describe('tool listing and dispatch', () => {
  it('listServerTools returns the internal tool definitions', async () => {
    const { tools, error } = await mcpService.listServerTools(INTERNAL_SERVER_NAME);
    expect(error).toBeUndefined();
    expect(tools.map((t) => t.name)).toEqual(['ping']);
  });

  it('callTool dispatches in-process and wraps the CallToolResult in data', async () => {
    const result = await mcpService.callTool(INTERNAL_SERVER_NAME, 'ping', { a: 1 });
    expect(internalCallToolMock).toHaveBeenCalledWith(mcpService, 'ping', { a: 1 });
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ content: [{ type: 'text', text: 'pong' }] });
  });

  it('listServerResources/Prompts return empty without errors', async () => {
    // The internal server's listServerResources reads the REAL on-disk Tier-3
    // run-resource store (db/run-resources), so isolate it to an empty temp dir
    // via the store's test seam to make the emptiness assertion deterministic on
    // any machine that has ever produced run artifacts.
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'flujo-internal-'));
    const prevDir = _setRunResourcesDirForTests(tmp);
    try {
      const resources = await mcpService.listServerResources(INTERNAL_SERVER_NAME);
      expect(resources.error).toBeUndefined();
      expect(Array.isArray(resources.resources)).toBe(true);
      expect(resources.resources).toEqual([]);
      const prompts = await mcpService.listServerPrompts(INTERNAL_SERVER_NAME);
      expect(prompts.prompts).toEqual([]);
      expect(prompts.error).toBeUndefined();
    } finally {
      _setRunResourcesDirForTests(prevDir);
      await fsp.rm(tmp, { recursive: true, force: true });
    }
  });
});

describe('CRUD guards', () => {
  it('refuses to update or create the built-in server', async () => {
    const result = await mcpService.updateServerConfig(INTERNAL_SERVER_NAME, { disabled: true });
    expect('error' in result && result.error).toMatch(/built-in/i);
    expect(saveItemMock).not.toHaveBeenCalled();
  });

  it('refuses to delete the built-in server', async () => {
    const result = await mcpService.deleteServerConfig(INTERNAL_SERVER_NAME);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/built-in/i);
    expect(saveItemMock).not.toHaveBeenCalled();
  });

  it('refuses to rename another server onto the reserved name', async () => {
    loadItemMock.mockResolvedValue({ other: { transport: 'stdio', command: 'x' } });
    const result = await mcpService.updateServerConfig('other', { name: INTERNAL_SERVER_NAME });
    expect('error' in result && result.error).toMatch(/already exists/i);
  });

  it('still allows editing a stored server that shadows the name', async () => {
    loadItemMock.mockResolvedValue({ [INTERNAL_SERVER_NAME]: { transport: 'stdio', command: 'x' } });
    const result = await mcpService.updateServerConfig(INTERNAL_SERVER_NAME, { disabled: true });
    expect('error' in result ? result.error : undefined).toBeUndefined();
    expect(saveItemMock).toHaveBeenCalled();
  });
});

describe('persistence', () => {
  it('saveConfig never writes builtIn entries to storage', async () => {
    const configs = new Map<string, MCPServerConfig>();
    configs.set(INTERNAL_SERVER_NAME, internalServerConfig());
    configs.set('real', {
      name: 'real',
      transport: 'stdio',
      command: 'x',
      args: [],
      env: {},
      disabled: false,
      autoApprove: [],
      rootPath: '',
      _buildCommand: '',
      _installCommand: '',
    } as MCPServerConfig);

    const result = await saveConfig(configs);
    expect(result.success).toBe(true);

    const saved = saveItemMock.mock.calls[0][1] as Record<string, unknown>;
    expect(Object.keys(saved)).toEqual(['real']);
  });

  it('updating another server does not leak the synthetic entry into storage', async () => {
    loadItemMock.mockResolvedValue({ other: { transport: 'stdio', command: 'x' } });
    // disabled: true keeps handleConnectionStateChange from attempting a real connect.
    const result = await mcpService.updateServerConfig('other', { disabled: true });
    expect('error' in result ? result.error : undefined).toBeUndefined();

    const saved = saveItemMock.mock.calls[0][1] as Record<string, unknown>;
    expect(saved.other).toBeDefined();
    expect(saved[INTERNAL_SERVER_NAME]).toBeUndefined();
  });
});
