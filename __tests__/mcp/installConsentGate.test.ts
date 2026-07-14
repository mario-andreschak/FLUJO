/**
 * SEP-1024 consent gate on the headless /mcp-flows `install_mcp_server` authoring
 * tool (issue #98). Proves the tool cannot silently spawn a server: an untrusted
 * caller gets the resolved plan + consentRequired instead of an install, and an
 * audit entry is written BEFORE any spawn on every path.
 */

const registryGetJsonMock = jest.fn();
jest.mock('@/backend/utils/registryClient', () => ({
  REGISTRY_ORIGIN: 'https://registry.test',
  registryGetJson: (...a: unknown[]) => registryGetJsonMock(...a),
}));

const loadServerConfigsMock = jest.fn();
const updateServerConfigMock = jest.fn();
const listServerToolsMock = jest.fn();
const getServerStatusMock = jest.fn();
jest.mock('@/backend/services/mcp', () => ({
  mcpService: {
    loadServerConfigs: (...a: unknown[]) => loadServerConfigsMock(...a),
    updateServerConfig: (...a: unknown[]) => updateServerConfigMock(...a),
    listServerTools: (...a: unknown[]) => listServerToolsMock(...a),
    getServerStatus: (...a: unknown[]) => getServerStatusMock(...a),
  },
}));

// Control the settings and capture audit writes without touching disk.
const loadAutoInstallSettingsMock = jest.fn();
const appendInstallAuditMock = jest.fn();
jest.mock('@/backend/services/mcp/autoInstall', () => ({
  loadAutoInstallSettings: (...a: unknown[]) => loadAutoInstallSettingsMock(...a),
  appendInstallAudit: (...a: unknown[]) => appendInstallAuditMock(...a),
}));

import { authoringCallTool } from '@/backend/services/mcp/flowAuthoringTools';
import { DEFAULT_MCP_AUTO_INSTALL_SETTINGS } from '@/utils/mcp/autoInstallConsent';

const npmEntry = (name: string) => ({
  server: {
    name,
    packages: [
      { registryType: 'npm', identifier: `@example/${name.split('/').pop()}`, version: '1.0.0', transport: { type: 'stdio' } },
    ],
  },
});

function payload(result: { content: Array<{ type: string }> }): any {
  const first = result.content[0] as { type: string; text?: string };
  return JSON.parse(first.text!);
}

beforeEach(() => {
  jest.clearAllMocks();
  registryGetJsonMock.mockResolvedValue({ servers: [npmEntry('ai.example/web-search')] });
  loadServerConfigsMock.mockResolvedValue([]);
  updateServerConfigMock.mockResolvedValue({ name: 'web-search' });
  listServerToolsMock.mockResolvedValue({ tools: [{ name: 'search' }] });
  appendInstallAuditMock.mockResolvedValue(undefined);
});

describe('install_mcp_server consent gate', () => {
  it('does NOT spawn when consent is required (untrusted) — returns the plan + consentRequired, audits first', async () => {
    // Untrusted authoring tool: brain-stem trust off, consent required, empty allowlist.
    loadAutoInstallSettingsMock.mockResolvedValue({
      requireConsent: true,
      trustBrainStem: false,
      namespaceAllowlist: [],
    });

    const result = await authoringCallTool('install_mcp_server', { name: 'ai.example/web-search' });
    const body = payload(result);

    expect(body.consentRequired).toBe(true);
    expect(body.installed).toBe(false);
    expect(body.plan).toEqual(expect.objectContaining({ command: 'npx', serverName: 'web-search' }));
    // Crucially: nothing was spawned.
    expect(updateServerConfigMock).not.toHaveBeenCalled();
    // And an audit entry was written before the (skipped) spawn, marked not-installed.
    expect(appendInstallAuditMock).toHaveBeenCalledTimes(1);
    expect(appendInstallAuditMock.mock.calls[0][0]).toEqual(
      expect.objectContaining({ installed: false, consent: expect.objectContaining({ allowed: false }) })
    );
  });

  it('an allowlisted namespace lets the untrusted tool install (and audits twice)', async () => {
    loadAutoInstallSettingsMock.mockResolvedValue({
      requireConsent: true,
      trustBrainStem: false,
      namespaceAllowlist: ['ai.example'],
    });

    const result = await authoringCallTool('install_mcp_server', { name: 'ai.example/web-search' });
    const body = payload(result);

    expect(body.installed).toBe(true);
    expect(updateServerConfigMock).toHaveBeenCalledTimes(1);
    // resolve-only audit + post-install audit.
    expect(appendInstallAuditMock).toHaveBeenCalledTimes(2);
  });

  it('trustBrainStem (default) installs without a consent prompt', async () => {
    loadAutoInstallSettingsMock.mockResolvedValue({ ...DEFAULT_MCP_AUTO_INSTALL_SETTINGS });
    const result = await authoringCallTool('install_mcp_server', { name: 'ai.example/web-search' });
    const body = payload(result);
    expect(body.installed).toBe(true);
    expect(body.consentRequired).toBeUndefined();
    expect(updateServerConfigMock).toHaveBeenCalledTimes(1);
  });
});
