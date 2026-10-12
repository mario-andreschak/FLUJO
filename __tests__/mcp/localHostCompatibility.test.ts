import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { MCPStdioConfig } from '@/shared/types/mcp';
import { attachLocalHostLaunch, getLocalHostLaunch, localHostMcpAllowed } from '@/backend/services/mcp/localHost';
import { assertHostMcpLaunchAllowed, assertMcpIsolationDispatch } from '@/backend/services/mcp/isolation';
import { executionApprovalFailure } from '@/backend/services/mcp/executionApproval';
import { TrustedHostMcpError } from '@/backend/services/security/trustedHostMcp';

let mockConfig: MCPStdioConfig;
jest.mock('@/backend/services/mcp/config', () => ({ loadServerConfigs: async () => [mockConfig] }));

const environmentNames = ['FLUJO_OWNER_AUTH_FILE', 'FLUJO_MCP_TRUSTED_HOST_FILE',
  'FLUJO_MCP_ISOLATION_FILE', 'FLUJO_WORKER_MODE', 'FLUJO_EXPOSURE_MODE',
  'FLUJO_EXTRA_LOCAL_HOSTS', 'FLUJO_MCP_APP_HOST_ORIGINS', 'FLUJO_MCP_APP_SANDBOX_PUBLIC_URL'];
let previous: Record<string, string | undefined>;
beforeEach(() => {
  previous = Object.fromEntries(environmentNames.map(name => [name, process.env[name]]));
  for (const name of environmentNames) delete process.env[name];
  process.env.FLUJO_EXPOSURE_MODE = 'localhost';
  mockConfig = { name: 'bash', transport: 'stdio', command: 'node', args: ['dist/index.js'],
    disabled: false, rootPath: 'mcp-servers/bash', env: {}, _installCommand: '', _buildCommand: '' };
});
afterEach(() => {
  for (const [name, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
});

it.each(['bash', 'browser', 'filesystem', 'flujo', 'installed-third-party'])('admits an existing local %s server', name => {
  mockConfig.name = name;
  expect(() => assertHostMcpLaunchAllowed(mockConfig)).not.toThrow();
});

it.each([
  ['FLUJO_OWNER_AUTH_FILE', ''], ['FLUJO_MCP_TRUSTED_HOST_FILE', 'missing'],
  ['FLUJO_MCP_ISOLATION_FILE', 'missing'], ['FLUJO_WORKER_MODE', '1'],
  ['FLUJO_EXPOSURE_MODE', 'network'], ['FLUJO_EXPOSURE_MODE', 'public'],
])('does not downgrade %s=%s to the local path', (name, value) => {
  process.env[name] = value;
  expect(localHostMcpAllowed(mockConfig)).toBe(false);
  expect(() => assertHostMcpLaunchAllowed(mockConfig)).toThrow();
});

it('does not downgrade an explicit server profile', () => {
  expect(localHostMcpAllowed({ ...mockConfig, trustedHost: {} })).toBe(false);
  expect(localHostMcpAllowed({ ...mockConfig, isolation: {} })).toBe(false);
});

it('allows dispatch only from its captured local transport and current launch config', async () => {
  const transport = { start: jest.fn(async () => undefined) };
  const close = jest.fn(async () => undefined);
  attachLocalHostLaunch(transport, mockConfig, config => JSON.stringify([config.command, config.args]));
  const wrapper = { __flujoInnerTransport: transport };
  expect(getLocalHostLaunch(wrapper)).toBeDefined();
  const client = { transport: wrapper, close } as unknown as Client;
  await expect(assertMcpIsolationDispatch(client, mockConfig.name)).resolves.toBeUndefined();
  mockConfig.args = ['different-server.js'];
  await expect(assertMcpIsolationDispatch(client, mockConfig.name)).rejects.toMatchObject({ code: 'HOST_CONSENT_REQUIRED' });
  expect(close).toHaveBeenCalledTimes(1);
});

it('revokes a local transport when a protected profile is selected', () => {
  const transport = { start: jest.fn(async () => undefined) };
  attachLocalHostLaunch(transport, mockConfig, config => config.command);
  process.env.FLUJO_OWNER_AUTH_FILE = 'selected-policy';
  expect(() => getLocalHostLaunch(transport)!.assertCurrent(mockConfig)).toThrow();
});

it('denies untracked local clients even when compatibility mode is available', async () => {
  const client = { transport: {}, close: jest.fn() } as unknown as Client;
  await expect(assertMcpIsolationDispatch(client, mockConfig.name)).rejects.toMatchObject({ code: 'HOST_CONSENT_REQUIRED' });
});

it('returns an expected approval result without including stack traces', () => {
  expect(executionApprovalFailure(new TrustedHostMcpError('HOST_CONSENT_REQUIRED')))
    .toMatchObject({ success: false, requiresApproval: true, errorType: 'execution-approval', statusCode: 409 });
  expect(executionApprovalFailure(new Error('unexpected crash'))).toBeUndefined();
});
