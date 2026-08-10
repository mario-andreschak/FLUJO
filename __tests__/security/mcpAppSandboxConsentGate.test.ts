import { NextRequest } from 'next/server';
import type { MCPServerConfig } from '@/shared/types/mcp';
import { StorageKey } from '@/shared/types/storage';

/**
 * Issue #331 — the consent decision must be BACKEND-authoritative. The sandbox
 * token is what actually lets an app frame load, so a crafted request that
 * skips the frontend prompt has to fail closed before any token is minted.
 */

const consentStore: Record<string, unknown> = {};

jest.mock('@/utils/storage/backend', () => ({
  loadItem: jest.fn(async (key: string, defaultValue: unknown) =>
    key in consentStore ? consentStore[key] : defaultValue),
  saveItem: jest.fn(async (key: string, value: unknown) => { consentStore[key] = value; }),
}));

jest.mock('@/utils/encryption/lockGate', () => ({
  assertUnlocked: jest.fn(async () => null),
}));

// This suite exercises route authorization, not the independently tested
// startup migration barrier. Avoid coupling every request to filesystem
// migration fixtures that other Jest workers may intentionally perturb.
jest.mock('@/backend/services/workspace/migration', () => ({
  ensureWorkspaceLayoutReady: jest.fn(async () => undefined),
}));
jest.mock('@/utils/workspace', () => ({
  ...jest.requireActual('@/utils/workspace'),
  workspaceExists: jest.fn(async () => true),
}));

const loadServerConfigs = jest.fn(async (): Promise<MCPServerConfig[]> => []);
const readResourceFromApp = jest.fn(async () => ({
  success: true,
  data: {
    contents: [{
      uri: 'ui://acme/dashboard',
      mimeType: 'text/html;profile=mcp-app',
      text: '<main>verified app</main>',
    }],
  },
}));
jest.mock('@/backend/services/mcp', () => ({
  mcpService: {
    loadServerConfigs: (...args: unknown[]) => loadServerConfigs(...args as []),
    readResourceFromApp: (...args: unknown[]) => readResourceFromApp(...args as []),
  },
}));

const ensureSandboxForOriginKey = jest.fn(async (_originKey?: string) => ({ port: 4100, token: 'scoped-token' }));
const registerSandboxHostOrigin = jest.fn();

jest.mock('@/backend/mcpApps/sandboxServer', () => ({
  ensureSandboxForOriginKey: (key: string) => ensureSandboxForOriginKey(key),
  registerSandboxHostOrigin: (origin: string) => registerSandboxHostOrigin(origin),
  deriveSandboxPublicUrl: (_host: string, port: number, key: string) =>
    `http://${key}.localhost:${port}/sandbox.html`,
}));

import { GET } from '@/app/api/mcp/app-sandbox/route';
import { setMcpAppConsent } from '@/backend/mcpApps/appConsent';
import { deriveVerifiedMcpAppOriginKey } from '@/backend/mcpApps/appOrigin';

const URI = 'ui://acme/dashboard';
const originalExposureMode = process.env.FLUJO_EXPOSURE_MODE;

const external = (name: string): MCPServerConfig => ({
  name, transport: 'stdio', command: 'node', args: [], env: {}, disabled: false,
} as unknown as MCPServerConfig);

const shippedBash = (name: string): MCPServerConfig => ({
  ...external(name),
  source: { type: 'marketplace', id: '@mario.andreschak/mcp-bash' },
} as unknown as MCPServerConfig);

const request = (query: string): NextRequest =>
  new NextRequest(`http://localhost:4200/api/mcp/app-sandbox${query}`, {
    headers: { host: 'localhost:4200' },
  });

const expectDenied = async (response: Response) => {
  expect(response.status).toBe(403);
  await expect(response.json()).resolves.toEqual({ error: 'mcp_app_consent_required' });
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  // Nothing may be allocated or handed out for a denied request.
  expect(readResourceFromApp).not.toHaveBeenCalled();
  expect(ensureSandboxForOriginKey).not.toHaveBeenCalled();
  expect(registerSandboxHostOrigin).not.toHaveBeenCalled();
};

