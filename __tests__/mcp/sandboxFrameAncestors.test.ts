/**
 * Regression coverage for the MCP Apps sandbox `frame-ancestors` directive.
 *
 * The sandbox proxy is served by its own loopback listener (e.g. :4203) while
 * the embedder is FLUJO itself (e.g. :4200). Deriving the directive from the
 * listener's own `Host` header named the sandbox instead of the host, so every
 * app frame was blocked with:
 *   Framing 'http://localhost:4203/' violates ... "frame-ancestors http://localhost:4203"
 */
import type http from 'node:http';

type SandboxModule = typeof import('@/backend/mcpApps/sandboxServer');

/** The module adopts cross-bundle state from this key; drop it for a clean load. */
const RUNTIME_STATE_KEY = Symbol.for('flujo.mcpApps.sandboxRuntimeState.v2');

function loadSandboxModule(env: Record<string, string | undefined> = {}): SandboxModule {
  let mod!: SandboxModule;
  delete (globalThis as Record<symbol, unknown>)[RUNTIME_STATE_KEY];
  jest.isolateModules(() => {
    const previous: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries(env)) {
      previous[key] = process.env[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      mod = require('@/backend/mcpApps/sandboxServer') as SandboxModule;
      // Touch the runtime state while the env is still in place.
      mod.getRegisteredSandboxHostOrigins();
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
  return mod;
}

function request(headers: Record<string, string>): http.IncomingMessage {
  return { headers } as unknown as http.IncomingMessage;
}

describe('sandbox frame-ancestors resolution', () => {
  const HOST_ORIGINS_ENV = 'FLUJO_MCP_APP_HOST_ORIGINS';

  it('names the FLUJO host origin registered when the token was minted', () => {
    const sandbox = loadSandboxModule({ [HOST_ORIGINS_ENV]: undefined });
    sandbox.registerSandboxHostOrigin('http://localhost:4200');

    const ancestors = sandbox.getAllowedFrameAncestors(
      request({ host: 'localhost:4203', referer: 'http://localhost:4200/' }),
    );

    expect(ancestors).toContain('http://localhost:4200');
    // The regression: the listener's own origin must never be the ancestor.
    expect(ancestors).not.toContain('http://localhost:4203');
    expect(sandbox.buildSandboxProxyCsp(ancestors)).toContain(
      'frame-ancestors http://localhost:4200',
    );
  });

  it('trusts a same-hostname referrer on another port even before registration', () => {
    const sandbox = loadSandboxModule({ [HOST_ORIGINS_ENV]: undefined });

    expect(
      sandbox.getAllowedFrameAncestors(
        request({ host: '127.0.0.1:4204', referer: 'http://127.0.0.1:4200/mcp' }),
      ),
    ).toEqual(['http://127.0.0.1:4200']);
  });

  it('treats localhost and 127.0.0.1 as the same loopback host', () => {
    const sandbox = loadSandboxModule({ [HOST_ORIGINS_ENV]: undefined });

    expect(
      sandbox.getAllowedFrameAncestors(
        request({ host: '127.0.0.1:4201', referer: 'http://localhost:4200/' }),
      ),
    ).toEqual(['http://localhost:4200']);
  });

  it('fails closed for an untrusted or missing referrer', () => {
    const sandbox = loadSandboxModule({ [HOST_ORIGINS_ENV]: undefined });

    expect(
      sandbox.getAllowedFrameAncestors(
        request({ host: 'localhost:4203', referer: 'https://evil.example.test/' }),
      ),
    ).toEqual([]);
    expect(sandbox.getAllowedFrameAncestors(request({ host: 'localhost:4203' }))).toEqual([]);
    expect(sandbox.buildSandboxProxyCsp([])).toContain("frame-ancestors 'none'");
  });

  it('keeps an explicit allowlist authoritative for nested embedding chains', () => {
    const sandbox = loadSandboxModule({
      [HOST_ORIGINS_ENV]: 'https://flujo.example.test,https://portal.example.test',
    });

    expect(
      sandbox.getAllowedFrameAncestors(
        request({ host: 'sandbox.example.test', referer: 'https://evil.example.test/' }),
      ),
    ).toEqual(['https://flujo.example.test', 'https://portal.example.test']);
  });

  it('ignores malformed registrations and bounds the registry', () => {
    const sandbox = loadSandboxModule({ [HOST_ORIGINS_ENV]: undefined });
    sandbox.registerSandboxHostOrigin('not a url');
    sandbox.registerSandboxHostOrigin('javascript:alert(1)');
    sandbox.registerSandboxHostOrigin(undefined);
    expect(sandbox.getRegisteredSandboxHostOrigins()).toEqual([]);

    for (let i = 0; i < 20; i++) {
      sandbox.registerSandboxHostOrigin(`http://localhost:${4300 + i}`);
    }
    const registered = sandbox.getRegisteredSandboxHostOrigins();
    expect(registered.length).toBeLessThanOrEqual(16);
    // Most recent survives, oldest is evicted.
    expect(registered).toContain('http://localhost:4319');
    expect(registered).not.toContain('http://localhost:4300');
  });
});
