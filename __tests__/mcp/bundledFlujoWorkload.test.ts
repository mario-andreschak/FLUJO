import { computeBundledFlujoWorkloadDefinitions, computeBundledFlujoWorkloadInventory } from '@/backend/services/mcp/bundledFlujoWorkloadInventory';
import { FLUJO_AUTHORING_TOOLS, FLUJO_FLOW_TOOLS, FLUJO_SERVER_TOOLS, FLUJO_AUTOMATION_TOOLS, FLUJO_STATE_TOOLS } from '@/backend/services/mcp/flujoControlApi';
import { assertVerifiedBundledFlujoWorkloadStart } from '@/backend/services/mcp/trustedHost';
import { resolveBundledFlujoWorkloadRequest, withBundledFlujoWorkloadAuthorization, type BundledFlujoWorkloadAuthorization, type PendingBundledFlujoWorkload } from '@/backend/services/security/bundledFlujoWorkload';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { getCurrentWorkspace, getWorkspaceDir } from '@/utils/workspace';
import { createShippedServerConfig, SHIPPED_MCP_SERVERS } from '@/backend/services/mcp/shippedServers';
import { ensureShippedWorkspacePackages } from '@/backend/services/mcp/shippedWorkspacePackages';
import { saveConfig } from '@/backend/services/mcp/config';
import { previewBundledHostConsent, approveBundledHostConsent } from '@/backend/services/security/bundledMcpConsent';
import { attachTrustedHost } from '@/backend/services/mcp/trustedHost';
import { prepareBundledFlujoWorkload, getPendingWorkloadEnvironment } from '@/backend/services/security/bundledFlujoWorkload';
import { installBundledFixtureOwner } from './fixtures/bundledFixtureOwner';

test.each(['FLUJO_MCP_WORKLOAD_TOKEN', 'flujo_mcp_workload_token', 'Flujo_Mcp_Workload_Token',
  'FLUJO_MCP_WORKLOAD_AUDIENCE', 'flujo_mcp_workload_audience', 'Flujo_Mcp_Workload_Audience'])
('reserved persisted %s denies unrelated and worker stdio before eligibility returns', name => {
  const previous = process.env.FLUJO_WORKER_MODE;
  try {
    const descriptor = SHIPPED_MCP_SERVERS.find(item => item.packageDirectory === 'filesystem')!;
    for (const worker of [undefined, '1']) {
      if (worker === undefined) delete process.env.FLUJO_WORKER_MODE; else process.env.FLUJO_WORKER_MODE = worker;
      const config = createShippedServerConfig(descriptor);
      expect(prepareBundledFlujoWorkload(config)).toBeUndefined();
      for (const trustedHost of [undefined, { schemaVersion: 1, kind: 'trusted-host', privileges: 'owner-account',
        runtime: 'node', entryPoint: process.execPath, sourceRoot: path.dirname(process.execPath),
        sourceDigest: '0'.repeat(64), executableDigest: '0'.repeat(64), environmentNames: [] }]) {
        expect(() => prepareBundledFlujoWorkload({ ...config, trustedHost, env: { ...config.env, [name]: 'persisted-untrusted-value' } })).toThrow();
      }
    }
  } finally {
    if (previous === undefined) delete process.env.FLUJO_WORKER_MODE; else process.env.FLUJO_WORKER_MODE = previous;
  }
});

test('review inventory covers every actual mapped tool and all six protocol operations', async () => {
  const mapped = [...FLUJO_AUTHORING_TOOLS, ...FLUJO_FLOW_TOOLS, ...FLUJO_SERVER_TOOLS, ...FLUJO_AUTOMATION_TOOLS, ...FLUJO_STATE_TOOLS];
  expect(mapped).toHaveLength(43);
  const definitions = await computeBundledFlujoWorkloadDefinitions();
  expect(definitions.filter(item => item.tool).map(item => item.action.action).sort()).toEqual([...mapped].sort());
  expect(definitions.filter(item => !item.tool).map(item => item.action.action).sort()).toEqual(
    ['listTools', 'listResources', 'listResourceTemplates', 'readResource', 'listSkills', 'getSkill'].sort());
  expect(await computeBundledFlujoWorkloadInventory()).toHaveLength(49);
  for (const item of definitions) {
    expect(item.schema).toEqual(expect.objectContaining({ type: 'object' }));
    expect(item.action.schemaDigest).toMatch(/^[a-f0-9]{64}$/);
  }
});

