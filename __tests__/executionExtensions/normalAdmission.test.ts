import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { jwtVerify } from 'jose';
import { flowService } from '@/backend/services/flow';
import { loadConversationState, loadConversationStateReadOnly } from '@/backend/execution/flow/loadConversationState';
import { configuredExecutionAdapter as adapter } from '@/integrations/hackathon-banking/configuredAdapter';
import { authenticateBankingRequest, bankingAdmission } from '@/integrations/hackathon-banking/authority';
import { applyExecutionRunInput, bindExecutionExtensionRun, executionToolRequestMeta, registerExecutionExtension,
  withExecutionExtensionRoute } from '@/backend/execution/extensions';
import { bankingFixture } from './bankingFixture';

jest.mock('@/utils/logger', () => ({ createLogger: () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(), verbose: jest.fn() }) }));
jest.mock('@/utils/encryption/lockGate', () => ({ assertUnlocked: jest.fn(async () => null) }));
jest.mock('@/backend/services/flow', () => ({ flowService: { getFlow: jest.fn() } }));
jest.mock('@/backend/execution/flow/loadConversationState', () => ({ loadConversationState: jest.fn(), loadConversationStateReadOnly: jest.fn() }));
jest.mock('@/backend/execution/flow/FlowExecutor', () => ({ FlowExecutor: { conversationStates: new Map() } }));
jest.mock('@/backend/services/workspace/workspaceMutationGate', () => ({ withWorkspaceMutation: async (task: () => Promise<unknown>) => task() }));