describe('MCP App sandbox token issuance is consent-gated (#331)', () => {
  beforeEach(() => {
    process.env.FLUJO_EXPOSURE_MODE = 'localhost';
    for (const key of Object.keys(consentStore)) delete consentStore[key];
    consentStore[StorageKey.SPEECH_SETTINGS] = {
      speech: { enabled: true },
      experimental: { enabled: false, requireMcpAppLaunchClick: true },
    };
    jest.clearAllMocks();
    loadServerConfigs.mockResolvedValue([]);
    readResourceFromApp.mockResolvedValue({
      success: true,
      data: {
        contents: [{ uri: URI, mimeType: 'text/html;profile=mcp-app', text: '<main>verified</main>' }],
      },
    });
    ensureSandboxForOriginKey.mockResolvedValue({ port: 4100, token: 'scoped-token' });
  });

  afterAll(() => {
    if (originalExposureMode === undefined) delete process.env.FLUJO_EXPOSURE_MODE;
    else process.env.FLUJO_EXPOSURE_MODE = originalExposureMode;
  });

  it('refuses to identify an app at all when serverName/uri are missing', async () => {
    await expectDenied(await GET(request('')));
    jest.clearAllMocks();
    await expectDenied(await GET(request('?serverName=acme')));
    jest.clearAllMocks();
    await expectDenied(await GET(request(`?uri=${encodeURIComponent(URI)}`)));
  });

  it('denies an app with no stored consent decision', async () => {
    loadServerConfigs.mockResolvedValue([external('acme')]);
    await expectDenied(await GET(request(`?serverName=acme&uri=${encodeURIComponent(URI)}`)));
  });

  it('denies a deny-always app and an unknown server config', async () => {
    await setMcpAppConsent('acme', URI, 'deny-always');
    loadServerConfigs.mockResolvedValue([external('acme')]);
    await expectDenied(await GET(request(`?serverName=acme&uri=${encodeURIComponent(URI)}`)));

    jest.clearAllMocks();
    loadServerConfigs.mockResolvedValue([]);
    await expectDenied(await GET(request(`?serverName=ghost&uri=${encodeURIComponent(URI)}`)));
  });

  it('honours the conversation scope of an allow-once grant', async () => {
    await setMcpAppConsent('acme', URI, 'allow-once', 'conversation-1');
    loadServerConfigs.mockResolvedValue([external('acme')]);

    await expectDenied(await GET(request(
      `?serverName=acme&uri=${encodeURIComponent(URI)}&conversationId=conversation-2`,
    )));

    jest.clearAllMocks();
    const allowed = await GET(request(
      `?serverName=acme&uri=${encodeURIComponent(URI)}&conversationId=conversation-1`,
    ));
    expect(allowed.status).toBe(200);
    await expect(allowed.json()).resolves.toMatchObject({
      port: 4100,
      token: 'scoped-token',
      originKey: deriveVerifiedMcpAppOriginKey({
        workspace: 'default-workspace', serverName: 'acme', uri: URI,
      }),
      shared: false,
    });
  });

  it('does not let a renamed third-party server impersonate a shipped app', async () => {
    loadServerConfigs.mockResolvedValue([external('bash')]);
    await expectDenied(await GET(request(`?serverName=bash&uri=${encodeURIComponent(URI)}`)));

    jest.clearAllMocks();
    loadServerConfigs.mockResolvedValue([shippedBash('bash')]);
    const internal = await GET(request(`?serverName=bash&uri=${encodeURIComponent(URI)}`));
    expect(internal.status).toBe(200);
    await expect(internal.json()).resolves.toMatchObject({ token: 'scoped-token', shared: false });
  });

  it('issues a token for an allow-always app in any conversation', async () => {
    await setMcpAppConsent('acme', URI, 'allow-always');
    loadServerConfigs.mockResolvedValue([external('acme')]);

    const response = await GET(request(
      `?serverName=acme&uri=${encodeURIComponent(URI)}&conversationId=whatever`,
    ));
    expect(response.status).toBe(200);
    expect(registerSandboxHostOrigin).toHaveBeenCalledWith('http://localhost:4200');
    await expect(response.json()).resolves.toMatchObject({ token: 'scoped-token', shared: false });
  });

  it('uses the server MCP Apps grant directly when click-to-display consent is off', async () => {
    consentStore[StorageKey.SPEECH_SETTINGS] = {
      speech: { enabled: true },
      experimental: { enabled: false, requireMcpAppLaunchClick: false },
    };
    await setMcpAppConsent('acme', URI, 'deny-always');
    loadServerConfigs.mockResolvedValue([external('acme')]);

    const response = await GET(request(`?serverName=acme&uri=${encodeURIComponent(URI)}`));

    expect(response.status).toBe(200);
    expect(readResourceFromApp).toHaveBeenCalledWith('acme', URI);
    await expect(response.json()).resolves.toMatchObject({ token: 'scoped-token' });
  });

  it('rejects a caller origin hint that disagrees with the verified identity', async () => {
    await setMcpAppConsent('acme', URI, 'allow-always');
    loadServerConfigs.mockResolvedValue([external('acme')]);

    const response = await GET(request(
      `?serverName=acme&uri=${encodeURIComponent(URI)}&originKey=attacker-app`,
    ));
    expect(response.status).toBe(409);
    expect(ensureSandboxForOriginKey).not.toHaveBeenCalled();
    expect(registerSandboxHostOrigin).not.toHaveBeenCalled();
  });

  it('fails closed when the server does not return exact MCP App HTML', async () => {
    await setMcpAppConsent('acme', URI, 'allow-always');
    loadServerConfigs.mockResolvedValue([external('acme')]);
    readResourceFromApp.mockResolvedValueOnce({
      success: true,
      data: {
        contents: [{
          uri: 'ui://acme/other',
          mimeType: 'text/html;profile=mcp-app',
          text: '<main>wrong resource</main>',
        }],
      },
    });

    const response = await GET(request(`?serverName=acme&uri=${encodeURIComponent(URI)}`));
    expect(response.status).toBe(422);
    expect(ensureSandboxForOriginKey).not.toHaveBeenCalled();
    expect(registerSandboxHostOrigin).not.toHaveBeenCalled();
  });

  it('keeps a localhost dashboard working after Public mode is selected', async () => {
    process.env.FLUJO_EXPOSURE_MODE = 'public';
    await setMcpAppConsent('acme', URI, 'allow-always');
    loadServerConfigs.mockResolvedValue([external('acme')]);

    const response = await GET(request(`?serverName=acme&uri=${encodeURIComponent(URI)}`));
    expect(response.status).toBe(200);
    expect(ensureSandboxForOriginKey).toHaveBeenCalled();
    expect(registerSandboxHostOrigin).toHaveBeenCalledWith('http://localhost:4200');
  });

  it('stays locked behind the encryption gate before consent is even considered', async () => {
    const { assertUnlocked } = jest.requireMock('@/utils/encryption/lockGate');
    (assertUnlocked as jest.Mock).mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'locked' }), { status: 401 }),
    );
    await setMcpAppConsent('acme', URI, 'allow-always');
    loadServerConfigs.mockResolvedValue([external('acme')]);

    const response = await GET(request(`?serverName=acme&uri=${encodeURIComponent(URI)}`));
    expect(response.status).toBe(401);
    expect(readResourceFromApp).not.toHaveBeenCalled();
    expect(ensureSandboxForOriginKey).not.toHaveBeenCalled();
  });
});
