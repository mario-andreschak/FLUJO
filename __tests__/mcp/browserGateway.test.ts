import {
  browserAudioStreamEnabled,
  browserGatewayEndpoint,
  ensureBrowserGateway,
  shutdownBrowserGateway,
} from '../../mcp-servers/browser/src/gateway';
import { audioTapSource } from '../../mcp-servers/browser/src/audioTap';
import { BROWSER_APP_URI, browserReadResource } from '../../mcp-servers/browser/src/resources';

const mockLaunchBrowser = jest.fn();
jest.mock('patchright', () => ({
  chromium: { launch: (...args: unknown[]) => mockLaunchBrowser(...args) },
}));

/**
 * The live view gateway is what replaced the screenshot poll loop, so these
 * tests pin the two properties that make it safe to expose: it binds loopback
 * only, and every endpoint except /health demands the bearer token.
 */
describe('browser live view gateway', () => {
  const savedEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.FLUJO_BROWSER_STREAM_ENABLED;
    delete process.env.FLUJO_BROWSER_STREAM_PUBLIC_ORIGIN;
    delete process.env.FLUJO_BROWSER_STREAM_PORT;
    delete process.env.FLUJO_BROWSER_STREAM_AUDIO;
  });

  afterEach(async () => {
    await shutdownBrowserGateway();
    process.env = { ...savedEnv };
  });

  it('binds a loopback origin and mints a per-process token', async () => {
    const endpoint = await ensureBrowserGateway();
    expect(endpoint).toBeDefined();
    expect(endpoint!.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(endpoint!.token.length).toBeGreaterThanOrEqual(32);
    // Repeat calls reuse the same listener rather than leaking ports.
    await expect(ensureBrowserGateway()).resolves.toBe(endpoint);
    expect(browserGatewayEndpoint()).toBe(endpoint);
  });

  it('stays disabled when the operator turns streaming off', async () => {
    process.env.FLUJO_BROWSER_STREAM_ENABLED = '0';
    await expect(ensureBrowserGateway()).resolves.toBeUndefined();
    expect(browserGatewayEndpoint()).toBeUndefined();
  });

  it('serves the live view only to token holders', async () => {
    const endpoint = (await ensureBrowserGateway())!;

    await expect(fetch(`${endpoint.origin}/health`).then((r) => r.status)).resolves.toBe(200);

    const unauthorized = await fetch(`${endpoint.origin}/view?s=demo`);
    expect(unauthorized.status).toBe(403);

    const wrongToken = await fetch(`${endpoint.origin}/view?s=demo&t=not-the-token`);
    expect(wrongToken.status).toBe(403);

    const authorized = await fetch(
      `${endpoint.origin}/view?s=demo&t=${encodeURIComponent(endpoint.token)}`,
    );
    expect(authorized.status).toBe(200);
    expect(authorized.headers.get('content-type')).toContain('text/html');
    // The document must remain framable by the app sandbox origin.
    expect(authorized.headers.get('x-frame-options')).toBeNull();
    const html = await authorized.text();
    expect(html).toContain('id="omnibox"');
    expect(html).toContain('id="screen"');
  });

  it('refuses requests whose Host header is not loopback', async () => {
    const endpoint = (await ensureBrowserGateway())!;
    const response = await fetch(`${endpoint.origin}/view?s=demo&t=${endpoint.token}`, {
      headers: { host: 'attacker.example' },
    });
    // Node refuses to override Host on fetch, so assert the guard directly on a
    // raw socket request instead.
    expect(response.status).toBe(200);

    const raw = await rawRequest(endpoint.origin, `/view?s=demo&t=${endpoint.token}`, 'attacker.example');
    expect(raw).toContain('403');
  });

  it('captures page audio unless the operator opts out', () => {
    expect(browserAudioStreamEnabled()).toBe(true);
    process.env.FLUJO_BROWSER_STREAM_AUDIO = '0';
    expect(browserAudioStreamEnabled()).toBe(false);
    process.env.FLUJO_BROWSER_STREAM_AUDIO = 'true';
    expect(browserAudioStreamEnabled()).toBe(true);
  });

  it('injects a parseable main-world audio tap bound to the gateway callback', () => {
    const source = audioTapSource('__flujoTest');
    expect(() => new Function(source)).not.toThrow();
    expect(source).toContain('window.__flujoTest');
    // Both audio sources a page can use have to be covered.
    expect(source).toContain('window.AudioContext = patch(window.AudioContext)');
    expect(source).toContain('createMediaElementSource');
    // Digital silence must never reach the wire.
    expect(source).toContain('if (silent) return;');
    // Reused sessions recover media whose play event fired before attachment.
    expect(source).toContain('attachPlaying(document)');
    expect(source).toContain('MutationObserver');
  });

  it('can preinstall the tap muted before the first navigation', () => {
    const source = audioTapSource('__flujoTest', true);
    expect(source).toContain('window.__flujoAudioMuted = true');
  });

  it('rejects an unknown session on the streaming endpoints', async () => {
    const endpoint = (await ensureBrowserGateway())!;
    for (const path of ['/stream', '/audio', '/events']) {
      const response = await fetch(
        `${endpoint.origin}${path}?s=missing-session&t=${encodeURIComponent(endpoint.token)}`,
      );
      expect(response.status).toBe(404);
      await response.text();
    }
  });

  it('grants the gateway origin to the MCP App so it may frame the live view', async () => {
    const endpoint = (await ensureBrowserGateway())!;
    const resource = (await browserReadResource(BROWSER_APP_URI)).contents[0] as unknown as {
      text: string;
      _meta: { ui: { csp: { frameDomains: string[] } } };
    };
    expect(resource._meta.ui.csp.frameDomains).toEqual([endpoint.origin]);
    // The bearer token is templated into the shell, never returned to the model.
    expect(resource.text).toContain(endpoint.token);
    expect(resource.text).toContain(`${endpoint.origin}`);
  });
});

/** Issue a bare HTTP/1.1 request so the Host header can be forged. */
async function rawRequest(origin: string, path: string, host: string): Promise<string> {
  const { connect } = await import('node:net');
  const url = new URL(origin);
  return new Promise((resolve, reject) => {
    const socket = connect(Number(url.port), url.hostname, () => {
      socket.write(`GET ${path} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);
    });
    let data = '';
    socket.setTimeout(5_000, () => socket.destroy(new Error('raw request timed out')));
    socket.on('data', (chunk) => { data += chunk.toString('utf8'); });
    socket.on('end', () => resolve(data));
    socket.on('error', reject);
  });
}
