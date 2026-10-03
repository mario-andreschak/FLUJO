import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, DEFAULT_INHERITED_ENV_VARS } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StdioClientTransport as BetaStdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { createStdioTransport, createTransport, stdioConfigKey, safelyCloseClient } from '@/backend/services/mcp/connection';
import { createBetaTransport, createNewBetaClient } from '@/backend/services/mcp/betaClient';
import { createRootsListHandler } from '@/backend/services/mcp/roots';
import { createIsolatedMcpLaunch, isolatedMcpPolicyDigest, type IsolatedMcpLaunch } from '@/backend/services/security/isolatedMcp';
import { approvedIsolationDigest, assertMcpIsolationDispatch, getManagedMcpIsolation, assertIsolatedMcpArguments } from '@/backend/services/mcp/isolation';
import { loadServerConfigs } from '@/backend/services/mcp/config';
import { beginTeardown, _resetLifecycleForTests } from '@/backend/services/mcp/lifecycleCoordinator';
import type { MCPStdioConfig } from '@/shared/types/mcp';
import { getCurrentWorkspace } from '@/utils/workspace';
import { issueOwnerCredential } from '@/backend/services/security/ownerCredentials';

jest.mock('@/backend/services/security/isolatedMcp', () => ({
  ...jest.requireActual('@/backend/services/security/isolatedMcp'), createIsolatedMcpLaunch: jest.fn(),
}));
jest.mock('@/backend/services/mcp/config', () => ({ loadServerConfigs: jest.fn() }));
jest.mock('@/utils/storage/backend', () => ({ loadItem: jest.fn(async () => undefined), saveItem: jest.fn() }));

const create = jest.mocked(createIsolatedMcpLaunch);
const configs = jest.mocked(loadServerConfigs);
const generation = '9cda7d2f-1a8d-41d2-a48d-97c6ed8614f6';
let directory: string;
let config: MCPStdioConfig;
let launch: IsolatedMcpLaunch;
let close: jest.Mock;
let approvals: { schemaVersion: number; ownerId: string; approvals: Array<{ workspace: string; serverName: string; policyDigest: string; expiresAt: number }> };
let saved: Record<string, string | undefined>;

function persist() { fs.writeFileSync(path.join(directory, 'approvals.json'), JSON.stringify(approvals), { mode: 0o600 }); }
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'flujo-mcp-transport-test-'));
  saved = { FLUJO_MCP_ISOLATION_FILE: process.env.FLUJO_MCP_ISOLATION_FILE, FLUJO_OWNER_AUTH_FILE: process.env.FLUJO_OWNER_AUTH_FILE };
  process.env.FLUJO_MCP_ISOLATION_FILE = path.join(directory, 'approvals.json');
  process.env.FLUJO_OWNER_AUTH_FILE = path.join(directory, 'owner.json');
  fs.writeFileSync(process.env.FLUJO_OWNER_AUTH_FILE, JSON.stringify({ schemaVersion: 1, ownerId: 'approved-owner', credentials: [] }), { mode: 0o600 });
  config = { name: 'isolated-fixture', transport: 'stdio', command: 'node', args: ['server.js'], disabled: false,
    env: { ALLOWED_TOKEN: 'approved fixture token', UNRELATED_SECRET: 'not forwarded' }, rootPath: '', _buildCommand: '', _installCommand: '',
    isolation: { schemaVersion: 1, kind: 'docker-deny-egress', image: `sha256:${'a'.repeat(64)}`,
      dockerExecutable: path.join(directory, 'docker'), daemon: 'unix:///var/run/docker.sock', command: ['node', 'server.js'],
      environmentNames: ['ALLOWED_TOKEN'], mounts: [], memoryMiB: 128, cpus: 0.5, pidsLimit: 32 },
  };
  approvals = { schemaVersion: 1, ownerId: 'approved-owner', approvals: [{ workspace: getCurrentWorkspace(), serverName: config.name,
    policyDigest: isolatedMcpPolicyDigest(config.isolation), expiresAt: Date.now() + 60_000 }] };
  persist();
  close = jest.fn(() => ({ outcome: 'removed' }));
  launch = { command: path.join(directory, 'docker'), args: ['container', 'start', '--attach', 'c'.repeat(64)],
    env: { NODE_ENV: 'production', ...(process.platform === 'win32' ? { SystemRoot: 'C:\\Windows' } : {}) }, cwd: directory, generation,
    containerId: 'c'.repeat(64), close };
  create.mockReset().mockReturnValue(launch);
  configs.mockReset().mockResolvedValue([config]);
  global.__flujo_mcp_isolated_generations?.clear();
  _resetLifecycleForTests();
});
afterEach(() => {
  jest.restoreAllMocks();
  global.__flujo_mcp_isolated_generations?.clear();
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  const relative = path.relative(path.resolve(os.tmpdir()), directory);
  if (!/^flujo-mcp-transport-test-[A-Za-z0-9]+$/.test(relative)) throw new Error('Unsafe transport test cleanup');
  fs.rmSync(directory, { recursive: true, force: true });
});

