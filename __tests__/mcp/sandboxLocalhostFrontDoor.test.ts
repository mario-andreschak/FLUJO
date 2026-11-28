/**
 * Issue #1336 — MCP App views in Localhost mode behind a trusted front door.
 *
 * A cloud machine runs FLUJO on 127.0.0.1 in Localhost mode; the operator's own
 * signed-in gateway is the only way in. It forwards dashboard requests with
 * `X-Forwarded-Host`/`-Proto` and forwards its shared HTTPS sandbox origin to
 * the sandbox listener with a loopback `Host`. When the operator sets
 * `FLUJO_EXPOSURE_MODE=localhost` together with the hosted sandbox settings
 * where FLUJO starts, those settings must win for requests through that front
 * door, while this computer, a plain install and a Settings-page choice keep
 * today's local-only behaviour.
 */
import http from 'node:http';

type SandboxModule = typeof import('@/backend/mcpApps/sandboxServer');

const RUNTIME_STATE_KEY = Symbol.for('flujo.mcpApps.sandboxRuntimeState.v2');
const PUBLIC_URL_ENV = 'FLUJO_MCP_APP_SANDBOX_PUBLIC_URL';
const HOST_ORIGINS_ENV = 'FLUJO_MCP_APP_HOST_ORIGINS';
const EXPOSURE_ENV = 'FLUJO_EXPOSURE_MODE';
const SOURCE_ENV = 'FLUJO_EXPOSURE_MODE_SOURCE';
const BIND_HOST_ENV = 'FLUJO_MCP_APP_SANDBOX_HOST';
const PORT_ENV = 'FLUJO_MCP_APP_SANDBOX_PORT';
const ALLOW_ALL_ENV = 'FLUJO_MCP_APP_SANDBOX_ALLOW_ALL';

const APP = `app${'d'.repeat(60)}`;
const OTHER_APP = `app${'e'.repeat(60)}`;
const DASHBOARD = 'https://phone.example.test';
const SHARED_SANDBOX = 'https://phone.example.test:8443/sandbox.html';

const mockLog = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };

const pendingEnvRestores: Array<() => void> = [];
const startedModules: SandboxModule[] = [];

afterEach(async () => {
  while (startedModules.length > 0) await startedModules.pop()!.stopAllSandboxListeners();
  while (pendingEnvRestores.length > 0) pendingEnvRestores.pop()!();
  delete (globalThis as Record<symbol, unknown>)[RUNTIME_STATE_KEY];
  jest.clearAllMocks();
});

/** Keep the env in place for the whole test; the module reads it lazily. */
function loadSandboxModule(env: Record<string, string | undefined>): SandboxModule {
  delete (globalThis as Record<symbol, unknown>)[RUNTIME_STATE_KEY];
  const previous: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries({ [ALLOW_ALL_ENV]: undefined, ...env })) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  pendingEnvRestores.push(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  let mod!: SandboxModule;
  jest.isolateModules(() => {
    jest.doMock('@/utils/logger', () => ({ createLogger: () => mockLog }));
    mod = require('@/backend/mcpApps/sandboxServer') as SandboxModule;
    mod.getRegisteredSandboxHostOrigins();
  });
  startedModules.push(mod);
  return mod;
}

async function freePort(): Promise<number> {
  const server = http.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise<void>(resolve => server.close(() => resolve()));
  return port;
}

interface Reply { status: number; headers: http.IncomingHttpHeaders; body: string }

/** What the front door (or a local browser) sends to the sandbox listener. */
function get(port: number, path: string, headers: Record<string, string>): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path, headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on('error', reject);
  });
}

function frameAncestors(reply: Reply): string {
  const csp = String(reply.headers['content-security-policy'] ?? '');
  return csp.split(';').map(part => part.trim()).find(part => part.startsWith('frame-ancestors')) ?? '';
}

async function frontDoorEnv(overrides: Record<string, string | undefined> = {}) {
  return {
    [EXPOSURE_ENV]: 'localhost',
    [SOURCE_ENV]: 'runtime',
    [PUBLIC_URL_ENV]: SHARED_SANDBOX,
    [HOST_ORIGINS_ENV]: DASHBOARD,
    [BIND_HOST_ENV]: '127.0.0.1',
    [PORT_ENV]: String(await freePort()),
    ...overrides,
  };
}

