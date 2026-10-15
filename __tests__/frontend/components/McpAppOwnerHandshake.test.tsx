import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import McpAppFrame from '@/frontend/components/Chat/McpAppFrame';
import { TextDecoder, TextEncoder } from 'util';

Object.assign(globalThis, { TextDecoder, TextEncoder });

interface BridgeFixture {
  client: { request: (request: unknown) => Promise<unknown> };
  oninitialized?: () => void;
  close: jest.Mock;
  sendToolResult: jest.Mock;
  teardownResource: jest.Mock;
}
const mockBridges: BridgeFixture[] = [];
const mockCallToolFromApp = jest.fn(async () => ({ success: true, data: { content: [] } }));
const mockReadResourceFromApp = jest.fn(async (_server: string, uri: string) => ({
  success: true, data: { contents: [{ uri, mimeType: 'text/html;profile=mcp-app', text: '<p>Browser</p>' }] },
}));

jest.mock('@/frontend/contexts/I18nContext', () => {
  const t = (key: string) => key;
  return { useI18n: () => ({ t }) };
});
jest.mock('@/frontend/contexts/StorageContext', () => ({ useStorage: () => ({ settings: {}, settingsHydrated: true }) }));
jest.mock('@/frontend/services/mcp', () => ({
  mcpService: {
    readResourceFromApp: (...args: [string, string]) => mockReadResourceFromApp(...args),
    listServerTools: async () => ({ tools: [] }),
    callToolFromApp: (...args: unknown[]) => mockCallToolFromApp(...args as []),
  },
}));
jest.mock('@modelcontextprotocol/ext-apps/app-bridge', () => ({
  AppBridge: class {
    client: BridgeFixture['client'];
    oninitialized?: () => void;
    close = jest.fn(async () => undefined);
    sendToolInput = jest.fn(async () => undefined);
    sendToolResult = jest.fn(async () => undefined);
    sendToolCancelled = jest.fn(async () => undefined);
    sendSandboxResourceReady = jest.fn(async () => undefined);
    sendHostContextChange = jest.fn(async () => undefined);
    teardownResource = jest.fn(async () => undefined);
    connect = jest.fn(async () => undefined);
    getAppCapabilities = () => ({ availableDisplayModes: ['inline', 'pip'] });
    constructor(client: BridgeFixture['client']) { this.client = client; mockBridges.push(this); }
  },
  PostMessageTransport: class {},
  buildAllowAttribute: () => '',
  McpUiResourceCspSchema: { safeParse: () => ({ success: false }) },
  McpUiResourcePermissionsSchema: { safeParse: () => ({ success: false }) },
}));

const originalFetch = global.fetch;
const originKey = `app${'a'.repeat(56)}`;
const sandboxOrigin = `http://${originKey}.localhost:4211`;

beforeEach(() => {
  mockBridges.length = 0;
  mockCallToolFromApp.mockClear();
  mockReadResourceFromApp.mockClear();
  global.fetch = jest.fn(async () => ({
    ok: true,
    json: async () => ({ shared: false, originKey, token: 'test-token', url: `${sandboxOrigin}/sandbox.html` }),
  } as Response));
});
afterEach(() => { global.fetch = originalFetch; });

it('names the full-screen control even before the App declares display capabilities', () => {
  render(<McpAppFrame conversationId="accessible-frame" serverName="browser"
    uri="ui://browser/owner-handshake" defaultExpanded toolOwnerScope="run:accessible" />);
  expect(screen.getByRole('button', { name: 'chat.app.fullscreen' })).toBeDisabled();
});

async function readyLatestProxy(container: HTMLElement, expectedBridgeCount: number) {
  await waitFor(() => expect(container.querySelector('iframe')?.src).toContain(sandboxOrigin));
  const iframe = container.querySelector('iframe')!;
  await act(async () => {
    window.dispatchEvent(new MessageEvent('message', {
      origin: sandboxOrigin, source: iframe.contentWindow,
      data: { jsonrpc: '2.0', method: 'ui/notifications/sandbox-proxy-ready' },
    }));
  });
  await waitFor(() => expect(mockBridges).toHaveLength(expectedBridgeCount));
}

