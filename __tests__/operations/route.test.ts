import { NextRequest } from 'next/server';

const inspect = jest.fn(() => ({ started: true, pausedAtLastReconcile: false, armedTriggers: 0, runningRuns: 0,
  overlapQueued: 0, maxOverlapDepth: 0, exclusiveWaiting: 0, blockedByExclusive: 0, queueCap: 50, ownedWorkerRunIds: new Set(), statuses: [] }));
const read = jest.fn(async () => undefined);
const recheck = jest.fn();
const resolve = jest.fn();
jest.mock('@/app/api/_workspace', () => ({ withWorkspaceRoute: (handler: unknown) => handler }));
jest.mock('@/utils/encryption/lockGate', () => ({ assertUnlocked: async () => null }));
jest.mock('@/utils/workspace', () => ({ getCurrentWorkspace: () => 'fixture-workspace', getWorkspaceDataDir: () => 'PRIVATE_PATH' }));
jest.mock('@/backend/services/operations/boundedRead', () => ({ boundedJsonReader: () => read }));
jest.mock('@/backend/services/scheduler', () => ({ getSchedulerService: () => ({ inspectOperations: inspect }) }));
jest.mock('@/backend/execution/flow/FlowExecutor', () => ({ FlowExecutor: { conversationStates: new Map() } }));
jest.mock('@/backend/services/mcp/lifecycleCoordinator', () => ({ listRuntimes: () => [] }));
jest.mock('@/backend/services/scheduler/workerLocalRecovery', () => ({ inspectWorkerRecovery: async () => undefined }));
jest.mock('@/backend/services/security/ownerAccess', () => ({ resolveOwnerRequest: (...args: unknown[]) => resolve(...args) }));
import { GET } from '@/app/api/operations/status/route';
import { setWorkerBootstrapStatus } from '@/backend/services/workspace/workerMode';

const keys = ['FLUJO_WORKER_MODE', 'FLUJO_SNAPSHOT_CONTROL_TOKEN', 'FLUJO_OPERATIONS_RSS_BUDGET_BYTES'] as const;
const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
const request = (token?: string) => new NextRequest('http://localhost/api/operations/status?workspace=fixture-workspace', {
  headers: token ? { authorization: `Bearer ${token}` } : {},
});
beforeEach(() => {
  read.mockReset().mockResolvedValue(undefined); inspect.mockClear(); recheck.mockReset().mockReturnValue(null);
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
  expect(await response.json()).toMatchObject({ schemaVersion: 1, actor: { kind: 'worker-control' }, workspace: 'fixture-workspace' });
  expect(resolve).not.toHaveBeenCalled(); expect(inspect).toHaveBeenCalledTimes(1);
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
