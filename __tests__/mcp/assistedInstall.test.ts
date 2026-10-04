const installRegistryServerMock = jest.fn();
const getModelMock = jest.fn();

jest.mock('@/backend/services/model', () => ({
  modelService: { getModel: (...args: unknown[]) => getModelMock(...args) },
}));

jest.mock('@/backend/services/mcp/registryInstall', () => ({
  installRegistryServer: (...args: unknown[]) => installRegistryServerMock(...args),
  resolveRegistryEntry: jest.fn(),
  searchRegistry: jest.fn(),
}));

import {
  assistantRequiredInputs,
  installAssistedMcpServer,
  normalizeMcpAssistantServerName,
  researchMcpServers,
} from '@/backend/services/mcp/assistedInstall';

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
      serverName: 'search',
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
      serverName: 'search',
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
      serverName: 'search',
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
      serverName: 'search',
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

  it('installs a DCR endpoint without requesting or saving a static Authorization value', async () => {
    const dcrPlan = {
      ...plan,
      registryName: 'com.paypal.mcp/mcp',
      resolvedName: 'com.paypal.mcp/mcp',
      serverName: 'paypal',
      transport: 'streamable' as const,
      command: undefined,
      args: undefined,
      serverUrl: 'https://mcp.paypal.com/mcp',
      requiredEnvNames: [],
    };
    installRegistryServerMock
      .mockResolvedValueOnce({ installed: false, plan: dcrPlan })
      .mockResolvedValueOnce({ installed: true, serverName: 'paypal', plan: dcrPlan, tools: [] });

    const result = await installAssistedMcpServer({
      registryName: 'com.paypal.mcp/mcp',
      transport: 'streamable',
      serverName: 'paypal',
      reviewedPlan: dcrPlan,
      approved: true,
      authMode: 'oauth-dcr',
    });

    expect(result).toEqual(expect.objectContaining({ installed: true, needsAuthentication: true }));
    expect(installRegistryServerMock).toHaveBeenLastCalledWith(
      'com.paypal.mcp/mcp',
      undefined,
      expect.objectContaining({
        serverName: 'paypal',
        oauthDynamicClientRegistration: true,
        headerOverrides: {},
      }),
    );
  });
});

describe('owner-bound assisted research', () => {
  it('stops before web discovery when a saved policy has become unavailable', async () => {
    getModelMock.mockResolvedValueOnce(null);
    const fetchSpy = jest.spyOn(global, 'fetch');
    try {
      await expect(researchMcpServers({ query: 'search documents', modelId: 'policy-model' }))
        .rejects.toThrow(/not found or unavailable/i);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('stops before web discovery and key resolution', async () => {
    installRegistryServerMock.mockClear();
    getModelMock.mockResolvedValueOnce({
      id: 'owner-model', name: 'bound', ApiKey: '', ownerCredentialBinding: null,
    });
    const fetchSpy = jest.spyOn(global, 'fetch');
    try {
      await expect(researchMcpServers({ query: 'search documents', modelId: 'owner-model' }))
        .rejects.toThrow(/authorized model-step transport/i);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(installRegistryServerMock).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe('assisted install policy helpers', () => {
  it('uses the AI service name instead of a generic Registry slug', () => {
    expect(normalizeMcpAssistantServerName('PayPal MCP Server', 'paypal-mcp')).toBe('paypal');
    expect(normalizeMcpAssistantServerName('mcp', 'paypal-mcp')).toBe('paypal');
  });

  it('omits only Authorization when DCR was advertised', () => {
    const option = {
      kind: 'remote' as const,
      label: 'Hosted',
      remote: {
        type: 'streamable-http',
        url: 'https://mcp.paypal.com/mcp',
        headers: [
          { name: 'Authorization', isRequired: true },
          { name: 'X-Tenant', isRequired: true },
        ],
      },
    };
    expect(assistantRequiredInputs(option, 'oauth-dcr')).toEqual(['X-Tenant']);
    expect(assistantRequiredInputs(option, 'oauth-manual')).toEqual(['Authorization', 'X-Tenant']);
  });
});
