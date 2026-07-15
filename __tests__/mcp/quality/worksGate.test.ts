// The registry list every lookup returns: a "dead" server (0 tools) ranked
// first, then a "good" one. Names sanitize to "dead" / "good".
const mockRegistryData = {
  servers: [
    {
      server: { name: 'io.x/dead', packages: [{ registryType: 'npm', identifier: 'dead-pkg' }] },
      _meta: { 'io.modelcontextprotocol.registry/official': { status: 'active' } },
    },
    {
      server: { name: 'io.x/good', packages: [{ registryType: 'npm', identifier: 'good-pkg' }] },
      _meta: { 'io.modelcontextprotocol.registry/official': { status: 'active' } },
    },
  ],
};

const mockListServerTools = jest.fn(async (name: string) =>
  name === 'good' ? { tools: [{ name: 't' }] } : { tools: [] }
);
const mockDeleteServerConfig = jest.fn(async () => ({ success: true }));
const mockUpdateServerConfig = jest.fn(async () => []);

jest.mock('@/backend/utils/registryClient', () => ({
  REGISTRY_ORIGIN: 'https://registry.example',
  registryGetJson: jest.fn(async () => mockRegistryData),
}));
jest.mock('@/backend/services/mcp/quality/orchestrator', () => ({
  enrichAndRank: jest.fn(async (_q: string, candidates: unknown[]) =>
    candidates.map((c) => ({ candidate: c, score: 1, signals: [] }))
  ),
}));
jest.mock('@/backend/services/mcp/quality/settings', () => ({
  loadQualitySettings: jest.fn(async () => ({ worksGate: true, minScore: 0, providers: [] })),
}));
jest.mock('@/backend/services/mcp', () => ({
  mcpService: {
    loadServerConfigs: jest.fn(async () => []),
    updateServerConfig: (...a: unknown[]) => mockUpdateServerConfig(...(a as [])),
    listServerTools: (name: string) => mockListServerTools(name),
    deleteServerConfig: (name: string) => mockDeleteServerConfig(),
  },
}));

import { installRegistryServer, installBestForCapability } from '@/backend/services/mcp/registryInstall';

describe('works-gate', () => {
  beforeEach(() => {
    mockListServerTools.mockClear();
    mockDeleteServerConfig.mockClear();
    mockUpdateServerConfig.mockClear();
  });

  it('rejects and rolls back a server that exposes zero tools (default gate on)', async () => {
    const res = await installRegistryServer('io.x/dead');
    expect(res.installed).toBe(false);
    expect(res.worksGateRejected).toBe(true);
    expect(mockDeleteServerConfig).toHaveBeenCalledTimes(1); // rolled back
  });

  it('keeps a zero-tool server when the gate is explicitly off', async () => {
    const res = await installRegistryServer('io.x/dead', undefined, { worksGate: false });
    expect(res.installed).toBe(true);
    expect(mockDeleteServerConfig).not.toHaveBeenCalled();
  });

  it('installs a working server normally', async () => {
    const res = await installRegistryServer('io.x/good');
    expect(res.installed).toBe(true);
    expect(res.serverName).toBe('good');
    expect(res.tools).toEqual([{ name: 't' }]);
    expect(mockDeleteServerConfig).not.toHaveBeenCalled();
  });

  it('installBestForCapability walks best→worst, skipping the dead one for the good one', async () => {
    const res = await installBestForCapability('anything');
    expect(res.installed).toBe(true);
    expect(res.serverName).toBe('good');
    // the dead candidate was attempted, rejected, rolled back, and recorded.
    expect(mockDeleteServerConfig).toHaveBeenCalledTimes(1);
    expect(res.attempts).toHaveLength(1);
    expect(res.attempts![0]).toMatchObject({ name: 'io.x/dead' });
    expect(res.attempts![0].reason).toContain('works-gate');
  });

  it('installBestForCapability invokes the audit hook for each attempt', async () => {
    const onAttempt = jest.fn();
    await installBestForCapability('anything', undefined, { onAttempt });
    // one for the dead (rejected) attempt, one for the good (installed) attempt.
    expect(onAttempt).toHaveBeenCalledTimes(2);
  });
});