test.each(['v1', 'beta'])('%s factory selects only the isolated attach command and clears SDK account defaults', async era => {
  const transport = era === 'v1' ? createStdioTransport(config) : createBetaTransport(config);
  const parameters = (transport as unknown as { _serverParams: { command: string; args: string[]; env: Record<string, string> } })._serverParams;
  expect(parameters.command).toBe(launch.command);
  expect(parameters.args).toEqual(launch.args);
  expect(create.mock.calls[0][4]).toEqual({ key: expect.stringMatching(/^[a-f0-9]{64}$/) });
  for (const name of DEFAULT_INHERITED_ENV_VARS) {
    expect(parameters.env[name]).toBe(name === 'SYSTEMROOT' ? 'C:\\Windows' : '');
  }
  expect(parameters.env).not.toHaveProperty('UNRELATED_SECRET');
  expect(parameters.env).not.toHaveProperty('ALLOWED_TOKEN');
  expect(getManagedMcpIsolation(transport)?.policyDigest).toBe(approvals.approvals[0].policyDigest);
  await transport.close();
  expect(close).toHaveBeenCalled();
});

test('beta client uses documented legacy mode instead of cloning a disposable sibling for the same CID', () => {
  const client = createNewBetaClient(config);
  expect((client as unknown as { _versionNegotiation: unknown })._versionNegotiation).toEqual({ mode: 'legacy' });
});

test.each(['v1', 'beta'])('%s start rechecks revocation before SDK spawn', async era => {
  const baseStart = jest.spyOn(era === 'v1' ? StdioClientTransport.prototype : BetaStdioClientTransport.prototype, 'start').mockResolvedValue();
  const transport = era === 'v1' ? createStdioTransport(config) : createBetaTransport(config);
  approvals.approvals = []; persist();
  await expect(transport.start()).rejects.toMatchObject({ code: 'ISOLATION_RECONSENT_REQUIRED' });
  expect(baseStart).not.toHaveBeenCalled();
  expect(close).toHaveBeenCalled();
});

test('MCP roots do not disclose host roots or interpolate global secrets to an isolated server', async () => {
  expect(await createRootsListHandler(config)()).toEqual({ roots: [] });
});

test.each(['missing approval', 'wrong workspace', 'wrong owner', 'expired grant', 'changed policy'])('rejects %s before container creation', reason => {
  if (reason === 'missing approval') approvals.approvals = [];
  if (reason === 'wrong workspace') approvals.approvals[0].workspace = 'another-workspace';
  if (reason === 'wrong owner') approvals.ownerId = 'another-owner';
  if (reason === 'expired grant') approvals.approvals[0].expiresAt = Date.now();
  if (reason === 'changed policy') (config.isolation as { memoryMiB: number }).memoryMiB = 256;
  persist();
  expect(() => createStdioTransport(config)).toThrow(expect.objectContaining({ code: 'ISOLATION_RECONSENT_REQUIRED' }));
  expect(create).not.toHaveBeenCalled();
});

