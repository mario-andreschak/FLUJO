jest.mock('@/backend/utils/resolveGlobalVars', () => ({
  resolveGlobalVars: jest.fn(async (value: unknown) => value),
}));
jest.mock('@/backend/services/mcp', () => ({
  mcpService: { isMcpAppAccessEnabled: jest.fn(async () => true) },
}));
jest.mock('@/backend/services/mcp/clientTasks', () => ({
  runRemoteTaskLifecycle: jest.fn(),
}));

const mockLaunchBrowser = jest.fn();
jest.mock('patchright', () => ({
  chromium: { launch: (...args: unknown[]) => mockLaunchBrowser(...args), launchPersistentContext: jest.fn() },
}));

import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { callTool } from '@/backend/services/mcp/tools';
import { runRemoteTaskLifecycle } from '@/backend/services/mcp/clientTasks';
import { resolveInvokedToolUiLink } from '@/backend/mcpApps/toolUi';
import {
  MCP_APP_OWNER_SCOPE_META,
  mcpAppOwnerScopeFromResult,
  resolveMcpAppOwnerScope,
} from '@/shared/utils/mcpAppOwnerScope';
import { groupMcpAppOccurrences } from '@/frontend/components/Chat/mcpAppProjection';
import { emptyCanvasState, openCanvasApp, updateCanvasApp } from '@/frontend/components/Chat/canvasState';
import { openSession, shutdownBrowserRuntime } from '../../mcp-servers/browser/src/runtime';

const view = { conversationId: 'conversation-1', serverName: 'browser', uri: 'ui://browser/view', frameInstanceId: 'frame-1' };

function clientFor(implementation: (params: {
  arguments: Record<string, unknown>;
  _meta?: { flujo?: { ownerScope?: string } };
}) => Promise<unknown>): Client {
  return {
    listTools: jest.fn(async () => ({ tools: [{ name: 'browser_open', inputSchema: { type: 'object' } }] })),
    callTool: jest.fn(implementation),
  } as unknown as Client;
}

async function invoke(client: Client, ownerScope: string | undefined, source: 'model' | 'app' = 'model', sessionId = 'session-1') {
  return callTool(client, 'browser', 'browser_open', { sessionId }, undefined, undefined, undefined, source, undefined, ownerScope);
}

afterEach(async () => {
  await shutdownBrowserRuntime();
  jest.clearAllMocks();
});

it('reattaches the App to a model-owned browser after transcript hydration and a later run', async () => {
  const newContext = jest.fn(async () => {
    let closed = false;
    const page = {
      isClosed: () => closed, close: async () => { closed = true; },
      mainFrame: jest.fn(), on: jest.fn(), url: () => 'about:blank',
    };
    return { newPage: async () => page, route: jest.fn(), close: async () => { closed = true; } };
  });
  mockLaunchBrowser.mockResolvedValue({ close: jest.fn(async () => undefined), isConnected: () => true, once: jest.fn(), newContext });
  const client = clientFor(async (params) => {
    const session = await openSession(params.arguments.sessionId, new AbortController().signal, params._meta?.flujo?.ownerScope);
    return {
      content: [], structuredContent: { sessionId: session.id },
      _meta: { [MCP_APP_OWNER_SCOPE_META]: 'run:server-spoof', flujo: { gatewaySessionToken: session.gatewayToken } },
    };
  });
  const first = await invoke(client, 'run:first');
  expect(first.success).toBe(true);
  const link = await resolveInvokedToolUiLink('browser', 'browser_open', view.uri, first.data);
  expect(link?.toolOwnerScope).toBe('run:first');
  const message = JSON.parse(JSON.stringify({
    id: 'result-1', timestamp: 1, role: 'tool', tool_call_id: 'call-1',
    // Actual large snapshots can be replaced by a non-JSON spill preview.
    content: 'Large tool result saved as a run resource.', ui: link,
  }));
  const historical = groupMcpAppOccurrences([{
    toolCall: { id: 'call-1', type: 'function', function: { name: 'browser_open', arguments: '{}' } },
    result: message,
  }])[0].latest;
  const canvas = openCanvasApp(emptyCanvasState, historical).state;
  const entry = canvas.entries[canvas.activeKey!];

  await invoke(client, 'run:second', 'model', 'session-2');
  const appOwner = resolveMcpAppOwnerScope({ ...view, toolOwnerScope: entry.latestToolOwnerScope, toolResultContent: entry.latestResultContent });
  expect(appOwner).toBe('run:first');
  const attached = await invoke(client, appOwner, 'app');
  expect(attached.success).toBe(true);
  expect(attached.data).toMatchObject({ structuredContent: { sessionId: 'session-1' } });
  expect(newContext).toHaveBeenCalledTimes(2);

  // The regression is solved by correct provenance, without weakening denial.
  expect((await invoke(client, 'conversation:conversation-1', 'app')).success).toBe(false);
  expect((await invoke(client, 'run:second', 'app')).success).toBe(false);
  expect(newContext).toHaveBeenCalledTimes(2);
});

