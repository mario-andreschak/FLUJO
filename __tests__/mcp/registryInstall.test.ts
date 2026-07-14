/**
 * Tests for headless registry install (brain / self-improvement track):
 * searchRegistry result mapping and installRegistryServer's resolve → config →
 * save+connect → tools chain, including the needsEnv and already-exists guards.
 */

const registryGetJsonMock = jest.fn();
jest.mock('@/backend/utils/registryClient', () => ({
  REGISTRY_ORIGIN: 'https://registry.test',
  registryGetJson: (...a: unknown[]) => registryGetJsonMock(...a),
}));

const loadServerConfigsMock = jest.fn();
const updateServerConfigMock = jest.fn();
const listServerToolsMock = jest.fn();
jest.mock('@/backend/services/mcp', () => ({
  mcpService: {
    loadServerConfigs: (...a: unknown[]) => loadServerConfigsMock(...a),
    updateServerConfig: (...a: unknown[]) => updateServerConfigMock(...a),
    listServerTools: (...a: unknown[]) => listServerToolsMock(...a),
  },
}));

import { searchRegistry, installRegistryServer } from '@/backend/services/mcp/registryInstall';

/** A registry entry with an npm stdio package (installable, no required env). */
const npmEntry = (name: string, extras: Record<string, unknown> = {}) => ({
  server: {
    name,
    description: `The ${name} server`,
    packages: [
      {
        registryType: 'npm',
        identifier: `@example/${name.split('/').pop()}`,
        version: '1.0.0',
        transport: { type: 'stdio' },
        ...extras,
      },
    ],
  },
});

const keyedEntry = (name: string) =>
  npmEntry(name, {
    environmentVariables: [{ name: 'THE_API_KEY', isRequired: true, isSecret: true }],
  });

beforeEach(() => {
  jest.clearAllMocks();
  loadServerConfigsMock.mockResolvedValue([]);
  updateServerConfigMock.mockResolvedValue({ name: 'whatever' });
  listServerToolsMock.mockResolvedValue({ tools: [{ name: 'sing', description: 'sings a song' }] });
});

describe('searchRegistry', () => {
  it('maps entries to hits with installability + required env', async () => {
    registryGetJsonMock.mockResolvedValue({
      servers: [
        npmEntry('io.github.acme/voice'),
        keyedEntry('io.github.acme/keyed-voice'),
        { server: { name: 'io.github.acme/unsupported', packages: [] } },
      ],
    });
    const hits = await searchRegistry('voice');
    expect(hits).toEqual([
      expect.objectContaining({ name: 'io.github.acme/voice', installable: true, requiredEnv: [] }),
      expect.objectContaining({ name: 'io.github.acme/keyed-voice', installable: true, requiredEnv: ['THE_API_KEY'] }),
      expect.objectContaining({ name: 'io.github.acme/unsupported', installable: false }),
    ]);
    // The registry matches names only; the query must reach the upstream URL.
    const url = registryGetJsonMock.mock.calls[0][0] as URL;
    expect(url.searchParams.get('search')).toBe('voice');
    expect(url.searchParams.get('version')).toBe('latest');
  });
});

