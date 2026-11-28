/**
 * Issue #1337 end to end: a local MCP server whose settings hold a secret,
 * saved and encrypted on disk, started by the MCP service as a real child
 * process and called the way a chat or a background job calls it. It covers
 * the first tool call, a FLUJO restart, a changed secret, and the update from
 * approvals that FLUJO computed before the fix (over the saved, encrypted
 * text). Those approvals keep working without the owner approving again.
 *
 * Only the Windows permission probe is replaced, and only on Windows: a test
 * folder there is not private to this account. Linux runs every check.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { MCPServerConfig, MCPStdioConfig } from '@/shared/types/mcp';
import { installPrivateProfileFixture, unlockPrivateFixtureInCurrentWorkspace } from '../utils/privateProfileFixture';
import { installBundledFixtureOwner } from './fixtures/bundledFixtureOwner';
import { bundledMcpEntry } from '../helpers/bundledMcpEntry';

jest.mock('@/backend/services/security/windowsPrivateAuthority', () => {
  const actual = jest.requireActual('@/backend/services/security/windowsPrivateAuthority');
  return process.platform === 'win32' ? { ...actual,
    windowsPrivateAuthorityStamp: jest.fn(() => 'synthetic-private-stamp'),
    windowsPrivateAuthorityStampAsync: jest.fn(async () => 'synthetic-private-stamp') } : actual;
});

jest.setTimeout(240_000);

type Flujo = {
  service: InstanceType<typeof import('@/backend/services/mcp').MCPService>;
  config: typeof import('@/backend/services/mcp/config');
  launchForm: typeof import('@/backend/services/mcp/launchForm');
  consent: typeof import('@/backend/services/security/bundledMcpConsent');
  trusted: typeof import('@/backend/services/security/trustedHostMcp');
  save: typeof import('@/backend/services/mcp/serverConfigSave');
  workspace: typeof import('@/utils/workspace');
};

const ENVIRONMENT = ['FLUJO_DATA_DIR', 'FLUJO_PARENT_DATA_DIR', 'FLUJO_OWNER_AUTH_FILE', 'FLUJO_MCP_TRUSTED_HOST_FILE',
  'FLUJO_MCP_ISOLATION_FILE', 'FLUJO_WORKER_MODE', 'FLUJO_EXPOSURE_MODE'];
const FIXTURE = path.join(__dirname, 'fixtures', 'secretEnvStdioServer.mjs');
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const secret = (value: string) => ({ value, metadata: { isSecret: true } });
const globalsAtStart = new Set(Object.keys(globalThis));
let savedEnvironment: Record<string, string | undefined>;

/** Each restart loads FLUJO's modules afresh, so they are required here rather than imported once. */
function load(): Flujo {
  const { MCPService } = require('@/backend/services/mcp') as typeof import('@/backend/services/mcp');
  return {
    service: new MCPService(),
    config: require('@/backend/services/mcp/config'),
    launchForm: require('@/backend/services/mcp/launchForm'),
    consent: require('@/backend/services/security/bundledMcpConsent'),
    trusted: require('@/backend/services/security/trustedHostMcp'),
    save: require('@/backend/services/mcp/serverConfigSave'),
    workspace: require('@/utils/workspace'),
  };
}

/** Stop FLUJO and start it again on the same data: no module state, live client or process key survives. */
async function restart(previous: Flujo, serverName: string): Promise<Flujo> {
  await previous.service.disconnectServer(serverName);
  for (const key of Object.keys(globalThis)) {
    if (key.startsWith('__flujo') && !globalsAtStart.has(key)) delete (globalThis as Record<string, unknown>)[key];
  }
  jest.resetModules();
  const next = load();
  await unlockPrivateFixtureInCurrentWorkspace();
  return next;
}

async function storedServer(flujo: Flujo, name: string): Promise<MCPStdioConfig> {
  const configs = await flujo.config.loadServerConfigs();
  const found = Array.isArray(configs) ? configs.find(item => item.name === name) : undefined;
  if (found?.transport !== 'stdio') throw new Error(`${name} is not saved as a local server.`);
  return found;
}

async function saveServer(flujo: Flujo, config: MCPServerConfig) {
  expect(await flujo.config.saveConfig(new Map([[config.name, config]]))).toMatchObject({ success: true });
}

function readLedger() {
  return JSON.parse(fs.readFileSync(process.env.FLUJO_MCP_TRUSTED_HOST_FILE!, 'utf8')) as {
    schemaVersion: number; ownerId: string; approvals: Array<{ workspace: string; serverName: string; policyDigest: string; expiresAt: number }>;
  };
}

