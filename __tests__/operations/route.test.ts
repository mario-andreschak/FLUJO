import { NextRequest } from 'next/server';

const inspect = jest.fn(() => ({ workspace: 'fixture-workspace', started: true, pausedAtLastReconcile: false, armedTriggers: 0, runningRuns: 0,
  overlapQueued: 0, maxOverlapDepth: 0, exclusiveWaiting: 0, blockedByExclusive: 0, queueCap: 50, ownedWorkerRunIds: new Set(), statuses: [] }));
const read = jest.fn(async () => undefined);
const recheck = jest.fn();
const resolve = jest.fn();
const unlock = jest.fn();
jest.mock('@/app/api/_workspace', () => ({ withWorkspaceRoute: (handler: unknown) => handler }));
jest.mock('@/utils/encryption/lockGate', () => ({ assertUnlocked: () => unlock() }));
jest.mock('@/utils/workspace', () => ({ getCurrentWorkspace: () => 'fixture-workspace', getWorkspaceDataDir: () => 'PRIVATE_PATH' }));
jest.mock('@/backend/services/operations/boundedRead', () => ({ boundedJsonReader: () => read }));
jest.mock('@/backend/services/scheduler', () => ({ getSchedulerService: () => ({ inspectOperations: inspect }) }));
jest.mock('@/backend/execution/flow/FlowExecutor', () => ({ FlowExecutor: { conversationStates: new Map() } }));
jest.mock('@/backend/services/mcp/lifecycleCoordinator', () => ({ listRuntimes: () => [] }));
jest.mock('@/backend/services/scheduler/workerLocalRecovery', () => ({ inspectWorkerRecovery: async () => undefined }));
jest.mock('@/backend/services/security/ownerAccess', () => ({ resolveOwnerRequest: (...args: unknown[]) => resolve(...args) }));
import { GET } from '@/app/api/operations/status/route';
import { acquireFlowRunAdmission } from '@/backend/execution/flow/runAdmission';
import { withSubflowPreparationBudget } from '@/backend/execution/flow/subflowPreparationBudget';
import { SubflowOutputBudget } from '@/backend/execution/flow/subflowOutputBudget';
import { setWorkerBootstrapStatus } from '@/backend/services/workspace/workerMode';
import { publishConversation } from '@/backend/execution/flow/conversationPublication';
import { acquireChatIngress, claimChatIngress, finishChatInputParsing } from '@/utils/http/chatIngress';
import { checkChatRateLimit } from '@/utils/http/chatRateLimit';

const keys = ['FLUJO_WORKER_MODE', 'FLUJO_SNAPSHOT_CONTROL_TOKEN', 'FLUJO_OPERATIONS_RSS_BUDGET_BYTES'] as const;
const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
const request = (token?: string) => new NextRequest('http://localhost/api/operations/status?workspace=fixture-workspace', {
  headers: token ? { authorization: `Bearer ${token}` } : {},
});
beforeEach(() => {
  read.mockReset().mockResolvedValue(undefined); inspect.mockClear(); recheck.mockReset().mockReturnValue(null);
  unlock.mockReset().mockResolvedValue(null);
  resolve.mockReset().mockReturnValue({ ok: true, authorization: { principal: { ownerId: 'owner-a', credentialId: 'credential-a' }, recheck } });
  process.env.FLUJO_WORKER_MODE = '1'; process.env.FLUJO_SNAPSHOT_CONTROL_TOKEN = 'fixture-control';
  delete process.env.FLUJO_OPERATIONS_RSS_BUDGET_BYTES;
  setWorkerBootstrapStatus({ state: 'ready', workspace: 'fixture-workspace' });
});
afterEach(() => {
  for (const key of keys) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
  global.__flujo_worker_bootstrap_status = undefined;
});

it.each([undefined, 'wrong'])('denies wrong dedicated worker bearer before workspace data access: %s', async token => {
  expect((await GET(request(token))).status).toBe(401); expect(read).not.toHaveBeenCalled(); expect(inspect).not.toHaveBeenCalled();
});
it('uses worker control authority and never calls scheduler reconciliation/arming', async () => {
  const response = await GET(request('fixture-control'));
  expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store');
  expect(await response.json()).toMatchObject({ schemaVersion: 2, actor: { kind: 'worker-control' }, workspace: 'fixture-workspace' });
  expect(resolve).not.toHaveBeenCalled(); expect(inspect).toHaveBeenCalledTimes(1);
});

