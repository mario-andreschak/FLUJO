import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, DEFAULT_INHERITED_ENV_VARS } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StdioClientTransport as BetaStdioClientTransport, DEFAULT_INHERITED_ENV_VARS as BETA_INHERITED_ENV_VARS } from '@modelcontextprotocol/client/stdio';
import type { MCPStdioConfig } from '@/shared/types/mcp';
import { getCurrentWorkspace, getWorkspaceDataDir } from '@/utils/workspace';
import { createStdioTransport } from '@/backend/services/mcp/connection';
import { createBetaTransport, createNewBetaClient } from '@/backend/services/mcp/betaClient';
import { loadServerConfigs } from '@/backend/services/mcp/config';
import { assertMcpIsolationDispatch } from '@/backend/services/mcp/isolation';
import { getManagedTrustedHost } from '@/backend/services/mcp/trustedHost';
import { fingerprintTrustedHostExecutable, fingerprintTrustedHostSource, trustedHostMcpPolicyDigest } from '@/backend/services/security/trustedHostMcp';
import { callTool } from '@/backend/services/mcp/tools';
import { createRootsListHandler, setNodeRoots, _resetNodeRootsForTests } from '@/backend/services/mcp/roots';
import { resolveGlobalVars } from '@/backend/utils/resolveGlobalVars';

jest.mock('@/backend/services/mcp/config', () => ({ loadServerConfigs: jest.fn() }));
jest.mock('@/utils/storage/backend', () => ({ loadItem: jest.fn(async () => undefined), saveItem: jest.fn() }));
jest.mock('@/backend/utils/resolveGlobalVars', () => ({ resolveGlobalVars: jest.fn(() => {
  throw new Error('Trusted host dispatch must not access the shared secret store');
}) }));

let directory: string;
let config: MCPStdioConfig;
let saved: Record<string, string | undefined>;
let grant: { schemaVersion: number; ownerId: string; approvals: Array<{ workspace: string; serverName: string; policyDigest: string; expiresAt: number }> };
const configs = jest.mocked(loadServerConfigs);
function persist() { fs.writeFileSync(process.env.FLUJO_MCP_TRUSTED_HOST_FILE!, JSON.stringify(grant), { mode: 0o600 }); }
function approve(current = config) { grant.approvals[0].policyDigest = trustedHostMcpPolicyDigest(current); persist(); }

beforeEach(() => {
  saved = Object.fromEntries(['FLUJO_DATA_DIR', 'FLUJO_PARENT_DATA_DIR', 'FLUJO_OWNER_AUTH_FILE', 'FLUJO_MCP_TRUSTED_HOST_FILE', 'FLUJO_MCP_ISOLATION_FILE'].map(name => [name, process.env[name]]));
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'flujo-trusted-transport-'));
  process.env.FLUJO_DATA_DIR = path.join(directory, 'data');
  delete process.env.FLUJO_PARENT_DATA_DIR;
  delete process.env.FLUJO_MCP_ISOLATION_FILE;
  process.env.FLUJO_OWNER_AUTH_FILE = path.join(directory, 'owner.json');
  process.env.FLUJO_MCP_TRUSTED_HOST_FILE = path.join(directory, 'approval.json');
  fs.writeFileSync(process.env.FLUJO_OWNER_AUTH_FILE, JSON.stringify({ schemaVersion: 1, ownerId: 'synthetic-owner', credentials: [] }), { mode: 0o600 });
  const sourceRoot = path.join(getWorkspaceDataDir(), 'mcp-servers', 'fixed');
  fs.mkdirSync(sourceRoot, { recursive: true });
  const command = path.join(sourceRoot, 'synthetic-executable');
  fs.writeFileSync(command, 'never executed; SDK startup is explicitly modeled');
  const env = { APPROVED_TOKEN: 'synthetic-scoped-value', ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot ?? 'C:\\Windows' } : {}) };
  config = { name: 'trusted-fixture', transport: 'stdio', command, args: [], cwd: sourceRoot, disabled: false,
    rootPath: '', roots: [], env, _buildCommand: '', _installCommand: '',
    trustedHost: { schemaVersion: 1, kind: 'trusted-host', privileges: 'owner-account', runtime: 'native', entryPoint: command,
      sourceRoot, sourceDigest: fingerprintTrustedHostSource(sourceRoot), executableDigest: fingerprintTrustedHostExecutable(command), environmentNames: Object.keys(env) } };
  grant = { schemaVersion: 1, ownerId: 'synthetic-owner', approvals: [{ workspace: getCurrentWorkspace(), serverName: config.name,
    policyDigest: trustedHostMcpPolicyDigest(config), expiresAt: Date.now() + 60_000 }] };
  persist();
  configs.mockReset().mockResolvedValue([config]);
  jest.mocked(resolveGlobalVars).mockClear();
});

