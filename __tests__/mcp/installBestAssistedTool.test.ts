const researchMcpServersMock = jest.fn();
jest.mock('@/backend/services/mcp/assistedInstall', () => ({
  researchMcpServers: (...args: unknown[]) => researchMcpServersMock(...args),
  sameMcpInstallPlan: (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right),
}));

const installRegistryServerMock = jest.fn();
const installBestForCapabilityMock = jest.fn();
const findBestRegistryServersMock = jest.fn();
jest.mock('@/backend/services/mcp/registryInstall', () => ({
  searchRegistry: jest.fn(),
  findBestRegistryServers: (...args: unknown[]) => findBestRegistryServersMock(...args),
  installRegistryServer: (...args: unknown[]) => installRegistryServerMock(...args),
  installBestForCapability: (...args: unknown[]) => installBestForCapabilityMock(...args),
}));

const loadModelsMock = jest.fn();
jest.mock('@/backend/services/model', () => ({
  modelService: {
    loadModels: (...args: unknown[]) => loadModelsMock(...args),
  },
}));

const loadAutoInstallSettingsMock = jest.fn();
const appendInstallAuditMock = jest.fn();
jest.mock('@/backend/services/mcp/autoInstall', () => ({
  loadAutoInstallSettings: (...args: unknown[]) => loadAutoInstallSettingsMock(...args),
  appendInstallAudit: (...args: unknown[]) => appendInstallAuditMock(...args),
}));

jest.mock('@/backend/services/flow/assistedAuthoring', () => ({
  suggestToolsForFlowStep: jest.fn(),
  applyToolsToFlowStep: jest.fn(),
  checkFlowPlausibility: jest.fn(),
}));

import { authoringCallTool } from '@/backend/services/mcp/flowAuthoringTools';
import { DEFAULT_MCP_AUTO_INSTALL_SETTINGS } from '@/utils/mcp/autoInstallConsent';

const plan = {
  registryName: 'com.paypal/mcp',
  resolvedName: 'com.paypal/mcp',
  serverName: 'paypal',
  transport: 'stdio' as const,
  command: 'npx',
  args: ['-y', '@paypal/mcp@1.2.3'],
  requiredEnvNames: ['PAYPAL_TOKEN'],
  verificationStatus: 'active',
};

const researchResult = {
  query: 'connect my PayPal account',
  summary: 'The local PayPal package is the strongest evidenced option.',
  recommendedId: 'com.paypal/mcp::stdio',
  generatedAt: '2026-08-02T00:00:00.000Z',
  sources: [
    { id: 'registry', label: 'Official MCP Registry', url: 'https://registry.modelcontextprotocol.io/', status: 'searched' },
    { id: 'github', label: 'GitHub', url: 'https://github.com/search', status: 'searched' },
    { id: 'npm', label: 'npm', url: 'https://www.npmjs.com/search', status: 'searched' },
    { id: 'awesome-mcp', label: 'Awesome MCP', url: 'https://github.com/punkpeye/awesome-mcp-servers', status: 'searched' },
  ],
  candidates: [{
    id: 'com.paypal/mcp::stdio',
    registryName: 'com.paypal/mcp',
    title: 'PayPal MCP',
    description: 'PayPal tools',
    score: 92,
    recommended: true,
    plan,
    config: { name: 'paypal', transport: 'stdio' },
    authMode: 'none',
    freeNote: 'Free to install locally; service charges may apply.',
    reasons: ['Popular npm package', 'Active Registry entry'],
    warnings: [],
    requiredInputs: ['PAYPAL_TOKEN'],
    weeklyDownloads: 12_345,
    verificationStatus: 'active',
    alternateTransports: [],
  }],
};

function payload(result: { content: Array<{ type: string; text?: string }> }): any {
  return JSON.parse(result.content[0].text!);
}

beforeEach(() => {
  jest.clearAllMocks();
  loadModelsMock.mockResolvedValue([{ id: 'research-model', name: 'research-model', ApiKey: 'encrypted' }]);
  loadAutoInstallSettingsMock.mockResolvedValue({ ...DEFAULT_MCP_AUTO_INSTALL_SETTINGS });
  appendInstallAuditMock.mockResolvedValue(undefined);
  researchMcpServersMock.mockResolvedValue(researchResult);
  installRegistryServerMock.mockImplementation(async (_name: string, _env: unknown, options: { resolveOnly?: boolean }) => {
    if (options?.resolveOnly) return { installed: false, plan };
    return { installed: true, serverName: 'paypal', tools: [{ name: 'create_invoice' }], plan };
  });
  findBestRegistryServersMock.mockResolvedValue([{ name: 'com.paypal/mcp', installable: true, requiredEnv: [] }]);
});

