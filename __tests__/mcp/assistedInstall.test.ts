const installRegistryServerMock = jest.fn();

jest.mock('@/backend/services/mcp/registryInstall', () => ({
  installRegistryServer: (...args: unknown[]) => installRegistryServerMock(...args),
  resolveRegistryEntry: jest.fn(),
  searchRegistry: jest.fn(),
}));

import { installAssistedMcpServer } from '@/backend/services/mcp/assistedInstall';

const plan = {
  registryName: 'io.example/search',
  resolvedName: 'io.example/search',
  serverName: 'search',
  transport: 'stdio' as const,
  command: 'npx',
  args: ['-y', '@example/search'],
  requiredEnvNames: ['SEARCH_KEY'],
  verificationStatus: 'active',
};

describe('installAssistedMcpServer', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('does not resolve or install without explicit reviewed-plan approval', async () => {
    const result = await installAssistedMcpServer({
      registryName: 'io.example/search',
      transport: 'stdio',
      reviewedPlan: plan,
      approved: false as true,
    });

    expect(result.installed).toBe(false);
    expect(result.error).toMatch(/approve/i);
    expect(installRegistryServerMock).not.toHaveBeenCalled();
  });

  it('rejects credential fields that were not declared by the reviewed plan', async () => {
    installRegistryServerMock.mockResolvedValueOnce({ installed: false, plan });

    const result = await installAssistedMcpServer({
      registryName: 'io.example/search',
      transport: 'stdio',
      reviewedPlan: plan,
      approved: true,
      inputs: { SEARCH_KEY: 'allowed', SURPRISE_TOKEN: 'blocked' },
    });

    expect(result.installed).toBe(false);
    expect(result.error).toContain('SURPRISE_TOKEN');
    expect(installRegistryServerMock).toHaveBeenCalledTimes(1);
  });

  it('aborts when the Registry command changes after the user reviewed it', async () => {
    installRegistryServerMock.mockResolvedValueOnce({
      installed: false,
      plan: { ...plan, args: ['-y', '@example/search@2.0.0'] },
    });

    const result = await installAssistedMcpServer({
      registryName: 'io.example/search',
      transport: 'stdio',
      reviewedPlan: plan,
      approved: true,
      inputs: { SEARCH_KEY: 'secret-value' },
    });

    expect(result.installed).toBe(false);
    expect(result.error).toMatch(/changed after review/i);
    expect(installRegistryServerMock).toHaveBeenCalledTimes(1);
  });

  it('installs only the exact transport that was reviewed', async () => {
    installRegistryServerMock
      .mockResolvedValueOnce({ installed: false, plan })
      .mockResolvedValueOnce({ installed: true, serverName: 'search', plan, tools: [{ name: 'search' }] });

    const result = await installAssistedMcpServer({
      registryName: 'io.example/search',
      transport: 'stdio',
      reviewedPlan: plan,
      approved: true,
      inputs: { SEARCH_KEY: 'secret-value' },
    });

    expect(result.installed).toBe(true);
    expect(installRegistryServerMock).toHaveBeenLastCalledWith(
      'io.example/search',
      { SEARCH_KEY: 'secret-value' },
      expect.objectContaining({ preferredTransport: 'stdio', worksGate: true }),
    );
  });
});
