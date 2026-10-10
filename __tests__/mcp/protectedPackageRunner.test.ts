import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { MCPStdioConfig } from '@/shared/types/mcp';
import { createStdioTransport, resolveStdioLaunch } from '@/backend/services/mcp/connection';
import { createBetaTransport, createNewBetaClient } from '@/backend/services/mcp/betaClient';
import { getManagedTrustedHost } from '@/backend/services/mcp/trustedHost';
import { saveConfig } from '@/backend/services/mcp/config';
import { resolveRuntimeHomeIsolation } from '@/backend/services/mcp/runtimeHomeIsolation';
import { approveBundledHostConsent, previewBundledHostConsent } from '@/backend/services/security/bundledMcpConsent';
import { installBundledFixtureOwner } from './fixtures/bundledFixtureOwner';
import { saveItem } from '@/utils/storage/backend';
import { StorageKey } from '@/shared/types/storage';
import { getCurrentWorkspace } from '@/utils/workspace';
import { fingerprintTrustedHostSource, trustedHostMcpPolicyDigest, trustedHostMcpPolicySchema, verifyTrustedHostMcp } from '@/backend/services/security/trustedHostMcp';

import { materializeProtectedPackageRunner } from './fixtures/protectedPackageRunner';

// This server uses genuine npm exec resolution and real SDK stdio transport.
// Its one materialized synthetic dependency exercises actual Node resolution.
// There is no registry access, lifecycle hook or real credential.
const serverSource = `#!/usr/bin/env node
const readline = require('node:readline');
const dependency = require('owned-probe-dependency');
if (process.env.SYNTHETIC_STARTUP_MARKER) require('node:fs').writeFileSync(process.env.SYNTHETIC_STARTUP_MARKER, 'started');
readline.createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  let result;
  if (request.method === 'initialize') result = {
    protocolVersion: request.params.protocolVersion, capabilities: { tools: {} },
    serverInfo: { name: 'owned-probe', version: '1.0.0' }
  };
  else if (request.method === 'tools/list') result = { tools: [{ name: 'probe',
    description: 'Read synthetic fixture runtime', inputSchema: { type: 'object' } }] };
  else if (request.method === 'tools/call') result = { content: [{ type: 'text', text: JSON.stringify({
    cwd: process.cwd(), home: process.env.HOME, args: process.argv.slice(2), marker: 'reviewed-package', dependency
  }) }] };
  else if (request.method === 'ping') result = {};
  else { process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,error:{code:-32601,message:'Unknown method'}})+'\\n'); return; }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n');
});
`;

let directory: string;
let cwdDirectory: string;
let parent: string;
let config: MCPStdioConfig;
let saved: Record<string, string | undefined>;
let ledger: { schemaVersion: number; ownerId: string; approvals: Array<{
  workspace: string; serverName: string; policyDigest: string; expiresAt: number;
}> };
const envNames = ['FLUJO_DATA_DIR', 'FLUJO_PARENT_DATA_DIR', 'FLUJO_OWNER_AUTH_FILE', 'FLUJO_MCP_RUNTIME_HOME_ISOLATION',
  'FLUJO_MCP_TRUSTED_HOST_FILE', 'FLUJO_MCP_ISOLATION_FILE'];
const persist = () => fs.writeFileSync(process.env.FLUJO_MCP_TRUSTED_HOST_FILE!, JSON.stringify(ledger), { mode: 0o600 });
const approve = (value = config) => { ledger.approvals = [{ workspace: getCurrentWorkspace(),
  serverName: value.name, policyDigest: trustedHostMcpPolicyDigest(value), expiresAt: Date.now() + 120_000 }]; persist(); };

// The 2026-10-09 isolated Windows run took 206.13s: closure cases took
// 13.05/13.17s and four launch/home/writer cases exceeded the old 25s budget.
// Allow full fresh fingerprint/ACL work and cleanup; SDK connect/call remain 10s.
const caseTimeout = process.platform === 'win32' ? 60_000 : 25_000;
const closureTimeout = process.platform === 'win32' ? 60_000 : 15_000;
const cleanupTimeout = process.platform === 'win32' ? 120_000 : 15_000;
const ownedCases = new Set<Promise<void>>();
function ownedCase(operation: () => Promise<void>): Promise<void> {
  const pending = operation();
  ownedCases.add(pending);
  // Returning the original promise keeps every assertion failure visible to Jest.
  void pending.then(() => ownedCases.delete(pending), () => ownedCases.delete(pending));
  return pending;
}

