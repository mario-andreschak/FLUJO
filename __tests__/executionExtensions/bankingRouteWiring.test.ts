import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { POST as revoke } from '@/app/v1/banking/session/revoke/route';
import { POST as action } from '@/app/v1/banking/action/route';
import { GET as chains } from '@/app/v1/chat/conversation-chains/route';
import { GET as events } from '@/app/v1/chat/events/route';
import { proxy } from '@/proxy';
import { configuredExecutionAdapter as adapter } from '@/integrations/hackathon-banking/configuredAdapter';
import { authenticateBankingRequest, bankingAdmission } from '@/integrations/hackathon-banking/authority';
import { registerBankingActiveRun } from '@/integrations/hackathon-banking/controllers';
import { propagateBankingRevocation } from '@/integrations/hackathon-banking/localControl';
import { registerExecutionExtension, executionExtensionRouteResponse } from '@/backend/execution/extensions';
import { setWorkerBootstrapStatus } from '@/backend/services/workspace/workerMode';
import { getCurrentWorkspace, workspaceExists, ensureWorkspaceDirs } from '@/utils/workspace';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import { listConversationSummaries } from '@/backend/execution/flow/conversationSummaryStore';
import { executionEventBus } from '@/backend/execution/flow/engine/ExecutionEventBus';
import { FlowExecutor } from '@/backend/execution/flow/FlowExecutor';
import { flowService } from '@/backend/services/flow';
import { mcpService } from '@/backend/services/mcp';
import { bankingFixture } from './bankingFixture';

// Keep the actual route exports, extension admission, workspace selection,
// worker gate, JWT verification and durable banking store. Stub only external
// filesystem layout/bootstrap, encryption and subprocess effects.
jest.mock('@/utils/logger', () => ({ createLogger: () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(), verbose: jest.fn() }) }));
jest.mock('@/utils/encryption/lockGate', () => ({ assertUnlocked: jest.fn(async () => null) }));
jest.mock('@/backend/services/workspace/layoutReadiness', () => ({ waitForWorkspaceLayoutReady: jest.fn(async () => undefined) }));
jest.mock('@/utils/workspace', () => ({ ...jest.requireActual('@/utils/workspace'),
  workspaceExists: jest.fn(async () => true), ensureWorkspaceDirs: jest.fn(async () => undefined) }));
jest.mock('@/backend/services/flow', () => ({ flowService: { getFlow: jest.fn() } }));
jest.mock('@/backend/services/mcp', () => ({ mcpService: { callTool: jest.fn() } }));
jest.mock('@/backend/execution/flow/loadConversationState', () => ({ loadConversationStateReadOnly: jest.fn() }));
jest.mock('@/backend/execution/flow/FlowExecutor', () => ({ FlowExecutor: { conversationStates: new Map() } }));
jest.mock('@/backend/services/workspace/workspaceMutationGate', () => ({ withWorkspaceMutation: async (task: () => Promise<unknown>) => task() }));
jest.mock('@/integrations/hackathon-banking/localControl', () => ({ propagateBankingRevocation: jest.fn(async () => undefined) }));
jest.mock('@/backend/execution/flow/conversationSummaryStore', () => ({ listConversationSummaries: jest.fn(async () => []) }));
jest.mock('@/backend/execution/flow/engine/ExecutionEventBus', () => ({ executionEventBus: {
  getGlobalBufferedSince: jest.fn(() => [{ globalSeq: 1, event: { type: 'message', content: 'PRIVATE_BANK_TOOL' } }]),
  subscribeGlobal: jest.fn(() => jest.fn()), hasListeners: jest.fn(() => false),
} }));