it.each([false, true])('reloads the current resource after teardown without re-running its tool (docked=%s)', async (docked) => {
  const { container, unmount } = render(<McpAppFrame docked={docked} defaultExpanded
    serverName="browser" conversationId={`reload-${docked}`} uri={`ui://browser/reload-${docked}`}
    toolName="browser_open" toolOwnerScope="run:reload" toolResultContent="original result" />);
  await readyLatestProxy(container, 1);
  const previous = mockBridges[0];
  await act(async () => previous.oninitialized?.());
  let finishTeardown!: () => void;
  previous.teardownResource.mockImplementation(() => new Promise<void>(resolve => { finishTeardown = resolve; }));
  const readCount = mockReadResourceFromApp.mock.calls.length;
  const discoveryCount = (global.fetch as jest.Mock).mock.calls.length;
  fireEvent.click(screen.getByRole('button', { name: 'chat.app.reload' }));
  expect(screen.getByRole('button', { name: 'chat.app.reload' })).toBeDisabled();
  await waitFor(() => expect(previous.teardownResource).toHaveBeenCalledTimes(1));
  expect(mockReadResourceFromApp).toHaveBeenCalledTimes(readCount);
  await act(async () => { finishTeardown(); });
  await readyLatestProxy(container, 2);
  await act(async () => { previous.oninitialized?.(); mockBridges[1].oninitialized?.(); });
  await waitFor(() => expect(screen.getByRole('button', { name: 'chat.app.reload' })).toBeEnabled());
  expect(previous.close).toHaveBeenCalledTimes(1);
  expect(mockReadResourceFromApp).toHaveBeenCalledTimes(readCount + 1);
  expect(global.fetch).toHaveBeenCalledTimes(discoveryCount + 1);
  expect(mockCallToolFromApp).not.toHaveBeenCalled();
  expect(previous.sendToolResult).toHaveBeenCalledTimes(1);
  expect(mockBridges[1].sendToolResult).toHaveBeenCalledTimes(1);
  unmount();
});

it('does not recreate the View when it unmounts during reload teardown', async () => {
  const { container, unmount } = render(<McpAppFrame docked serverName="browser"
    conversationId="reload-unmount" uri="ui://browser/reload-unmount" />);
  await readyLatestProxy(container, 1);
  const previous = mockBridges[0];
  await act(async () => previous.oninitialized?.());
  let finishTeardown!: () => void;
  previous.teardownResource.mockImplementation(() => new Promise<void>(resolve => { finishTeardown = resolve; }));
  fireEvent.click(screen.getByRole('button', { name: 'chat.app.reload' }));
  await waitFor(() => expect(previous.teardownResource).toHaveBeenCalledTimes(1));
  const reads = mockReadResourceFromApp.mock.calls.length;
  unmount();
  await act(async () => { finishTeardown(); });
  expect(mockReadResourceFromApp).toHaveBeenCalledTimes(reads);
  expect(mockBridges).toHaveLength(1);
});

it('rebinds same-tool owner changes during initialization and overlapping teardown to the latest run', async () => {
  const props = {
    docked: true, conversationId: 'owner-handshake-conversation', serverName: 'browser',
    uri: 'ui://browser/owner-handshake', toolName: 'browser_open',
    toolResultContent: 'bounded result preview',
  };
  const { container, rerender, unmount } = render(<McpAppFrame {...props} toolOwnerScope="run:first" toolUpdateId="first" />);
  await readyLatestProxy(container, 1);
  const first = mockBridges[0];
  // The first bridge exists, but its App has not sent initialized yet.
  let finishClose!: () => void;
  first.close.mockImplementation(() => new Promise<void>((resolve) => { finishClose = resolve; }));
  rerender(<McpAppFrame {...props} toolOwnerScope="run:second" toolUpdateId="second" />);
  await waitFor(() => expect(first.close).toHaveBeenCalledTimes(1));
  rerender(<McpAppFrame {...props} toolOwnerScope="run:third" toolUpdateId="third" />);
  await act(async () => { finishClose(); });
  await readyLatestProxy(container, 2);

  const current = mockBridges[1];
  await act(async () => { first.oninitialized?.(); current.oninitialized?.(); });
  await waitFor(() => expect(current.sendToolResult).toHaveBeenCalledTimes(1));
  expect(first.sendToolResult).not.toHaveBeenCalled();
  await current.client.request({
    method: 'tools/call',
    params: { name: 'browser_open', arguments: { sessionId: 'third-session' }, ownerScope: 'run:app-forged' },
  });
  expect(mockCallToolFromApp).toHaveBeenLastCalledWith(
    'browser', 'browser_open', { sessionId: 'third-session' }, undefined, undefined, 'run:third',
  );
  unmount();
});
