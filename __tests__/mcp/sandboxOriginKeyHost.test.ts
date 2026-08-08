/**
 * MCP App sandbox origin isolation.
 *
 * Local and hosted deployments share one transport listener, but every app is
 * addressed through a stable, key-bearing hostname. The listener must derive
 * that key from Host before accepting the corresponding scoped token.
 */
import http from 'node:http';

type SandboxModule = typeof import('@/backend/mcpApps/sandboxServer');

/** The module adopts cross-bundle state from this key; drop it for a clean load. */
const RUNTIME_STATE_KEY = Symbol.for('flujo.mcpApps.sandboxRuntimeState.v2');
const PUBLIC_URL_ENV = 'FLUJO_MCP_APP_SANDBOX_PUBLIC_URL';
const BIND_HOST_ENV = 'FLUJO_MCP_APP_SANDBOX_HOST';
const PORT_ENV = 'FLUJO_MCP_APP_SANDBOX_PORT';
const EXPOSURE_ENV = 'FLUJO_EXPOSURE_MODE';
const EXPOSURE_SOURCE_ENV = 'FLUJO_EXPOSURE_MODE_SOURCE';

const APP_A = `app${'a'.repeat(60)}`;
const APP_B = `app${'b'.repeat(60)}`;

/**
 * The module reads deployment variables lazily. Keep them in place through the
 * test body, then restore them after each isolated module instance is stopped.
 */
const pendingEnvRestores: Array<() => void> = [];

afterEach(() => {
  while (pendingEnvRestores.length > 0) pendingEnvRestores.pop()!();
});

function loadSandboxModule(
  env: Record<string, string | undefined>,
  options: { preserveRuntime?: boolean } = {},
): SandboxModule {
  let mod!: SandboxModule;
  if (!options.preserveRuntime) {
    delete (globalThis as Record<symbol, unknown>)[RUNTIME_STATE_KEY];
  }

  const previous: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
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

  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    mod = require('@/backend/mcpApps/sandboxServer') as SandboxModule;
    // Initialize the isolated runtime while this test's env is active.
    mod.getRegisteredSandboxHostOrigins();
  });
  return mod;
}

async function findFreePort(): Promise<number> {
  const server = http.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
  });
  return port;
}

async function listenEphemeral(server: http.Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  return typeof address === 'object' && address ? address.port : 0;
}

function get(port: number, host: string, path: string): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    const req = http.get(
      { host: '127.0.0.1', port, path, headers: { host } },
      (res) => {
        res.resume();
        res.on('end', () => resolve({ status: res.statusCode ?? 0 }));
      },
    );
    req.on('error', reject);
  });
}