describe('optional banking profile through exported HTTP routes', () => {
  let fixture: Awaited<ReturnType<typeof bankingFixture>>;
  let restore: () => void;
  const oldMode = process.env.FLUJO_WORKER_MODE;
  const oldControlToken = process.env.FLUJO_SNAPSHOT_CONTROL_TOKEN;
  const oldStatus = global.__flujo_worker_bootstrap_status;
  beforeEach(async () => {
    jest.clearAllMocks();
    jest.mocked(workspaceExists).mockResolvedValue(true);
    jest.mocked(ensureWorkspaceDirs).mockResolvedValue('synthetic-workspace-root');
    jest.mocked(assertUnlocked).mockResolvedValue(null);
    fixture = await bankingFixture();
    fixture.policy.workspace = 'banking-workspace';
    await fs.writeFile(fixture.configFile, JSON.stringify(fixture.policy));
    restore = registerExecutionExtension(adapter);
    process.env.FLUJO_WORKER_MODE = '1';
    process.env.FLUJO_SNAPSHOT_CONTROL_TOKEN = 'synthetic-operator-control-token';
    global.__flujo_worker_bootstrap_status = undefined;
    setWorkerBootstrapStatus({ state: 'ready', workspace: 'banking-workspace' });
  });
  afterEach(async () => {
    restore();
    FlowExecutor.conversationStates.clear();
    if (oldMode === undefined) delete process.env.FLUJO_WORKER_MODE; else process.env.FLUJO_WORKER_MODE = oldMode;
    if (oldControlToken === undefined) delete process.env.FLUJO_SNAPSHOT_CONTROL_TOKEN;
    else process.env.FLUJO_SNAPSHOT_CONTROL_TOKEN = oldControlToken;
    global.__flujo_worker_bootstrap_status = oldStatus;
    await fixture.close();
  });
  async function owner() {
    const principal = await authenticateBankingRequest(await fixture.request('A'));
    const admission = bankingAdmission(principal);
    const id = randomUUID();
    await admission.store.createConversation(id, admission.identity);
    const controller = new AbortController();
    const release = registerBankingActiveRun(principal, id, controller);
    return { ...admission, controller, release };
  }

  test('nondefault worker revokes durably and aborts jobs before bank propagation, consuming the JWT once', async () => {
    const { store, identity, controller, release } = await owner();
    const request = await fixture.request('A', undefined, '/v1/banking/session/revoke');
    const assertion = request.headers.get('x-flujo-user-assertion');
    jest.mocked(propagateBankingRevocation).mockImplementationOnce(async () => {
      expect(getCurrentWorkspace()).toBe('banking-workspace');
      await expect(store.assertSession(identity)).rejects.toThrow('authorization_expired');
      expect(controller.signal.aborted).toBe(true);
    });
    try {
      expect(proxy(request).status).toBe(200);
      const response = await revoke(request);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ revoked: true });
      expect(response.headers.get('cache-control')).toContain('no-store');
      expect(workspaceExists).toHaveBeenCalledWith('banking-workspace');
      expect(ensureWorkspaceDirs).toHaveBeenCalledWith('banking-workspace');
      expect(propagateBankingRevocation).toHaveBeenCalledTimes(1);
      expect(request.headers.get('x-flujo-user-assertion')).toBe(assertion);
      expect(new URL(request.url).search).toBe('');
      // Success above detects accidental double JWT consumption; replay is denied.
      expect((await revoke(request)).status).toBe(401);
      expect(propagateBankingRevocation).toHaveBeenCalledTimes(1);
      await expect(authenticateBankingRequest(await fixture.request('A'))).rejects.toThrow('authorization_expired');
      expect((await revoke(await fixture.request('A', undefined, '/v1/banking/session/revoke'))).status).toBe(200);
    } finally { release(); }
  });

  test.each(['different-worker', 'not-ready', 'missing-workspace', 'unsafe-storage', 'locked'])
  ('%s prevents revocation through the real workspace/worker gates', async scenario => {
    const { store, identity, controller, release } = await owner();
    const expected = scenario === 'locked' ? 423 : ['different-worker', 'missing-workspace'].includes(scenario) ? 404 : 503;
    if (scenario === 'different-worker') setWorkerBootstrapStatus({ workspace: 'another-workspace' });
    if (scenario === 'not-ready') setWorkerBootstrapStatus({ state: 'installing' });
    if (scenario === 'missing-workspace') jest.mocked(workspaceExists).mockResolvedValueOnce(false);
    if (scenario === 'unsafe-storage') jest.mocked(ensureWorkspaceDirs).mockRejectedValueOnce(new Error('unsafe layout'));
    if (scenario === 'locked') jest.mocked(assertUnlocked).mockResolvedValueOnce(new NextResponse(null, { status: 423 }));
    try {
      expect((await revoke(await fixture.request('A', undefined, '/v1/banking/session/revoke'))).status).toBe(expected);
      await expect(store.assertSession(identity)).resolves.toBeUndefined();
      expect(controller.signal.aborted).toBe(false);
      expect(propagateBankingRevocation).not.toHaveBeenCalled();
    } finally { release(); }
  });

  test.each(['query', 'x-flujo-workspace', 'x-workspace', 'invalid-bearer', 'expired'])
  ('rejects %s before generic workspace lookup or revocation', async scenario => {
    const request = await fixture.request('A', undefined,
      '/v1/banking/session/revoke' + (scenario === 'query' ? '?workspace=banking-workspace' : ''), 'POST',
      scenario === 'expired' ? { iat: Math.floor(Date.now() / 1000) - 121, nbf: Math.floor(Date.now() / 1000) - 121,
        exp: Math.floor(Date.now() / 1000) - 1 } : {});
    if (scenario.startsWith('x-')) request.headers.set(scenario, 'banking-workspace');
    if (scenario === 'invalid-bearer') request.headers.set('authorization', 'Bearer invalid');
    expect((await revoke(request)).status).toBe(['expired', 'invalid-bearer'].includes(scenario) ? 401 : 400);
    expect(workspaceExists).not.toHaveBeenCalled();
    expect(ensureWorkspaceDirs).not.toHaveBeenCalled();
    expect(propagateBankingRevocation).not.toHaveBeenCalled();
  });

  test('direct handler dispatch cannot fabricate the server-minted revocation capability', async () => {
    expect((await executionExtensionRouteResponse(await fixture.request('A', undefined, '/v1/banking/session/revoke'))).status).toBe(401);
    expect(propagateBankingRevocation).not.toHaveBeenCalled();
  });

  test('action route binds an owned conversation and reads back a verified sandbox handoff', async () => {
    const { identity, store } = await owner();
    const conversationId = randomUUID();
    await store.createConversation(conversationId, identity);
    jest.mocked(flowService.getFlow).mockResolvedValue(fixture.graph);
    const pendingHandle = 'a'.repeat(43);
    const handoffId = 'HOF-abcdefgh';
    const transaction = { transaction_reference: 'txn_' + 'a'.repeat(12),
      transaction_date: '2026-09-29T00:00:00Z', process_date: '2026-09-29', amount: '12.00',
      currency: 'COP', status: 'Approved', merchant: null, transaction_type: 'Purchase',
      channel: 'App', product: 'Card' };
    const result = (data: Record<string, unknown>) => ({ success: true, data: { structuredContent: data } });
    jest.mocked(mcpService.callTool).mockResolvedValueOnce(result({ pending_handle: pendingHandle,
      snapshot: 'build-1', action: 'simulated_intake', decision: 'handoff', reason: 'missing_evidence',
      transaction, risk: { unrecognized_count_24h: null, risk_data_complete: false } }) as never)
      .mockResolvedValueOnce(result({ state: 'created', handoff: { id: handoffId } }) as never)
      .mockResolvedValueOnce(result({ state: 'created', handoff: { id: handoffId,
        reason: 'missing_evidence', human_responded: false } }) as never);
    const response = await action(await fixture.request('A', { operation: 'prepare', conversationId,
      transactionId: 'private-owned-transaction', snapshot: 'build-1' }, '/v1/banking/action'));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.state).toBe('handoff_verified');
    expect(body.handoff.id).toBe(handoffId);
    expect(JSON.stringify(body)).not.toContain('unrecognized_count_24h');
    expect(mcpService.callTool).toHaveBeenCalledTimes(3);
    expect((await action(await fixture.request('B', { operation: 'prepare', conversationId,
      transactionId: 'private-owned-transaction', snapshot: 'build-1' }, '/v1/banking/action'))).status).toBe(404);
    expect(mcpService.callTool).toHaveBeenCalledTimes(3);
  });

  test('uncertain confirmation reads once and separately verifies a handoff', async () => {
    const { identity, store } = await owner();
    const conversationId = randomUUID();
    await store.createConversation(conversationId, identity);
    jest.mocked(flowService.getFlow).mockResolvedValue(fixture.graph);
    const result = (data: Record<string, unknown>) => ({ success: true, data: { structuredContent: data } });
    jest.mocked(mcpService.callTool).mockRejectedValueOnce(new Error('lost confirm response'))
      .mockResolvedValueOnce(result({ state: 'action_unverified', receipt: null }) as never)
      .mockResolvedValueOnce(result({ state: 'created', handoff: { id: 'HOF-abcdefgh' } }) as never)
      .mockResolvedValueOnce(result({ state: 'created', handoff: { id: 'HOF-abcdefgh' } }) as never);
    const response = await action(await fixture.request('A', { operation: 'confirm', conversationId,
      pendingHandle: 'a'.repeat(43), confirmed: true }, '/v1/banking/action'));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.state).toBe('action_unverified');
    expect(body.handoff.state).toBe('handoff_verified');
    expect(mcpService.callTool).toHaveBeenCalledTimes(4);
    expect(jest.mocked(mcpService.callTool).mock.calls.map(call => call[1])).toEqual([
      'confirm_simulated_intake', 'read_intake_receipt', 'create_verified_handoff', 'read_verified_handoff']);
  });

  test('separate no-target human requests carry separate exact idempotency identities', async () => {
    const { identity, store } = await owner();
    const conversationId = randomUUID();
    await store.createConversation(conversationId, identity);
    jest.mocked(flowService.getFlow).mockResolvedValue(fixture.graph);
    const result = (data: Record<string, unknown>) => ({ success: true, data: { structuredContent: data } });
    jest.mocked(mcpService.callTool).mockImplementation(async () =>
      result({ state: 'created', handoff: { id: 'HOF-abcdefgh' } }) as never);
    const firstId = randomUUID(), secondId = randomUUID();
    for (const requestId of [firstId, secondId]) {
      const response = await action(await fixture.request('A', { operation: 'handoff', conversationId,
        reason: 'customer_request', requestId }, '/v1/banking/action'));
      expect(response.status).toBe(200);
      expect((await response.json()).state).toBe('handoff_verified');
    }
    const created = jest.mocked(mcpService.callTool).mock.calls.filter(call => call[1] === 'create_verified_handoff');
    expect(created.map(call => call[2])).toEqual([
      { reason: 'customer_request', request_id: firstId },
      { reason: 'customer_request', request_id: secondId },
    ]);
  });

  test.each(['/v1/chat/conversation-chains', '/v1/chat/conversation-chains?root=customer&limit=25',
    '/v1/chat/conversation-chains/', '/v1/chat/conversation-%63hains',
    '/v1/chat/events', '/v1/chat/events?fromSeq=0', '/v1/chat/events?scope=sidebar', '/v1/chat/events/', '/v1/chat/%65vents'])
  ('operator transport cannot read protected global projection %s', async path => {
    const request = new NextRequest('http://localhost' + path, { headers: { host: 'localhost',
      authorization: 'Bearer synthetic-operator-control-token' } });
    // This is ordinary authenticated operator transport, not a customer bearer.
    expect(proxy(request).status).toBe(200);
    const response = await (path.includes('chains') || path.includes('%63hains') ? chains : events)(request);
    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain('PRIVATE_BANK');
    expect(workspaceExists).not.toHaveBeenCalled();
    expect(listConversationSummaries).not.toHaveBeenCalled();
    expect(executionEventBus.getGlobalBufferedSince).not.toHaveBeenCalled();
    expect(executionEventBus.subscribeGlobal).not.toHaveBeenCalled();
  });

  test.each(['/v1/chat/conversation-chains', '/v1/chat/events'])
  ('customer credentials remain denied on global projection %s', async path => {
    const request = await fixture.request('A', undefined, path, 'GET');
    expect(proxy(request).status).toBe(403);
    expect((await (path.endsWith('events') ? events : chains)(request)).status).toBe(403);
    expect(listConversationSummaries).not.toHaveBeenCalled();
    expect(executionEventBus.subscribeGlobal).not.toHaveBeenCalled();
  });

  test('ordinary projections still execute when the optional integration is absent', async () => {
    restore();
    delete process.env.FLUJO_WORKER_MODE;
    const request = new NextRequest('http://localhost/v1/chat/conversation-chains', { headers: { host: 'localhost' } });
    expect((await chains(request)).status).toBe(200);
    expect(listConversationSummaries).toHaveBeenCalledTimes(1);
    const response = await events(new NextRequest('http://localhost/v1/chat/events?fromSeq=0', { headers: { host: 'localhost' } }));
    const reader = response.body!.getReader();
    expect(response.status).toBe(200);
    await reader.read(); // Initial connection frame.
    const replay = await reader.read();
    expect(new TextDecoder().decode(replay.value)).toContain('PRIVATE_BANK_TOOL');
    expect(executionEventBus.subscribeGlobal).toHaveBeenCalledTimes(1);
    await reader.cancel();
  });
});