afterEach(async () => {
  // Jest timeouts do not cancel async tests. Drain their finally blocks before
  // another case restores credentials or renames this shared dependency tree.
  const results = await Promise.allSettled([...ownedCases]);
  for (const result of results) if (result.status === 'rejected') throw result.reason;
}, cleanupTimeout);

beforeAll(() => {
  saved = Object.fromEntries(envNames.map(name => [name, process.env[name]]));
  parent = path.resolve(process.platform === 'win32' ? process.env.LOCALAPPDATA! : os.tmpdir());
  directory = fs.mkdtempSync(path.join(parent, 'flujo-package-runner-'));
  process.env.FLUJO_DATA_DIR = path.join(directory, 'data');
  delete process.env.FLUJO_PARENT_DATA_DIR;
  delete process.env.FLUJO_MCP_ISOLATION_FILE;
  delete process.env.FLUJO_MCP_RUNTIME_HOME_ISOLATION;
  process.env.FLUJO_OWNER_AUTH_FILE = path.join(directory, 'owner.json');
  process.env.FLUJO_MCP_TRUSTED_HOST_FILE = path.join(directory, 'approval.json');
  fs.writeFileSync(process.env.FLUJO_OWNER_AUTH_FILE, JSON.stringify({ schemaVersion: 1,
    ownerId: 'synthetic-package-owner', credentials: [] }), { mode: 0o600 });
  config = materializeProtectedPackageRunner('reviewed-package-runner', serverSource);
  cwdDirectory = config.cwd!;
  ledger = { schemaVersion: 1, ownerId: 'synthetic-package-owner', approvals: [] };
}, 30_000);

beforeEach(async () => {
  if (ownedCases.size) throw new Error('A prior owned package-runner case has not finished cleanup.');
  approve();
  expect(await saveConfig(new Map([[config.name, config]]))).toMatchObject({ success: true });
});
afterAll(() => {
  if (ownedCases.size) throw new Error('Cannot mutate package-runner fixture settings or files while an owned case is active.');
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
  const resolved = path.resolve(directory);
  if (path.dirname(resolved) !== parent || !/^flujo-package-runner-[A-Za-z0-9]+$/.test(path.basename(resolved))
    || fs.lstatSync(resolved).isSymbolicLink()) throw new Error('Unsafe package runner fixture cleanup');
  fs.rmSync(resolved, { recursive: true, force: true });
});

test.each(['v1', 'beta'])('%s starts the reviewed package via genuine offline npx within the original deadline', era => ownedCase(async () => {
  const ignoredConfig = path.join(config.cwd!, '.npmrc');
  fs.writeFileSync(ignoredConfig, 'script-shell=unreviewed-shell-that-does-not-exist\nregistry=https://example.invalid\n');
  const transport = era === 'v1' ? createStdioTransport(config, { isolateRuntimeHome: true })
    : createBetaTransport(config, { isolateRuntimeHome: true });
  const client = era === 'v1' ? new Client({ name: 'synthetic-probe-client', version: '1.0.0' }) : createNewBetaClient(config);
  try {
    await client.connect(transport, { timeout: 10_000 });
    const result = era === 'v1' ? await client.callTool({ name: 'probe', arguments: {} }, undefined, { timeout: 10_000 })
      : await (client as unknown as { callTool(params: unknown, options: unknown): Promise<unknown> }).callTool(
        { name: 'probe', arguments: {} }, { timeout: 10_000 });
    const text = (result as { content: Array<{ text: string }> }).content[0].text;
    expect(JSON.parse(text)).toMatchObject({ marker: 'reviewed-package', cwd: config.cwd,
      args: ['--synthetic-argument'], dependency: 'reviewed-dependency' });
    expect(JSON.parse(text).home).not.toBe(process.env.HOME);
    expect(getManagedTrustedHost(transport)).toBeDefined();
    ledger.approvals = []; persist();
    await expect(getManagedTrustedHost(transport)!.assertCurrent(config))
      .rejects.toMatchObject({ code: 'HOST_CONSENT_REQUIRED' });
  } finally { await client.close(); fs.unlinkSync(ignoredConfig); }
}), caseTimeout);

test.each(['v1', 'beta'])('%s refuses durable revocation before genuine SDK startup', async era => {
  const transport = era === 'v1' ? createStdioTransport(config, { isolateRuntimeHome: true })
    : createBetaTransport(config, { isolateRuntimeHome: true });
  ledger.approvals = []; persist();
  try { await expect(transport.start()).rejects.toMatchObject({ code: 'HOST_CONSENT_REQUIRED' }); }
  finally { await transport.close(); }
});