describe('sandbox hostname/key derivation', () => {
  it('derives only a single key label under localhost in local mode', () => {
    const sandbox = loadSandboxModule({
      [EXPOSURE_ENV]: 'localhost',
      [EXPOSURE_SOURCE_ENV]: undefined,
      [PUBLIC_URL_ENV]: undefined,
    });

    expect(sandbox.deriveOriginKeyFromHost(`${APP_A}.localhost:4201`)).toBe(APP_A);
    expect(sandbox.deriveOriginKeyFromHost(`${APP_A.toUpperCase()}.LOCALHOST`)).toBe(APP_A);
    expect(sandbox.deriveOriginKeyFromHost('localhost:4201')).toBeUndefined();
    expect(sandbox.deriveOriginKeyFromHost(`nested.${APP_A}.localhost`)).toBeUndefined();
    expect(sandbox.deriveOriginKeyFromHost(`${APP_A}.localhost/../evil`)).toBeUndefined();
    expect(sandbox.deriveOriginKeyFromHost(`${APP_A}.localhost?x=1`)).toBeUndefined();
    expect(sandbox.deriveOriginKeyFromHost(undefined)).toBeUndefined();
  });

  it('builds a stable localhost URL and rejects non-label keys', () => {
    const sandbox = loadSandboxModule({
      [EXPOSURE_ENV]: 'localhost',
      [EXPOSURE_SOURCE_ENV]: undefined,
      [PUBLIC_URL_ENV]: undefined,
    });

    expect(sandbox.deriveSandboxPublicUrl('http://localhost:4200', 4317, APP_A)).toBe(
      `http://${APP_A}.localhost:4317/sandbox.html`,
    );
    expect(sandbox.deriveSandboxPublicUrl('http://localhost:4200', 4317, 'two.labels'))
      .toBeUndefined();
    expect(sandbox.deriveSandboxPublicUrl('http://localhost:4200', 4317))
      .toBeUndefined();
  });

  it('accepts {app} only as one complete hosted DNS label', () => {
    const sandbox = loadSandboxModule({
      [EXPOSURE_ENV]: 'public',
      [EXPOSURE_SOURCE_ENV]: undefined,
      [PUBLIC_URL_ENV]: 'https://sandbox.{app}.example.test',
    });

    expect(sandbox.hasValidSandboxAppUrlTemplate()).toBe(true);
    expect(sandbox.deriveOriginKeyFromHost(`sandbox.${APP_A}.example.test:443`)).toBe(APP_A);
    expect(sandbox.deriveOriginKeyFromHost(`${APP_A}.sandbox.example.test`)).toBeUndefined();
    expect(sandbox.deriveOriginKeyFromHost(`sandbox.nested.${APP_A}.example.test`))
      .toBeUndefined();
    expect(sandbox.deriveSandboxPublicUrl('https://flujo.example.test', 4201, APP_A)).toBe(
      `https://sandbox.${APP_A}.example.test/sandbox.html`,
    );
  });

  it.each([
    'https://apps.example.test',
    'https://prefix-{app}.example.test',
    'https://{app}-suffix.example.test',
    'https://{app}.{app}.example.test',
    'https://apps.example.test/{app}',
  ])('rejects a non-wildcard or ambiguous hosted template: %s', (publicUrl) => {
    const sandbox = loadSandboxModule({
      [EXPOSURE_ENV]: 'network',
      [EXPOSURE_SOURCE_ENV]: undefined,
      [PUBLIC_URL_ENV]: publicUrl,
    });

    expect(sandbox.hasValidSandboxAppUrlTemplate()).toBe(false);
    expect(sandbox.deriveSandboxPublicUrl('https://flujo.example.test', 4201, APP_A))
      .toBeUndefined();
    expect(sandbox.deriveOriginKeyFromHost(`${APP_A}.example.test`)).toBeUndefined();
  });
});

