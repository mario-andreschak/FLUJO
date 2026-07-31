import {
  BROWSER_APP_URI,
  browserListResources,
  browserReadResource,
} from '../../mcp-servers/browser/src/resources';
import { browserToolDefinitions } from '../../mcp-servers/browser/src/tools';
import {
  BrowserMcpError,
  assertNavigationAllowed,
  openSession,
  runCancellable,
  shutdownBrowserRuntime,
  timeoutMs,
} from '../../mcp-servers/browser/src/runtime';
import {
  SHIPPED_MCP_SERVERS,
  createShippedServerConfig,
} from '../../src/backend/services/mcp/shippedServers';

const mockLaunchBrowser = jest.fn();
jest.mock('patchright', () => ({
  chromium: { launch: (...args: unknown[]) => mockLaunchBrowser(...args) },
}));

describe('bundled browser MCP', () => {
  const previousOrigins = process.env.FLUJO_BROWSER_ALLOWED_ORIGINS;
  const previousPrivate = process.env.FLUJO_BROWSER_ALLOW_PRIVATE_HOSTS;

  afterEach(async () => {
    if (previousOrigins === undefined) delete process.env.FLUJO_BROWSER_ALLOWED_ORIGINS;
    else process.env.FLUJO_BROWSER_ALLOWED_ORIGINS = previousOrigins;
    if (previousPrivate === undefined) delete process.env.FLUJO_BROWSER_ALLOW_PRIVATE_HOSTS;
    else process.env.FLUJO_BROWSER_ALLOW_PRIVATE_HOSTS = previousPrivate;
    await shutdownBrowserRuntime();
    mockLaunchBrowser.mockReset();
  });

  it('advertises a stable MCP Apps resource on every browser tool', () => {
    const tools = browserToolDefinitions();
    expect(tools.map(({ name }) => name)).toEqual([
      'browser_open',
      'browser_navigate',
      'browser_snapshot',
      'browser_click',
      'browser_type',
      'browser_screenshot',
      'browser_close',
    ]);
    for (const tool of tools) {
      expect(tool._meta).toMatchObject({
        ui: { resourceUri: BROWSER_APP_URI, visibility: ['model', 'app'] },
      });
    }
  });

  it('serves a self-contained MCP App with restrictive resource metadata', () => {
    expect(browserListResources()).toEqual({
      resources: [expect.objectContaining({
        uri: BROWSER_APP_URI,
        mimeType: 'text/html;profile=mcp-app',
      })],
    });
    const resource = browserReadResource(BROWSER_APP_URI).contents[0];
    expect(resource).toMatchObject({
      uri: BROWSER_APP_URI,
      mimeType: 'text/html;profile=mcp-app',
      _meta: { ui: { csp: { connectDomains: [], resourceDomains: [] }, permissions: {} } },
    });
    expect('text' in resource ? resource.text : '').toContain('ui/initialize');
    expect('text' in resource ? resource.text : '').toContain('tools/call');
    expect(() => browserReadResource('ui://browser/untrusted')).toThrow('Unknown browser resource');
  });

  it('rejects unsafe schemes, URL credentials, and private destinations', async () => {
    await expect(assertNavigationAllowed('file:///etc/passwd')).rejects.toMatchObject({
      code: 'NAVIGATION_BLOCKED',
    });
    await expect(assertNavigationAllowed('https://user:secret@example.com/')).rejects.toMatchObject({
      code: 'NAVIGATION_BLOCKED',
    });
    await expect(assertNavigationAllowed('http://127.0.0.1:4200/')).rejects.toMatchObject({
      code: 'NAVIGATION_BLOCKED',
    });
  });

  it('enforces exact configured origins and clamps timeouts', async () => {
    process.env.FLUJO_BROWSER_ALLOWED_ORIGINS = 'https://allowed.example';
    process.env.FLUJO_BROWSER_ALLOW_PRIVATE_HOSTS = '1';
    await expect(assertNavigationAllowed('https://other.example/path')).rejects.toBeInstanceOf(BrowserMcpError);
    await expect(assertNavigationAllowed('https://allowed.example/path')).resolves.toMatchObject({
      origin: 'https://allowed.example',
    });
    expect(timeoutMs(1)).toBe(1_000);
    expect(timeoutMs(500_000)).toBe(60_000);
    expect(() => timeoutMs('slow')).toThrow('timeoutMs must be a finite number');
  });

  it('enables MCP Apps only for the shipped browser record', () => {
    const env = {
      FLUJO_APP_ROOT: process.cwd(),
      FLUJO_BROWSER_ENABLED: '1',
    } as NodeJS.ProcessEnv;

    for (const descriptor of SHIPPED_MCP_SERVERS) {
      expect(createShippedServerConfig(descriptor, env).enableMcpApps).toBe(
        descriptor.defaultName === 'browser',
      );
    }
  });

  it('closes an active session when its operation is cancelled', async () => {
    const closeContext = jest.fn(async () => undefined);
    const page = {
      on: jest.fn(),
      url: jest.fn(() => 'about:blank'),
    };
    const context = {
      close: closeContext,
      newPage: jest.fn(async () => page),
      route: jest.fn(async () => undefined),
    };
    const fakeBrowser = {
      close: jest.fn(async () => undefined),
      isConnected: jest.fn(() => true),
      newContext: jest.fn(async () => context),
      once: jest.fn(),
    };
    mockLaunchBrowser.mockResolvedValue(fakeBrowser);
    const session = await openSession('cancelled-operation', new AbortController().signal);
    const controller = new AbortController();

    const operation = runCancellable(
      session,
      controller.signal,
      () => new Promise<never>(() => undefined),
    );
    controller.abort();

    await expect(operation).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(closeContext).toHaveBeenCalledTimes(1);
  });

  it('closes a partially created context when session opening is cancelled', async () => {
    const controller = new AbortController();
    let rejectNewPage: (reason?: unknown) => void = () => undefined;
    const pendingPage = new Promise<never>((_resolve, reject) => {
      rejectNewPage = reject;
    });
    const closeContext = jest.fn(async () => {
      rejectNewPage(new Error('context closed'));
    });
    const context = {
      close: closeContext,
      newPage: jest.fn(() => pendingPage),
      route: jest.fn(),
    };
    const fakeBrowser = {
      close: jest.fn(async () => undefined),
      isConnected: jest.fn(() => true),
      newContext: jest.fn(async () => context),
      once: jest.fn(),
    };
    mockLaunchBrowser.mockResolvedValue(fakeBrowser);

    const opening = openSession('cancelled-open', controller.signal);
    while (context.newPage.mock.calls.length === 0) await Promise.resolve();
    controller.abort();

    await expect(opening).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(closeContext).toHaveBeenCalledTimes(1);
  });
});
