import vm from 'node:vm';
import {
  buildSandboxCsp,
  buildSandboxProxyHtml,
  getSandboxAuthToken,
  isSandboxAuthTokenValid,
} from '@/backend/mcpApps/sandboxServer';

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
    const html = buildSandboxProxyHtml([], false, resourceCsp);
    const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
    expect(script).toBeDefined();

    const parentMessages: unknown[] = [];
    const innerMessages: unknown[] = [];
    let srcdoc = '';
    const attributes = new Map<string, string>();
    let messageHandler: ((event: any) => void) | undefined;
    const replaceState = jest.fn();

    const parentWindow = {
      postMessage: (message: unknown) => parentMessages.push(message),
    };
    const innerWindow = {
      postMessage: (message: unknown) => innerMessages.push(message),
    };
    const innerFrame = {
      style: { cssText: '' },
      contentWindow: innerWindow,
      get srcdoc() { return srcdoc; },
      set srcdoc(value: string) { srcdoc = value; },
      setAttribute: (name: string, value: string) => attributes.set(name, value),
    };
    const sandboxWindow: any = {
      parent: parentWindow,
      top: { alert: () => { throw new Error('cross-origin'); } },
      location: {
        href: 'http://127.0.0.1:4201/sandbox.html',
        pathname: '/sandbox.html',
        hostname: '127.0.0.1',
        origin: 'http://127.0.0.1:4201',
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
        referrer: 'http://127.0.0.1:4200/',
        body: { appendChild: jest.fn() },
        createElement: () => innerFrame,
      },
      window: sandboxWindow,
    });

    expect(messageHandler).toBeDefined();
    expect(replaceState).toHaveBeenCalledWith(null, '', '/sandbox.html');
    expect(parentMessages).toEqual([
      {
        jsonrpc: '2.0',
        method: 'ui/notifications/sandbox-proxy-ready',
        params: {},
      },
    ]);
    expect(attributes.get('sandbox')).toBe('allow-scripts');
    expect(attributes.get('sandbox')).not.toContain('allow-same-origin');
    expect(attributes.get('sandbox')).not.toContain('allow-forms');
    expect(attributes.get('referrerpolicy')).toBe('no-referrer');

    const fromHost = (data: unknown) =>
      messageHandler!({
        source: parentWindow,
        origin: 'http://127.0.0.1:4200',
        data,
      });
    const fromApp = (data: unknown) =>
      messageHandler!({
        source: innerWindow,
        origin: 'null',
        data,
      });

    fromHost({ jsonrpc: '2.0', method: 'ping', id: 1 });
    expect(innerMessages).toHaveLength(1);

    fromHost({
      jsonrpc: '2.0',
      method: 'ui/notifications/sandbox-resource-ready',
      params: {
        html: '<!doctype html><title>app</title>',
        sandbox: 'allow-scripts allow-same-origin allow-forms allow-popups',
      },
    });
    const innerPolicy = buildSandboxCsp(resourceCsp);
    const expectedCspMeta =
      `<meta http-equiv="Content-Security-Policy" content="${innerPolicy}">`;
    expect(srcdoc).toBe(`${expectedCspMeta}<!doctype html><title>app</title>`);
    expect(srcdoc.indexOf(expectedCspMeta)).toBe(0);
    expect(innerMessages).toHaveLength(1);
    expect(attributes.get('sandbox')).toBe('allow-scripts');

    fromHost({ jsonrpc: '2.0', method: 'ui/notifications/sandbox-proxy-ready' });
    fromHost({ jsonrpc: '2.0', method: 'ui/notifications/sandbox-custom' });
    expect(innerMessages).toHaveLength(1);

    fromApp({ jsonrpc: '2.0', method: 'ui/initialize', id: 2 });
    expect(parentMessages).toHaveLength(2);

    fromApp({ jsonrpc: '2.0', method: 'ui/notifications/sandbox-proxy-ready' });
    fromApp({ jsonrpc: '2.0', method: 'ui/notifications/sandbox-resource-ready' });
    fromApp({ jsonrpc: '2.0', method: 'ui/notifications/sandbox-custom' });
    expect(parentMessages).toHaveLength(2);
  });
});