describe('installRegistryServer', () => {
  it('installs an npm package end-to-end: config saved (which connects), tools returned', async () => {
    registryGetJsonMock.mockResolvedValue({ servers: [npmEntry('io.github.acme/voice')] });
    const result = await installRegistryServer('io.github.acme/voice');
    expect(result.installed).toBe(true);
    expect(result.tools).toEqual([{ name: 'sing', description: 'sings a song' }]);
    expect(updateServerConfigMock).toHaveBeenCalledTimes(1);
    const [savedName, config] = updateServerConfigMock.mock.calls[0];
    expect(result.serverName).toBe(savedName);
    expect(config).toEqual(
      expect.objectContaining({
        transport: 'stdio',
        command: 'npx',
        args: expect.arrayContaining(['-y', '@example/voice@1.0.0']),
        disabled: false,
      })
    );
  });

  it('refuses to install when required env is missing, reporting needsEnv', async () => {
    registryGetJsonMock.mockResolvedValue({ servers: [keyedEntry('io.github.acme/keyed-voice')] });
    const result = await installRegistryServer('io.github.acme/keyed-voice');
    expect(result.installed).toBe(false);
    expect(result.needsEnv).toEqual(['THE_API_KEY']);
    expect(updateServerConfigMock).not.toHaveBeenCalled();
  });

  it('installs a keyed server when the env value is provided', async () => {
    registryGetJsonMock.mockResolvedValue({ servers: [keyedEntry('io.github.acme/keyed-voice')] });
    const result = await installRegistryServer('io.github.acme/keyed-voice', { THE_API_KEY: 'sk-123' });
    expect(result.installed).toBe(true);
    const config = updateServerConfigMock.mock.calls[0][1];
    // Secret shape is preserved so the encrypted env handling applies on save.
    expect(config.env.THE_API_KEY).toEqual({ value: 'sk-123', metadata: { isSecret: true } });
  });

  it('resolveOnly returns the resolved plan WITHOUT spawning (no updateServerConfig)', async () => {
    registryGetJsonMock.mockResolvedValue({
      servers: [
        {
          ...keyedEntry('io.github.acme/keyed-voice'),
          _meta: { 'io.modelcontextprotocol.registry/official': { status: 'active' } },
        },
      ],
    });
    const result = await installRegistryServer('io.github.acme/keyed-voice', undefined, { resolveOnly: true });
    expect(result.installed).toBe(false);
    expect(updateServerConfigMock).not.toHaveBeenCalled();
    expect(result.plan).toEqual(
      expect.objectContaining({
        command: 'npx',
        args: expect.arrayContaining(['-y', '@example/keyed-voice@1.0.0']),
        serverName: 'keyed-voice',
        requiredEnvNames: ['THE_API_KEY'],
        verificationStatus: 'active',
      })
    );
    // Resolve-only carries required env NAMES only — never a value.
    expect(JSON.stringify(result.plan)).not.toContain('sk-');
  });

  it('the actual-install path also returns the plan and defaults verification to "unverified"', async () => {
    registryGetJsonMock.mockResolvedValue({ servers: [npmEntry('io.github.acme/voice')] });
    const result = await installRegistryServer('io.github.acme/voice');
    expect(result.installed).toBe(true);
    expect(result.plan?.command).toBe('npx');
    expect(result.plan?.verificationStatus).toBe('unverified');
  });

  it('still surfaces the plan alongside needsEnv when required env is missing', async () => {
    registryGetJsonMock.mockResolvedValue({ servers: [keyedEntry('io.github.acme/keyed-voice')] });
    const result = await installRegistryServer('io.github.acme/keyed-voice');
    expect(result.installed).toBe(false);
    expect(result.needsEnv).toEqual(['THE_API_KEY']);
    expect(result.plan?.requiredEnvNames).toEqual(['THE_API_KEY']);
    expect(updateServerConfigMock).not.toHaveBeenCalled();
  });

  it('never clobbers an existing server — reuses it and reports alreadyExisted', async () => {
    registryGetJsonMock.mockResolvedValue({ servers: [npmEntry('io.github.acme/voice')] });
    loadServerConfigsMock.mockResolvedValue([{ name: 'voice' }]);
    const result = await installRegistryServer('io.github.acme/voice');
    expect(result.installed).toBe(true);
    expect(result.alreadyExisted).toBe(true);
    expect(updateServerConfigMock).not.toHaveBeenCalled();
    expect(listServerToolsMock).toHaveBeenCalledWith('voice');
  });

  it('errors cleanly on unknown entries, unsupported entries, and registry failures', async () => {
    registryGetJsonMock.mockResolvedValue({ servers: [] });
    expect((await installRegistryServer('ghost/none')).installed).toBe(false);

    registryGetJsonMock.mockResolvedValue({ servers: [{ server: { name: 'x/unsupported', packages: [] } }] });
    const unsupported = await installRegistryServer('x/unsupported');
    expect(unsupported.installed).toBe(false);
    expect(unsupported.error).toContain('no install method');

    registryGetJsonMock.mockRejectedValue(new Error('registry down'));
    const failed = await installRegistryServer('x/y');
    expect(failed.installed).toBe(false);
    expect(failed.error).toContain('registry down');
  });
});
