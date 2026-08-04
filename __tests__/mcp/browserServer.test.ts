import {
  BROWSER_APP_URI,
  browserListResources,
  browserReadResource,
} from '../../mcp-servers/browser/src/resources';
import { browserCallTool, browserToolDefinitions } from '../../mcp-servers/browser/src/tools';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  BrowserMcpError,
  assertNavigationAllowed,
  closeSession,
  getSession,
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
      'browser_back',
      'browser_forward',
      'browser_reload',
      'browser_snapshot',
      'browser_click',
      'browser_type',
      'browser_press',
      'browser_scroll',
      'browser_screenshot',
      'browser_close',
    ]);
    for (const tool of tools) {
      expect(tool._meta).toMatchObject({
        ui: { resourceUri: BROWSER_APP_URI, visibility: ['model', 'app'] },
      });
      expect((tool.inputSchema.required ?? [])).not.toContain('sessionId');
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
    const html = 'text' in resource ? resource.text : '';
    expect(html).toContain('ui/initialize');
    expect(html).toContain('tools/call');
    expect(html).toContain('browser_scroll');
    expect(html).toContain('browser_press');
    const appScript = html.match(/<script>([\s\S]*)<\/script>/)?.[1];
    expect(appScript).toBeDefined();
    expect(() => new Function(appScript!)).not.toThrow();
    expect(() => browserReadResource('ui://browser/untrusted')).toThrow('Unknown browser resource');
  });

  it('persists screenshots and reports their full absolute file path', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-browser-screenshot-test-'));
    const previousDataDir = process.env.FLUJO_DATA_DIR;
    process.env.FLUJO_DATA_DIR = dataDir;
    const png = Buffer.from('png screenshot bytes');
    const page = {
      isClosed: jest.fn(() => false),
      locator: jest.fn(() => ({ innerText: jest.fn(async () => '') })),
      on: jest.fn(),
      screenshot: jest.fn(async () => png),
      title: jest.fn(async () => 'Screenshot test'),
      url: jest.fn(() => 'https://example.com/'),
      viewportSize: jest.fn(() => ({ width: 1280, height: 720 })),
    };
    const context = {
      close: jest.fn(async () => undefined),
      newPage: jest.fn(async () => page),
      route: jest.fn(async () => undefined),
    };
    mockLaunchBrowser.mockResolvedValue({
      close: jest.fn(async () => undefined),
      isConnected: jest.fn(() => true),
      newContext: jest.fn(async () => context),
      once: jest.fn(),
    });

    try {
      const opened = await openSession('screenshot-session', new AbortController().signal);
      expect(opened.id).toBe('screenshot-session');
      const result = await browserCallTool(
        'browser_screenshot',
        {},
        new AbortController().signal,
      );
      const structured = result.structuredContent as { path?: string };
      expect(path.isAbsolute(structured.path ?? '')).toBe(true);
      expect(structured.path).toBe(path.join(
        path.resolve(dataDir),
        'screenshots',
        'browser',
        opened.id,
        'viewport.png',
      ));
      await expect(fs.readFile(structured.path!)).resolves.toEqual(png);
      expect(JSON.parse((result.content[0] as { text: string }).text).path).toBe(structured.path);

      const fullPageResult = await browserCallTool(
        'browser_screenshot',
        { fullPage: true },
        new AbortController().signal,
      );
      const fullPagePath = (fullPageResult.structuredContent as { path: string }).path;
      expect(path.isAbsolute(fullPagePath)).toBe(true);
      expect(fullPagePath).toBe(path.join(path.dirname(structured.path!), 'full-page.png'));
      await expect(fs.readFile(fullPagePath)).resolves.toEqual(png);
    } finally {
      if (previousDataDir === undefined) delete process.env.FLUJO_DATA_DIR;
      else process.env.FLUJO_DATA_DIR = previousDataDir;
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  it('reuses the most recently used live session when sessionId is omitted', async () => {
    const contexts: Array<{ close: jest.Mock }> = [];
    mockLaunchBrowser.mockResolvedValue({
      close: jest.fn(async () => undefined),
      isConnected: jest.fn(() => true),
      newContext: jest.fn(async () => {
        const page = {
          isClosed: jest.fn(() => false),
          on: jest.fn(),
          url: jest.fn(() => 'about:blank'),
        };
        const context = {
          close: jest.fn(async () => undefined),
          newPage: jest.fn(async () => page),
          route: jest.fn(async () => undefined),
        };
        contexts.push(context);
        return context;
      }),
      once: jest.fn(),
    });

    const first = await openSession('first-session', new AbortController().signal);
    const second = await openSession('second-session', new AbortController().signal);
    expect(getSession(undefined).id).toBe(second.id);
    await expect(openSession(undefined, new AbortController().signal)).resolves.toBe(second);

    expect(getSession(first.id)).toBe(first);
    await expect(openSession(undefined, new AbortController().signal)).resolves.toBe(first);
    await expect(closeSession(undefined)).resolves.toBe(true);
    expect(contexts[0].close).toHaveBeenCalledTimes(1);
    expect(getSession(undefined).id).toBe(second.id);
    await expect(closeSession(undefined)).resolves.toBe(true);
    const closedAgain = await browserCallTool('browser_close', {}, new AbortController().signal);
    expect(closedAgain.structuredContent).toEqual({ success: true, sessionId: null, closed: false });
  });

  it('drives pointer, keyboard, scroll, and history interactions used by the MCP App', async () => {
    const mouse = { click: jest.fn(async () => undefined), wheel: jest.fn(async () => undefined) };
    const keyboard = { insertText: jest.fn(async () => undefined), press: jest.fn(async () => undefined) };
    const page = {
      goBack: jest.fn(async () => null),
      goForward: jest.fn(async () => null),
      isClosed: jest.fn(() => false),
      keyboard,
      locator: jest.fn(() => ({ innerText: jest.fn(async () => 'body') })),
      mouse,
      on: jest.fn(),
      reload: jest.fn(async () => null),
      title: jest.fn(async () => 'Interactive test'),
      url: jest.fn(() => 'https://example.com/'),
      viewportSize: jest.fn(() => ({ width: 1280, height: 720 })),
      waitForLoadState: jest.fn(async () => undefined),
    };
    const context = {
      close: jest.fn(async () => undefined),
      newPage: jest.fn(async () => page),
      route: jest.fn(async () => undefined),
    };
    mockLaunchBrowser.mockResolvedValue({
      close: jest.fn(async () => undefined),
      isConnected: jest.fn(() => true),
      newContext: jest.fn(async () => context),
      once: jest.fn(),
    });
    const session = await openSession('interactive-session', new AbortController().signal);
    const call = (name: string, args: Record<string, unknown>) => browserCallTool(
      name,
      { sessionId: session.id, ...args },
      new AbortController().signal,
    );

    const results = await Promise.all([
      call('browser_click', { x: 320, y: 180 }),
      call('browser_type', { text: 'hello' }),
      call('browser_press', { key: 'Enter' }),
      call('browser_scroll', { deltaY: 400 }),
      call('browser_back', {}),
      call('browser_forward', {}),
      call('browser_reload', {}),
    ]);
    for (const result of results) expect(result.structuredContent).toMatchObject({ success: true });

    expect(mouse.click).toHaveBeenCalledWith(320, 180, { button: 'left', clickCount: 1 });
    expect(mouse.wheel).toHaveBeenCalledWith(0, 400);
    expect(keyboard.insertText).toHaveBeenCalledWith('hello');
    expect(keyboard.press).toHaveBeenCalledWith('Enter');
    expect(page.goBack).toHaveBeenCalled();
    expect(page.goForward).toHaveBeenCalled();
    expect(page.reload).toHaveBeenCalled();
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
    };

    for (const descriptor of SHIPPED_MCP_SERVERS) {
      expect(createShippedServerConfig(descriptor, env).enableMcpApps).toBe(
        descriptor.enableMcpApps ?? false,
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
    let markNewPageStarted: () => void = () => undefined;
    const newPageStarted = new Promise<void>((resolve) => {
      markNewPageStarted = resolve;
    });
    const pendingPage = new Promise<never>((_resolve, reject) => {
      rejectNewPage = reject;
    });
    const closeContext = jest.fn(async () => {
      rejectNewPage(new Error('context closed'));
    });
    const context = {
      close: closeContext,
      newPage: jest.fn(() => {
        markNewPageStarted();
        return pendingPage;
      }),
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
    const cancelledOpening = expect(opening).rejects.toMatchObject({ code: 'CANCELLED' });
    await newPageStarted;
    controller.abort();

    await cancelledOpening;
    expect(closeContext).toHaveBeenCalledTimes(1);
  });
});