describe('plain Localhost install without hosted settings (unchanged)', () => {
  it.each(['settings', 'default', 'runtime', undefined])(
    'always hands out <app>.localhost (source %s)',
    (source) => {
      const sandbox = loadSandboxModule({
        [EXPOSURE_ENV]: 'localhost',
        [SOURCE_ENV]: source,
        [PUBLIC_URL_ENV]: undefined,
        [HOST_ORIGINS_ENV]: undefined,
      });

      for (const host of ['http://localhost:4200', 'http://127.0.0.1:4200', DASHBOARD]) {
        expect(sandbox.deriveSandboxPublicUrl(host, 4201, APP))
          .toBe(`http://${APP}.localhost:4201/sandbox.html`);
      }
      expect(sandbox.describeSandboxEndpointConfiguration()).toBeUndefined();
    },
  );

  it('serves per-app localhost origins and refuses a key carried in the URL', async () => {
    const env = await frontDoorEnv({ [SOURCE_ENV]: 'settings', [PUBLIC_URL_ENV]: undefined, [HOST_ORIGINS_ENV]: undefined });
    const sandbox = loadSandboxModule(env);
    const port = Number(env[PORT_ENV]);
    const app = await sandbox.ensureSandboxForOriginKey(APP);

    const local = await get(port, `/sandbox.html?token=${app!.token}`, {
      host: `${APP}.localhost:${port}`,
      referer: 'http://localhost:4200/',
    });
    expect(local.status).toBe(200);
    expect(frameAncestors(local)).toBe('frame-ancestors http://localhost:4200');

    const shared = await get(port, `/sandbox.html?originKey=${APP}&token=${app!.token}`, {
      host: `127.0.0.1:${port}`,
    });
    expect(shared.status).toBe(403);
  });
});

