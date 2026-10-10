import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { getCurrentWorkspace, getWorkspaceDir } from '@/utils/workspace';
import { createShippedServerConfig, SHIPPED_MCP_SERVERS } from '@/backend/services/mcp/shippedServers';
import { ensureShippedWorkspacePackages } from '@/backend/services/mcp/shippedWorkspacePackages';
import { saveConfig } from '@/backend/services/mcp/config';
import { previewBundledHostConsent, approveBundledHostConsent } from '@/backend/services/security/bundledMcpConsent';
import { attachTrustedHost } from '@/backend/services/mcp/trustedHost';
import { prepareBundledFlujoWorkload, getPendingWorkloadEnvironment, resolveBundledFlujoWorkloadRequest,
  withBundledFlujoWorkloadAuthorization, revokePendingWorkload, BundledFlujoWorkloadError } from '@/backend/services/security/bundledFlujoWorkload';
import { callTool } from '@/backend/services/mcp/tools';
import { installBundledFixtureOwner } from './fixtures/bundledFixtureOwner';

// Only observation timing is equipment: both dispatch admission calls execute
// the original guard. The producer is a real SDK server on linked transports;
// this does not claim shipped child-process or compiled HTTP execution.
let mockDispatchCount = 0;
let mockHoldFinalDispatch = false;
let mockObservedDispatch!: () => void;
let mockDispatchGate!: Promise<void>;
jest.mock('@/backend/services/mcp/isolation', () => {
  const actual = jest.requireActual<typeof import('@/backend/services/mcp/isolation')>('@/backend/services/mcp/isolation');
  return { ...actual, assertMcpIsolationDispatch: async (...args: Parameters<typeof actual.assertMcpIsolationDispatch>) => {
    await actual.assertMcpIsolationDispatch(...args);
    if (mockHoldFinalDispatch && ++mockDispatchCount === 2) {
      mockObservedDispatch();
      await mockDispatchGate;
    }
  } };
});