it.each([false, true])('overwrites server owner claims on classic results (isError=%s)', async (isError) => {
  const payload = { content: [], isError, _meta: { [MCP_APP_OWNER_SCOPE_META]: 'run:forged', custom: 'preserved' } };
  const client = clientFor(async () => payload);
  const result = await invoke(client, 'run:actual');
  expect(result.data).toMatchObject({ isError, _meta: { [MCP_APP_OWNER_SCOPE_META]: 'run:actual', custom: 'preserved' } });
  expect(payload._meta[MCP_APP_OWNER_SCOPE_META]).toBe('run:forged');
  expect(mcpAppOwnerScopeFromResult((await invoke(client, undefined)).data)).toBeUndefined();
});

it.each([false, true])('stamps the retrieved MCP Task result (isError=%s)', async (isError) => {
  const client = clientFor(async () => ({ task: { taskId: 'task-1', status: 'completed' } }));
  jest.mocked(runRemoteTaskLifecycle).mockResolvedValue({
    success: true, data: { content: [], isError, _meta: { [MCP_APP_OWNER_SCOPE_META]: 'run:forged' } },
  });
  const result = await invoke(client, 'run:actual');
  expect(mcpAppOwnerScopeFromResult(result.data)).toBe('run:actual');
  expect(mcpAppOwnerScopeFromResult((await invoke(client, undefined)).data)).toBeUndefined();
});

it('retains legacy and standalone namespaces and ignores owner strings in tool content', () => {
  expect(resolveMcpAppOwnerScope(view)).toBe('conversation:conversation-1');
  const standalone = { ...view, conversationId: undefined };
  expect(resolveMcpAppOwnerScope({ ...standalone, ownerScopeId: 'stable-panel' })).toBe('app:stable-panel');
  expect(resolveMcpAppOwnerScope(standalone)).toBe('app:browser:ui://browser/view:frame-1');
  expect(resolveMcpAppOwnerScope({ ...view, toolResultContent: JSON.stringify({ content: [{ type: 'text', text: JSON.stringify({ _meta: { [MCP_APP_OWNER_SCOPE_META]: 'run:forged' } }) }] }) })).toBe('conversation:conversation-1');
  for (const invalid of ['', '  run:bad', 'x'.repeat(513), 123, null]) {
    expect(mcpAppOwnerScopeFromResult({ _meta: { [MCP_APP_OWNER_SCOPE_META]: invalid } })).toBeUndefined();
  }
  expect(mcpAppOwnerScopeFromResult('not JSON')).toBeUndefined();
});

it('updates the canvas owner per delivery and clears it for a later legacy or standalone result', () => {
  const input = { serverName: view.serverName, uri: view.uri, toolOwnerScope: 'run:first', updateId: 'result-1', resultContent: 'preview' };
  let canvas = openCanvasApp(emptyCanvasState, input).state;
  const key = canvas.activeKey!;
  canvas = updateCanvasApp(canvas, { ...input, toolOwnerScope: 'run:second', updateId: 'result-2' });
  expect(canvas.entries[key].latestToolOwnerScope).toBe('run:second');
  canvas = updateCanvasApp(canvas, { serverName: view.serverName, uri: view.uri, updateId: 'result-3', resultContent: 'preview' });
  expect(canvas.entries[key].latestToolOwnerScope).toBeUndefined();
});
