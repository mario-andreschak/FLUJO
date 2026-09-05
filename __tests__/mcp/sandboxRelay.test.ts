import vm from 'node:vm';
import {
  buildSandboxCsp,
  buildSandboxProxyHtml,
} from '@/backend/mcpApps/sandboxServer';
import { MCP_APP_IFRAME_SANDBOX } from '@/shared/utils/mcpApps';

const HOST_ORIGIN = 'http://127.0.0.1:4200';
const SANDBOX_ORIGIN = 'http://127.0.0.1:4201';

interface ViewFrame {
  attributes: Map<string, string>;
  written: string;
  srcdoc: string;
  contentWindow: { postMessage: (message: unknown) => void };
  messages: unknown[];
}

/**
 * Boot the inlined proxy script in a VM with a minimal DOM, exposing the frames
 * it creates plus hooks to drive host/View messages through the relay.
 */
function bootProxy(options: {
  csp?: Parameters<typeof buildSandboxCsp>[0];
  sameOriginView?: boolean;
  allowAll?: boolean;
  hostOrigin?: string;
} = {}) {
  const hostOrigin = options.hostOrigin ?? HOST_ORIGIN;
  const html = buildSandboxProxyHtml([], false, options.csp, options.allowAll);
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  expect(script).toBeDefined();

  const parentMessages: unknown[] = [];
  const parentTargetOrigins: string[] = [];
  const frames: ViewFrame[] = [];
  const parentWindow = {
    postMessage: (message: unknown, targetOrigin: string) => {
      parentMessages.push(message);
      parentTargetOrigins.push(targetOrigin);
    },
  };
  let messageHandler: ((event: any) => void) | undefined;
  const replaceState = jest.fn();

  const createElement = (): unknown => {
    const frame: ViewFrame = {
      attributes: new Map(),
      written: '',
      srcdoc: '',
      messages: [],
      contentWindow: { postMessage: () => undefined },
    };
    frame.contentWindow.postMessage = (message: unknown) => frame.messages.push(message);
    frames.push(frame);
    const doc = {
      open: jest.fn(),
      write: (value: string) => { frame.written += value; },
      close: jest.fn(),
    };
    return {
      style: { cssText: '' },
      setAttribute: (name: string, value: string) => frame.attributes.set(name, value),
      contentWindow: frame.contentWindow,
      contentDocument: options.sameOriginView === false ? null : doc,
      get srcdoc() { return frame.srcdoc; },
      set srcdoc(value: string) { frame.srcdoc = value; },
    };
  };

  const sandboxWindow: any = {
    parent: parentWindow,
    top: { alert: () => { throw new Error('cross-origin'); } },
    location: {
      href: `${SANDBOX_ORIGIN}/sandbox.html`,
      pathname: '/sandbox.html',
      hostname: '127.0.0.1',
      origin: SANDBOX_ORIGIN,
    },
    history: { replaceState },
    addEventListener: (name: string, handler: (event: any) => void) => {
      if (name === 'message') messageHandler = handler;
    },
  };
  sandboxWindow.self = sandboxWindow;

  vm.runInNewContext(script!, {
    URL,
    console,
    document: {
      referrer: `${hostOrigin}/`,
      body: { appendChild: jest.fn() },
      createElement,
    },
    window: sandboxWindow,
  });

  expect(messageHandler).toBeDefined();
  return {
    parentMessages,
    parentTargetOrigins,
    frames,
    replaceState,
    view: () => frames[frames.length - 1],
    fromHost: (data: unknown, origin = hostOrigin) =>
      messageHandler!({ source: parentWindow, origin, data }),
    fromOtherWindow: (data: unknown, origin = hostOrigin) =>
      messageHandler!({ source: {}, origin, data }),
    fromView: (data: unknown, origin = SANDBOX_ORIGIN) =>
      messageHandler!({ source: frames[frames.length - 1].contentWindow, origin, data }),
  };
}

