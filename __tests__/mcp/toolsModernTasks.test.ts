import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { z } from 'zod';
jest.mock('@/config/features', () => ({ FEATURES: { ENABLE_MCP_TASKS_CLIENT: true } }));
jest.mock('@/backend/utils/resolveGlobalVars', () => ({ resolveGlobalVars: jest.fn(async (value: unknown) => value) }));
jest.mock('@/backend/services/mcp/config', () => ({ loadServerConfigs: jest.fn(async () => [{
  name: 'srv', transport: 'streamable', serverUrl: 'https://tasks.example.test/mcp', disabled: false,
}]) }));
jest.mock('@/backend/services/mcp/remoteTaskStore', () => ({
  getMcpRemoteTaskSettings: async () => ({ requestedTtlMs: 60000 }),
  resolveServerIdentity: jest.fn(async () => 'task-server-identity'),
}));
jest.mock('@/backend/services/mcp/clientTasks', () => ({
  runRemoteTaskLifecycle: jest.fn(async () => ({ success: true, data: { content: [{ type: 'text', text: 'complete' }] } })),
}));
import { callTool } from '@/backend/services/mcp/tools';
import { runRemoteTaskLifecycle } from '@/backend/services/mcp/clientTasks';
import { MCP_TASKS_EXTENSION_ID } from '@/shared/types/mcp/tasks';
import { modernToolResultSchema } from '@/backend/services/mcp/tasksProtocol';

const task = { resultType: 'task', taskId: 'modern-tool-task', status: 'working', ttlMs: 60000,
  pollIntervalMs: 1000, createdAt: '2026-10-09T00:00:00Z', lastUpdatedAt: '2026-10-09T00:00:00Z' };
beforeEach(() => jest.clearAllMocks());

it.each([false, true])('dispatches modern tasks through validated generic request (beta=%s)', async beta => {
  const progress = jest.fn();
  const controller = new AbortController();
  const request = jest.fn(async (_request: unknown, schema: z.ZodType, options: { onprogress: (value: unknown) => void }) => {
    options.onprogress({ progress: 2, total: 3, message: 'progress' });
    return schema.parse(task);
  });
  const classic = jest.fn();
  const client = { __flujoBeta: beta, callTool: classic, request,
    getServerCapabilities: () => ({ extensions: { [MCP_TASKS_EXTENSION_ID]: {} } }),
  } as unknown as Client;
  const response = await callTool(client, 'srv', 'demo', { text: 'input' }, 120, progress,
    controller.signal, 'host', 'caller-node', 'owner-scope');
  expect(response.success).toBe(true);
  expect(classic).not.toHaveBeenCalled();
  expect(request).toHaveBeenCalledTimes(1);
  const [wire, schema, options] = request.mock.calls[0];
  expect(wire).toMatchObject({ method: 'tools/call', params: { name: 'demo', arguments: { text: 'input' }, _meta: {
    'io.modelcontextprotocol/clientCapabilities': { extensions: { [MCP_TASKS_EXTENSION_ID]: {} } },
    flujo: { callerNodeId: 'caller-node', ownerScope: 'owner-scope' },
  } } });
  expect((wire as { params: object }).params).not.toHaveProperty('task');
  expect(schema).toBe(modernToolResultSchema);
  expect(options).toMatchObject({ timeout: 120000, signal: controller.signal, resetTimeoutOnProgress: true });
  expect(progress).toHaveBeenCalledWith({ progress: 2, total: 3, message: 'progress' });
  expect(runRemoteTaskLifecycle).toHaveBeenCalledWith(expect.objectContaining({
    generation: '2026-07-28', task: expect.objectContaining({ generation: '2026-07-28', taskId: task.taskId }),
    ownership: { nodeId: 'caller-node', ownerScope: 'owner-scope', source: 'host' },
    signal: controller.signal, timeoutMs: 120000,
  }));
});

it.each([false, true])('preserves classic SDK call signatures (beta=%s)', async beta => {
  const request = jest.fn(async () => { throw new Error('MethodNotFound'); });
  const classic = jest.fn(async () => ({ content: [] }));
  const client = { __flujoBeta: beta, callTool: classic, request } as unknown as Client;
  expect((await callTool(client, 'srv', 'demo', {}, 10)).success).toBe(true);
  const args = classic.mock.calls[0] as unknown as unknown[];
  expect(args[0]).toEqual({ name: 'demo', arguments: {} });
  expect(args).toHaveLength(beta ? 2 : 3);
  expect(args[beta ? 1 : 2]).toMatchObject({ timeout: 10000, resetTimeoutOnProgress: true });
  expect(runRemoteTaskLifecycle).not.toHaveBeenCalled();
});

it('rejects malformed modern creation before invoking lifecycle', async () => {
  const client = { callTool: jest.fn(), getServerCapabilities: () => ({ extensions: { [MCP_TASKS_EXTENSION_ID]: {} } }),
    request: jest.fn(async (_wire: unknown, schema: z.ZodType) => schema.parse({ ...task, ttlMs: -1 })),
  } as unknown as Client;
  expect((await callTool(client, 'srv', 'demo', {})).success).toBe(false);
  expect(runRemoteTaskLifecycle).not.toHaveBeenCalled();
});