it('reports numeric submission pressure without exposing retained inputs or identities', async () => {
  const permit = acquireFlowRunAdmission({ conversationId: 'PRIVATE_CONVERSATION', prompt: 'PRIVATE_PROMPT' });
  try {
    const response = await GET(request('fixture-control'));
    const result = await response.json();
    expect(result.flowRunAdmission).toMatchObject({ activeRuns: 1, workspaceActiveRuns: 1, workspaceConversations: 1 });
    expect(result.flowRunAdmission.reservedBytes).toBeGreaterThan(0);
    expect(Object.values(result.flowRunAdmission).every(value => typeof value === 'number')).toBe(true);
    expect(JSON.stringify(result.flowRunAdmission)).not.toMatch(/PRIVATE_CONVERSATION|PRIVATE_PROMPT|fixture-workspace/);
  } finally { permit.release(); }
  expect((await (await GET(request('fixture-control'))).json()).flowRunAdmission).toMatchObject({ activeRuns: 0, reservedBytes: 0 });
});
it('reports held preparation capacity as numeric observations until its owner settles', async () => {
  await withSubflowPreparationBudget(async budget => {
    budget.reserve(2 * 1024 ** 2);
    const response = await GET(request('fixture-control'));
    const result = await response.json();
    expect(result.subflowPreparation).toMatchObject({ active: 1, reservedBytes: 2 * 1024 ** 2 });
    expect(Object.values(result.subflowPreparation).every(value => typeof value === 'number')).toBe(true);
    expect(JSON.stringify(result.subflowPreparation)).not.toMatch(/PRIVATE|fixture-workspace/);
  });
  expect((await (await GET(request('fixture-control'))).json()).subflowPreparation)
    .toMatchObject({ active: 0, reservedBytes: 0 });
});
it('reports held output capacity with numeric values only', async () => {
  const budget = new SubflowOutputBudget();
  try {
    budget.reserve(8192);
    const response = await GET(request('fixture-control'));
    const result = await response.json();
    expect(result.subflowOutput).toMatchObject({ active: 1, reservedBytes: 8192, promotionWorkers: 4 });
    expect(result.allocationReservations).toMatchObject({ output: 8192, total: 8192 });
    expect(Object.values(result.allocationReservations).every(value => typeof value === 'number')).toBe(true);
    expect(Object.values(result.subflowOutput).every(value => typeof value === 'number')).toBe(true);
    expect(JSON.stringify(result.subflowOutput)).not.toMatch(/PRIVATE|fixture-workspace/);
  } finally { budget.release(); }
  expect((await (await GET(request('fixture-control'))).json()).subflowOutput).toMatchObject({ active: 0, reservedBytes: 0 });
});
it('reports sequence ownership and descriptor pressure without exposing registry keys', async () => {
  const response = await GET(request('fixture-control'));
  const result = await response.json();
  expect(result.conversationSequences).toMatchObject({ maxKeys: 4096, maxColdScans: 4, scanActive: 0, scanQuarantined: 0 });
  expect(Object.values(result.conversationSequences).every(value => typeof value === 'number')).toBe(true);
  expect(JSON.stringify(result.conversationSequences)).not.toMatch(/PRIVATE|fixture-workspace/);
});
it('reports ingress capacity while a producer still owns the parsed input and releases it after settlement', async () => {
  const input = new NextRequest('http://localhost/v1/chat/completions?workspace=PRIVATE_WORKSPACE', {
    method: 'POST', body: '{"prompt":"PRIVATE_PROMPT"}', headers: { authorization: 'Bearer PRIVATE_CREDENTIAL' },
  });
  const permit = acquireChatIngress(input);
  finishChatInputParsing(permit, 27, 2);
  const owner = claimChatIngress(permit);
  const producerDone = owner.retain();
  try {
    permit.release(); owner.release();
    const result = await (await GET(request('fixture-control'))).json();
    expect(result.chatIngress).toMatchObject({ active: 1, parsing: 0 });
    expect(result.chatIngress.reservedBytes).toBeGreaterThan(0);
    expect(result.allocationReservations.ingress).toBe(result.chatIngress.reservedBytes);
    expect(Object.values(result.chatIngress).every(value => typeof value === 'number' && Number.isFinite(value))).toBe(true);
    expect(JSON.stringify(result.chatIngress)).not.toMatch(/PRIVATE|fixture-workspace/);
  } finally { permit.release(); owner.release(); producerDone(); }
  const released = await (await GET(request('fixture-control'))).json();
  expect(released.chatIngress).toMatchObject({ active: 0, parsing: 0, reservedBytes: 0 });
  expect(released.allocationReservations.ingress).toBe(0);
});
it('reports a live publication owner without exposing its key or captured content and drains after release', async () => {
  let release!: () => void, entered!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const publication = publishConversation('PRIVATE_WORKSPACE/PRIVATE_CONVERSATION', {
    content: 'PRIVATE_PROMPT', media: [{ uri: 'run-resource://PRIVATE_MEDIA' }],
  }, async () => { entered(); await blocked; });
  try {
    await started;
    const result = await (await GET(request('fixture-control'))).json();
    expect(result.conversationPublication).toMatchObject({ owners: 1, writers: 1, queuedWriters: 0, chains: 1 });
    expect(result.conversationPublication.retainedBytes).toBeGreaterThan(0);
    expect(result.conversationPublication.allocationBytes).toBeGreaterThan(0);
    expect(result.allocationReservations.publication).toBe(result.conversationPublication.allocationBytes);
    expect(Object.values(result.conversationPublication).every(value => typeof value === 'number' && Number.isFinite(value))).toBe(true);
    expect(JSON.stringify(result.conversationPublication)).not.toMatch(/PRIVATE|run-resource|fixture-workspace/);
  } finally { release(); await publication; }
  const released = await (await GET(request('fixture-control'))).json();
  expect(released.conversationPublication).toMatchObject({ owners: 0, writers: 0, queuedWriters: 0, chains: 0, retainedBytes: 0, allocationBytes: 0 });
  expect(released.allocationReservations.publication).toBe(0);
});
it('reports bounded numeric rate pressure without exposing retained IP quota keys', async () => {
  const ip = '198.51.100.23';
  expect(checkChatRateLimit(ip)).toBe('allowed');
  const result = await (await GET(request('fixture-control'))).json();
  expect(result.chatRateLimit).toMatchObject({ keys: 1, maxKeys: 4096, maxKeyBytes: 1024 * 1024 });
  expect(result.chatRateLimit.keyBytes).toBeGreaterThan(0);
  expect(Object.values(result.chatRateLimit).every(value => typeof value === 'number' && Number.isFinite(value))).toBe(true);
  expect(JSON.stringify(result.chatRateLimit)).not.toMatch(/198\.51\.100\.23|PRIVATE|fixture-workspace/);
});
it('rechecks a rotated worker bearer after awaited reads', async () => {
  read.mockImplementationOnce(async () => { process.env.FLUJO_SNAPSHOT_CONTROL_TOKEN = 'rotated-fixture-control'; return undefined; });
  expect((await GET(request('fixture-control'))).status).toBe(401);
});
it('refuses a profile switch during awaited observation without returning cached metadata', async () => {
  read.mockImplementationOnce(async () => { process.env.FLUJO_WORKER_MODE = '0'; return undefined; });
  const response = await GET(request('fixture-control'));
  expect(response.status).toBe(409); expect(response.headers.get('cache-control')).toBe('no-store');
  expect(await response.json()).not.toHaveProperty('schedules');
});
it('requires the existing scoped owner resolver without anonymous fallback', async () => {
  process.env.FLUJO_WORKER_MODE = '0'; resolve.mockReturnValueOnce({ ok: false, response: Response.json({ error: 'refused' }, { status: 503 }) });
  expect((await GET(request())).status).toBe(503); expect(read).not.toHaveBeenCalled();
  expect(resolve).toHaveBeenCalledWith(expect.any(Request), ['control:admin', 'secrets:read']);
});
it('retains owner attribution and fences a revoked policy after observation', async () => {
  process.env.FLUJO_WORKER_MODE = '0';
  const response = await GET(request('owner-fixture'));
  expect(await response.json()).toMatchObject({ actor: { kind: 'owner', ownerId: 'owner-a', credentialId: 'credential-a' } });
  recheck.mockReturnValueOnce(Response.json({ error: 'refused' }, { status: 401 }));
  expect((await GET(request('owner-fixture'))).status).toBe(401);
});
it('suppresses private exception text', async () => {
  inspect.mockImplementationOnce(() => { throw new Error('SECRET_KEY PRIVATE_PATH SECRET_COMMAND'); });
  const response = await GET(request('fixture-control'));
  expect(response.status).toBe(503); expect(await response.text()).not.toMatch(/SECRET_KEY|PRIVATE_PATH|SECRET_COMMAND/);
});