test.each(['live', 'retired-after-final-admission'] as const)('real SDK producer honors %s workload dispatch', async mode => {
  const cancellation = new AbortController();
  const deadline = setTimeout(() => cancellation.abort(new Error('SDK dispatch fixture cancellation deadline.')), 55_000);
  const names = ['FLUJO_APP_ROOT', 'FLUJO_DATA_DIR', 'FLUJO_PARENT_DATA_DIR', 'FLUJO_BASE_URL', 'FLUJO_WORKER_MODE'];
  const saved = Object.fromEntries(names.map(name => [name, process.env[name]]));
  const parent = path.resolve(process.platform === 'win32' ? process.env.LOCALAPPDATA ?? os.tmpdir() : os.tmpdir());
  const root = fs.mkdtempSync(path.join(parent, 'flujo-sdk-dispatch-'));
  const application = path.join(root, 'application');
  const write = (relative: string, content: string) => {
    const filename = path.join(application, relative);
    fs.mkdirSync(path.dirname(filename), { recursive: true }); fs.writeFileSync(filename, content);
  };
  const client = new Client({ name: 'actual-dispatch-client', version: '1' });
  const server = new Server({ name: 'actual-dispatch-server', version: '1' }, { capabilities: { tools: {} } });
  const producer = jest.fn(async () => ({ content: [{ type: 'text' as const, text: 'actual SDK producer' }] }));
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: 'list_flows', inputSchema: { type: 'object' as const } }] }));
  server.setRequestHandler(CallToolRequestSchema, producer);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  let owner: ReturnType<typeof installBundledFixtureOwner> | undefined;
  let capsule: ReturnType<typeof prepareBundledFlujoWorkload>;
  let pendingCall: Promise<unknown> | undefined;
  let releaseDispatch = () => {};
  let primaryError: unknown;
  let failed = false;
  mockHoldFinalDispatch = false;
  mockDispatchCount = 0;
  try {
    process.env.FLUJO_APP_ROOT = application; process.env.FLUJO_DATA_DIR = path.join(root, 'data');
    process.env.FLUJO_BASE_URL = 'http://127.0.0.1:4200';
    delete process.env.FLUJO_PARENT_DATA_DIR; delete process.env.FLUJO_WORKER_MODE;
    const descriptor = SHIPPED_MCP_SERVERS.find(item => item.packageDirectory === 'flujo')!;
    write('package.json', '{"name":"flujo-ai","version":"1.0.0"}');
    write('node_modules/fixture-dependency/package.json', '{"name":"fixture-dependency","version":"1.0.0","type":"module","exports":"./index.js"}');
    write('node_modules/fixture-dependency/index.js', 'export const value = 1;');
    write('mcp-servers/flujo/package.json', JSON.stringify({ name: descriptor.packageId, version: '1.0.0', type: 'module', dependencies: { 'fixture-dependency': '1.0.0' } }));
    write('mcp-servers/flujo/src/index.ts', '// genuine fixture source');
    write('mcp-servers/flujo/dist/index.js', 'export { value } from "fixture-dependency";');
    fs.mkdirSync(getWorkspaceDir(getCurrentWorkspace()), { recursive: true });
    await ensureShippedWorkspacePackages(getWorkspaceDir(getCurrentWorkspace()), application, ['flujo']);
    const proposed = createShippedServerConfig(descriptor);
    expect((await saveConfig(new Map([[proposed.name, proposed]]))).success).toBe(true);
    const fixtureOwner = installBundledFixtureOwner(); owner = fixtureOwner;
    const preview = await previewBundledHostConsent(proposed.name, { runtimeHome: 'host' });
    const approved = await approveBundledHostConsent(new Request(fixtureOwner.request(proposed.name), { signal: cancellation.signal }),
      proposed.name, { runtimeHome: 'host', reviewedDigest: preview.policyDigest, expiresAt: fixtureOwner.expiresAt });
    capsule = prepareBundledFlujoWorkload(approved.config);
    if (!capsule) throw new Error('Genuine pending SDK workload was not prepared.');
    const environment = getPendingWorkloadEnvironment(approved.config, capsule);
    attachTrustedHost(clientTransport, approved.config, undefined, capsule);
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const request = new Request('http://127.0.0.1:4200/api/mcp/flujo/tools', { signal: cancellation.signal,
      headers: { host: '127.0.0.1:4200', 'x-flujo-workspace': getCurrentWorkspace(), authorization: `Bearer ${environment.FLUJO_MCP_WORKLOAD_TOKEN}` } });
    const resolved = await resolveBundledFlujoWorkloadRequest(request);
    expect(resolved.kind).toBe('authorized');
    if (resolved.kind !== 'authorized') throw new Error('Genuine SDK workload capability was not admitted.');
    if (mode === 'live') {
      const result = await withBundledFlujoWorkloadAuthorization(resolved.authorization, request, () =>
        callTool(client, proposed.name, 'list_flows', {}, 5, undefined, cancellation.signal));
      expect(result.success).toBe(true);
      expect(producer).toHaveBeenCalledTimes(1);
    } else {
      const observed = new Promise<void>(resolve => { mockObservedDispatch = resolve; });
      mockDispatchGate = new Promise<void>(resolve => { releaseDispatch = resolve; });
      mockHoldFinalDispatch = true;
      const dispatch = withBundledFlujoWorkloadAuthorization(resolved.authorization, request, () =>
        callTool(client, proposed.name, 'list_flows', {}, 5, undefined, cancellation.signal));
      pendingCall = dispatch.then(() => undefined, () => undefined);
      try {
        await Promise.race([observed, dispatch.then(() => { throw new Error('Dispatch settled before final admission observation.'); })]);
        // Retire only genuine request authority. The SDK connection stays open,
        // so a missing final workload check would actually reach the producer.
        revokePendingWorkload(capsule);
      } finally { releaseDispatch(); await pendingCall; }
      await expect(dispatch).rejects.toBeInstanceOf(BundledFlujoWorkloadError);
      expect(mockDispatchCount).toBe(2);
      expect(producer).not.toHaveBeenCalled();
      await client.callTool({ name: 'list_flows', arguments: {} }, undefined, { timeout: 5_000 });
      expect(producer).toHaveBeenCalledTimes(1);
    }
  } catch (error) { failed = true; primaryError = error; throw error; }
  finally {
    clearTimeout(deadline); cancellation.abort(new Error('SDK dispatch fixture cleanup.'));
    releaseDispatch();
    const cleanupErrors: unknown[] = [];
    const attempt = async (cleanup: () => unknown | Promise<unknown>) => { try { await cleanup(); } catch (error) { cleanupErrors.push(error); } };
    await attempt(() => pendingCall);
    mockHoldFinalDispatch = false;
    await attempt(() => client.close()); await attempt(() => server.close());
    await attempt(() => revokePendingWorkload(capsule));
    await attempt(() => owner?.restore());
    await attempt(() => {
      for (const [name, value] of Object.entries(saved)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
    });
    if (!cleanupErrors.length) await attempt(() => {
      if (path.dirname(root) !== parent || !/^flujo-sdk-dispatch-[A-Za-z0-9]+$/.test(path.basename(root)) || fs.lstatSync(root).isSymbolicLink()) throw new Error('Unsafe SDK fixture cleanup.');
      fs.rmSync(root, { recursive: true, force: true });
    });
    if (cleanupErrors.length) throw new AggregateError(failed ? [primaryError, ...cleanupErrors] : cleanupErrors, 'SDK dispatch fixture cleanup failed.');
  }
}, 60_000);