afterEach(() => {
  jest.restoreAllMocks();
  _resetNodeRootsForTests();
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
  if (path.dirname(directory) !== path.resolve(os.tmpdir()) || !/^flujo-trusted-transport-[A-Za-z0-9]+$/.test(path.basename(directory)) || fs.lstatSync(directory).isSymbolicLink()) throw new Error('Unsafe owned fixture cleanup');
  fs.rmSync(directory, { recursive: true, force: true });
});

test.each(['v1', 'beta'])('%s factory binds fixed parameters and suppresses both SDK inherited defaults', async era => {
  const transport = era === 'v1' ? createStdioTransport(config) : createBetaTransport(config);
  const parameters = (transport as unknown as { _serverParams: { command: string; args: string[]; env: Record<string, string>; cwd: string } })._serverParams;
  expect(parameters.command).toBe(config.command);
  expect(parameters.cwd).toBe(config.cwd);
  expect(parameters.env.APPROVED_TOKEN).toBe('synthetic-scoped-value');
  for (const name of new Set([...DEFAULT_INHERITED_ENV_VARS, ...BETA_INHERITED_ENV_VARS])) {
    if (process.platform === 'win32' && name.toUpperCase() === 'SYSTEMROOT') continue;
    expect(parameters.env[name]).toBe('');
  }
  expect(Object.isFrozen(parameters)).toBe(true);
  expect(Object.isFrozen(parameters.args)).toBe(true);
  expect(Object.isFrozen(parameters.env)).toBe(true);
  expect(getManagedTrustedHost(transport)?.serverName).toBe(config.name);
  await transport.close();
});

test.each(['v1', 'beta'])('%s refuses revoked consent before SDK start and retires the generation', async era => {
  const start = jest.spyOn(era === 'v1' ? StdioClientTransport.prototype : BetaStdioClientTransport.prototype, 'start').mockResolvedValue();
  const transport = era === 'v1' ? createStdioTransport(config) : createBetaTransport(config);
  grant.approvals = []; persist();
  await expect(transport.start()).rejects.toMatchObject({ code: 'HOST_CONSENT_REQUIRED' });
  expect(start).not.toHaveBeenCalled();
  await expect(getManagedTrustedHost(transport)!.assertCurrent(config)).rejects.toMatchObject({ code: 'HOST_CONSENT_REQUIRED' });
});

test.each(['v1', 'beta'])('%s refuses an imported profile without private owner approval', era => {
  delete process.env.FLUJO_MCP_TRUSTED_HOST_FILE;
  expect(() => era === 'v1' ? createStdioTransport(config) : createBetaTransport(config)).toThrow('explicit owner consent');
});

test('actual tool preflight refuses revocation before discovery or shared-secret reads', async () => {
  const transport = createStdioTransport(config);
  const sdkCall = jest.fn();
  const list = jest.fn();
  const close = jest.fn(() => transport.close());
  grant.approvals = []; persist();
  const client = { transport, callTool: sdkCall, listTools: list, close } as unknown as Client;
  expect(await callTool(client, config.name, 'probe', { secret: '${global:UNAPPROVED}' }, 5, undefined, undefined, 'model'))
    .toMatchObject({ success: false, error: 'HOST_CONSENT_REQUIRED', statusCode: 403 });
  expect(sdkCall).not.toHaveBeenCalled();
  expect(list).not.toHaveBeenCalled();
  expect(resolveGlobalVars).not.toHaveBeenCalled();
  expect(close).toHaveBeenCalledTimes(1);
});

test.each(['removed', 'disabled'])('untracked dispatch refuses a %s current server', async state => {
  configs.mockResolvedValue(state === 'removed' ? [] : [{ ...config, disabled: true }]);
  const close = jest.fn();
  await expect(assertMcpIsolationDispatch({ transport: {}, close } as unknown as Client, config.name)).rejects.toMatchObject({ code: 'ISOLATION_RECONSENT_REQUIRED' });
  expect(close).toHaveBeenCalledTimes(1);
});

test.each(['v1', 'beta'])('%s closes a modeled startup if consent is revoked while SDK start awaits', async era => {
  jest.spyOn(era === 'v1' ? StdioClientTransport.prototype : BetaStdioClientTransport.prototype, 'start').mockImplementation(async () => { grant.approvals = []; persist(); });
  const close = jest.spyOn(era === 'v1' ? StdioClientTransport.prototype : BetaStdioClientTransport.prototype, 'close').mockResolvedValue();
  const transport = era === 'v1' ? createStdioTransport(config) : createBetaTransport(config);
  await expect(transport.start()).rejects.toMatchObject({ code: 'HOST_CONSENT_REQUIRED' });
  expect(close).toHaveBeenCalledTimes(1);
});

