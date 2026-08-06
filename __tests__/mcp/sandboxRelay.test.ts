import vm from 'node:vm';
import {
  buildSandboxCsp,
  buildSandboxProxyHtml,
  getSandboxAuthToken,
  isSandboxAuthTokenValid,
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
function bootProxy(options: { csp?: Parameters<typeof buildSandboxCsp>[0]; sameOriginView?: boolean } = {}) {
  const html = buildSandboxProxyHtml([], false, options.csp);
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  expect(script).toBeDefined();

  const parentMessages: unknown[] = [];
  const frames: ViewFrame[] = [];
  const parentWindow = { postMessage: (message: unknown) => parentMessages.push(message) };
  let messageHandlers: Array<(event: any) => void> = [];
  const replaceState = jest.fn();

  let createdIframe: ViewFrame | null = null;
  let createElementCalled = false;
  const createElement = (tagName: string): unknown => {
    createElementCalled = true;
    console.log('createElement called with:', tagName);
    if (tagName.toLowerCase() !== 'iframe') {
      return { style: {}, setAttribute: jest.fn() };
    }
    const frame: ViewFrame = {
      attributes: new Map(),
      written: '',
      srcdoc: '',
      messages: [],
      contentWindow: { postMessage: () => undefined },
    };
    frame.contentWindow.postMessage = (message: unknown) => frame.messages.push(message);
    frames.push(frame);
    createdIframe = frame;
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
      onload: null as any,
    };
  };

  const mockDocument = {
    referrer: `${HOST_ORIGIN}/`,
    body: {
      appendChild: (child: any) => {
        console.log('mockDocument.body.appendChild called');
        // Trigger iframe onload if it exists
        if (child && typeof child.onload === 'function') {
          console.log('Triggering iframe.onload from appendChild');
          setTimeout(() => child.onload(), 0);
        }
      }
    },
    createElement,
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
      if (name === 'message') {
        console.log('[TEST] addEventListener called for message');
        messageHandlers.push(handler);
      }
    },
  };
  sandboxWindow.self = sandboxWindow;
  sandboxWindow.document = mockDocument;

  const vmDocument = {
    referrer: `${HOST_ORIGIN}/`,
    body: { 
      appendChild: (child: any) => { 
        console.log('VM document.body.appendChild called'); 
        // The iframe's onload should fire after appendChild
        if (child && child.onload) {
          console.log('Triggering iframe.onload');
          setTimeout(() => child.onload(), 0);
        }
      } 
    },
    createElement: (tagName: string) => {
      console.log('VM document.createElement called with:', tagName);
      const result = createElement(tagName);
      console.log('VM document.createElement returning:', result ? 'object' : 'null');
      return result;
    },
  };
  vm.runInNewContext(script!, {
    URL,
    console,
    document: vmDocument,
    window: sandboxWindow,
  });

  expect(messageHandlers.length).toBeGreaterThan(0);
  console.log('bootProxy: messageHandlers count:', messageHandlers.length, 'frames length:', frames.length);
  return {
    parentMessages,
    frames,
    replaceState,
    view: () => {
      console.log('view() called, frames length:', frames.length);
      return frames[frames.length - 1];
    },
    fromHost: (data: unknown, origin = HOST_ORIGIN) => {
      console.log('fromHost called with:', data);
      console.log('messageHandlers count:', messageHandlers.length);
      const event = { source: parentWindow, origin, data };
      console.log('calling all messageHandlers with event:', event);
      for (const handler of messageHandlers) {
        handler(event);
      }
      console.log('after messageHandler calls');
    },
    fromView: (data: unknown, origin = SANDBOX_ORIGIN) =>
      messageHandlers.forEach(h => h({ source: frames[frames.length - 1].contentWindow, origin, data })),
  };
}

describe('MCP App sandbox proxy relay', () => {
  it('uses a stable high-entropy per-process access token', () => {
    const token = getSandboxAuthToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(getSandboxAuthToken()).toBe(token);
    expect(isSandboxAuthTokenValid(token)).toBe(true);
    expect(isSandboxAuthTokenValid(`${token[0] === 'A' ? 'B' : 'A'}${token.slice(1)}`)).toBe(false);
    expect(isSandboxAuthTokenValid(undefined)).toBe(false);
  });

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
    expect(proxy.parentMessages).toHaveLength(3); // +1 for sandbox-resource-ready loaded
    proxy.fromView({ jsonrpc: '2.0', method: 'ui/initialize', id: 5 }, 'null');
    expect(proxy.parentMessages).toHaveLength(4);
    proxy.fromView({ jsonrpc: '2.0', method: 'ui/initialize', id: 6 }, 'https://evil.example.com');
    expect(proxy.parentMessages).toHaveLength(4);

    proxy.fromView({ jsonrpc: '2.0', method: 'ui/notifications/sandbox-proxy-ready' });
    proxy.fromView({ jsonrpc: '2.0', method: 'ui/notifications/sandbox-resource-ready' });
    proxy.fromView({ jsonrpc: '2.0', method: 'ui/notifications/sandbox-custom' });
    expect(proxy.parentMessages).toHaveLength(4);
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
