/**
 * MCP Apps (#387) — Mode B (hosted) sandbox listener Host-header originKey
 * resolution.
 *
 * `ensureSandboxForOriginKey()` mints a token scoped to the REQUESTED app's
 * originKey even though the underlying Mode B listener is started with the
 * shared/empty originKey `''`. Before this fix, `handleSandboxRequest()`
 * validated every token against that listener's own `''` key regardless of
 * which app's hostname the request actually arrived on — so per-app hostnames
 * were cosmetic (a token minted for app X either always failed, or — depending
 * on future changes — could be accepted on app Y's hostname). The fix derives
 * the effective originKey from the request's `Host` header (matched against
 * the `{app}` placeholder in the configured public URL template) and MUST
 * take priority over the listener's own key.
 */
import http from 'node:http';

type SandboxModule = typeof import('@/backend/mcpApps/sandboxServer');

/** The module adopts cross-bundle state from this key; drop it for a clean load. */
const RUNTIME_STATE_KEY = Symbol.for('flujo.mcpApps.sandboxRuntimeState.v2');

/**
 * `deriveOriginKeyFromHost()` / `getSandboxPublicUrl()` read `process.env`
 * LAZILY -- at call time, not at module-load time -- so the env vars set up
 * by `loadSandboxModule()` below must stay in place until the *test's*
 * assertions have run, not just until the module has finished loading.
 * Restoring them in a `finally` block inside `loadSandboxModule()` would
 * un-set them before the test body even gets a chance to call into the
 * module, breaking every assertion. Instead we defer the restore to
 * `afterEach`, which still guarantees no env leakage across tests/suites.
 */
const pendingEnvRestores: Array<() => void> = [];

afterEach(() => {
  while (pendingEnvRestores.length > 0) {
    pendingEnvRestores.pop()!();
  }
});

function loadSandboxModule(env: Record<string, string | undefined> = {}): SandboxModule {
  let mod!: SandboxModule;
  delete (globalThis as Record<symbol, unknown>)[RUNTIME_STATE_KEY];

  const previous: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  // Restore after the test (see comment above), not right after the module
  // load -- the module reads these env vars lazily at assertion time.
  pendingEnvRestores.push(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    mod = require('@/backend/mcpApps/sandboxServer') as SandboxModule;
    mod.getRegisteredSandboxHostOrigins();
  });
  return mod;
}

function fakeRequest(host: string | undefined): http.IncomingMessage {
  return { headers: { host } } as unknown as http.IncomingMessage;
}

describe('deriveOriginKeyFromHost (unit)', () => {
  const PUBLIC_URL_ENV = 'FLUJO_MCP_APP_SANDBOX_PUBLIC_URL';

  it('returns undefined when no {app} template is configured (Mode A/C unaffected)', () => {
    const sandbox = loadSandboxModule({ [PUBLIC_URL_ENV]: undefined });
    expect(sandbox.deriveOriginKeyFromHost('localhost:4203')).toBeUndefined();
  });

  it('returns undefined for a single-origin (Mode C) public URL without {app}', () => {
    const sandbox = loadSandboxModule({ [PUBLIC_URL_ENV]: 'https://apps.example.test' });
    expect(sandbox.deriveOriginKeyFromHost('apps.example.test')).toBeUndefined();
  });

  it('extracts the {app} label from a matching Host header', () => {
    const sandbox = loadSandboxModule({
      [PUBLIC_URL_ENV]: 'https://{app}.sandbox.example.test',
    });
    expect(sandbox.deriveOriginKeyFromHost('my-app.sandbox.example.test')).toBe('my-app');
    // Port is stripped before matching.
    expect(sandbox.deriveOriginKeyFromHost('my-app.sandbox.example.test:443')).toBe('my-app');
  });

  it('rejects a Host header that does not match the template shape', () => {
    const sandbox = loadSandboxModule({
      [PUBLIC_URL_ENV]: 'https://{app}.sandbox.example.test',
    });
    expect(sandbox.deriveOriginKeyFromHost('sandbox.example.test')).toBeUndefined();
    expect(sandbox.deriveOriginKeyFromHost('my-app.other.example.test')).toBeUndefined();
    expect(sandbox.deriveOriginKeyFromHost('evil.test')).toBeUndefined();
    expect(sandbox.deriveOriginKeyFromHost(undefined)).toBeUndefined();
  });

  it('rejects malicious/malformed Host headers that would otherwise smuggle an invalid label', () => {
    const sandbox = loadSandboxModule({
      [PUBLIC_URL_ENV]: 'https://{app}.sandbox.example.test',
    });
    // DNS hostnames are case-insensitive; the Host header is normalized to
    // lowercase before matching (same case-folding DNS itself applies), so an
    // uppercase label still resolves to the (already-lowercase) originKey.
    expect(sandbox.deriveOriginKeyFromHost('MYAPP.sandbox.example.test')).toBe('myapp');
    // Dotted "label" (two labels stuffed into the {app} slot) must not be
    // accepted as a single-label match.
    expect(sandbox.deriveOriginKeyFromHost('my.app.sandbox.example.test')).toBeUndefined();
    // Path/query smuggled into the Host header string.
    expect(sandbox.deriveOriginKeyFromHost('my-app.sandbox.example.test/../evil')).toBeUndefined();
    expect(sandbox.deriveOriginKeyFromHost('my-app.sandbox.example.test?x=1')).toBeUndefined();
  });
});