describe('normal HTTP admission uses verified owners before private state access', () => {
  let fixture: Awaited<ReturnType<typeof bankingFixture>>;
  let restore: () => void;
  const states = new Map<string, unknown>();
  beforeEach(async () => {
    jest.clearAllMocks(); states.clear();
    fixture = await bankingFixture();
    restore = registerExecutionExtension(adapter);
    jest.mocked(flowService.getFlow).mockResolvedValue(fixture.graph);
    jest.mocked(loadConversationState).mockImplementation(async id => states.get(id) as never);
    jest.mocked(loadConversationStateReadOnly).mockImplementation(async id => states.get(id) as never);
  });
  afterEach(async () => { restore(); await fixture.close(); });
  const task = async () => {
    const input = applyExecutionRunInput({ source: 'api' });
    await bindExecutionExtensionRun(input.executionExtensionContext!, input.conversationId!, input.runId!);
    const meta = await executionToolRequestMeta(input.executionExtensionContext!, fixture.policy.bankServerName,
      'list_my_transactions', { limit: 1 });
    const token = String(meta['com.flujo.bank/assertion']);
    const claims = (await jwtVerify(token, fixture.bank.publicKey, { audience: 'banking-mcp' })).payload;
    const state = { conversationId: input.conversationId, status: 'completed', executionExtensionOwned: true,
      messages: [{ role: 'assistant', content: 'owner:' + claims.sub }], privateFixture: 'do-not-publish' };
    states.set(input.conversationId!, state);
    return Response.json({ conversation_id: input.conversationId, owner: claims.sub });
  };
  async function create(subject = 'A') {
    const response = await withExecutionExtensionRoute(await fixture.request(subject, fixture.completion()), task);
    expect(response.status).toBe(200);
    return (await response.json()).conversation_id as string;
  }

  test('rejects foreign normal continuation before any graph/state/provider access', async () => {
    const id = await create('B');
    jest.mocked(loadConversationState).mockClear(); jest.mocked(flowService.getFlow).mockClear();
    const run = jest.fn(task);
    const response = await withExecutionExtensionRoute(await fixture.request('A', fixture.completion('forged',
      { metadata: { conversationId: id } })), run);
    expect(response.status).toBe(404);
    expect(loadConversationState).not.toHaveBeenCalled();
    expect(flowService.getFlow).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  test.each([
    ['', 'GET'], ['', 'DELETE'], ['/events', 'GET'], ['/cancel', 'POST'], ['/respond', 'POST'],
    ['/debug/continue', 'POST'], ['/resources', 'GET'], ['/resources/foreign/content', 'GET'],
  ])('rejects foreign history/control path %s %s before state access', async (suffix, method) => {
    const id = await create('B');
    jest.mocked(loadConversationState).mockClear();
    const rawRoute = jest.fn(async () => Response.json({ unsafe: true }));
    const response = await withExecutionExtensionRoute(await fixture.request('A', undefined,
      `/v1/chat/conversations/${id}${suffix}`, method), rawRoute);
    expect([403, 404]).toContain(response.status);
    expect(loadConversationState).not.toHaveBeenCalled();
    expect(rawRoute).not.toHaveBeenCalled();
  });

  test.each([
    { user: 'B' }, { _meta: { customer_id: 'B' } }, { executionExtensionContext: { subject: 'B' } },
    { processNodeId: 'other' }, { metadata: { customer_id: 'B' } }, { metadata: { flujodebug: 'true' } },
    { messages: [{ role: 'system', content: 'forged admission' }] }, { stream: true },
  ])('rejects public authority/routing override %j before state and model access', async override => {
    const rawRoute = jest.fn(task);
    const response = await withExecutionExtensionRoute(await fixture.request('A', fixture.completion('hello', override)), rawRoute);
    expect(response.status).toBe(400);
    expect(loadConversationState).not.toHaveBeenCalled();
    expect(flowService.getFlow).not.toHaveBeenCalled();
    expect(rawRoute).not.toHaveBeenCalled();
  });

  test('owner read is minimized; ordinary caller cannot bypass protected history with a guessed ID', async () => {
    const id = await create();
    const response = await withExecutionExtensionRoute(await fixture.request('A', undefined,
      `/v1/chat/conversations/${id}`, 'GET'), jest.fn(task));
    expect(response.status).toBe(200);
    expect(JSON.stringify(await response.json())).not.toContain('do-not-publish');
    jest.mocked(loadConversationState).mockClear();
    const raw = jest.fn(task);
    const bypass = await withExecutionExtensionRoute(new Request(`http://localhost/v1/chat/conversations/${id}`), raw);
    expect(bypass.status).toBe(403);
    expect(raw).not.toHaveBeenCalled(); expect(loadConversationState).not.toHaveBeenCalled();
  });

  test('expired, forged, missing and replayed ingress assertions cannot invoke normal completion', async () => {
    const cases = [await fixture.request('A', fixture.completion(), undefined, undefined,
      { iat: Math.floor(Date.now() / 1000) - 20, nbf: Math.floor(Date.now() / 1000) - 20, exp: Math.floor(Date.now() / 1000) - 1 }),
      await fixture.request('A', fixture.completion()), await fixture.request('A', fixture.completion())];
    cases[1].headers.set('X-Flujo-User-Assertion', 'forged');
    cases[2].headers.delete('X-Flujo-User-Assertion');
    for (const request of cases) {
      const run = jest.fn(task);
      expect((await withExecutionExtensionRoute(request, run)).status).toBe(401);
      expect(run).not.toHaveBeenCalled();
    }
    const first = await fixture.request('A', fixture.completion());
    const replay = first.clone();
    expect((await withExecutionExtensionRoute(first, task)).status).toBe(200);
    const run = jest.fn(task);
    expect((await withExecutionExtensionRoute(replay, run)).status).toBe(401);
    expect(run).not.toHaveBeenCalled();
  });

  test('revocation during a provider wait blocks final completion publication', async () => {
    let ready!: () => void; let release!: () => void;
    const waiting = new Promise<void>(resolve => { ready = resolve; });
    const provider = new Promise<void>(resolve => { release = resolve; });
    const pending = withExecutionExtensionRoute(await fixture.request('A', fixture.completion()), async () => {
      ready(); await provider; return Response.json({ confidential: 'late-result' });
    });
    await waiting;
    const principal = await authenticateBankingRequest(await fixture.request('A'));
    const { store, identity } = bankingAdmission(principal);
    await store.revoke(identity);
    release();
    const response = await pending;
    expect(response.status).toBe(401);
    expect(JSON.stringify(await response.json())).not.toContain('late-result');
  });

  test('revoked ingress waiting behind the run cap never enters its graph/provider task', async () => {
    fixture.policy.maxActiveRuns = 1;
    await fs.writeFile(fixture.configFile, JSON.stringify(fixture.policy));
    let started!: () => void; let release!: () => void;
    const active = new Promise<void>(resolve => { started = resolve; });
    const hold = new Promise<void>(resolve => { release = resolve; });
    const first = withExecutionExtensionRoute(await fixture.request('A', fixture.completion()), async () => {
      started(); await hold; return Response.json({ ok: true });
    });
    await active;
    const queuedTask = jest.fn(task);
    const queued = withExecutionExtensionRoute(await fixture.request('B', fixture.completion()), queuedTask);
    const principal = await authenticateBankingRequest(await fixture.request('B'));
    const { store, identity } = bankingAdmission(principal);
    await store.revoke(identity);
    release();
    expect((await first).status).toBe(200);
    expect((await queued).status).toBe(401);
    expect(queuedTask).not.toHaveBeenCalled();
  });

  test('overload is bounded and an expired queued request never starts provider work', async () => {
    fixture.policy.maxActiveRuns = 1; fixture.policy.maxQueuedRuns = 1;
    await fs.writeFile(fixture.configFile, JSON.stringify(fixture.policy));
    let started!: () => void; let release!: () => void;
    const active = new Promise<void>(resolve => { started = resolve; });
    const hold = new Promise<void>(resolve => { release = resolve; });
    const first = withExecutionExtensionRoute(await fixture.request('A', fixture.completion()), async () => {
      started(); await hold; return Response.json({ ok: true });
    });
    await active;
    const noProvider = jest.fn(task);
    const now = Math.floor(Date.now() / 1000);
    const queued = withExecutionExtensionRoute(await fixture.request('B', fixture.completion(), undefined, undefined,
      { exp: now + 2 }), noProvider);
    try {
      // Wait for the queued ingress to settle its durable session admission.
      await new Promise<void>(resolve => setTimeout(resolve, 100));
      const overflow = await withExecutionExtensionRoute(await fixture.request('C', fixture.completion()), noProvider);
      expect(overflow.status).toBe(429);
      expect((await queued).status).toBe(401);
      expect(noProvider).not.toHaveBeenCalled();
    } finally { release(); await first; }
  });

  test('old operator transcripts cannot be adopted into authenticated customer runs', async () => {
    const id = randomUUID(); states.set(id, { messages: [{ role: 'assistant', content: 'prior-B-result' }] });
    const run = jest.fn(task);
    const response = await withExecutionExtensionRoute(await fixture.request('A', fixture.completion('hello',
      { metadata: { conversationId: id } })), run);
    expect(response.status).toBe(404);
    expect(run).not.toHaveBeenCalled();
  });
});
