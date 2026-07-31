import {
  BROWSER_APP_URI,
  browserListResources,
  browserReadResource,
} from '../../mcp-servers/browser/src/resources';
import { browserToolDefinitions } from '../../mcp-servers/browser/src/tools';
import { BrowserMcpError, assertNavigationAllowed, timeoutMs } from '../../mcp-servers/browser/src/runtime';

describe('bundled browser MCP', () => {
  const previousOrigins = process.env.FLUJO_BROWSER_ALLOWED_ORIGINS;
  const previousPrivate = process.env.FLUJO_BROWSER_ALLOW_PRIVATE_HOSTS;

  afterEach(() => {
    if (previousOrigins === undefined) delete process.env.FLUJO_BROWSER_ALLOWED_ORIGINS;
    else process.env.FLUJO_BROWSER_ALLOWED_ORIGINS = previousOrigins;
    if (previousPrivate === undefined) delete process.env.FLUJO_BROWSER_ALLOW_PRIVATE_HOSTS;
    else process.env.FLUJO_BROWSER_ALLOW_PRIVATE_HOSTS = previousPrivate;
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
});