test.each(['enableMcpApps', 'enableMcpSkills', 'sampling', 'elicitation', 'command'])('rejects unapproved host-side capability %s', capability => {
  if (capability === 'command') config.command = 'another-command';
  else if (capability === 'sampling' || capability === 'elicitation') config[capability] = { enabled: true };
  else config[capability as 'enableMcpApps' | 'enableMcpSkills'] = true;
  expect(() => createStdioTransport(config)).toThrow(expect.objectContaining({ code: 'ISOLATION_POLICY_INVALID' }));
  expect(create).not.toHaveBeenCalled();
});

test('malformed approval/policy and absent configuration fail closed without host fallback', () => {
  fs.writeFileSync(process.env.FLUJO_MCP_ISOLATION_FILE!, 'private malformed approval');
  expect(() => createStdioTransport(config)).toThrow(expect.objectContaining({ code: 'ISOLATION_UNAVAILABLE' }));
  delete process.env.FLUJO_MCP_ISOLATION_FILE;
  expect(() => createBetaTransport(config)).toThrow(expect.objectContaining({ code: 'ISOLATION_UNAVAILABLE' }));
  expect(create).not.toHaveBeenCalled();
});

test('remote transports cannot carry an ignored isolation declaration', () => {
  const remote = { ...config, transport: 'streamable', serverUrl: 'https://example.invalid' } as unknown as Parameters<typeof createTransport>[0];
  expect(() => createTransport(remote)).toThrow(expect.objectContaining({ code: 'ISOLATION_POLICY_INVALID' }));
  expect(() => createBetaTransport(remote)).toThrow(expect.objectContaining({ code: 'ISOLATION_POLICY_INVALID' }));
});

test('adding or changing isolation participates in the reconnect identity', () => {
  expect(stdioConfigKey(config)).not.toBe(stdioConfigKey({ ...config, isolation: undefined }));
  expect(stdioConfigKey(config)).not.toBe(stdioConfigKey({ ...config, isolation: { ...(config.isolation as object), memoryMiB: 256 } }));
});

test('dispatch observes grant revocation and stops the exact managed container', async () => {
  const transport = createStdioTransport(config);
  const client = { transport } as unknown as Client;
  await expect(assertMcpIsolationDispatch(client, config.name)).resolves.toBeUndefined();
  approvals.approvals = []; persist();
  await expect(assertMcpIsolationDispatch(client, config.name)).rejects.toMatchObject({ code: 'ISOLATION_RECONSENT_REQUIRED' });
  expect(close).toHaveBeenCalled();
});

test('a host connection cannot dispatch after the selected config requires isolation', async () => {
  await expect(assertMcpIsolationDispatch({ transport: {} } as Client, config.name, config)).rejects.toMatchObject({ code: 'ISOLATION_RECONSENT_REQUIRED' });
});

test('an imported config cannot omit the profile and bypass its private isolation grant', async () => {
  const omitted = { ...config, isolation: undefined };
  expect(() => createStdioTransport(omitted)).toThrow(expect.objectContaining({ code: 'ISOLATION_RECONSENT_REQUIRED' }));
  expect(() => createBetaTransport(omitted)).toThrow(expect.objectContaining({ code: 'ISOLATION_RECONSENT_REQUIRED' }));
  await expect(assertMcpIsolationDispatch({ transport: {} } as unknown as Client, config.name, omitted))
    .rejects.toMatchObject({ code: 'ISOLATION_RECONSENT_REQUIRED' });
  expect(create).not.toHaveBeenCalled();
});

