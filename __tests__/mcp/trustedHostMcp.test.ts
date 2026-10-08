import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { MCPStdioConfig } from '@/shared/types/mcp';
import { resolveTrustedHostLaunch } from '@/backend/services/mcp/trustedHost';
import { getCurrentWorkspace, getWorkspaceDataDir, runWithWorkspace } from '@/utils/workspace';
import {
  assertTrustedHostMcpAllowed, fingerprintTrustedHostExecutable,
  fingerprintTrustedHostSource, trustedHostMcpPolicyDigest, trustedHostMcpPolicySchema, verifyTrustedHostMcp,
} from '@/backend/services/security/trustedHostMcp';

let root: string;
let fixtureParent: string;
let config: MCPStdioConfig;
let saved: Record<string, string | undefined>;
let approval: { schemaVersion: number; ownerId: string; approvals: Array<{ workspace: string; serverName: string; policyDigest: string; expiresAt: number }> };

function persist() {
  fs.writeFileSync(process.env.FLUJO_MCP_TRUSTED_HOST_FILE!, JSON.stringify(approval), { mode: 0o600 });
}

beforeEach(() => {
  saved = Object.fromEntries(['FLUJO_DATA_DIR', 'FLUJO_PARENT_DATA_DIR', 'FLUJO_OWNER_AUTH_FILE', 'FLUJO_MCP_TRUSTED_HOST_FILE'].map(name => [name, process.env[name]]));
  // Windows authority is checked against the native DACL, including parents.
  // Use the existing private user tree; chmod does not make a public temp tree private.
  const privateParent = process.platform === 'win32' ? process.env.LOCALAPPDATA : os.tmpdir();
  if (!privateParent || !path.isAbsolute(privateParent)) throw new Error('Private fixture parent unavailable');
  fixtureParent = path.resolve(privateParent);
  root = fs.mkdtempSync(path.join(fixtureParent, 'flujo-host-consent-'));
  process.env.FLUJO_DATA_DIR = path.join(root, 'data');
  delete process.env.FLUJO_PARENT_DATA_DIR;
  process.env.FLUJO_OWNER_AUTH_FILE = path.join(root, 'owner.json');
  process.env.FLUJO_MCP_TRUSTED_HOST_FILE = path.join(root, 'consent.json');
  fs.writeFileSync(process.env.FLUJO_OWNER_AUTH_FILE, JSON.stringify({ schemaVersion: 1, ownerId: 'synthetic-owner', credentials: [] }), { mode: 0o600 });
  const sourceRoot = path.join(getWorkspaceDataDir(), 'mcp-servers', 'fixed-package');
  fs.mkdirSync(sourceRoot, { recursive: true });
  const executable = path.join(sourceRoot, 'synthetic-executable');
  fs.writeFileSync(executable, 'fingerprinted fixture; never executed');
  fs.writeFileSync(path.join(sourceRoot, 'server.js'), 'synthetic package source');
  config = { name: 'synthetic-host', transport: 'stdio', command: executable, args: [], cwd: sourceRoot,
    disabled: false, rootPath: '', env: {}, _buildCommand: '', _installCommand: '',
    trustedHost: { schemaVersion: 1, kind: 'trusted-host', privileges: 'owner-account', runtime: 'native', entryPoint: executable, sourceRoot,
      sourceDigest: fingerprintTrustedHostSource(sourceRoot), executableDigest: fingerprintTrustedHostExecutable(executable), environmentNames: [] } };
  approval = { schemaVersion: 1, ownerId: 'synthetic-owner', approvals: [{ workspace: getCurrentWorkspace(), serverName: config.name,
    policyDigest: trustedHostMcpPolicyDigest(config), expiresAt: Date.now() + 60_000 }] };
  persist();
});

afterEach(() => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
  const relative = path.relative(fixtureParent, root);
  if (!/^flujo-host-consent-[A-Za-z0-9]+$/.test(relative) || fs.lstatSync(root).isSymbolicLink()) throw new Error('Unsafe owned fixture cleanup');
  fs.rmSync(root, { recursive: true, force: true });
});

