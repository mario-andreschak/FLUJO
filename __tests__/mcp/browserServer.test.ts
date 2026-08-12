import {
  BROWSER_APP_URI,
  browserListResources,
  browserReadResource,
} from '../../mcp-servers/browser/src/resources';
import { shutdownBrowserGateway } from '../../mcp-servers/browser/src/gateway';
import { renderBrowserViewHtml } from '../../mcp-servers/browser/src/viewHtml';
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
const mockLaunchPersistentContext = jest.fn();
jest.mock('patchright', () => ({
  chromium: {
    launch: (...args: unknown[]) => mockLaunchBrowser(...args),
    launchPersistentContext: (...args: unknown[]) => mockLaunchPersistentContext(...args),
  },
}));

describe('bundled browser MCP', () => {
  const managedEnvKeys = [
    'FLUJO_BROWSER_ALLOWED_ORIGINS',
    'FLUJO_BROWSER_ALLOW_PRIVATE_HOSTS',
    'FLUJO_BROWSER_RESTRICT_NAVIGATION',
    'FLUJO_BROWSER_STREAM_ENABLED',
    'FLUJO_BROWSER_MODE',
    'FLUJO_BROWSER_CHANNEL',
    'FLUJO_BROWSER_HEADED',
    'FLUJO_BROWSER_ALLOW_SERVICE_WORKERS',
    'FLUJO_BROWSER_EXECUTABLE_PATH',
    'FLUJO_BROWSER_PROFILE_DIR',
    'FLUJO_BROWSER_LOCALE',
    'FLUJO_BROWSER_TIMEZONE_ID',
    'FLUJO_BROWSER_EXTENSION_DIRS',
    'FLUJO_BROWSER_WINDOW_VISIBILITY',
    'FLUJO_BROWSER_SCREENSHOT_DIR',
  ] as const;
  const previousEnv = new Map(managedEnvKeys.map((key) => [key, process.env[key]]));

  beforeEach(() => {
    for (const key of managedEnvKeys) delete process.env[key];
    // The live view gateway binds a real loopback listener; suites that do not
    // exercise it opt out explicitly.
    process.env.FLUJO_BROWSER_STREAM_ENABLED = '0';
  });

  afterEach(async () => {
    for (const key of managedEnvKeys) {
      const previous = previousEnv.get(key);
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    }
    await shutdownBrowserGateway();
    await shutdownBrowserRuntime();
    mockLaunchBrowser.mockReset();
    mockLaunchPersistentContext.mockReset();
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
      'browser_capture_page',
      'browser_capture_element_metrics',
      'browser_capture_region',
      'browser_record_start',
      'browser_record_stop',
      'browser_record_status',
      'browser_diagnostics',
      'browser_extensions',
      'browser_close',
    ]);
    for (const tool of tools) {
      expect(tool._meta).toMatchObject({
        ui: { resourceUri: BROWSER_APP_URI, visibility: ['model', 'app'] },
      });
      expect((tool.inputSchema.required ?? [])).not.toContain('sessionId');
    }
  });

  it('serves an MCP App shell that grants no origins when streaming is off', async () => {
    expect(browserListResources()).toEqual({
      resources: [expect.objectContaining({
        uri: BROWSER_APP_URI,
        mimeType: 'text/html;profile=mcp-app',
      })],
    });
    const resource = (await browserReadResource(BROWSER_APP_URI)).contents[0];
    expect(resource).toMatchObject({
      uri: BROWSER_APP_URI,
      mimeType: 'text/html;profile=mcp-app',
      _meta: {
        ui: {
          prefersBorder: false,
          csp: { frameDomains: [], connectDomains: [], resourceDomains: [] },
          permissions: {},
        },
      },
    });
    const html = 'text' in resource ? resource.text : '';
    expect(html).toContain('ui/initialize');
    expect(html).toContain('tools/call');
    expect(html).toContain('browser_open');
    expect(html).toContain('availableDisplayModes: ["inline", "fullscreen", "pip"]');
    // Navigation still travels the tool channel so the model observes it.
    expect(html).toContain('browser_navigate');
    const appScript = html.match(/<script>([\s\S]*)<\/script>/)?.[1];
    expect(appScript).toBeDefined();
    expect(() => new Function(appScript!)).not.toThrow();
    await expect(browserReadResource('ui://browser/untrusted')).rejects.toThrow('Unknown browser resource');
  });

  it('ships a parseable live view document with real browser chrome', () => {
    const html = renderBrowserViewHtml();
    for (const marker of ['id="omnibox"', 'id="screen"', 'id="tabs"', 'id="progress"']) {
      expect(html).toContain(marker);
    }
    // The live view must consume the stream and input endpoints directly.
    expect(html).toContain('/stream');
    expect(html).toContain('/events');
    expect(html).toContain('/input');
    // Audio is played by Web Audio in the viewer, not fetched as encoded media.
    expect(html).toContain('/audio');
    expect(html).toContain('createBufferSource');
    expect(html).toContain('id="sound"');
    // No third-party requests may leak the visited hostnames.
    expect(html).not.toContain('google.com');
    const viewScript = html.match(/<script>([\s\S]*)<\/script>/)?.[1];
    expect(viewScript).toBeDefined();
    expect(() => new Function(viewScript!)).not.toThrow();
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
      mainFrame: jest.fn(() => ({})),
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

  it('propagates the useful browser failure after recovery is exhausted', async () => {
    const page = {
      isClosed: jest.fn(() => false),
      mainFrame: jest.fn(() => ({})),
      on: jest.fn(),
      screenshot: jest.fn(async () => { throw new Error('Chromium encoder rejected the requested frame size'); }),
      url: jest.fn(() => 'about:blank'),
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

    await openSession('propagated-error', new AbortController().signal);
    const result = await browserCallTool('browser_screenshot', {}, new AbortController().signal);
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      success: false,
      error: { message: expect.stringContaining('Chromium encoder rejected the requested frame size') },
    });
  });

  it('retries deterministic capture at a safer resolution and reports the recovery', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-capture-recovery-'));
    process.env.FLUJO_BROWSER_SCREENSHOT_DIR = dataDir;
    const png = Buffer.alloc(26);
    Buffer.from('89504e470d0a1a0a', 'hex').copy(png);
    png[25] = 6;
    const page = (fail: boolean) => ({
      evaluate: jest.fn(async () => undefined),
      isClosed: jest.fn(() => false),
      mainFrame: jest.fn(() => ({})),
      on: jest.fn(),
      screenshot: fail
        ? jest.fn(async () => { throw new Error('GPU rejected the 4k capture surface'); })
        : jest.fn(async () => png),
      setContent: jest.fn(async () => undefined),
      setViewportSize: jest.fn(async () => undefined),
      waitForLoadState: jest.fn(async () => undefined),
    });
    const firstPage = page(true);
    const secondPage = page(false);
    const contexts = [firstPage, secondPage].map((currentPage) => ({
      close: jest.fn(async () => undefined),
      newPage: jest.fn(async () => currentPage),
      route: jest.fn(async () => undefined),
    }));
    const newContext = jest.fn()
      .mockResolvedValueOnce(contexts[0])
      .mockResolvedValueOnce(contexts[1]);
    mockLaunchBrowser.mockResolvedValue({
      close: jest.fn(async () => undefined),
      isConnected: jest.fn(() => true),
      newContext,
      once: jest.fn(),
    });

    const result = await browserCallTool(
      'browser_capture_page',
      { source: '<h1>capture</h1>', resolution: '4k' },
      new AbortController().signal,
    );
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      success: true,
      requestedResolution: { width: 3840, height: 2160 },
      effectiveResolution: { width: 1920, height: 1080 },
      attempts: [expect.stringContaining('GPU rejected')],
      warnings: expect.arrayContaining([expect.stringContaining('Capture recovered')]),
    });
    expect(contexts[0].close).toHaveBeenCalled();
    expect(contexts[1].close).toHaveBeenCalled();
    await fs.rm(dataDir, { recursive: true, force: true });
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
          mainFrame: jest.fn(() => ({})),
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

  it('uses installed headed Chrome with a dedicated persistent profile in trusted mode', async () => {
    const profileDir = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-browser-profile-test-'));
    process.env.FLUJO_BROWSER_MODE = 'trusted';
    process.env.FLUJO_BROWSER_CHANNEL = 'chrome';
    process.env.FLUJO_BROWSER_HEADED = '1';
    process.env.FLUJO_BROWSER_ALLOW_SERVICE_WORKERS = '1';
    process.env.FLUJO_BROWSER_PROFILE_DIR = profileDir;
    process.env.FLUJO_BROWSER_LOCALE = 'en-US';
    process.env.FLUJO_BROWSER_TIMEZONE_ID = 'America/Bogota';

    let closed = false;
    const page = {
      close: jest.fn(async () => { closed = true; }),
      evaluate: jest.fn(async () => ({
        userAgent: 'Mozilla/5.0 Chrome/149.0.0.0 Safari/537.36',
        userAgentBrands: [{ brand: 'Google Chrome', version: '149' }],
        webdriver: false,
        language: 'en-US',
        languages: ['en-US'],
        platform: 'Win32',
        timezone: 'America/Bogota',
      })),
      isClosed: jest.fn(() => closed),
      mainFrame: jest.fn(() => ({})),
      on: jest.fn(),
      url: jest.fn(() => 'about:blank'),
    };
    const context = {
      browser: jest.fn(() => ({ version: jest.fn(() => '149.0.0.0') })),
      close: jest.fn(async () => undefined),
      newPage: jest.fn(async () => page),
      once: jest.fn(),
      pages: jest.fn(() => [page]),
      route: jest.fn(async () => undefined),
    };
    mockLaunchPersistentContext.mockResolvedValue(context);

    try {
      const session = await openSession('trusted-session', new AbortController().signal);
      expect(session.mode).toBe('trusted');
      expect(mockLaunchPersistentContext).toHaveBeenCalledWith(
        path.resolve(profileDir),
        expect.objectContaining({
          channel: 'chrome',
          headless: false,
          locale: 'en-US',
          serviceWorkers: 'allow',
          timezoneId: 'America/Bogota',
        }),
      );

      const diagnostics = await browserCallTool(
        'browser_diagnostics',
        { sessionId: session.id },
        new AbortController().signal,
      );
      expect(diagnostics.structuredContent).toMatchObject({
        success: true,
        mode: 'trusted',
        channel: 'chrome',
        headless: false,
        persistentProfile: true,
        fingerprint: { webdriver: false, language: 'en-US' },
      });

      await expect(closeSession(session.id)).resolves.toBe(true);
      expect(page.close).toHaveBeenCalledTimes(1);
      expect(context.close).not.toHaveBeenCalled();
    } finally {
      await fs.rm(profileDir, { recursive: true, force: true });
    }
  });

  it('classifies destination challenges separately from FLUJO policy blocks', async () => {
    process.env.FLUJO_BROWSER_ALLOW_PRIVATE_HOSTS = '1';
    const response = { status: jest.fn(() => 200) };
    const page = {
      goto: jest.fn(async () => response),
      isClosed: jest.fn(() => false),
      locator: jest.fn(() => ({ innerText: jest.fn(async () => 'Unsere Systeme haben ungewöhnlichen Datenverkehr festgestellt') })),
      mainFrame: jest.fn(() => ({})),
      on: jest.fn(),
      title: jest.fn(async () => 'https://www.google.com/search?q=test'),
      url: jest.fn(() => 'https://www.google.com/sorry/index'),
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
      version: jest.fn(() => '149.0.0.0'),
    });
    const session = await openSession('classification-session', new AbortController().signal);

    const siteResult = await browserCallTool(
      'browser_navigate',
      { sessionId: session.id, url: 'https://example.com/' },
      new AbortController().signal,
    );
    expect(siteResult.structuredContent).toMatchObject({
      success: true,
      navigation: { classification: 'site', blocked: true, status: 200 },
    });

    process.env.FLUJO_BROWSER_ALLOW_PRIVATE_HOSTS = '0';
    process.env.FLUJO_BROWSER_RESTRICT_NAVIGATION = '1';
    const policyResult = await browserCallTool(
      'browser_navigate',
      { sessionId: session.id, url: 'http://127.0.0.1:4200/' },
      new AbortController().signal,
    );
    expect(policyResult.structuredContent).toMatchObject({
      success: false,
      error: { code: 'NAVIGATION_BLOCKED', category: 'policy' },
    });
  });

  it('loads only explicitly allowlisted unpacked extensions and can hide headed Chrome off-screen', async () => {
    const extensionDir = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-browser-extension-test-'));
    const profileDir = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-browser-extension-profile-'));
    await fs.writeFile(path.join(extensionDir, 'manifest.json'), JSON.stringify({
      manifest_version: 3,
      name: 'FLUJO test extension',
      version: '1.0.0',
      background: { service_worker: 'worker.js' },
    }));
    process.env.FLUJO_BROWSER_MODE = 'trusted';
    process.env.FLUJO_BROWSER_CHANNEL = 'chromium';
    process.env.FLUJO_BROWSER_EXTENSION_DIRS = extensionDir;
    process.env.FLUJO_BROWSER_PROFILE_DIR = profileDir;
    process.env.FLUJO_BROWSER_WINDOW_VISIBILITY = 'offscreen';

    const page = {
      close: jest.fn(async () => undefined),
      isClosed: jest.fn(() => false),
      mainFrame: jest.fn(() => ({})),
      on: jest.fn(),
      url: jest.fn(() => 'about:blank'),
    };
    const context = {
      backgroundPages: jest.fn(() => []),
      browser: jest.fn(() => ({ version: jest.fn(() => '149.0.0.0') })),
      close: jest.fn(async () => undefined),
      newPage: jest.fn(async () => page),
      once: jest.fn(),
      pages: jest.fn(() => [page]),
      route: jest.fn(async () => undefined),
      serviceWorkers: jest.fn(() => [{
        url: () => 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/worker.js',
      }]),
    };
    mockLaunchPersistentContext.mockResolvedValue(context);

    try {
      await openSession('extension-session', new AbortController().signal);
      const options = mockLaunchPersistentContext.mock.calls[0][1] as { args: string[]; channel: string };
      expect(options.channel).toBe('chromium');
      expect(options.args).toEqual(expect.arrayContaining([
        '--window-position=-32000,-32000',
        `--disable-extensions-except=${await fs.realpath(extensionDir)}`,
        `--load-extension=${await fs.realpath(extensionDir)}`,
      ]));

      const result = await browserCallTool('browser_extensions', {}, new AbortController().signal);
      expect(result.structuredContent).toMatchObject({
        success: true,
        configuredUnpacked: [{ name: 'FLUJO test extension', version: '1.0.0' }],
        activeExtensionIds: ['aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'],
      });
    } finally {
      await fs.rm(extensionDir, { recursive: true, force: true });
      await fs.rm(profileDir, { recursive: true, force: true });
    }
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
      mainFrame: jest.fn(() => ({})),
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

  it('accepts local files and friendly bare targets while rejecting executable schemes and URL credentials', async () => {
    await expect(assertNavigationAllowed(path.resolve('package.json'))).resolves.toMatchObject({ protocol: 'file:' });
    await expect(assertNavigationAllowed('localhost:4200/app')).resolves.toMatchObject({
      protocol: 'http:', hostname: 'localhost',
    });
    await expect(assertNavigationAllowed('192.168.1.20:3000/app')).resolves.toMatchObject({
      protocol: 'http:', hostname: '192.168.1.20',
    });
    await expect(assertNavigationAllowed('example.com/docs')).resolves.toMatchObject({
      protocol: 'https:', hostname: 'example.com',
    });
    await expect(assertNavigationAllowed('javascript:alert(1)')).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
    await expect(assertNavigationAllowed('https://user:secret@example.com/')).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
  });

  it('allows private destinations by default and supports an explicit restricted deployment mode', async () => {
    await expect(assertNavigationAllowed('http://127.0.0.1:4200/')).resolves.toMatchObject({
      hostname: '127.0.0.1',
    });
    process.env.FLUJO_BROWSER_RESTRICT_NAVIGATION = '1';
    for (const setting of ['0', 'false', 'no', 'off']) {
      process.env.FLUJO_BROWSER_ALLOW_PRIVATE_HOSTS = setting;
      await expect(assertNavigationAllowed('http://127.0.0.1:4200/')).rejects.toMatchObject({
        code: 'NAVIGATION_BLOCKED',
      });
    }
  });

  it('enforces exact configured origins and clamps timeouts', async () => {
    process.env.FLUJO_BROWSER_RESTRICT_NAVIGATION = '1';
    process.env.FLUJO_BROWSER_ALLOWED_ORIGINS = 'https://allowed.example';
    await expect(assertNavigationAllowed('https://other.example/path')).rejects.toBeInstanceOf(BrowserMcpError);
    await expect(assertNavigationAllowed('https://allowed.example/path')).resolves.toMatchObject({
      origin: 'https://allowed.example',
    });
    expect(timeoutMs(1)).toBe(1_000);
    expect(timeoutMs(500_000)).toBe(60_000);
    expect(timeoutMs('slow')).toBe(30_000);
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
      mainFrame: jest.fn(() => ({})),
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