test('natural transport close removes its generation and preserves subsequently assigned SDK callbacks', () => {
  const transport = createStdioTransport(config);
  const callback = jest.fn();
  transport.onclose = callback;
  transport.onclose();
  expect(close).toHaveBeenCalled();
  expect(callback).toHaveBeenCalledTimes(1);
  expect(global.__flujo_mcp_isolated_generations?.size).toBe(0);
});

test('close callback composition cannot recurse through the SDK previous-callback pattern', () => {
  const transport = createStdioTransport(config);
  const previous = transport.onclose;
  const callback = jest.fn(() => previous?.());
  transport.onclose = callback;
  expect(() => transport.onclose?.()).not.toThrow();
  expect(callback).toHaveBeenCalledTimes(1);
});

test('isolated arguments cannot interpolate global secrets or cause unbounded recursive scans', () => {
  expect(() => assertIsolatedMcpArguments({ nested: [{ value: '${global:HOST_PRIVATE_KEY}' }] })).toThrow();
  const cycle: Record<string, unknown> = {}; cycle.self = cycle;
  expect(() => assertIsolatedMcpArguments(cycle)).toThrow();
  expect(() => assertIsolatedMcpArguments(Array(4097).fill(1))).toThrow();
  expect(() => assertIsolatedMcpArguments({ plain: 'approved literal', nested: [1, null, true] })).not.toThrow();
});

test('a second launch cannot remove an active same-server generation as a test probe', () => {
  createStdioTransport(config);
  expect(() => createStdioTransport(config)).toThrow(expect.objectContaining({ code: 'ISOLATION_UNAVAILABLE' }));
  expect(close).not.toHaveBeenCalled();
  expect(create).toHaveBeenCalledTimes(1);
});

test('unobserved cleanup prevents replacement; successful reconciliation permits it', async () => {
  const first = createStdioTransport(config);
  close.mockReturnValue({ outcome: 'unknown' });
  await first.close();
  expect(() => createStdioTransport(config)).toThrow(expect.objectContaining({ code: 'ISOLATION_UNAVAILABLE' }));
  expect(create).toHaveBeenCalledTimes(1);
  close.mockReturnValue({ outcome: 'removed' });
  createStdioTransport(config);
  expect(create).toHaveBeenCalledTimes(2);
});

test('a stopped attach CLI cannot qualify unknown container cleanup', async () => {
  const transport = createStdioTransport(config);
  (transport as unknown as { _process: unknown })._process = { exitCode: 0, signalCode: null, kill: jest.fn() };
  close.mockReturnValue({ outcome: 'unknown' });
  const result = await safelyCloseClient({ transport, close: jest.fn() } as unknown as Client, config.name, config);
  expect(result.exited).toBe(false);
  expect(result.exitOutcome).toBe('unknown');
  expect(result.isolation).toEqual({ schemaVersion: 1, generation, cleanupOutcome: 'unknown' });
  const receipt = await beginTeardown(config.name, 'isolated test', async () => result);
  expect(receipt.isolation).toEqual(result.isolation);
  expect(JSON.stringify(receipt)).not.toMatch(/approved fixture token|UNRELATED_SECRET|docker/);
});

test('private grant digest can be checked independently without creating a container', () => {
  expect(approvedIsolationDigest(config)).toBe(approvals.approvals[0].policyDigest);
  expect(create).not.toHaveBeenCalled();
});

test('private MCP approval composes with the new voice-only workspace credential schema', () => {
  const voice = issueOwnerCredential(['avatar:voice'], Date.now() + 60_000, Date.now(), { workspaceId: 'voice-workspace' });
  fs.writeFileSync(process.env.FLUJO_OWNER_AUTH_FILE!, JSON.stringify({ schemaVersion: 1, ownerId: 'approved-owner', credentials: [voice.record] }), { mode: 0o600 });
  expect(approvedIsolationDigest(config)).toBe(approvals.approvals[0].policyDigest);
});