test('a newly approved same-name revision cannot authorize the older client', async () => {
  const transport = createStdioTransport(config);
  const changed = { ...config, args: ['new-revision'] };
  approve(changed);
  configs.mockResolvedValue([changed]);
  const close = jest.fn(() => transport.close());
  await expect(assertMcpIsolationDispatch({ transport, close } as unknown as Client, config.name, config)).rejects.toMatchObject({ code: 'HOST_CONSENT_REQUIRED' });
  expect(close).toHaveBeenCalledTimes(1);
});

test('tool dispatch forwards literals, denies shared-secret references and redacts SDK errors', async () => {
  const transport = createStdioTransport(config);
  const sdkCall = jest.fn().mockResolvedValue({ content: [{ type: 'text', text: 'synthetic result' }] });
  const client = { transport, callTool: sdkCall, close: () => transport.close() } as unknown as Client;
  expect(await callTool(client, config.name, 'probe', { literal: 'scoped input' }, 5)).toMatchObject({ success: true });
  expect(sdkCall.mock.calls[0][0].arguments).toEqual({ literal: 'scoped input' });
  expect(await callTool(client, config.name, 'probe', { secret: '${global:UNAPPROVED}' }, 5)).toMatchObject({ success: false, error: 'HOST_POLICY_INVALID', statusCode: 403 });
  sdkCall.mockRejectedValue(new Error('synthetic private SDK diagnostic'));
  const failed = await callTool(client, config.name, 'probe', {}, 5);
  expect(failed).toMatchObject({ success: false, error: 'TRUSTED_HOST_TOOL_FAILED' });
  expect(JSON.stringify(failed)).not.toContain('synthetic private SDK diagnostic');
  expect(resolveGlobalVars).not.toHaveBeenCalled();
  await transport.close();
});

test('wrapped untracked local clients refuse before discovery or interpolation', async () => {
  const call = jest.fn();
  const list = jest.fn();
  const close = jest.fn();
  configs.mockResolvedValue([{ name: config.name, transport: 'sse', serverUrl: 'https://example.invalid', disabled: false,
    rootPath: '', env: {}, _buildCommand: '', _installCommand: '' }]);
  const client = { transport: { __flujoInnerTransport: { __flujoKind: 'stdio' } }, callTool: call, listTools: list, close } as unknown as Client;
  expect(await callTool(client, config.name, 'probe', {}, 5, undefined, undefined, 'model')).toMatchObject({ success: false, error: 'HOST_CONSENT_REQUIRED' });
  expect(call).not.toHaveBeenCalled();
  expect(list).not.toHaveBeenCalled();
  expect(resolveGlobalVars).not.toHaveBeenCalled();
  expect(close).toHaveBeenCalledTimes(1);
});

test('roots disclose only approved literal entries and reject newly approved stale-client capabilities', async () => {
  config = { ...config, roots: [path.join(directory, 'approved')] };
  approve();
  configs.mockResolvedValue([config]);
  const transport = createStdioTransport(config);
  const owner = { transport, close: () => transport.close() };
  setNodeRoots(config.name, 'synthetic-node', [path.join(directory, 'unapproved-overlay')]);
  const handler = createRootsListHandler(config, owner);
  const result = await handler();
  expect(result.roots).toHaveLength(1);
  expect(result.roots[0].uri).toContain('approved');
  expect(result.roots[0].uri).not.toContain('unapproved-overlay');
  const changed = { ...config, roots: [path.join(directory, 'new-root')] };
  approve(changed);
  configs.mockResolvedValue([changed]);
  expect(await handler()).toEqual({ roots: [] });
  expect(resolveGlobalVars).not.toHaveBeenCalled();
});

test('beta local client refuses automatic sibling-process negotiation', () => {
  const client = createNewBetaClient(config);
  expect((client as unknown as { _versionNegotiation: unknown })._versionNegotiation).toEqual({ mode: 'legacy' });
});

test('natural close preserves SDK callbacks and refuses reuse of the retired generation', async () => {
  const transport = createStdioTransport(config);
  const callback = jest.fn();
  transport.onclose = callback;
  transport.onclose!();
  expect(callback).toHaveBeenCalledTimes(1);
  await expect(getManagedTrustedHost(transport)!.assertCurrent(config)).rejects.toMatchObject({ code: 'HOST_CONSENT_REQUIRED' });
  await transport.close();
});

test('roots removal retires its actual managed generation', async () => {
  const transport = createStdioTransport(config);
  const close = jest.fn(() => transport.close());
  const handler = createRootsListHandler(config, { transport, close });
  configs.mockResolvedValue([]);
  expect(await handler()).toEqual({ roots: [] });
  expect(close).toHaveBeenCalledTimes(1);
  await expect(getManagedTrustedHost(transport)!.assertCurrent(config)).rejects.toMatchObject({ code: 'HOST_CONSENT_REQUIRED' });
});
