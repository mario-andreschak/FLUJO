import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StdioClientTransport as BetaStdioClientTransport } from '@modelcontextprotocol/client/stdio';
import type { MCPStdioConfig } from '@/shared/types/mcp';
import { getCurrentWorkspace, getWorkspaceDataDir } from '@/utils/workspace';
import { createStdioTransport, localLaunchFingerprint } from '@/backend/services/mcp/connection';
import { createBetaTransport } from '@/backend/services/mcp/betaClient';
import { loadServerConfigs } from '@/backend/services/mcp/config';
import { assertMcpIsolationDispatch } from '@/backend/services/mcp/isolation';
import { stdioLaunchForm } from '@/backend/services/mcp/launchForm';
import { createRootsListHandler } from '@/backend/services/mcp/roots';
import { callTool } from '@/backend/services/mcp/tools';
import { trustedHostMcpPolicyDigest, trustedHostMcpPreviewDigestAsync } from '@/backend/services/security/trustedHostMcp';
import { fingerprintTrustedHostExecutable, fingerprintTrustedHostSource } from './fixtures/trustedHostFingerprint';

// Issue #1337: a server whose env holds a secret was launched with the
// decrypted value but checked against the saved, encrypted text, so its first
// tool call was refused with "Owner approval required". These tests launch
// through the real transport factories and check the way tool calls do.
jest.mock('@/backend/services/mcp/config', () => ({ loadServerConfigs: jest.fn() }));
jest.mock('@/utils/storage/backend', () => ({ loadItem: jest.fn(async () => undefined), saveItem: jest.fn() }));
jest.mock('@/backend/utils/resolveGlobalVars', () => ({
  resolveGlobalVars: async (value: unknown) => value,
  resolveAndDecryptApiKey: async (value: string) => ({
    'encrypted:v2:first': 'fly-token-one',
    'encrypted:v2:again': 'fly-token-one',
    'encrypted:v2:rotated': 'fly-token-two',
  })[value] ?? value,
}));
// Windows file permissions of a temporary test folder are not private; Linux
// runs the real owner and permission checks.
jest.mock('@/backend/services/security/windowsPrivateAuthority', () => ({
  ...jest.requireActual('@/backend/services/security/windowsPrivateAuthority'),
  windowsPrivateAuthorityStampAsync: jest.fn(async () => 'synthetic-private-stamp'),
}));

const configs = jest.mocked(loadServerConfigs);
const secret = (ciphertext: string) => ({ value: ciphertext, metadata: { isSecret: true } });
const environmentNames = ['FLUJO_DATA_DIR', 'FLUJO_PARENT_DATA_DIR', 'FLUJO_OWNER_AUTH_FILE', 'FLUJO_MCP_TRUSTED_HOST_FILE',
  'FLUJO_MCP_ISOLATION_FILE', 'FLUJO_WORKER_MODE', 'FLUJO_EXPOSURE_MODE'];
let saved: Record<string, string | undefined>;
let stored: MCPStdioConfig;

function setEnv(config: Omit<MCPStdioConfig, 'env'>, env: Record<string, unknown>): MCPStdioConfig {
  return { ...config, env: env as MCPStdioConfig['env'] };
}

async function launch(era: 'v1' | 'beta') {
  const launched = await stdioLaunchForm(stored);
  const transport = era === 'v1' ? await createStdioTransport(launched) : await createBetaTransport(launched);
  const close = jest.fn(async () => { await transport.close(); });
  return { transport, close, client: { transport, close } as unknown as Client };
}

beforeEach(() => {
  saved = Object.fromEntries(environmentNames.map(name => [name, process.env[name]]));
  for (const name of environmentNames) delete process.env[name];
});

afterEach(() => {
  jest.restoreAllMocks();
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
});

