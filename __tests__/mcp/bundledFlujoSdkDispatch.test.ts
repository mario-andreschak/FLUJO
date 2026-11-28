import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { getCurrentWorkspace } from '@/utils/workspace';
import { attachTrustedHost } from '@/backend/services/mcp/trustedHost';
import { prepareBundledFlujoWorkload, getPendingWorkloadEnvironment, resolveBundledFlujoWorkloadRequest,
  withBundledFlujoWorkloadAuthorization, revokePendingWorkload, BundledFlujoWorkloadError } from '@/backend/services/security/bundledFlujoWorkload';
import { callTool } from '@/backend/services/mcp/tools';
import { APPROVED_BUNDLED_FLUJO_SETUP_MS, installApprovedBundledFlujo, type ApprovedBundledFlujo } from './fixtures/approvedBundledFlujo';

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

// A guarded dispatch re-checks fresh workload authority, and on Windows every
// check starts native permission checks: 22-28 s per case on a busy PC on its
// own, and up to twice that beside another worker.
const DISPATCH_CASE_MS = 120_000;
// Cancel early enough that cleanup still finishes in time.
const DISPATCH_CLEANUP_MS = 15_000;

describe('real SDK producer', () => {
let consent!: ApprovedBundledFlujo;
beforeAll(async () => { consent = await installApprovedBundledFlujo({ prefix: 'flujo-sdk-dispatch-' }); }, APPROVED_BUNDLED_FLUJO_SETUP_MS);
afterAll(async () => { await consent?.remove(); });

test.each(['live', 'retired-after-final-admission'] as const)('honors %s workload dispatch', async mode => {
  const cancellation = new AbortController();
  const deadline = setTimeout(() => cancellation.abort(new Error('SDK dispatch fixture cancellation deadline.')), DISPATCH_CASE_MS - DISPATCH_CLEANUP_MS);
  const { proposed } = consent;
  const approved = { config: consent.approved };
  const client = new Client({ name: 'actual-dispatch-client', version: '1' });
  const server = new Server({ name: 'actual-dispatch-server', version: '1' }, { capabilities: { tools: {} } });
  const producer = jest.fn(async () => ({ content: [{ type: 'text' as const, text: 'actual SDK producer' }] }));
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: 'list_flows', inputSchema: { type: 'object' as const } }] }));
  server.setRequestHandler(CallToolRequestSchema, producer);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  let capsule: ReturnType<typeof prepareBundledFlujoWorkload>;
  let pendingCall: Promise<unknown> | undefined;
  let releaseDispatch = () => {};
  let primaryError: unknown;
  let failed = false;
  mockHoldFinalDispatch = false;
  mockDispatchCount = 0;
  try {
    capsule = prepareBundledFlujoWorkload(approved.config);
    if (!capsule) throw new Error('Genuine pending SDK workload was not prepared.');
    const environment = getPendingWorkloadEnvironment(approved.config, capsule);
    await attachTrustedHost(clientTransport, approved.config, undefined, capsule);
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
    if (cleanupErrors.length) throw new AggregateError(failed ? [primaryError, ...cleanupErrors] : cleanupErrors, 'SDK dispatch fixture cleanup failed.');
  }
}, DISPATCH_CASE_MS);
});