describe('Localhost behind a trusted front door with explicit settings', () => {
  it('uses the configured shared address only for requests through the front door', async () => {
    const sandbox = loadSandboxModule(await frontDoorEnv());

    expect(sandbox.deriveSandboxPublicUrl(DASHBOARD, 4201, APP))
      .toBe(`${SHARED_SANDBOX}?originKey=${APP}`);
    // This computer's own dashboard keeps one browser origin per App.
    expect(sandbox.deriveSandboxPublicUrl('http://localhost:4200', 4201, APP))
      .toBe(`http://${APP}.localhost:4201/sandbox.html`);
    expect(sandbox.deriveSandboxPublicUrl('http://127.0.0.1:4200', 4201, APP))
      .toBe(`http://${APP}.localhost:4201/sandbox.html`);
    expect(sandbox.getConfiguredSandboxHostOrigins()).toEqual([DASHBOARD]);
  });

  it('serves the app view through the front door with the right headers', async () => {
    const env = await frontDoorEnv();
    const sandbox = loadSandboxModule(env);
    const port = Number(env[PORT_ENV]);
    const app = await sandbox.ensureSandboxForOriginKey(APP);
    const other = await sandbox.ensureSandboxForOriginKey(OTHER_APP);
    // The authenticated /api/mcp/app-sandbox route registers the forwarded origin.
    sandbox.registerSandboxHostOrigin(DASHBOARD);

    // The front door rewrites Host to loopback and keeps the browser's Referer.
    const viaFrontDoor = { host: `127.0.0.1:${port}`, referer: `${DASHBOARD}/` };
    const reply = await get(port, `/sandbox.html?originKey=${APP}&token=${app!.token}`, viaFrontDoor);

    expect(reply.status).toBe(200);
    expect(reply.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(frameAncestors(reply)).toBe(`frame-ancestors ${DASHBOARD}`);
    expect(reply.headers['referrer-policy']).toBe('no-referrer');
    expect(reply.headers['x-content-type-options']).toBe('nosniff');
    expect(reply.headers['cache-control']).toBe('no-cache, no-store, must-revalidate');
    expect(reply.headers['set-cookie']).toBeUndefined();
    expect(reply.body).toContain(`var CONFIGURED_HOST_ORIGINS = ["${DASHBOARD}"]`);

    // Tokens stay scoped to one App; the internal readiness key is never a fallback.
    expect((await get(port, `/sandbox.html?originKey=${OTHER_APP}&token=${app!.token}`, viaFrontDoor)).status)
      .toBe(403);
    expect((await get(port, `/sandbox.html?originKey=${OTHER_APP}&token=${other!.token}`, viaFrontDoor)).status)
      .toBe(200);
    expect((await get(port, `/sandbox.html?token=${app!.token}`, viaFrontDoor)).status).toBe(403);
  });

  it('keeps this computer working: the configured origins add to the local defaults', async () => {
    const env = await frontDoorEnv();
    const sandbox = loadSandboxModule(env);
    const port = Number(env[PORT_ENV]);
    const app = await sandbox.ensureSandboxForOriginKey(APP);

    const local = await get(port, `/sandbox.html?token=${app!.token}`, {
      host: `${APP}.localhost:${port}`,
      referer: 'http://localhost:4200/',
    });
    expect(local.status).toBe(200);
    expect(frameAncestors(local)).toBe(`frame-ancestors ${DASHBOARD} http://localhost:4200`);
    expect(local.body).toContain('var HOST_ALLOWLIST_CONFIGURED = false');

    // A page nobody listed still cannot frame the sandbox.
    const stranger = await get(port, `/sandbox.html?token=${app!.token}`, {
      host: `${APP}.localhost:${port}`,
      referer: 'https://evil.example.test/',
    });
    expect(frameAncestors(stranger)).toBe(`frame-ancestors ${DASHBOARD}`);
  });

  it('honors an {app} template behind the front door when it preserves Host', async () => {
    const sandbox = loadSandboxModule(await frontDoorEnv({
      [PUBLIC_URL_ENV]: 'https://{app}.sandbox.example.test',
    }));

    expect(sandbox.deriveSandboxPublicUrl(DASHBOARD, 4201, APP))
      .toBe(`https://${APP}.sandbox.example.test/sandbox.html`);
    expect(sandbox.deriveOriginKeyFromHost(`${APP}.sandbox.example.test`)).toBe(APP);
  });

  it('says in one line what it uses', () => {
    const sandbox = loadSandboxModule({
      [EXPOSURE_ENV]: 'localhost',
      [SOURCE_ENV]: 'runtime',
      [PUBLIC_URL_ENV]: SHARED_SANDBOX,
      [HOST_ORIGINS_ENV]: DASHBOARD,
    });

    const description = sandbox.describeSandboxEndpointConfiguration();
    expect(description?.level).toBe('info');
    expect(description?.message).toBe(
      'MCP Apps sandbox (localhost mode): requests through the front door use shared address '
        + `${SHARED_SANDBOX} and extra dashboard origins ${DASHBOARD}; this computer keeps <app>.localhost.`,
    );
  });
});

describe('Localhost chosen on the Settings page ignores leftover hosted settings', () => {
  it('keeps the local address, refuses a URL-carried key and says why', async () => {
    const env = await frontDoorEnv({ [SOURCE_ENV]: 'settings' });
    const sandbox = loadSandboxModule(env);
    const port = Number(env[PORT_ENV]);
    const app = await sandbox.ensureSandboxForOriginKey(APP);

    expect(sandbox.deriveSandboxPublicUrl(DASHBOARD, 4201, APP))
      .toBe(`http://${APP}.localhost:4201/sandbox.html`);
    expect(sandbox.getConfiguredSandboxHostOrigins()).toEqual([]);
    expect((await get(port, `/sandbox.html?originKey=${APP}&token=${app!.token}`, {
      host: `127.0.0.1:${port}`,
      referer: `${DASHBOARD}/`,
    })).status).toBe(403);

    const description = sandbox.describeSandboxEndpointConfiguration();
    expect(description?.level).toBe('warn');
    expect(description?.message).toContain(
      `ignoring ${PUBLIC_URL_ENV} and ${HOST_ORIGINS_ENV} because Localhost was chosen on the Settings page`,
    );
    expect(description?.message).toContain('set FLUJO_EXPOSURE_MODE=localhost where FLUJO is started');
  });

  it('also ignores them when the launcher fell back to safe Localhost mode', () => {
    const sandbox = loadSandboxModule({
      [EXPOSURE_ENV]: 'localhost',
      [SOURCE_ENV]: 'default',
      [PUBLIC_URL_ENV]: SHARED_SANDBOX,
      [HOST_ORIGINS_ENV]: undefined,
    });

    expect(sandbox.deriveSandboxPublicUrl(DASHBOARD, 4201, APP))
      .toBe(`http://${APP}.localhost:4201/sandbox.html`);
    expect(sandbox.describeSandboxEndpointConfiguration()?.message).toContain(
      `ignoring ${PUBLIC_URL_ENV} because the saved network setting could not be read`,
    );
  });
});

describe('invalid hosted settings fall back safely with a clear message', () => {
  it.each([
    'https://user:hunter2@sandbox.example.test/',
    'https://prefix-{app}.example.test',
    'ftp://sandbox.example.test',
    'not a url',
  ])('ignores %s in Localhost mode and keeps <app>.localhost', async (publicUrl) => {
    const env = await frontDoorEnv({ [PUBLIC_URL_ENV]: publicUrl });
    const sandbox = loadSandboxModule(env);
    const port = Number(env[PORT_ENV]);
    const app = await sandbox.ensureSandboxForOriginKey(APP);

    expect(sandbox.deriveSandboxPublicUrl(DASHBOARD, 4201, APP))
      .toBe(`http://${APP}.localhost:4201/sandbox.html`);
    expect((await get(port, `/sandbox.html?originKey=${APP}&token=${app!.token}`, {
      host: `127.0.0.1:${port}`,
    })).status).toBe(403);

    const description = sandbox.describeSandboxEndpointConfiguration();
    expect(description?.level).toBe('warn');
    expect(description?.message).toContain(`Ignoring ${PUBLIC_URL_ENV}`);
    expect(description?.message).toContain('app views keep the local <app>.localhost address');
    // A malformed value may carry a password; it is never repeated in the log.
    expect(description?.message).not.toContain('hunter2');
  });

  it('skips malformed dashboard origins and keeps the valid ones and the local defaults', async () => {
    const env = await frontDoorEnv({
      [HOST_ORIGINS_ENV]: `javascript:alert(1), ${DASHBOARD}/path, ${DASHBOARD}`,
    });
    const sandbox = loadSandboxModule(env);
    const port = Number(env[PORT_ENV]);
    const app = await sandbox.ensureSandboxForOriginKey(APP);

    expect(sandbox.getConfiguredSandboxHostOrigins()).toEqual([DASHBOARD]);
    const local = await get(port, `/sandbox.html?token=${app!.token}`, {
      host: `${APP}.localhost:${port}`,
      referer: 'http://localhost:4200/',
    });
    expect(frameAncestors(local)).toBe(`frame-ancestors ${DASHBOARD} http://localhost:4200`);

    const description = sandbox.describeSandboxEndpointConfiguration();
    expect(description?.level).toBe('warn');
    expect(description?.message).toContain(`Ignoring 2 ${HOST_ORIGINS_ENV} entries`);
    expect(description?.message).not.toContain('javascript');
  });

  it('keeps Public mode fail-closed and explains it', () => {
    const sandbox = loadSandboxModule({
      [EXPOSURE_ENV]: 'public',
      [SOURCE_ENV]: 'settings',
      [PUBLIC_URL_ENV]: 'https://prefix-{app}.example.test',
      [HOST_ORIGINS_ENV]: undefined,
    });

    expect(sandbox.deriveSandboxPublicUrl(DASHBOARD, 4201, APP)).toBeUndefined();
    expect(sandbox.describeSandboxEndpointConfiguration()?.message)
      .toContain('which HTTPS dashboards cannot load');
  });
});

describe('startup log', () => {
  // The operator reads the server's own output, where the app logger prints
  // only errors; a line sent through it never reached a real deployment's log.
  it('writes the settings line once per process to the server output', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const info = jest.spyOn(console, 'info').mockImplementation(() => undefined);
    try {
      const sandbox = loadSandboxModule(await frontDoorEnv({ [PUBLIC_URL_ENV]: 'not a url' }));

      sandbox.startSandboxServer();
      sandbox.startSandboxServer();
      await sandbox.ensureSandboxForOriginKey('');

      const settingsLines = warn.mock.calls
        .map(([message]) => String(message))
        .filter(message => message.startsWith('[FLUJO] MCP Apps sandbox (localhost mode):'));
      expect(settingsLines).toHaveLength(1);
      expect(info.mock.calls.map(([message]) => String(message)))
        .not.toContainEqual(expect.stringMatching(/MCP Apps sandbox \(/));
      expect([...mockLog.info.mock.calls, ...mockLog.warn.mock.calls].map(([message]) => String(message)))
        .not.toContainEqual(expect.stringMatching(/MCP Apps sandbox \(/));
    } finally {
      warn.mockRestore();
      info.mockRestore();
    }
  });

  it('writes a valid front door setup as one information line', async () => {
    const info = jest.spyOn(console, 'info').mockImplementation(() => undefined);
    try {
      const sandbox = loadSandboxModule(await frontDoorEnv({}));
      sandbox.startSandboxServer();
      await sandbox.ensureSandboxForOriginKey('');
      expect(info.mock.calls.map(([message]) => String(message))
        .filter(message => message.startsWith('[FLUJO] MCP Apps sandbox (localhost mode): requests through the front door use')))
        .toHaveLength(1);
    } finally {
      info.mockRestore();
    }
  });
});