function writeLedger(grant: { workspace: string; serverName: string; policyDigest: string; expiresAt: number }) {
  fs.writeFileSync(process.env.FLUJO_MCP_TRUSTED_HOST_FILE!, JSON.stringify({ ...readLedger(), approvals: [grant] }), { mode: 0o600 });
}

const text = (result: { data?: unknown }) => JSON.stringify(result.data);
const pidOf = (result: { data?: unknown }) => /pid (\d+)/.exec(text(result))?.[1];

beforeEach(() => {
  savedEnvironment = Object.fromEntries(ENVIRONMENT.map(name => [name, process.env[name]]));
  for (const name of ENVIRONMENT) delete process.env[name];
});

afterEach(() => {
  for (const [name, value] of Object.entries(savedEnvironment)) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
});

describe('a local server with a secret in localhost mode', () => {
  const name = 'website-builder';
  let profile: Awaited<ReturnType<typeof installPrivateProfileFixture>>;
  let flujo: Flujo;
  let pidFile: string;

  beforeEach(async () => {
    profile = await installPrivateProfileFixture();
    process.env.FLUJO_EXPOSURE_MODE = 'localhost';
    pidFile = path.join(profile.root, 'pids.txt');
    jest.resetModules();
    flujo = load();
  });

  afterEach(async () => {
    try { await flujo.service.disconnectServer(name); } finally {
      for (const pid of fs.existsSync(pidFile) ? fs.readFileSync(pidFile, 'utf8').split('\n').filter(Boolean).map(Number) : []) {
        try { process.kill(pid); } catch { /* already gone */ }
      }
      await profile.restore();
    }
  });

  test('saves the secret encrypted, passes its first tool call, survives a restart and picks up a new secret', async () => {
    const created = await flujo.service.updateServerConfig(name, {
      name, transport: 'stdio', command: process.execPath, args: [FIXTURE], rootPath: profile.root, disabled: false,
      _buildCommand: '', _installCommand: '', env: { FLY_API_TOKEN: secret('fly-token-one'), REGION: 'fra', PID_FILE: pidFile },
    } as Partial<MCPServerConfig>);
    expect(created).toMatchObject({ name });
    const saved = await storedServer(flujo, name);
    expect(JSON.stringify(saved)).not.toContain('fly-token-one');
    expect(saved.env?.FLY_API_TOKEN).toMatchObject({ value: expect.stringMatching(/^encrypted:/), metadata: { isSecret: true } });

    expect(await flujo.service.connectServer(name)).toMatchObject({ success: true });
    const first = await flujo.service.callTool(name, 'deploy', {});
    expect(first).toMatchObject({ success: true });
    expect(text(first)).toContain(sha256('fly-token-one'));
    expect(await flujo.service.callTool(name, 'deploy', {})).toMatchObject({ success: true });

    flujo = await restart(flujo, name);
    expect(await flujo.service.connectServer(name)).toMatchObject({ success: true });
    const afterRestart = await flujo.service.callTool(name, 'deploy', {});
    expect(afterRestart).toMatchObject({ success: true });
    expect(text(afterRestart)).toContain(sha256('fly-token-one'));
    expect(pidOf(afterRestart)).not.toBe(pidOf(first));

    const rotated = await flujo.service.updateServerConfig(name, {
      env: { FLY_API_TOKEN: secret('fly-token-two'), REGION: 'fra', PID_FILE: pidFile },
    } as Partial<MCPServerConfig>);
    expect(rotated).toMatchObject({ name });
    expect(await flujo.service.connectServer(name)).toMatchObject({ success: true });
    const afterChange = await flujo.service.callTool(name, 'deploy', {});
    expect(afterChange).toMatchObject({ success: true });
    expect(text(afterChange)).toContain(sha256('fly-token-two'));
  });
});