describe('Mode B sandbox listener: per-app token/hostname isolation (integration)', () => {
  const PUBLIC_URL_ENV = 'FLUJO_MCP_APP_SANDBOX_PUBLIC_URL';
  const BIND_HOST_ENV = 'FLUJO_MCP_APP_SANDBOX_HOST';

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

  it('validates a token against the per-app Host label, not the listener default key', async () => {
    const sandbox = loadSandboxModule({
      [PUBLIC_URL_ENV]: 'https://{app}.sandbox.example.test',
      [BIND_HOST_ENV]: '127.0.0.1',
    });

    try {
      // Start the Mode B singleton listener (the empty '' entry).
      const base = await sandbox.ensureSandboxForOriginKey('');
      expect(base).toBeDefined();
      const port = base!.port;

      const appA = await sandbox.ensureSandboxForOriginKey('app-a');
      const appB = await sandbox.ensureSandboxForOriginKey('app-b');
      expect(appA).toBeDefined();
      expect(appB).toBeDefined();
      // Both apps are served from the SAME singleton listener/port in Mode B.
      expect(appA!.port).toBe(port);
      expect(appB!.port).toBe(port);
      expect(appA!.token).not.toBe(appB!.token);

      // app-a's token on app-a's hostname: allowed.
      const okA = await get(port, 'app-a.sandbox.example.test', `/sandbox.html?token=${appA!.token}`);
      expect(okA.status).toBe(200);

      // app-a's token on app-b's hostname: MUST be rejected (this is the bug
      // being fixed — cross-app token reuse via hostname).
      const crossOverAonB = await get(
        port,
        'app-b.sandbox.example.test',
        `/sandbox.html?token=${appA!.token}`,
      );
      expect(crossOverAonB.status).toBe(403);

      // app-b's token on app-b's hostname: allowed.
      const okB = await get(port, 'app-b.sandbox.example.test', `/sandbox.html?token=${appB!.token}`);
      expect(okB.status).toBe(200);

      // app-b's token on app-a's hostname: MUST be rejected.
      const crossOverBonA = await get(
        port,
        'app-a.sandbox.example.test',
        `/sandbox.html?token=${appB!.token}`,
      );
      expect(crossOverBonA.status).toBe(403);

      // An unknown/unmapped Host header falls back to the listener's own key
      // ('' — the shared default) rather than accepting any app's token.
      const unknownHost = await get(port, 'unrelated.example.test', `/sandbox.html?token=${appA!.token}`);
      expect(unknownHost.status).toBe(403);
    } finally {
      await sandbox.stopAllSandboxListeners();
    }
  });
});