describe('singleton listener token/hostname isolation', () => {
  it('adopts the base listener safely and closes legacy recycled-port entries', async () => {
    const baseServer = http.createServer((_req, res) => {
      res.statusCode = 418;
      res.end('legacy shared handler');
    });
    const legacyPerAppServer = http.createServer((_req, res) => {
      res.statusCode = 200;
      res.end('legacy per-app handler');
    });
    const basePort = await listenEphemeral(baseServer);
    const legacyPort = await listenEphemeral(legacyPerAppServer);

    (globalThis as Record<symbol, unknown>)[RUNTIME_STATE_KEY] = {
      secret: Buffer.alloc(32, 7),
      entries: new Map([
        ['', { server: baseServer, port: basePort, status: 'listening', lastUsedAt: 1 }],
        ['legacy-origin', {
          server: legacyPerAppServer,
          port: legacyPort,
          status: 'listening',
          lastUsedAt: 1,
        }],
      ]),
      basePort,
      bindHost: '127.0.0.1',
      configuredHostOrigins: [],
      hostOrigins: [],
    };

    const sandbox = loadSandboxModule({
      [EXPOSURE_ENV]: 'localhost',
      [EXPOSURE_SOURCE_ENV]: undefined,
      [PUBLIC_URL_ENV]: undefined,
      [BIND_HOST_ENV]: '127.0.0.1',
      [PORT_ENV]: String(basePort),
    }, { preserveRuntime: true });

    try {
      const app = await sandbox.ensureSandboxForOriginKey(APP_A);
      expect(app?.port).toBe(basePort);
      expect((await get(
        basePort,
        `${APP_A}.localhost`,
        `/sandbox.html?token=${app!.token}`,
      )).status).toBe(200);

      if (legacyPerAppServer.listening) {
        await new Promise<void>(resolve => legacyPerAppServer.once('close', resolve));
      }
      expect(legacyPerAppServer.listening).toBe(false);
    } finally {
      await sandbox.stopAllSandboxListeners();
      if (legacyPerAppServer.listening) {
        await new Promise<void>(resolve => legacyPerAppServer.close(() => resolve()));
      }
      delete (globalThis as Record<symbol, unknown>)[RUNTIME_STATE_KEY];
    }
  });

  it('shares one local listener during concurrent startup but never app tokens', async () => {
    const port = await findFreePort();
    const sandbox = loadSandboxModule({
      [EXPOSURE_ENV]: 'localhost',
      [EXPOSURE_SOURCE_ENV]: undefined,
      [PUBLIC_URL_ENV]: undefined,
      [BIND_HOST_ENV]: '127.0.0.1',
      [PORT_ENV]: String(port),
    });

    try {
      const [appA, appB, appASecond, readiness] = await Promise.all([
        sandbox.ensureSandboxForOriginKey(APP_A),
        sandbox.ensureSandboxForOriginKey(APP_B),
        sandbox.ensureSandboxForOriginKey(APP_A),
        sandbox.ensureSandboxForOriginKey(''),
      ]);
      expect(appA).toBeDefined();
      expect(appB).toBeDefined();
      expect(appASecond).toBeDefined();
      expect(readiness).toBeDefined();
      expect(new Set([appA!.port, appB!.port, appASecond!.port, readiness!.port]))
        .toEqual(new Set([port]));
      expect(appA!.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(appB!.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(appASecond!.token).toBe(appA!.token);
      expect(appA!.token).not.toBe(appB!.token);
      expect(readiness!.token).not.toBe(appA!.token);

      expect((await get(port, `${APP_A}.localhost`, `/sandbox.html?token=${appA!.token}`)).status)
        .toBe(200);
      expect((await get(port, `${APP_B}.localhost`, `/sandbox.html?token=${appB!.token}`)).status)
        .toBe(200);
      expect((await get(port, `${APP_B}.localhost`, `/sandbox.html?token=${appA!.token}`)).status)
        .toBe(403);
      expect((await get(port, `${APP_A}.localhost`, `/sandbox.html?token=${appB!.token}`)).status)
        .toBe(403);
      // The internal readiness credential is not a shared HTTP fallback.
      expect((await get(port, 'localhost', `/sandbox.html?token=${readiness!.token}`)).status)
        .toBe(403);
    } finally {
      await sandbox.stopAllSandboxListeners();
    }
  });

  it('uses the same singleton and Host-scoped tokens behind a hosted template', async () => {
    const port = await findFreePort();
    const sandbox = loadSandboxModule({
      [EXPOSURE_ENV]: 'public',
      [EXPOSURE_SOURCE_ENV]: undefined,
      [PUBLIC_URL_ENV]: 'https://{app}.sandbox.example.test',
      [BIND_HOST_ENV]: '127.0.0.1',
      [PORT_ENV]: String(port),
    });

    try {
      const [appA, appB] = await Promise.all([
        sandbox.ensureSandboxForOriginKey(APP_A),
        sandbox.ensureSandboxForOriginKey(APP_B),
      ]);
      expect(appA).toBeDefined();
      expect(appB).toBeDefined();
      expect(appA!.port).toBe(port);
      expect(appB!.port).toBe(port);
      expect(appA!.token).not.toBe(appB!.token);

      expect((await get(
        port,
        `${APP_A}.sandbox.example.test`,
        `/sandbox.html?token=${appA!.token}`,
      )).status).toBe(200);
      expect((await get(
        port,
        `${APP_B}.sandbox.example.test`,
        `/sandbox.html?token=${appA!.token}`,
      )).status).toBe(403);
    } finally {
      await sandbox.stopAllSandboxListeners();
    }
  });

  it('does not start in hosted/network mode without a valid wildcard template', async () => {
    const port = await findFreePort();
    const sandbox = loadSandboxModule({
      [EXPOSURE_ENV]: 'network',
      [EXPOSURE_SOURCE_ENV]: undefined,
      [PUBLIC_URL_ENV]: 'https://apps.example.test',
      [BIND_HOST_ENV]: '127.0.0.1',
      [PORT_ENV]: String(port),
    });

    expect(await sandbox.ensureSandboxForOriginKey(APP_A)).toBeUndefined();
    expect(await sandbox.ensureSandboxForOriginKey('')).toBeUndefined();
    expect(sandbox.getSandboxServerStatus()).toBe('idle');
  });
});