it('requires a separate grant and accepts the matching explicit package revision', () => {
  expect(assertTrustedHostMcpAllowed(config).kind).toBe('trusted-host');
  delete process.env.FLUJO_MCP_TRUSTED_HOST_FILE;
  expect(() => assertTrustedHostMcpAllowed(config)).toThrow('explicit owner consent');
  expect(() => assertTrustedHostMcpAllowed({ ...config, trustedHost: undefined })).toThrow('explicit owner consent');
});

it.each(['inherited', 'field-accessor', 'map-accessor'])('refuses %s environment values without invoking getters', kind => {
  const getter = jest.fn(() => 'secret');
  const raw = kind === 'inherited' ? Object.create({ get value() { return getter(); } })
    : Object.defineProperty({}, 'value', { get: getter, enumerable: true });
  const env = kind === 'map-accessor' ? Object.defineProperty({}, 'SAFE', { get: getter, enumerable: true }) : { SAFE: raw };
  config.env = env;
  config.trustedHost = { ...trustedHostMcpPolicySchema.parse(config.trustedHost), environmentNames: ['SAFE'] };
  expect(() => trustedHostMcpPolicyDigest(config)).toThrow();
  expect(getter).not.toHaveBeenCalled();
});

it('preserves an explicitly approved own prototype-named environment value', () => {
  config.env = Object.fromEntries([['__proto__', 'literal'], ...(process.platform === 'win32' ? [['SystemRoot', process.env.SystemRoot!]] : [])]);
  config.trustedHost = { ...trustedHostMcpPolicySchema.parse(config.trustedHost), environmentNames: Object.keys(config.env) };
  approval.approvals[0].policyDigest = trustedHostMcpPolicyDigest(config);
  persist();
  const environment = resolveTrustedHostLaunch(config).env;
  expect(Object.getPrototypeOf(environment)).toBeNull();
  expect(Object.getOwnPropertyDescriptor(environment, '__proto__')?.value).toBe('literal');
});

it.each(['owner', 'server', 'workspace', 'expiry', 'revocation'])('refuses a %s mismatch', mismatch => {
  if (mismatch === 'owner') approval.ownerId = 'different-owner';
  if (mismatch === 'server') approval.approvals[0].serverName = 'different-server';
  if (mismatch === 'workspace') approval.approvals[0].workspace = 'different-workspace';
  if (mismatch === 'expiry') approval.approvals[0].expiresAt = Date.now() - 1;
  if (mismatch === 'revocation') approval.approvals = [];
  persist();
  expect(() => assertTrustedHostMcpAllowed(config)).toThrow('explicit owner consent');
});

it('requires re-consent for changed package bytes, including a nested dependency', () => {
  const policy = config.trustedHost as { sourceRoot: string };
  fs.mkdirSync(path.join(policy.sourceRoot, 'dependencies'));
  fs.writeFileSync(path.join(policy.sourceRoot, 'dependencies', 'changed.js'), 'new dependency revision');
  expect(() => assertTrustedHostMcpAllowed(config)).toThrow('package revision changed');
});

it('refuses executable replacement even when the remaining package is unchanged', () => {
  fs.writeFileSync(config.command, 'different executable revision');
  expect(() => assertTrustedHostMcpAllowed(config)).toThrow('package revision changed');
});

it.each([
  { args: ['different-argument'] }, { enableMcpApps: true }, { enableMcpSkills: true },
  { sampling: { enabled: true } }, { roots: ['different-root'] },
])('binds actual requested launch and broker capabilities (%j)', change => {
  expect(() => assertTrustedHostMcpAllowed({ ...config, ...change })).toThrow('explicit owner consent');
});

it('an imported approval flag cannot convey authority', () => {
  const forged = { ...(config.trustedHost as object), approved: true };
  expect(() => assertTrustedHostMcpAllowed({ ...config, trustedHost: forged })).toThrow();
});

it('refuses a source hard link without reading unrelated file contents', () => {
  const policy = config.trustedHost as { sourceRoot: string };
  const outside = path.join(root, 'outside.txt');
  fs.writeFileSync(outside, 'synthetic outside canary');
  fs.linkSync(outside, path.join(policy.sourceRoot, 'linked.txt'));
  expect(() => fingerprintTrustedHostSource(policy.sourceRoot)).toThrow('package revision changed');
});