test.each(['v1', 'beta'])('%s honors a genuinely approved package-runner host-home mode', era => ownedCase(async () => {
  const policy = trustedHostMcpPolicySchema.parse(config.trustedHost);
  const home = path.join(directory, 'reviewed-host-home');
  const cwd = path.join(directory, 'reviewed-host-cwd');
  fs.mkdirSync(cwd, { recursive: true });
  const host = { ...config, cwd, runtimeHomeMode: 'host' as const,
    env: { ...config.env, HOME: home, USERPROFILE: home, NPM_CONFIG_CACHE: path.join(home, '.npm') },
    trustedHost: { ...policy, runtimeHome: 'host' as const } };
  approve(host);
  expect(await saveConfig(new Map([[host.name, host]]))).toMatchObject({ success: true });
  const transport = era === 'v1' ? createStdioTransport(host, { isolateRuntimeHome: false })
    : createBetaTransport(host, { isolateRuntimeHome: false });
  const client = era === 'v1' ? new Client({ name: 'synthetic-host-probe', version: '1.0.0' }) : createNewBetaClient(host);
  try {
    await client.connect(transport, { timeout: 10_000 });
    const result = era === 'v1' ? await client.callTool({ name: 'probe', arguments: {} }, undefined, { timeout: 10_000 })
      : await (client as unknown as { callTool(params: unknown, options: unknown): Promise<unknown> }).callTool(
        { name: 'probe', arguments: {} }, { timeout: 10_000 });
    expect(JSON.parse((result as { content: Array<{ text: string }> }).content[0].text))
      .toMatchObject({ marker: 'reviewed-package', cwd, home });
  } finally { await client.close(); }
}), caseTimeout);

test('the production owner-bearer writer publishes an exact package-runner approval', () => ownedCase(async () => {
  const owner = installBundledFixtureOwner();
  try {
    const preview = await previewBundledHostConsent(config.name, { runtimeHome: 'isolated' });
    const approved = await approveBundledHostConsent(owner.request(config.name), config.name, {
      runtimeHome: 'isolated', reviewedDigest: preview.policyDigest, expiresAt: owner.expiresAt,
    });
    expect((await verifyTrustedHostMcp(approved.config)).digest).toBe(preview.policyDigest);
    expect(JSON.parse(fs.readFileSync(process.env.FLUJO_MCP_TRUSTED_HOST_FILE!, 'utf8')).approvals)
      .toEqual([expect.objectContaining({ serverName: config.name, policyDigest: preview.policyDigest })]);
  } finally { owner.restore(); }
}), caseTimeout);

test('effective runtime-home precedence uses actual workspace settings and server/process preferences', async () => {
  const inherited = { ...config, runtimeHomeMode: 'inherit' as const };
  await saveItem(StorageKey.SPEECH_SETTINGS, { experimental: { mcpRuntimeHomeIsolation: true } });
  try {
    expect(await resolveRuntimeHomeIsolation(inherited, {})).toBe(true);
    expect(await resolveRuntimeHomeIsolation({ ...config, runtimeHomeMode: 'host' }, {})).toBe(false);
    expect(await resolveRuntimeHomeIsolation({ ...config, runtimeHomeMode: 'host' }, { FLUJO_MCP_RUNTIME_HOME_ISOLATION: 'isolated' })).toBe(true);
    expect(await resolveRuntimeHomeIsolation(config, { FLUJO_MCP_RUNTIME_HOME_ISOLATION: 'host' })).toBe(false);
    await saveItem(StorageKey.SPEECH_SETTINGS, { experimental: { mcpRuntimeHomeIsolation: false } });
    expect(await resolveRuntimeHomeIsolation(inherited, {})).toBe(false);
    expect(await resolveRuntimeHomeIsolation({ ...config, runtimeHomeMode: 'isolated' }, {})).toBe(true);
  } finally { await saveItem(StorageKey.SPEECH_SETTINGS, {}); }
});

test.each(['v1', 'beta'])('%s refuses an isolated approval requested with host launch mode', era => {
  expect(() => era === 'v1' ? createStdioTransport(config, { isolateRuntimeHome: false })
    : createBetaTransport(config, { isolateRuntimeHome: false })).toThrow();
});