test('public lookalikes cannot issue a private start proof or enter workload ALS', async () => {
  expect(() => assertVerifiedBundledFlujoWorkloadStart({}, {} as PendingBundledFlujoWorkload)).toThrow();
  const request = new Request('http://127.0.0.1:4200/api/mcp/flujo/tools');
  const forged = { workspace: 'default', serverName: 'flujo', generation: 'synthetic', inventory: [],
    readRequest: () => request, recheck: async () => null } satisfies BundledFlujoWorkloadAuthorization;
  const effect = jest.fn(async () => 'executed');
  await expect(withBundledFlujoWorkloadAuthorization(forged, request, effect)).rejects.toThrow();
  expect(effect).not.toHaveBeenCalled();
});

test.each(['Bearer flo_mcp1_bad', 'bearer FLO_MCP1_bad', 'Basic flo_mcp1_bad', 'Bearer flo_mcp1_bad, Bearer owner'])
('present malformed workload credential categorically denies rather than owner fallback: %s', async authorization => {
  const result = await resolveBundledFlujoWorkloadRequest(new Request('http://127.0.0.1:4200/api/mcp/flujo/tools', {
    headers: { authorization },
  }));
  expect(result.kind).toBe('denied');
  if (result.kind === 'denied') expect(result.response.status).toBe(401);
});

test('unrelated owner credential remains outside workload authority', async () => {
  expect(await resolveBundledFlujoWorkloadRequest(new Request('http://127.0.0.1:4200/api/mcp/flujo/tools', {
    headers: { authorization: 'Bearer synthetic-owner-credential' },
  }))).toEqual({ kind: 'unrelated' });
});