describe('a protected bundled server with a secret', () => {
  const name = 'filesystem';
  let profile: Awaited<ReturnType<typeof installPrivateProfileFixture>>;
  let owner: ReturnType<typeof installBundledFixtureOwner> | undefined;
  let flujo: Flujo;
  let roots: string;

  beforeEach(async () => {
    expect(fs.existsSync(bundledMcpEntry('filesystem'))).toBe(true); // CI builds the MCP packages before Jest.
    profile = await installPrivateProfileFixture();
    roots = fs.mkdtempSync(path.join(os.tmpdir(), 'flujo-secret-approval-roots-'));
    owner = installBundledFixtureOwner();
    jest.resetModules();
    flujo = load();
    const { ensureShippedWorkspacePackages } = await import('@/backend/services/mcp/shippedWorkspacePackages');
    const { createShippedServerConfig, SHIPPED_MCP_SERVERS } = await import('@/backend/services/mcp/shippedServers');
    await ensureShippedWorkspacePackages(flujo.workspace.getWorkspaceDataDir(), undefined, ['filesystem']);
    const shipped = createShippedServerConfig(SHIPPED_MCP_SERVERS.find(item => item.packageDirectory === 'filesystem')!);
    await saveServer(flujo, { ...shipped, name, disabled: false, roots: [roots],
      env: { ...shipped.env, FLUJO_FS_ROOTS: roots, DEPLOY_TOKEN: secret(await flujo.save.encryptSecretForSave('fs-token-one')) } });
  });

  afterEach(async () => {
    try { await flujo.service.disconnectServer(name); } finally {
      try { owner?.restore(); } finally {
        fs.rmSync(roots, { recursive: true, force: true });
        await profile.restore();
      }
    }
  });

  test('an approval made before the update moves to the launch form once and keeps working after a restart', async () => {
    // How FLUJO approved before #1337: the owner's review digest covered the
    // saved settings with the encrypted secret, and approving saved them.
    const proposal = await flujo.consent.previewBundledHostConsent(name, { runtimeHome: 'host' });
    await saveServer(flujo, proposal.config);
    const oldDigest = flujo.trusted.trustedHostMcpPolicyDigest(proposal.config);
    const launchDigest = flujo.trusted.trustedHostMcpPolicyDigest(await flujo.launchForm.stdioLaunchForm(proposal.config));
    expect(oldDigest).not.toBe(launchDigest);
    expect(proposal.policyDigest).toBe(launchDigest);
    const expiresAt = Date.now() + 30 * 60_000;
    const workspace = flujo.workspace.getCurrentWorkspace();
    writeLedger({ workspace, serverName: name, policyDigest: oldDigest, expiresAt });

    expect(await flujo.service.connectServer(name)).toMatchObject({ success: true });
    expect(await flujo.service.callTool(name, 'get_allowed_directories', {})).toMatchObject({ success: true });
    expect(readLedger().approvals).toEqual([{ workspace, serverName: name, policyDigest: launchDigest, expiresAt }]);

    flujo = await restart(flujo, name);
    expect(await flujo.service.connectServer(name)).toMatchObject({ success: true });
    const afterRestart = await flujo.service.callTool(name, 'get_allowed_directories', {});
    expect(afterRestart).toMatchObject({ success: true });
    expect(text(afterRestart)).toContain(JSON.stringify(path.resolve(roots)).slice(1, -1));
    expect(readLedger().approvals).toEqual([{ workspace, serverName: name, policyDigest: launchDigest, expiresAt }]);
  });

  test('a changed secret is refused until the owner approves it once through the review', async () => {
    const proposal = await flujo.consent.previewBundledHostConsent(name, { runtimeHome: 'host' });
    await saveServer(flujo, proposal.config);
    const workspace = flujo.workspace.getCurrentWorkspace();
    writeLedger({ workspace, serverName: name, policyDigest: flujo.trusted.trustedHostMcpPolicyDigest(proposal.config), expiresAt: Date.now() + 30 * 60_000 });
    expect(await flujo.service.connectServer(name)).toMatchObject({ success: true });
    expect(await flujo.service.callTool(name, 'get_allowed_directories', {})).toMatchObject({ success: true });
    const upgraded = readLedger().approvals;

    await saveServer(flujo, { ...proposal.config, env: { ...proposal.config.env,
      DEPLOY_TOKEN: await flujo.save.encryptSecretForSave('fs-token-two') } });
    expect(await flujo.service.callTool(name, 'get_allowed_directories', {})).toMatchObject({ success: false });
    expect(readLedger().approvals).toEqual(upgraded);

    // The owner's single review: preview, then approve the digest shown.
    owner!.restore();
    owner = installBundledFixtureOwner();
    const review = await flujo.consent.previewBundledHostConsent(name, { runtimeHome: 'host' });
    await flujo.consent.approveBundledHostConsent(owner.request(name), name,
      { runtimeHome: 'host', reviewedDigest: review.policyDigest, expiresAt: owner.expiresAt });
    expect(await flujo.service.connectServer(name)).toMatchObject({ success: true });
    expect(await flujo.service.callTool(name, 'get_allowed_directories', {})).toMatchObject({ success: true });
  });
});