test.each(['v1', 'beta'])('%s refuses a host approval requested with isolated launch mode', era => {
  const policy = trustedHostMcpPolicySchema.parse(config.trustedHost);
  const host = { ...config, runtimeHomeMode: 'host' as const, trustedHost: { ...policy, runtimeHome: 'host' as const } };
  approve(host);
  expect(() => era === 'v1' ? createStdioTransport(host, { isolateRuntimeHome: true })
    : createBetaTransport(host, { isolateRuntimeHome: true })).toThrow();
});

test.each(['HOME', 'NPM_CONFIG_CACHE'])('a reviewed stale %s cannot silently change the effective runtime profile', field => {
  const changed = { ...config, env: { ...config.env, [field]: path.join(directory, 'wrong-runtime-home') } };
  approve(changed);
  expect(() => resolveStdioLaunch(changed, { isolateRuntimeHome: true })).toThrow();
});

test('package manifest drift cannot be covered by reusing the source digest', () => ownedCase(async () => {
  const policy = trustedHostMcpPolicySchema.parse(config.trustedHost);
  const manifest = path.join(policy.packageRunner!.packageDirectory, 'node_modules', 'owned-probe', 'package.json');
  const original = fs.readFileSync(manifest);
  try {
    const value = JSON.parse(original.toString());
    fs.writeFileSync(manifest, JSON.stringify({ ...value, version: '9.9.9' }));
    await expect(verifyTrustedHostMcp(config)).rejects.toThrow();
  } finally { fs.writeFileSync(manifest, original); }
}), closureTimeout);

test.each(['missing', 'ambient'])('a reapproved source cannot execute an %s mandatory dependency closure', state => ownedCase(async () => {
  const policy = trustedHostMcpPolicySchema.parse(config.trustedHost);
  const packageDirectory = policy.packageRunner!.packageDirectory;
  const dependency = path.join(packageDirectory, 'node_modules', 'owned-probe-dependency');
  const backup = path.join(directory, 'dependency-backup');
  const ambient = path.join(path.dirname(policy.sourceRoot), 'node_modules', 'owned-probe-dependency');
  const ambientParentExisted = fs.existsSync(path.dirname(ambient));
  const entryPoint = path.join(packageDirectory, 'node_modules', 'owned-probe', 'server.cjs');
  const resolveInActualNode = () => execFileSync(process.execPath, ['-e',
    "process.stdout.write(require('node:module').createRequire(process.argv[1]).resolve('owned-probe-dependency'))", entryPoint], {
    encoding: 'utf8', timeout: 5_000, stdio: ['ignore', 'pipe', 'pipe'], env: {
      NODE_ENV: 'test',
      HOME: path.join(directory, 'resolution-home'), USERPROFILE: path.join(directory, 'resolution-home'),
      ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot! } : {}),
    },
  });
  fs.renameSync(dependency, backup);
  try {
    if (state === 'ambient') {
      fs.mkdirSync(ambient, { recursive: true });
      fs.writeFileSync(path.join(ambient, 'package.json'), JSON.stringify({
        name: 'owned-probe-dependency', version: '1.0.0', main: 'index.cjs' }));
      fs.writeFileSync(path.join(ambient, 'index.cjs'), "module.exports = 'unreviewed-ambient-dependency';\n");
      // Demonstrate the actual resolution candidate, not a modeled resolver.
      expect(resolveInActualNode()).toBe(path.join(ambient, 'index.cjs'));
    } else {
      expect(() => resolveInActualNode()).toThrow();
    }
    const reapproved = { ...config, trustedHost: { ...policy,
      sourceDigest: fingerprintTrustedHostSource(policy.sourceRoot) } };
    approve(reapproved);
    await expect(verifyTrustedHostMcp(reapproved)).rejects.toThrow();
  } finally {
    const resolved = path.resolve(ambient);
    if (!resolved.startsWith(path.resolve(directory) + path.sep)) throw new Error('Unsafe ambient dependency cleanup');
    fs.rmSync(resolved, { recursive: true, force: true });
    if (!ambientParentExisted && fs.existsSync(path.dirname(ambient))) fs.rmdirSync(path.dirname(ambient));
    fs.renameSync(backup, dependency);
  }
}), closureTimeout);

