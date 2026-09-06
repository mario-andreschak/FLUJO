import React from 'react';
import { act, render, waitFor } from '@testing-library/react';
import McpAppFrame from '@/frontend/components/Chat/McpAppFrame';
import { TextDecoder, TextEncoder } from 'util';

Object.assign(globalThis, { TextDecoder, TextEncoder });

interface BridgeFixture {
  client: { request: (request: unknown) => Promise<unknown> };
  oninitialized?: () => void;
  close: jest.Mock;
  sendToolResult: jest.Mock;
}
const mockBridges: BridgeFixture[] = [];
const mockCallToolFromApp = jest.fn(async () => ({ success: true, data: { content: [] } }));

jest.mock('@/frontend/contexts/I18nContext', () => {
  const t = (key: string) => key;
  return { useI18n: () => ({ t }) };
});
jest.mock('@/frontend/contexts/StorageContext', () => ({ useStorage: () => ({ settings: {}, settingsHydrated: true }) }));
jest.mock('@/frontend/services/mcp', () => ({
  mcpService: {
    readResourceFromApp: async (_server: string, uri: string) => ({
      success: true, data: { contents: [{ uri, mimeType: 'text/html;profile=mcp-app', text: '<p>Browser</p>' }] },
    }),
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
  global.fetch = jest.fn(async () => ({
    ok: true,
    json: async () => ({ shared: false, originKey, token: 'test-token', url: `${sandboxOrigin}/sandbox.html` }),
  } as Response));
});
afterEach(() => { global.fetch = originalFetch; });

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
