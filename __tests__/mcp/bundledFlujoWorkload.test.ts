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
import { AsyncLocalStorage } from 'node:async_hooks';

function reportRetirementSites(error: unknown, seen = new Set<unknown>()) {
  if (!(error instanceof Error) || seen.has(error)) return;
  seen.add(error);
  try {
    const sites = error.stack?.match(/bundledFlujoWorkload\.ts:\d+:\d+/g) ?? [];
    console.info('[workload-recovery-site]', sites);
  } catch { /* Preserve the actual fixture failure. */ }
  if (error instanceof AggregateError) for (const nested of error.errors) reportRetirementSites(nested, seen);
  reportRetirementSites(error.cause, seen);
}

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

test.each([false, true])('review inventory commits every available mapped tool and six protocols (screenshot enabled: %s)', async enabled => {
  const previous = process.env.FLUJO_SYSTEM_SCREENSHOT_ENABLED;
  process.env.FLUJO_SYSTEM_SCREENSHOT_ENABLED = enabled ? '1' : '0';
  try {
  const mapped = [...FLUJO_AUTHORING_TOOLS, ...FLUJO_FLOW_TOOLS, ...FLUJO_SERVER_TOOLS, ...FLUJO_AUTOMATION_TOOLS, ...FLUJO_STATE_TOOLS];
  expect(mapped).toHaveLength(43);
  const definitions = await computeBundledFlujoWorkloadDefinitions();
  expect(definitions.filter(item => item.tool).map(item => item.action.action).sort()).toEqual(mapped.filter(name => enabled || name !== 'system_screenshot').sort());
  expect(definitions.filter(item => !item.tool).map(item => item.action.action).sort()).toEqual(
    ['listTools', 'listResources', 'listResourceTemplates', 'readResource', 'listSkills', 'getSkill'].sort());
  expect(await computeBundledFlujoWorkloadInventory()).toHaveLength(enabled ? 49 : 48);
  for (const item of definitions) {
    expect(item.schema).toEqual(expect.objectContaining({ type: 'object' }));
    expect(item.action.schemaDigest).toMatch(/^[a-f0-9]{64}$/);
  }
  } finally { if (previous === undefined) delete process.env.FLUJO_SYSTEM_SCREENSHOT_ENABLED; else process.env.FLUJO_SYSTEM_SCREENSHOT_ENABLED = previous; }
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

test.each(['object', 'unrelated-request'])('present public %s carrier never falls back to ordinary effect authority', async kind => {
  const carrier = Object.getOwnPropertyDescriptor(globalThis, Symbol.for('FLUJO:bundled-flujo-workload-request:v1'))!.value as AsyncLocalStorage<unknown>;
  const frame = kind === 'object' ? { url: 'http://127.0.0.1:4200/api/mcp/flujo/tools', authorization: 'lookalike' }
    : new Request('http://127.0.0.1:4200/api/mcp/flujo/tools', { headers: { authorization: 'Bearer unrelated-owner' } });
  await carrier.run(frame, async () => {
    const workloadModule = jest.requireActual<typeof import('@/backend/services/security/bundledFlujoWorkload')>('@/backend/services/security/bundledFlujoWorkload');
    expect(() => workloadModule.getAuthorizedBundledFlujoWorkloadToolNames()).toThrow();
    await expect(workloadModule.assertBundledFlujoWorkloadEffectCurrent()).rejects.toThrow();
    await expect(workloadModule.assertBundledFlujoWorkloadAction('listTools', 'GET', '/api/mcp/flujo/tools')).rejects.toThrow();
  });
});

test.each(['lifecycle', 'crossgraph-positive', 'inventory-drift', 'deferred-owner-drift', 'retired-selected-context',
  'retire-unlink-retry', 'retire-closed-descriptor-retry', 'retire-unknown-parent', 'retire-acquisition-ambiguous'] as const)
('real private consent and fresh guarded workload contract: %s', async mode => {
  const startedAt = performance.now();
  const stamp = (name: string) => console.info('[workload-control]', name, Math.round(performance.now() - startedAt));
  const timed = async <T,>(name: string, operation: () => Promise<T>): Promise<T> => {
    stamp(`${name}:start`);
    try { return await operation(); } finally { stamp(`${name}:settled`); }
  };
  const cancellation = new AbortController();
  const deadline = setTimeout(() => {
    cancellation.abort(new Error('Workload fixture cancellation deadline.'));
    try { stamp('deadline-abort'); } catch { /* Keep cancellation independent of diagnostic logging. */ }
  }, 55_000);
  let graphB!: typeof import('@/backend/services/security/bundledFlujoWorkload');
  let readerDelegate!: { current: typeof import('@/backend/services/security/trustedHostMcp').readPrivateApprovalSetAsync };
  if (mode === 'deferred-owner-drift') jest.doMock('@/backend/services/security/trustedHostMcp', () => {
    const actual = jest.requireActual<typeof import('@/backend/services/security/trustedHostMcp')>('@/backend/services/security/trustedHostMcp');
    readerDelegate = { current: actual.readPrivateApprovalSetAsync };
    return { ...actual, readPrivateApprovalSetAsync: (...args: Parameters<typeof actual.readPrivateApprovalSetAsync>) => readerDelegate.current(...args) };
  });
  try {
    jest.isolateModules(() => { graphB = jest.requireActual('@/backend/services/security/bundledFlujoWorkload'); });
  } finally {
    if (mode === 'deferred-owner-drift') jest.dontMock('@/backend/services/security/trustedHostMcp');
  }
  expect(graphB.assertBundledFlujoWorkloadEffectCurrent).not.toBe(jest.requireActual('@/backend/services/security/bundledFlujoWorkload').assertBundledFlujoWorkloadEffectCurrent);
  const serviceKey = Symbol('Source control global graph B service');
  const capturedService = Object.freeze({ assertEffect: graphB.assertBundledFlujoWorkloadEffectCurrent });
  Object.defineProperty(globalThis, serviceKey, { value: capturedService, configurable: true });
  const names = ['FLUJO_APP_ROOT', 'FLUJO_DATA_DIR', 'FLUJO_PARENT_DATA_DIR', 'FLUJO_BASE_URL', 'FLUJO_WORKER_MODE', 'FLUJO_SYSTEM_SCREENSHOT_ENABLED', 'FLUJO_MCP_WORKLOAD_TRACE'];
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
  const foreignDescriptors: number[] = [];
  try {
    process.env.FLUJO_APP_ROOT = application; process.env.FLUJO_DATA_DIR = path.join(fixture, 'data');
    process.env.FLUJO_BASE_URL = 'http://127.0.0.1:4200'; delete process.env.FLUJO_PARENT_DATA_DIR; delete process.env.FLUJO_WORKER_MODE;
    process.env.FLUJO_SYSTEM_SCREENSHOT_ENABLED = '0';
    process.env.FLUJO_MCP_WORKLOAD_TRACE = '1';
    const descriptor = SHIPPED_MCP_SERVERS.find(item => item.packageDirectory === 'flujo')!;
    write('package.json', '{"name":"flujo-ai","version":"1.0.0"}');
    write('node_modules/fixture-dependency/package.json', '{"name":"fixture-dependency","version":"1.0.0","type":"module","exports":"./index.js"}');
    write('node_modules/fixture-dependency/index.js', 'export const value = 1;');
    write('mcp-servers/flujo/package.json', JSON.stringify({ name: descriptor.packageId, version: '1.0.0', type: 'module', dependencies: { 'fixture-dependency': '1.0.0' } }));
    write('mcp-servers/flujo/src/index.ts', '// genuine fixture source');
    write('mcp-servers/flujo/dist/index.js', 'export { value } from "fixture-dependency";');
    fs.mkdirSync(getWorkspaceDir(getCurrentWorkspace()), { recursive: true });
    await timed('package-copy', () => ensureShippedWorkspacePackages(getWorkspaceDir(getCurrentWorkspace()), application, ['flujo']));
    const proposed = createShippedServerConfig(descriptor);
    expect((await timed('persist-config', () => saveConfig(new Map([[proposed.name, proposed]])))).success).toBe(true);
    const fixtureOwner = installBundledFixtureOwner();
    owner = fixtureOwner;
    const preview = await timed('preview', () => previewBundledHostConsent(proposed.name, { runtimeHome: 'host' }));
    const approved = await timed('approve', () => approveBundledHostConsent(new Request(fixtureOwner.request(proposed.name), { signal: cancellation.signal }), proposed.name, {
      runtimeHome: 'host', reviewedDigest: preview.policyDigest, expiresAt: fixtureOwner.expiresAt,
    }));
    const capsule = prepareBundledFlujoWorkload(approved.config)!;
    const environment = getPendingWorkloadEnvironment(approved.config, capsule);
    const token = environment.FLUJO_MCP_WORKLOAD_TOKEN;
    const request = () => new Request('http://127.0.0.1:4200/api/mcp/flujo/tools', { signal: cancellation.signal, headers: {
      host: '127.0.0.1:4200', 'x-flujo-workspace': getCurrentWorkspace(), authorization: `Bearer ${token}`,
    } });
    expect((await resolveBundledFlujoWorkloadRequest(request())).kind).toBe('denied');
    const start = jest.fn(async () => undefined), close = jest.fn(async () => undefined);
    transport = { start, close };
    attachTrustedHost(transport, approved.config, undefined, capsule);
    const key = createHash('sha256').update(token).digest('hex');
    let recordDescriptor: number | undefined;
    const actualOpen = fs.openSync;
    const opened = mode.startsWith('retire-') ? jest.spyOn(fs, 'openSync').mockImplementation((...args: Parameters<typeof fs.openSync>) => {
      const fd = Reflect.apply(actualOpen, fs, args) as number;
      if (String(args[0]).endsWith(`${key}.pending`) && typeof args[1] === 'number' && (args[1] & fs.constants.O_EXCL)) recordDescriptor = fd;
      return fd;
    }) : undefined;
    try { await timed('guarded-start', () => transport!.start()); } finally { opened?.mockRestore(); }
    expect(start).toHaveBeenCalledTimes(1);
    expect((await timed('resolve-active', () => resolveBundledFlujoWorkloadRequest(request()))).kind).toBe('authorized');
    const admittedRequest = request();
    const admitted = await resolveBundledFlujoWorkloadRequest(admittedRequest);
    if (admitted.kind !== 'authorized') throw new Error('Genuine request not admitted.');
    const producer = jest.fn();
    if (mode === 'crossgraph-positive') {
    await withBundledFlujoWorkloadAuthorization(admitted.authorization, admittedRequest, async () => {
      expect(() => graphB.getAuthorizedBundledFlujoWorkloadToolNames()).toThrow(graphB.BundledFlujoWorkloadError);
      const service = Reflect.get(globalThis, serviceKey) as typeof capturedService;
      await timed('graph-b-effect', () => service.assertEffect());
      await timed('graph-b-action', () => graphB.assertBundledFlujoWorkloadAction('listTools', 'GET', '/api/mcp/flujo/tools'));
      producer();
    });
    expect(producer).toHaveBeenCalledTimes(1);
    }
    if (mode === 'inventory-drift') {
    await withBundledFlujoWorkloadAuthorization(admitted.authorization, admittedRequest, async () => {
      await timed('graph-b-prime', () => capturedService.assertEffect());
      process.env.FLUJO_SYSTEM_SCREENSHOT_ENABLED = '1';
      try { await expect(capturedService.assertEffect()).rejects.toThrow(); }
      finally { process.env.FLUJO_SYSTEM_SCREENSHOT_ENABLED = '0'; }
    });
    expect(producer).not.toHaveBeenCalled();
    }
    const ownerFilename = process.env.FLUJO_OWNER_AUTH_FILE!;
    const originalOwner = fs.readFileSync(ownerFilename);
    const changed = JSON.parse(originalOwner.toString()); changed.credentials = [];
    if (mode === 'lifecycle') {
      fs.writeFileSync(ownerFilename, JSON.stringify(changed));
      try { expect((await resolveBundledFlujoWorkloadRequest(request())).kind).toBe('denied'); }
      finally { fs.writeFileSync(ownerFilename, originalOwner); }
    }
    if (mode === 'deferred-owner-drift') {
    await withBundledFlujoWorkloadAuthorization(admitted.authorization, admittedRequest, async () => {
      await timed('graph-b-prime', () => capturedService.assertEffect());
      const actualRead = readerDelegate.current;
      let enter!: () => void, release!: () => void, paused = false;
      const entered = new Promise<void>(resolve => { enter = resolve; });
      const continuation = new Promise<void>(resolve => { release = resolve; });
      readerDelegate.current = async (filenames, signal) => {
        const value = await actualRead(filenames, signal);
        if (filenames.includes(ownerFilename) && !paused) { paused = true; stamp('owner-read:entered'); enter(); await continuation; }
        return value;
      };
      const checking = timed('graph-b-drift', () => capturedService.assertEffect());
      try {
        // Observe early completion/refusal as well as the gate; always release
        // and drain the real guard in finally before restoring its reader.
        await Promise.race([entered, checking.then(() => { throw new Error('Workload guard completed before owner-read gate.'); })]);
        fs.writeFileSync(ownerFilename, JSON.stringify(changed));
        release();
        await expect(checking).rejects.toBeInstanceOf(jest.requireActual('@/backend/services/security/bundledFlujoWorkload').BundledFlujoWorkloadError);
        expect((await resolveBundledFlujoWorkloadRequest(request())).kind).toBe('denied');
        await expect(capturedService.assertEffect()).rejects.toBeInstanceOf(jest.requireActual('@/backend/services/security/bundledFlujoWorkload').BundledFlujoWorkloadError);
        await expect(graphB.assertBundledFlujoWorkloadAction('listTools', 'GET', '/api/mcp/flujo/tools')).rejects.toThrow();
        expect(() => graphB.getAuthorizedBundledFlujoWorkloadToolNames()).toThrow();
      } finally {
        release();
        try { await checking; } catch { /* The refusal is asserted above; drain before fixture restoration. */ }
        readerDelegate.current = actualRead; fs.writeFileSync(ownerFilename, originalOwner);
      }
    });
    expect(producer).not.toHaveBeenCalled();
    }
    const ledger = process.env.FLUJO_MCP_TRUSTED_HOST_FILE!;
    const namespace = createHash('sha256').update(path.resolve(ledger)).digest('hex').slice(0, 24);
    const workloadDirectory = path.join(path.dirname(ledger), `.flujo-workloads-${namespace}`);
    let expectedCloseCount = 1;
    let unknownSiblingCreated = false;
    if (mode === 'retire-acquisition-ambiguous') {
      const actualOpen = fs.openSync, actualStat = fs.fstatSync, actualClose = fs.closeSync, actualUnlink = fs.unlinkSync;
      const recordName = path.join(workloadDirectory, `${key}.json`);
      let acquired: number | undefined, failedStat = false;
      const opened = jest.spyOn(fs, 'openSync').mockImplementation((...args: Parameters<typeof fs.openSync>) => {
        const fd = actualOpen(...args);
        const stack = new Error().stack ?? '';
        if (String(args[0]) === recordName && typeof args[1] === 'number' && (args[1] & fs.constants.O_RDWR) === 0
            && acquired === undefined && stack.includes('closeOwnedFile') && !stack.includes('readStableFile')) acquired = fd;
        return fd;
      });
      const stat = jest.spyOn(fs, 'fstatSync').mockImplementation((...args: Parameters<typeof fs.fstatSync>) => {
        if (args[0] === acquired && !failedStat) { failedStat = true; throw Object.assign(new Error('Owned acquisition validation fault.'), { code: 'EIO' }); }
        return actualStat(...args);
      });
      const closed = jest.spyOn(fs, 'closeSync').mockImplementation(fd => {
        if (fd === acquired) throw Object.assign(new Error('Ambiguous acquired descriptor close.'), { code: 'EIO' });
        actualClose(fd);
      });
      const unlink = jest.spyOn(fs, 'unlinkSync').mockImplementation(filename => {
        if (String(filename) === recordName) throw Object.assign(new Error('Owned unlink fault.'), { code: 'EIO' });
        actualUnlink(filename);
      });
      try { await expect(transport.close()).rejects.toThrow(); }
      finally { opened.mockRestore(); stat.mockRestore(); closed.mockRestore(); unlink.mockRestore(); }
      expect(failedStat).toBe(true); expect(acquired).toBeDefined();
      foreignDescriptors.push(acquired!);
      expect(actualStat(acquired!).isFile()).toBe(true);
      const retryOpen = jest.spyOn(fs, 'openSync');
      let retryRecordOpens = 0;
      try { await expect(transport.close()).rejects.toThrow(); retryRecordOpens = retryOpen.mock.calls.filter(args => String(args[0]) === recordName).length; }
      finally { retryOpen.mockRestore(); }
      expect(retryRecordOpens).toBe(0);
      expect(actualStat(acquired!).isFile()).toBe(true);
      expect((await resolveBundledFlujoWorkloadRequest(request())).kind).toBe('denied');
      // The fixture owns this genuinely acquired handle. Closing it establishes
      // authoritative EBADF; no production clear or authority mock is involved.
      actualClose(acquired!); foreignDescriptors.pop();
      const unrelated = path.join(fixture, 'ambiguous-acquisition-foreign.json');
      fs.writeFileSync(unrelated, '{"unrelated":"preserve"}');
      for (let count = 0; count < 64; count++) {
        const fd = actualOpen(unrelated, 'r'); foreignDescriptors.push(fd);
        if (fd === acquired) break;
      }
      expect(foreignDescriptors).toContain(acquired);
      await expect(transport.close()).rejects.toThrow();
      for (const fd of foreignDescriptors) expect(actualStat(fd).isFile()).toBe(true);
      expect(fs.readFileSync(unrelated, 'utf8')).toBe('{"unrelated":"preserve"}');
      for (const fd of foreignDescriptors) actualClose(fd);
      foreignDescriptors.length = 0;
      expectedCloseCount = 4;
    }
    if (mode === 'retire-unlink-retry' || mode === 'retire-unknown-parent') {
      const actualUnlink = fs.unlinkSync;
      const actualClose = fs.closeSync;
      let closeObserved = false;
      const observedClose = jest.spyOn(fs, 'closeSync').mockImplementation(fd => {
        const observe = !closeObserved && fd === recordDescriptor;
        if (observe) closeObserved = true;
        const before = observe ? fs.fstatSync(fd, { bigint: true }) : undefined;
        actualClose(fd);
        if (before) try {
          const after = fs.lstatSync(path.join(workloadDirectory, `${key}.json`), { bigint: true });
          const fields = ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'mode', 'uid', 'gid', 'nlink'] as const;
          console.info('[workload-recovery-close-fields]', fields.filter(field => before[field] !== after[field]));
        } catch { /* Observation cannot change the actual close result. */ }
      });
      let injected = false;
      const fault = jest.spyOn(fs, 'unlinkSync').mockImplementation(filename => {
        if (!injected && path.resolve(String(filename)) === path.join(workloadDirectory, `${key}.json`)) {
          injected = true; throw Object.assign(new Error('Owned record unlink fault.'), { code: 'EIO' });
        }
        return actualUnlink(filename);
      });
      try { await expect(transport.close()).rejects.toThrow(); } finally { fault.mockRestore(); observedClose.mockRestore(); }
      expect(injected).toBe(true);
      expect(() => getPendingWorkloadEnvironment(approved.config, capsule)).toThrow();
      expect((await resolveBundledFlujoWorkloadRequest(request())).kind).toBe('denied');
      expectedCloseCount = 2;
      if (mode === 'retire-unknown-parent') {
        const held = `${workloadDirectory}.held-recovery`, preserved = `${workloadDirectory}.preserved-unknown`;
        const before = fs.lstatSync(workloadDirectory, { bigint: true });
        let moved = false;
        try { fs.renameSync(workloadDirectory, held); moved = true; }
        catch (error) {
          if (process.platform !== 'win32' || (error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
          const after = fs.lstatSync(workloadDirectory, { bigint: true });
          expect(after.dev).toBe(before.dev); expect(after.ino).toBe(before.ino);
          expect(fs.existsSync(held)).toBe(false);
          expect((await resolveBundledFlujoWorkloadRequest(request())).kind).toBe('denied');
          // The real held Windows witness prevents the replacement itself.
          // Still prove retirement preserves an unrelated namespace object.
          fs.writeFileSync(path.join(workloadDirectory, 'unknown.json'), '{"unknown":"preserve"}', { mode: 0o600 });
          unknownSiblingCreated = true;
        }
        if (moved) {
        fs.mkdirSync(workloadDirectory, { mode: 0o700 });
        const unknown = path.join(workloadDirectory, 'unknown.json');
        fs.writeFileSync(unknown, '{"unknown":"preserve"}', { mode: 0o600 });
        await expect(transport.close()).rejects.toThrow();
        expect(fs.readFileSync(unknown, 'utf8')).toBe('{"unknown":"preserve"}');
        fs.renameSync(workloadDirectory, preserved);
        fs.renameSync(held, workloadDirectory);
        expect((await resolveBundledFlujoWorkloadRequest(request())).kind).toBe('denied');
        expectedCloseCount = 3;
        }
      }
    }
    if (mode === 'retire-closed-descriptor-retry') {
      expect(recordDescriptor).toBeDefined();
      const actualClose = fs.closeSync;
      let injected = false;
      const fault = jest.spyOn(fs, 'closeSync').mockImplementation(fd => {
        actualClose(fd);
        if (!injected && fd === recordDescriptor) { injected = true; throw Object.assign(new Error('Completed owned close fault.'), { code: 'EIO' }); }
      });
      try { await expect(transport.close()).rejects.toThrow(); } finally { fault.mockRestore(); }
      expect(injected).toBe(true);
      const unrelated = path.join(fixture, 'unrelated-descriptor.json');
      fs.writeFileSync(unrelated, '{"unrelated":"preserve"}');
      for (let count = 0; count < 64; count++) {
        const fd = fs.openSync(unrelated, 'r'); foreignDescriptors.push(fd);
        if (fd === recordDescriptor) break;
      }
      expect(foreignDescriptors).toContain(recordDescriptor);
      expectedCloseCount = 2;
    }
    const retire = async () => {
      await timed('durable-retire', () => transport!.close()); transport = undefined;
    };
    if (mode === 'retired-selected-context') {
    await withBundledFlujoWorkloadAuthorization(admitted.authorization, admittedRequest, async () => {
      await timed('graph-b-prime', () => capturedService.assertEffect());
      await retire();
      await expect(capturedService.assertEffect()).rejects.toThrow();
      expect(() => graphB.getAuthorizedBundledFlujoWorkloadToolNames()).toThrow();
    });
    expect(producer).not.toHaveBeenCalled();
    } else { await retire(); }
    expect(close).toHaveBeenCalledTimes(expectedCloseCount);
    if (unknownSiblingCreated) {
      expect(fs.existsSync(path.join(workloadDirectory, 'unknown.json'))).toBe(true);
      expect(fs.readFileSync(path.join(workloadDirectory, 'unknown.json'), 'utf8')).toBe('{"unknown":"preserve"}');
      // Only the fixture owner removes its own unrelated evidence after proving
      // the actual production retirement preserved it.
      fs.unlinkSync(path.join(workloadDirectory, 'unknown.json'));
    }
    expect(fs.readdirSync(workloadDirectory)).toEqual([]);
    expect((await resolveBundledFlujoWorkloadRequest(request())).kind).toBe('denied');
    for (const fd of foreignDescriptors) expect(fs.fstatSync(fd).isFile()).toBe(true);
  } catch (error) {
    try { console.info('[workload-fixture-signal]', cancellation.signal.aborted ? 'aborted' : 'live'); } catch { /* Preserve fixture failure. */ }
    reportRetirementSites(error);
    primaryFailed = true; primaryError = error; throw error;
  } finally {
    const cleanupErrors: unknown[] = [];
    clearTimeout(deadline);
    cancellation.abort(new Error('Workload fixture cleanup.'));
    stamp('cleanup:start');
    try { Reflect.deleteProperty(globalThis, serviceKey); } catch (error) { cleanupErrors.push(error); }
    try { await transport?.close(); } catch (error) { cleanupErrors.push(error); }
    for (const fd of foreignDescriptors) { try { fs.closeSync(fd); } catch (error) { cleanupErrors.push(error); } }
    try { owner?.restore(); } catch (error) { cleanupErrors.push(error); }
    for (const [name, value] of Object.entries(saved)) {
      try { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
      catch (error) { cleanupErrors.push(error); }
    }
    if (cleanupErrors.length === 0) try {
      if (path.dirname(fixture) !== parent || !/^flujo-workload-control-[A-Za-z0-9]+$/.test(path.basename(fixture)) || fs.lstatSync(fixture).isSymbolicLink()) throw new Error('Unsafe workload fixture cleanup.');
      fs.rmSync(fixture, { recursive: true, force: true });
    } catch (error) { cleanupErrors.push(error); }
    if (cleanupErrors.length) throw new AggregateError(primaryFailed ? [primaryError, ...cleanupErrors] : cleanupErrors,
      'Workload fixture cleanup failed.', primaryFailed ? { cause: primaryError } : undefined);
    stamp('cleanup:settled');
  }
}, 60_000);