test.each(['isolated', 'host'] as const)('a %s approval cannot survive an override flip during the actual source reader', async initialMode => {
  const policy = trustedHostMcpPolicySchema.parse(config.trustedHost);
  const marker = path.join(directory, 'late-mode-startup-marker');
  const home = path.join(directory, 'late-mode-host-home');
  const hostCwd = path.join(directory, 'late-mode-host-cwd');
  fs.mkdirSync(hostCwd, { recursive: true });
  const current = { ...config, runtimeHomeMode: 'inherit' as const,
    cwd: initialMode === 'host' ? hostCwd : config.cwd,
    env: { ...config.env, SYNTHETIC_STARTUP_MARKER: marker,
      ...(initialMode === 'host' ? { HOME: home, USERPROFILE: home, NPM_CONFIG_CACHE: path.join(home, '.npm') } : {}) },
    trustedHost: { ...policy, runtimeHome: initialMode,
      environmentNames: [...policy.environmentNames, 'SYNTHETIC_STARTUP_MARKER'] } };
  process.env.FLUJO_MCP_RUNTIME_HOME_ISOLATION = initialMode;
  approve(current);
  expect(await saveConfig(new Map([[current.name, current]]))).toMatchObject({ success: true });
  const transport = createStdioTransport(current, { isolateRuntimeHome: initialMode === 'isolated' });
  const source = path.join(policy.packageRunner!.packageDirectory, 'node_modules', 'owned-probe', 'server.cjs');
  const actualOpen = fs.promises.open.bind(fs.promises);
  let flipped = false;
  const reader = jest.spyOn(fs.promises, 'open').mockImplementation(async (filename, flags, mode) => {
    const handle = await actualOpen(filename, flags, mode);
    if (String(filename) === source && !flipped) {
      flipped = true;
      process.env.FLUJO_MCP_RUNTIME_HOME_ISOLATION = initialMode === 'isolated' ? 'host' : 'isolated';
    }
    return handle;
  });
  try {
    await expect(transport.start()).rejects.toThrow();
    expect(flipped).toBe(true);
    expect(fs.existsSync(marker)).toBe(false);
  } finally {
    reader.mockRestore();
    delete process.env.FLUJO_MCP_RUNTIME_HOME_ISOLATION;
    await transport.close();
  }
}, 25_000);

test.each(['expired', 'wrong-owner', 'imported'])('real authority refuses %s approvals', async state => {
  if (state === 'expired') ledger.approvals[0].expiresAt = Date.now() - 1;
  else if (state === 'wrong-owner') ledger.ownerId = 'another-owner';
  else ledger.approvals = [];
  persist();
  try { await expect(verifyTrustedHostMcp(config)).rejects.toThrow(); }
  finally { ledger.ownerId = 'synthetic-package-owner'; }
});

test('source bytes changed after approval refuse launch and are never silently reapproved', async () => {
  const target = path.join(trustedHostMcpPolicySchema.parse(config.trustedHost).sourceRoot, 'project', 'node_modules', 'owned-probe', 'server.cjs');
  const original = fs.readFileSync(target);
  try {
    fs.appendFileSync(target, '\n// Unreviewed revision\n');
    await expect(verifyTrustedHostMcp(config)).rejects.toThrow();
  } finally { fs.writeFileSync(target, original); }
});

test('ancestor binary resolution authority is also refused', async () => {
  const nested = path.join(cwdDirectory, 'nested');
  fs.mkdirSync(nested);
  const nestedConfig = { ...config, cwd: nested };
  const location = path.join(cwdDirectory, 'node_modules', '.bin');
  try {
    fs.mkdirSync(location, { recursive: true });
    await expect(verifyTrustedHostMcp(nestedConfig)).rejects.toThrow();
  } finally {
    const resolved = path.resolve(location);
    if (!resolved.startsWith(path.resolve(cwdDirectory) + path.sep)) throw new Error('Unsafe ancestor fixture cleanup');
    fs.rmSync(resolved, { recursive: true, force: true });
    fs.rmdirSync(nested);
  }
});

test.each(['args', 'cwd'])('a changed %s cannot reuse the real owner grant', field => {
  const changed = field === 'args' ? { ...config, args: [...config.args!, '--different'] }
    : { ...config, cwd: path.dirname(config.cwd!) };
  expect(() => resolveStdioLaunch(changed, { isolateRuntimeHome: true })).toThrow();
});

test('new cwd binary authority is refused even after policy reapproval', async () => {
  const location = path.join(config.cwd!, 'node_modules', '.bin');
  try {
    fs.mkdirSync(location, { recursive: true });
    approve();
    await expect(verifyTrustedHostMcp(config)).rejects.toThrow();
  } finally {
    const resolved = path.resolve(location);
    if (!resolved.startsWith(path.resolve(config.cwd!) + path.sep)) throw new Error('Unsafe resolution fixture cleanup');
    fs.rmSync(resolved, { recursive: true, force: true });
  }
});