it('rechecks unlock and worker readiness after awaited observations', async () => {
  read.mockImplementationOnce(async () => { setWorkerBootstrapStatus({ state: 'error', workspace: 'fixture-workspace' }); return undefined; });
  expect((await GET(request('fixture-control'))).status).toBe(503);
  setWorkerBootstrapStatus({ state: 'ready', workspace: 'fixture-workspace' });
  unlock.mockResolvedValueOnce(null).mockResolvedValueOnce(Response.json({ error: 'locked' }, { status: 423 }));
  expect((await GET(request('fixture-control'))).status).toBe(423);
});

it('refuses foreign bound owner workspace before observations', async () => {
  process.env.FLUJO_WORKER_MODE = '0';
  resolve.mockReturnValueOnce({ ok: true, authorization: { principal: {
    ownerId: 'owner-a', credentialId: 'credential-a', workspaceId: 'other-workspace' }, recheck } });
  expect((await GET(request('owner-fixture'))).status).toBe(403);
  expect(read).not.toHaveBeenCalled();
});

it('returns stable process correlation and explicit process-wide memory scope across samples', async () => {
  const first = await (await GET(request('fixture-control'))).json();
  const second = await (await GET(request('fixture-control'))).json();
  expect(second.observationProcessId).toBe(first.observationProcessId);
  expect(first.scope).toMatchObject({ memory: 'this-process-all-workspaces',
    observationProcessId: 'self-reported-process-correlation-only' });
});
