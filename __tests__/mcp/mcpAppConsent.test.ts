import type { MCPServerConfig } from '@/shared/types/mcp';
import { StorageKey } from '@/shared/types/storage';

const store: Record<string, unknown> = {};

jest.mock('@/utils/storage/backend', () => ({
  loadItem: jest.fn(async (key: string, defaultValue: unknown) =>
    key in store ? store[key] : defaultValue),
  saveItem: jest.fn(async (key: string, value: unknown) => { store[key] = value; }),
}));

import {
  clearMcpAppConsent,
  getEffectiveMcpAppConsent,
  getMcpAppConsent,
  isInternalMcpAppServer,
  isMcpAppConsentRequired,
  listMcpAppConsents,
  mcpAppConsentKey,
  setMcpAppConsent,
} from '@/backend/mcpApps/appConsent';

const URI = 'ui://acme/dashboard';

const external = (name = 'acme'): MCPServerConfig => ({
  name,
  transport: 'stdio',
  command: 'node',
  args: [],
  env: {},
  disabled: false,
  autoApprove: [],
  rootPath: '',
  _buildCommand: '',
  _installCommand: '',
} as unknown as MCPServerConfig);

const shipped = (name = 'bash'): MCPServerConfig => ({
  ...external(name),
  source: { type: 'marketplace', id: '@mario.andreschak/mcp-bash' },
} as unknown as MCPServerConfig);