describe('install_best_mcp_server assisted mode', () => {
  it('keeps find_best_mcp_server strictly read-only', async () => {
    const result = await authoringCallTool('find_best_mcp_server', {
      capability: 'connect my PayPal account',
    });
    const body = payload(result);
    expect(result.isError).toBeUndefined();
    expect(body).toEqual(expect.objectContaining({
      installed: false,
      researchMode: 'ai-assisted',
      recommendedId: 'com.paypal/mcp::stdio',
    }));
    expect(researchMcpServersMock).toHaveBeenCalledTimes(1);
    expect(installRegistryServerMock).not.toHaveBeenCalled();
    expect(installBestForCapabilityMock).not.toHaveBeenCalled();
    expect(appendInstallAuditMock).not.toHaveBeenCalled();
  });

  it('uses read-only deterministic ranking when no research model is configured', async () => {
    loadModelsMock.mockResolvedValue([]);
    const body = payload(await authoringCallTool('find_best_mcp_server', {
      capability: 'search transcripts',
      limit: 3,
    }));
    expect(body).toEqual(expect.objectContaining({
      installed: false,
      researchMode: 'registry-fallback',
      candidates: [{ name: 'com.paypal/mcp', installable: true, requiredEnv: [] }],
    }));
    expect(findBestRegistryServersMock).toHaveBeenCalledWith('search transcripts', 3);
    expect(installRegistryServerMock).not.toHaveBeenCalled();
    expect(installBestForCapabilityMock).not.toHaveBeenCalled();
  });

  it('uses the wizard research, filters credentials per exact plan, and audits before execution', async () => {
    const result = await authoringCallTool('install_best_mcp_server', {
      capability: 'connect my PayPal account',
      env: { PAYPAL_TOKEN: 'paypal-secret', UNRELATED_SECRET: 'do-not-forward' },
    });
    const body = payload(result);

    expect(result.isError).toBeUndefined();
    expect(body.installed).toBe(true);
    expect(body.selectedCandidateId).toBe('com.paypal/mcp::stdio');
    expect(body.research).toEqual(expect.objectContaining({ mode: 'ai-assisted', modelId: 'research-model' }));
    expect(researchMcpServersMock).toHaveBeenCalledWith({
      query: 'connect my PayPal account',
      modelId: 'research-model',
    });
    expect(installRegistryServerMock).toHaveBeenCalledTimes(2);
    expect(installRegistryServerMock.mock.calls[1][1]).toEqual({ PAYPAL_TOKEN: 'paypal-secret' });
    expect(installRegistryServerMock.mock.calls[1][2]).toEqual(expect.objectContaining({
      preferredTransport: 'stdio',
      serverName: 'paypal',
      worksGate: true,
    }));
    expect(appendInstallAuditMock).toHaveBeenCalledTimes(2);
    expect(appendInstallAuditMock.mock.invocationCallOrder[0])
      .toBeLessThan(installRegistryServerMock.mock.invocationCallOrder[1]);
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('paypal-secret');
    expect(serialized).not.toContain('do-not-forward');
  });

  it('returns the researched candidate and exact plan without executing when consent is required', async () => {
    loadAutoInstallSettingsMock.mockResolvedValue({
      requireConsent: true,
      trustBrainStem: false,
      namespaceAllowlist: [],
    });

    const result = await authoringCallTool('install_best_mcp_server', {
      capability: 'connect my PayPal account',
      env: { PAYPAL_TOKEN: 'paypal-secret' },
    });
    const body = payload(result);

    expect(body).toEqual(expect.objectContaining({
      installed: false,
      consentRequired: true,
      plan,
      candidate: expect.objectContaining({ registryName: 'com.paypal/mcp' }),
    }));
    expect(installRegistryServerMock).toHaveBeenCalledTimes(1);
    expect(appendInstallAuditMock).toHaveBeenCalledTimes(1);
    expect(appendInstallAuditMock.mock.calls[0][0]).toEqual(expect.objectContaining({
      installed: false,
      consent: expect.objectContaining({ allowed: false }),
    }));
  });
});