describe('MCP App sandbox proxy relay', () => {
  it.each([HOST_ORIGIN, 'https://hosted.example.com'])(
    'loads and relays the View with allow-all enabled for %s',
    (hostOrigin) => {
      const proxy = bootProxy({ allowAll: true, hostOrigin });
      const resourceReady = {
        jsonrpc: '2.0',
        method: 'ui/notifications/sandbox-resource-ready',
        params: { html: '<title>app</title>' },
      };

      // Allow-all relaxes the origin policy, never the parent Window check.
      proxy.fromOtherWindow(resourceReady);
      expect(proxy.frames).toHaveLength(0);
      proxy.fromHost(resourceReady);
      expect(proxy.frames).toHaveLength(1);
      expect(proxy.view().written).toContain('<title>app</title>');

      const initialize = { jsonrpc: '2.0', method: 'ui/initialize', id: 1 };
      proxy.fromView(initialize);
      expect(proxy.parentMessages).toHaveLength(2);
      expect(proxy.parentMessages[1]).toEqual(initialize);
      expect(proxy.parentTargetOrigins).toEqual(['*', '*']);

      const response = { jsonrpc: '2.0', id: 1, result: {} };
      proxy.fromHost(response);
      expect(proxy.view().messages).toEqual([response]);

      proxy.fromOtherWindow(response);
      proxy.fromHost({ jsonrpc: '2.0', method: 'ui/notifications/sandbox-custom' });
      proxy.fromView(resourceReady);
      proxy.fromView(initialize, 'https://unrelated.example.com');
      expect(proxy.view().messages).toEqual([response]);
      expect(proxy.parentMessages).toHaveLength(2);
    },
  );

  it('consumes host resource-ready and blocks every other reserved sandbox message', () => {
    const resourceCsp = {
      connectDomains: ['https://api.example.com'],
      frameDomains: ['https://embed.example.com'],
    };
    const proxy = bootProxy({ csp: resourceCsp });

    expect(proxy.replaceState).toHaveBeenCalledWith(null, '', '/sandbox.html');
    expect(proxy.parentMessages).toEqual([
      {
        jsonrpc: '2.0',
        method: 'ui/notifications/sandbox-proxy-ready',
        params: {},
      },
    ]);
    // No View exists before the host delivers a resource, so nothing can be
    // forwarded into one (the spec forbids the host sending first anyway).
    expect(proxy.frames).toHaveLength(0);
    proxy.fromHost({ jsonrpc: '2.0', method: 'ping', id: 1 });
    expect(proxy.frames).toHaveLength(0);

    proxy.fromHost({
      jsonrpc: '2.0',
      method: 'ui/notifications/sandbox-resource-ready',
      params: {
        html: '<!doctype html><title>app</title>',
        permissions: { clipboardWrite: {} },
      },
    });

    expect(proxy.frames).toHaveLength(1);
    const view = proxy.view();
    // Reference-host View policy: same-origin with this throwaway proxy origin,
    // never with FLUJO. Downloads/popups stay host-mediated.
    expect(view.attributes.get('sandbox')).toBe(MCP_APP_IFRAME_SANDBOX);
    expect(view.attributes.get('sandbox')).toBe('allow-scripts allow-same-origin allow-forms');
    expect(view.attributes.get('sandbox')).not.toContain('allow-downloads');
    expect(view.attributes.get('sandbox')).not.toContain('allow-popups');
    expect(view.attributes.get('referrerpolicy')).toBe('no-referrer');
    expect(view.attributes.get('allow')).toBe('clipboard-write');

    // The View is written into the frame (not srcdoc), CSP meta first.
    const expectedCspMeta =
      `<meta http-equiv="Content-Security-Policy" content="${buildSandboxCsp(resourceCsp)}">`;
    expect(view.written).toBe(`${expectedCspMeta}<!doctype html><title>app</title>`);
    expect(view.written.indexOf(expectedCspMeta)).toBe(0);
    expect(view.srcdoc).toBe('');

    // Host → View relay, and reserved sandbox-* messages are never forwarded.
    proxy.fromHost({ jsonrpc: '2.0', method: 'ping', id: 2 });
    expect(view.messages).toHaveLength(1);
    proxy.fromHost({ jsonrpc: '2.0', method: 'ui/notifications/sandbox-proxy-ready' });
    proxy.fromHost({ jsonrpc: '2.0', method: 'ui/notifications/sandbox-custom' });
    expect(view.messages).toHaveLength(1);
    proxy.fromHost({ jsonrpc: '2.0', method: 'ping', id: 3 }, 'http://evil.example.com');
    expect(view.messages).toHaveLength(1);

    // View → Host relay: the View now speaks from the sandbox origin.
    proxy.fromView({ jsonrpc: '2.0', method: 'ui/initialize', id: 4 });
    expect(proxy.parentMessages).toHaveLength(2);
    proxy.fromView({ jsonrpc: '2.0', method: 'ui/initialize', id: 5 }, 'null');
    expect(proxy.parentMessages).toHaveLength(3);
    proxy.fromView({ jsonrpc: '2.0', method: 'ui/initialize', id: 6 }, 'https://evil.example.com');
    expect(proxy.parentMessages).toHaveLength(3);

    proxy.fromView({ jsonrpc: '2.0', method: 'ui/notifications/sandbox-proxy-ready' });
    proxy.fromView({ jsonrpc: '2.0', method: 'ui/notifications/sandbox-resource-ready' });
    proxy.fromView({ jsonrpc: '2.0', method: 'ui/notifications/sandbox-custom' });
    expect(proxy.parentMessages).toHaveLength(3);
  });

  it('lets a host sandbox override narrow the View policy but never widen it', () => {
    const proxy = bootProxy();
    const ready = (sandbox: unknown) => proxy.fromHost({
      jsonrpc: '2.0',
      method: 'ui/notifications/sandbox-resource-ready',
      params: { html: '<title>app</title>', sandbox },
    });

    ready('allow-scripts allow-same-origin allow-forms allow-popups allow-downloads allow-top-navigation');
    expect(proxy.view().attributes.get('sandbox')).toBe('allow-scripts allow-same-origin allow-forms');

    ready('allow-scripts');
    expect(proxy.view().attributes.get('sandbox')).toBe('allow-scripts');

    ready('ALLOW-SCRIPTS   allow-scripts');
    expect(proxy.view().attributes.get('sandbox')).toBe('allow-scripts');

    // A View without scripts cannot run the bridge, so it gets no privileges.
    ready('allow-same-origin allow-forms');
    expect(proxy.view().attributes.get('sandbox')).toBe('');

    // A non-string override falls back to the default policy.
    ready(undefined);
    expect(proxy.view().attributes.get('sandbox')).toBe(MCP_APP_IFRAME_SANDBOX);
    expect(proxy.frames).toHaveLength(5);
  });

  it('falls back to srcdoc when the View document is unreachable', () => {
    const proxy = bootProxy({ sameOriginView: false });
    proxy.fromHost({
      jsonrpc: '2.0',
      method: 'ui/notifications/sandbox-resource-ready',
      params: { html: '<title>app</title>', sandbox: 'allow-scripts' },
    });
    const view = proxy.view();
    expect(view.written).toBe('');
    expect(view.srcdoc).toContain('Content-Security-Policy');
    expect(view.srcdoc.endsWith('<title>app</title>')).toBe(true);
  });
});