describe('MCP App consent decisions (#331)', () => {
  beforeEach(() => {
    for (const key of Object.keys(store)) delete store[key];
  });

  it('defaults to prompting: an unknown third-party app is never implicitly rendered', async () => {
    await expect(getMcpAppConsent(external(), 'acme', URI)).resolves.toBe('prompt');
    await expect(getMcpAppConsent(undefined, 'acme', URI)).resolves.toBe('prompt');
  });

  it('treats a shipped package as internal without consulting the store', async () => {
    const { loadItem } = jest.requireMock('@/utils/storage/backend');
    (loadItem as jest.Mock).mockClear();

    await expect(getMcpAppConsent(shipped(), 'bash', URI)).resolves.toBe('internal');
    expect(loadItem).not.toHaveBeenCalled();
  });

  it('derives trust from the installed package, not the editable server name', async () => {
    // A renamed third-party server impersonating a shipped one stays external.
    expect(isInternalMcpAppServer(external('bash'))).toBe(false);
    expect(isInternalMcpAppServer({
      ...external('bash'),
      source: { type: 'marketplace', id: '@evil/mcp-bash' },
    } as unknown as MCPServerConfig)).toBe(false);
    expect(isInternalMcpAppServer({
      ...external('bash'),
      source: { type: 'git', id: '@mario.andreschak/mcp-bash' },
    } as unknown as MCPServerConfig)).toBe(false);
    expect(isInternalMcpAppServer(undefined)).toBe(false);
    expect(isInternalMcpAppServer(shipped('renamed-by-user'))).toBe(true);

    await expect(getMcpAppConsent(external('bash'), 'bash', URI)).resolves.toBe('prompt');
  });

  it('scopes allow-once to the conversation it was granted in', async () => {
    await setMcpAppConsent('acme', URI, 'allow-once', 'conversation-1');

    await expect(getMcpAppConsent(external(), 'acme', URI, 'conversation-1'))
      .resolves.toBe('granted');
    await expect(getMcpAppConsent(external(), 'acme', URI, 'conversation-2'))
      .resolves.toBe('prompt');
    await expect(getMcpAppConsent(external(), 'acme', URI)).resolves.toBe('prompt');
  });

  it('persists allow-always and deny-always per server + resource', async () => {
    await setMcpAppConsent('acme', URI, 'allow-always');
    await setMcpAppConsent('acme', 'ui://acme/other', 'deny-always');

    await expect(getMcpAppConsent(external(), 'acme', URI)).resolves.toBe('granted');
    await expect(getMcpAppConsent(external(), 'acme', URI, 'any-conversation'))
      .resolves.toBe('granted');
    await expect(getMcpAppConsent(external(), 'acme', 'ui://acme/other'))
      .resolves.toBe('denied');
    // A different server may not inherit another server's grant.
    await expect(getMcpAppConsent(external('other'), 'other', URI)).resolves.toBe('prompt');

    const persisted = store[StorageKey.MCP_APP_CONSENT] as Record<string, unknown>;
    expect(Object.keys(persisted)).toEqual([
      mcpAppConsentKey('acme', URI),
      mcpAppConsentKey('acme', 'ui://acme/other'),
    ]);
  });

  it('fails closed when the persisted store is malformed', async () => {
    store[StorageKey.MCP_APP_CONSENT] = ['not', 'an', 'object'];
    await expect(getMcpAppConsent(external(), 'acme', URI)).resolves.toBe('prompt');

    store[StorageKey.MCP_APP_CONSENT] = null;
    await expect(getMcpAppConsent(external(), 'acme', URI)).resolves.toBe('prompt');
  });

  it('never leaks a previously written grant into a missing or malformed read', async () => {
    // Regression: loadStore() used to return a shared module-level empty object
    // that setMcpAppConsent then mutated, so this grant survived into every
    // later fail-closed fallback and rendered third-party apps without consent.
    await setMcpAppConsent('acme', URI, 'allow-always');
    await expect(getMcpAppConsent(external(), 'acme', URI)).resolves.toBe('granted');

    delete store[StorageKey.MCP_APP_CONSENT];
    await expect(getMcpAppConsent(external(), 'acme', URI)).resolves.toBe('prompt');

    store[StorageKey.MCP_APP_CONSENT] = ['not', 'an', 'object'];
    await expect(getMcpAppConsent(external(), 'acme', URI)).resolves.toBe('prompt');

    store[StorageKey.MCP_APP_CONSENT] = null;
    await expect(getMcpAppConsent(external(), 'acme', URI)).resolves.toBe('prompt');
  });

  it('does not hand out the persisted object by reference', async () => {
    await setMcpAppConsent('acme', URI, 'allow-always');

    const persisted = store[StorageKey.MCP_APP_CONSENT] as Record<string, unknown>;
    await setMcpAppConsent('acme', 'ui://acme/other', 'deny-always');

    // The first snapshot must not have grown a key behind the caller's back.
    expect(Object.keys(persisted)).toEqual([mcpAppConsentKey('acme', URI)]);
  });

  it('drops persisted entries that are not well-formed consent records', async () => {
    store[StorageKey.MCP_APP_CONSENT] = {
      [mcpAppConsentKey('acme', URI)]: { decision: 'allow-everything', updatedAt: 1 },
      [mcpAppConsentKey('acme', 'ui://acme/other')]: 'allow-always',
      [mcpAppConsentKey('acme', 'ui://acme/third')]: null,
    };

    await expect(getMcpAppConsent(external(), 'acme', URI)).resolves.toBe('prompt');
    await expect(getMcpAppConsent(external(), 'acme', 'ui://acme/other')).resolves.toBe('prompt');
    await expect(getMcpAppConsent(external(), 'acme', 'ui://acme/third')).resolves.toBe('prompt');
  });

  it('lets a later decision override an earlier one', async () => {
    await setMcpAppConsent('acme', URI, 'allow-always');
    await expect(getMcpAppConsent(external(), 'acme', URI)).resolves.toBe('granted');

    await setMcpAppConsent('acme', URI, 'deny-always');
    await expect(getMcpAppConsent(external(), 'acme', URI)).resolves.toBe('denied');
  });

  it('bypasses and hides per-app decisions unless click-to-display consent is enabled', async () => {
    await setMcpAppConsent('acme', URI, 'deny-always');

    await expect(isMcpAppConsentRequired()).resolves.toBe(false);
    await expect(getEffectiveMcpAppConsent(external(), 'acme', URI)).resolves.toBe('granted');

    store[StorageKey.SPEECH_SETTINGS] = {
      speech: { enabled: true },
      experimental: { enabled: false, requireMcpAppLaunchClick: true },
    };
    await expect(isMcpAppConsentRequired()).resolves.toBe(true);
    await expect(getEffectiveMcpAppConsent(external(), 'acme', URI)).resolves.toBe('denied');
  });

  it('lists and clears remembered decisions for the Settings consent manager', async () => {
    await setMcpAppConsent('acme', URI, 'deny-always');
    await setMcpAppConsent('other', 'ui://other/app', 'allow-always');

    await expect(listMcpAppConsents()).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ serverName: 'acme', uri: URI, decision: 'deny-always' }),
      expect.objectContaining({ serverName: 'other', uri: 'ui://other/app', decision: 'allow-always' }),
    ]));

    await clearMcpAppConsent('acme', URI);
    await expect(getMcpAppConsent(external(), 'acme', URI)).resolves.toBe('prompt');
    await expect(listMcpAppConsents()).resolves.not.toEqual(expect.arrayContaining([
      expect.objectContaining({ serverName: 'acme', uri: URI }),
    ]));
  });
});