describe('a local server in localhost mode', () => {
  beforeEach(() => {
    process.env.FLUJO_EXPOSURE_MODE = 'localhost';
    stored = setEnv({ name: 'website-builder', transport: 'stdio', command: process.execPath, args: ['website-builder.js'],
      disabled: false, rootPath: '', _buildCommand: '', _installCommand: '' }, {
      FLY_API_TOKEN: secret('encrypted:v2:first'), REGION: { value: 'fra', metadata: { isSecret: false } }, MODE: 'deploy',
    });
    configs.mockReset().mockImplementation(async () => [stored]);
  });

  test.each(['v1', 'beta'] as const)('%s: starts with the decrypted secret and passes its first tool call check', async era => {
    const { transport, client, close } = await launch(era);
    const parameters = (transport as unknown as { _serverParams: { env: Record<string, string> } })._serverParams;
    expect(parameters.env.FLY_API_TOKEN).toBe('fly-token-one');
    await expect(assertMcpIsolationDispatch(client, stored.name)).resolves.toBeUndefined();
    await expect(assertMcpIsolationDispatch(client, stored.name, stored)).resolves.toBeUndefined();
    expect(close).not.toHaveBeenCalled();
  });

  test('a server without secrets passes too', async () => {
    stored = setEnv(stored, { REGION: 'fra' });
    const { client } = await launch('v1');
    await expect(assertMcpIsolationDispatch(client, stored.name)).resolves.toBeUndefined();
  });

  test('the same secret encrypted again still matches the running server', async () => {
    const { client, close } = await launch('v1');
    stored = setEnv(stored, { ...stored.env, FLY_API_TOKEN: secret('encrypted:v2:again') });
    await expect(assertMcpIsolationDispatch(client, stored.name)).resolves.toBeUndefined();
    expect(close).not.toHaveBeenCalled();
  });

  test.each([
    ['a changed secret', { FLY_API_TOKEN: secret('encrypted:v2:rotated') }],
    ['a changed plain value', { REGION: 'ams' }],
    ['a removed value', { MODE: undefined }],
  ])('%s refuses the running server and closes it', async (_change, changed) => {
    const { client, close } = await launch('beta');
    stored = setEnv(stored, { ...stored.env, ...changed });
    await expect(assertMcpIsolationDispatch(client, stored.name)).rejects.toMatchObject({ code: 'HOST_CONSENT_REQUIRED' });
    expect(close).toHaveBeenCalledTimes(1);
  });

  test('a background job runs the tool, and stops once the secret changed', async () => {
    const { transport, close } = await launch('v1');
    const sdkCall = jest.fn().mockResolvedValue({ content: [{ type: 'text', text: 'deployed' }] });
    const client = { transport, close, callTool: sdkCall } as unknown as Client;
    expect(await callTool(client, stored.name, 'deploy', { site: 'docs' }, 5)).toMatchObject({ success: true });
    expect(sdkCall).toHaveBeenCalledTimes(1);
    stored = setEnv(stored, { ...stored.env, FLY_API_TOKEN: secret('encrypted:v2:rotated') });
    expect(await callTool(client, stored.name, 'deploy', { site: 'docs' }, 5)).toMatchObject({ success: false });
    expect(sdkCall).toHaveBeenCalledTimes(1);
  });

  test('after a restart, the newly started server passes and nothing is carried over', async () => {
    const { client: before } = await launch('v1');
    const root = globalThis as typeof globalThis & Record<string, unknown>;
    const keys = ['__flujoProtectedConfigFingerprintKey', '__flujoLocalHostMcpLaunches'];
    const kept = Object.fromEntries(keys.map(key => [key, root[key]]));
    for (const key of keys) delete root[key];
    try {
      let restarted!: { factory: typeof createStdioTransport; dispatch: typeof assertMcpIsolationDispatch };
      jest.isolateModules(() => {
        restarted = {
          factory: jest.requireActual<typeof import('@/backend/services/mcp/connection')>('@/backend/services/mcp/connection').createStdioTransport,
          dispatch: jest.requireActual<typeof import('@/backend/services/mcp/isolation')>('@/backend/services/mcp/isolation').assertMcpIsolationDispatch,
        };
      });
      const transport = await restarted.factory(await stdioLaunchForm(stored));
      await expect(restarted.dispatch({ transport, close: jest.fn() } as unknown as Client, stored.name)).resolves.toBeUndefined();
      await expect(restarted.dispatch(before, stored.name)).rejects.toMatchObject({ code: 'HOST_CONSENT_REQUIRED' });
    } finally {
      for (const key of keys) root[key] = kept[key];
    }
  });

  test('the launch fingerprint never contains the secret', async () => {
    const launched = await stdioLaunchForm(stored);
    const fingerprint = localLaunchFingerprint(launched, false);
    expect(fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(fingerprint).not.toContain('fly-token-one');
    expect(localLaunchFingerprint(await stdioLaunchForm(setEnv(stored, { ...stored.env, FLY_API_TOKEN: secret('encrypted:v2:again') })), false))
      .toBe(fingerprint);
  });
});

describe('a protected server with an owner approval', () => {
  let directory: string;
  let fixtureParent: string;

  function approve(digest: string) {
    fs.writeFileSync(process.env.FLUJO_MCP_TRUSTED_HOST_FILE!, JSON.stringify({ schemaVersion: 1, ownerId: 'synthetic-owner',
      approvals: [{ workspace: getCurrentWorkspace(), serverName: stored.name, policyDigest: digest, expiresAt: Date.now() + 120_000 }] }), { mode: 0o600 });
  }
  // The owner's review screen computes the digest this way (bundledMcpConsent.ts, packageRunnerConsent.ts).
  const reviewedDigest = async () => trustedHostMcpPreviewDigestAsync(await stdioLaunchForm(stored));

  beforeEach(async () => {
    fixtureParent = path.resolve(os.tmpdir());
    directory = fs.mkdtempSync(path.join(fixtureParent, 'flujo-secret-approval-'));
    process.env.FLUJO_DATA_DIR = path.join(directory, 'data');
    process.env.FLUJO_OWNER_AUTH_FILE = path.join(directory, 'owner.json');
    process.env.FLUJO_MCP_TRUSTED_HOST_FILE = path.join(directory, 'approval.json');
    fs.writeFileSync(process.env.FLUJO_OWNER_AUTH_FILE, JSON.stringify({ schemaVersion: 1, ownerId: 'synthetic-owner', credentials: [] }), { mode: 0o600 });
    const sourceRoot = path.join(getWorkspaceDataDir(), 'mcp-servers', 'website-builder');
    fs.mkdirSync(sourceRoot, { recursive: true });
    const command = path.join(sourceRoot, 'synthetic-executable');
    fs.writeFileSync(command, 'fingerprinted fixture; never executed');
    const env = { FLY_API_TOKEN: secret('encrypted:v2:first'), REGION: 'fra',
      ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot ?? 'C:\\Windows' } : {}) };
    stored = setEnv({ name: 'website-builder', transport: 'stdio', command, args: [], cwd: sourceRoot, disabled: false,
      rootPath: '', roots: [path.join(directory, 'site')], _buildCommand: '', _installCommand: '',
      trustedHost: { schemaVersion: 1, kind: 'trusted-host', privileges: 'owner-account', runtime: 'native', entryPoint: command,
        sourceRoot, sourceDigest: fingerprintTrustedHostSource(sourceRoot), executableDigest: fingerprintTrustedHostExecutable(command),
        environmentNames: Object.keys(env) } }, env);
    configs.mockReset().mockImplementation(async () => [stored]);
    approve(await reviewedDigest());
  });

  afterEach(() => {
    if (path.dirname(directory) !== fixtureParent || !/^flujo-secret-approval-[A-Za-z0-9]+$/.test(path.basename(directory))
      || fs.lstatSync(directory).isSymbolicLink()) throw new Error('Unsafe owned fixture cleanup');
    fs.rmSync(directory, { recursive: true, force: true });
  });

  test.each(['v1', 'beta'] as const)('%s: an approved secret env starts, passes its tool call check and lists its roots', async era => {
    jest.spyOn(era === 'v1' ? StdioClientTransport.prototype : BetaStdioClientTransport.prototype, 'start').mockResolvedValue();
    const { transport, client, close } = await launch(era);
    await expect(transport.start()).resolves.toBeUndefined();
    await expect(assertMcpIsolationDispatch(client, stored.name)).resolves.toBeUndefined();
    expect((await createRootsListHandler(stored, client)()).roots).toHaveLength(1);
    expect(close).not.toHaveBeenCalled();
    await transport.close();
  });

  test('the same secret encrypted again keeps the approval', async () => {
    const { transport, client, close } = await launch('v1');
    stored = setEnv(stored, { ...stored.env, FLY_API_TOKEN: secret('encrypted:v2:again') });
    await expect(assertMcpIsolationDispatch(client, stored.name)).resolves.toBeUndefined();
    expect(close).not.toHaveBeenCalled();
    await transport.close();
  });

  test('a changed secret needs a new approval', async () => {
    const { client, close } = await launch('v1');
    stored = setEnv(stored, { ...stored.env, FLY_API_TOKEN: secret('encrypted:v2:rotated') });
    await expect(assertMcpIsolationDispatch(client, stored.name)).rejects.toMatchObject({ code: 'HOST_CONSENT_REQUIRED' });
    expect(close).toHaveBeenCalledTimes(1);
    await expect(launch('v1')).rejects.toMatchObject({ code: 'HOST_CONSENT_REQUIRED' });
    approve(await reviewedDigest());
    const renewed = await launch('v1');
    await expect(assertMcpIsolationDispatch(renewed.client, stored.name)).resolves.toBeUndefined();
    await renewed.transport.close();
  });

  test('approvals of servers without a secret or global keep their digest', async () => {
    const plain = setEnv(stored, { REGION: 'fra', ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot ?? 'C:\\Windows' } : {}) });
    expect(trustedHostMcpPolicyDigest(await stdioLaunchForm(plain))).toBe(trustedHostMcpPolicyDigest(plain));
    expect(trustedHostMcpPolicyDigest(await stdioLaunchForm(stored))).not.toBe(trustedHostMcpPolicyDigest(stored));
  });
});