test('real private consent activates only at guarded start, owner drift denies, and retirement removes its owned pair', async () => {
  const names = ['FLUJO_APP_ROOT', 'FLUJO_DATA_DIR', 'FLUJO_PARENT_DATA_DIR', 'FLUJO_BASE_URL', 'FLUJO_WORKER_MODE'];
  const saved = Object.fromEntries(names.map(name => [name, process.env[name]]));
  const parent = path.resolve(process.platform === 'win32' ? process.env.LOCALAPPDATA ?? os.tmpdir() : os.tmpdir());
  const fixture = fs.mkdtempSync(path.join(parent, 'flujo-workload-control-'));
  const application = path.join(fixture, 'application');
  const write = (relative: string, content: string) => {
    const filename = path.join(application, relative); fs.mkdirSync(path.dirname(filename), { recursive: true }); fs.writeFileSync(filename, content);
  };
  let owner: ReturnType<typeof installBundledFixtureOwner> | undefined;
  let transport: { start(): Promise<void>; close(): Promise<void> } | undefined;
  let primaryFailed = false;
  let primaryError: unknown;
  try {
    process.env.FLUJO_APP_ROOT = application; process.env.FLUJO_DATA_DIR = path.join(fixture, 'data');
    process.env.FLUJO_BASE_URL = 'http://127.0.0.1:4200'; delete process.env.FLUJO_PARENT_DATA_DIR; delete process.env.FLUJO_WORKER_MODE;
    const descriptor = SHIPPED_MCP_SERVERS.find(item => item.packageDirectory === 'flujo')!;
    write('package.json', '{"name":"flujo-ai","version":"1.0.0"}');
    write('node_modules/fixture-dependency/package.json', '{"name":"fixture-dependency","version":"1.0.0","type":"module","exports":"./index.js"}');
    write('node_modules/fixture-dependency/index.js', 'export const value = 1;');
    write('mcp-servers/flujo/package.json', JSON.stringify({ name: descriptor.packageId, version: '1.0.0', type: 'module', dependencies: { 'fixture-dependency': '1.0.0' } }));
    write('mcp-servers/flujo/src/index.ts', '// genuine fixture source');
    write('mcp-servers/flujo/dist/index.js', 'export { value } from "fixture-dependency";');
    await ensureShippedWorkspacePackages(getWorkspaceDir(getCurrentWorkspace()), application, ['flujo']);
    const proposed = createShippedServerConfig(descriptor);
    expect((await saveConfig(new Map([[proposed.name, proposed]]))).success).toBe(true);
    owner = installBundledFixtureOwner();
    const preview = await previewBundledHostConsent(proposed.name, { runtimeHome: 'host' });
    const approved = await approveBundledHostConsent(owner.request(proposed.name), proposed.name, {
      runtimeHome: 'host', reviewedDigest: preview.policyDigest, expiresAt: owner.expiresAt,
    });
    const capsule = prepareBundledFlujoWorkload(approved.config)!;
    const environment = getPendingWorkloadEnvironment(approved.config, capsule);
    const token = environment.FLUJO_MCP_WORKLOAD_TOKEN;
    const request = () => new Request('http://127.0.0.1:4200/api/mcp/flujo/tools', { headers: {
      host: '127.0.0.1:4200', 'x-flujo-workspace': getCurrentWorkspace(), authorization: `Bearer ${token}`,
    } });
    expect((await resolveBundledFlujoWorkloadRequest(request())).kind).toBe('denied');
    const start = jest.fn(async () => undefined), close = jest.fn(async () => undefined);
    transport = { start, close };
    attachTrustedHost(transport, approved.config, undefined, capsule);
    await transport.start();
    expect(start).toHaveBeenCalledTimes(1);
    expect((await resolveBundledFlujoWorkloadRequest(request())).kind).toBe('authorized');
    const ownerFilename = process.env.FLUJO_OWNER_AUTH_FILE!;
    const originalOwner = fs.readFileSync(ownerFilename);
    const changed = JSON.parse(originalOwner.toString()); changed.credentials = [];
    fs.writeFileSync(ownerFilename, JSON.stringify(changed));
    expect((await resolveBundledFlujoWorkloadRequest(request())).kind).toBe('denied');
    fs.writeFileSync(ownerFilename, originalOwner);
    const ledger = process.env.FLUJO_MCP_TRUSTED_HOST_FILE!;
    const namespace = createHash('sha256').update(path.resolve(ledger)).digest('hex').slice(0, 24);
    const workloadDirectory = path.join(path.dirname(ledger), `.flujo-workloads-${namespace}`);
    await transport.close(); transport = undefined;
    expect(close).toHaveBeenCalledTimes(1);
    expect(fs.readdirSync(workloadDirectory)).toEqual([]);
    expect((await resolveBundledFlujoWorkloadRequest(request())).kind).toBe('denied');
  } catch (error) {
    primaryFailed = true; primaryError = error; throw error;
  } finally {
    const cleanupErrors: unknown[] = [];
    try { await transport?.close(); } catch (error) { cleanupErrors.push(error); }
    try { owner?.restore(); } catch (error) { cleanupErrors.push(error); }
    for (const [name, value] of Object.entries(saved)) {
      try { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
      catch (error) { cleanupErrors.push(error); }
    }
    try {
      if (path.dirname(fixture) !== parent || !/^flujo-workload-control-[A-Za-z0-9]+$/.test(path.basename(fixture)) || fs.lstatSync(fixture).isSymbolicLink()) throw new Error('Unsafe workload fixture cleanup.');
      fs.rmSync(fixture, { recursive: true, force: true });
    } catch (error) { cleanupErrors.push(error); }
    if (cleanupErrors.length) throw new AggregateError(primaryFailed ? [primaryError, ...cleanupErrors] : cleanupErrors,
      'Workload fixture cleanup failed.', primaryFailed ? { cause: primaryError } : undefined);
  }
}, 60_000);