it('refuses a junction or symbolic link in the package tree', () => {
  const policy = config.trustedHost as { sourceRoot: string };
  const outside = path.join(root, 'outside');
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(policy.sourceRoot, 'linked-directory'), 'junction');
  expect(() => fingerprintTrustedHostSource(policy.sourceRoot)).toThrow('package revision changed');
});

it('refuses approval stored alongside workspace data', () => {
  process.env.FLUJO_MCP_TRUSTED_HOST_FILE = path.join(getWorkspaceDataDir(), 'consent.json');
  persist();
  expect(() => assertTrustedHostMcpAllowed(config)).toThrow('explicit owner consent');
});

it('does not grant a different workspace the same server/package consent', async () => {
  await runWithWorkspace('foreign-workspace', async () => {
    expect(() => assertTrustedHostMcpAllowed(config)).toThrow('explicit owner consent');
  });
});

it('refuses unresolved executable paths and leaves caller values out of errors', () => {
  expect(() => assertTrustedHostMcpAllowed({ ...config, command: 'npx' })).toThrow('policy is invalid');
  fs.writeFileSync(process.env.FLUJO_MCP_TRUSTED_HOST_FILE!, 'synthetic-private-malformed-canary');
  let message = '';
  try { assertTrustedHostMcpAllowed(config); } catch (error) { message = (error as Error).message; }
  expect(message).toContain('explicit owner consent');
  expect(message).not.toContain('synthetic-private-malformed-canary');
});


it('binds configured environment values and refuses loader injection', () => {
  const configured = { ...config, env: { STATIC_VALUE: 'approved' }, trustedHost: { ...(config.trustedHost as object), environmentNames: ['STATIC_VALUE'] } };
  approval.approvals[0].policyDigest = trustedHostMcpPolicyDigest(configured);
  persist();
  expect(assertTrustedHostMcpAllowed(configured).kind).toBe('trusted-host');
  expect(() => assertTrustedHostMcpAllowed({ ...configured, env: { STATIC_VALUE: 'changed' } })).toThrow('explicit owner consent');
  expect(() => trustedHostMcpPolicyDigest({ ...config, trustedHost: { ...(config.trustedHost as object), environmentNames: ['NODE_OPTIONS'] }, env: { NODE_OPTIONS: '--require=/outside.js' } })).toThrow('policy is invalid');
});

it('refuses a node entry point outside the fingerprinted package and dynamic runner executables', () => {
  const nodePolicy = { ...(config.trustedHost as object), runtime: 'node', entryPoint: path.join(root, 'outside.js') };
  expect(() => trustedHostMcpPolicyDigest({ ...config, command: process.execPath, args: [nodePolicy.entryPoint], trustedHost: nodePolicy })).toThrow('policy is invalid');
  expect(() => trustedHostMcpPolicyDigest({ ...config, command: path.join(path.dirname(config.command), 'npx'), trustedHost: { ...(config.trustedHost as object), entryPoint: path.join(path.dirname(config.command), 'npx') } })).toThrow('policy is invalid');
});

it('async verification yields and refuses an approval revoked while filesystem verification is pending', async () => {
  const open = fs.promises.open.bind(fs.promises);
  let entered!: () => void;
  let release!: () => void;
  const checking = new Promise<void>(resolve => { entered = resolve; });
  const finish = new Promise<void>(resolve => { release = resolve; });
  const spy = jest.spyOn(fs.promises, 'open').mockImplementation(async (...args) => {
    const handle = await open(...args);
    if (String(args[0]) === config.command) {
      const read = handle.read.bind(handle);
      handle.read = (async (...readArgs: Parameters<typeof handle.read>) => { entered(); await finish; return read(...readArgs); }) as typeof handle.read;
    }
    return handle;
  });
  const verification = verifyTrustedHostMcp(config);
  const rejected = expect(verification).rejects.toThrow('explicit owner consent');
  await checking;
  approval.approvals = [];
  persist();
  release();
  await rejected;
  spy.mockRestore();
});
