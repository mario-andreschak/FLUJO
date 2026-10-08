import { NextRequest } from 'next/server';

const setRecovery = jest.fn();
const list = jest.fn(async () => [{ execution: { id: 'plan-a' }, status: {
  workerRecovery: { eligible: true, state: 'armed', reason: 'eligible' },
} }]);
jest.mock('@/app/api/_workspace', () => ({ withWorkspaceRoute: (handler: unknown) => handler }));
jest.mock('@/utils/encryption/lockGate', () => ({ assertUnlocked: async () => null }));
jest.mock('@/backend/services/scheduler', () => ({ getSchedulerService: () => ({ setWorkerLocalRecovery: setRecovery, list }) }));
import { POST } from '@/app/api/planned-executions/[id]/worker-recovery/route';

const savedMode = process.env.FLUJO_WORKER_MODE;
const savedToken = process.env.FLUJO_SNAPSHOT_CONTROL_TOKEN;
const body = { enabled: true, expectedGenerationId: 'generation-a', expectedDefinitionSha256: 'a'.repeat(64) };
const request = (authorization?: string, input: unknown = body) => new NextRequest('http://localhost/api/planned-executions/plan-a/worker-recovery', {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...(authorization ? { authorization } : {}) }, body: JSON.stringify(input),
});
const context = () => ({ params: Promise.resolve({ id: 'plan-a' }) });
beforeEach(() => {
  process.env.FLUJO_WORKER_MODE = '1'; process.env.FLUJO_SNAPSHOT_CONTROL_TOKEN = 'disposable-worker-bearer';
  setRecovery.mockReset().mockResolvedValue(undefined); list.mockClear();
});
afterEach(() => {
  if (savedMode === undefined) delete process.env.FLUJO_WORKER_MODE; else process.env.FLUJO_WORKER_MODE = savedMode;
  if (savedToken === undefined) delete process.env.FLUJO_SNAPSHOT_CONTROL_TOKEN; else process.env.FLUJO_SNAPSHOT_CONTROL_TOKEN = savedToken;
});

it.each([undefined, 'Bearer wrong', 'Basic disposable-worker-bearer'])('denies missing/wrong dedicated bearer %s before enrollment', async authorization => {
  const result = await POST(request(authorization), context());
  expect(result.status).toBe(401); expect(setRecovery).not.toHaveBeenCalled(); expect(list).not.toHaveBeenCalled();
});
it('refuses unconfigured control and nonworker use', async () => {
  delete process.env.FLUJO_SNAPSHOT_CONTROL_TOKEN;
  expect((await POST(request(), context())).status).toBe(503);
  process.env.FLUJO_WORKER_MODE = '0';
  expect((await POST(request(), context())).status).toBe(409);
});
it('validates the exact generation/digest enrollment shape and rejects caller provenance', async () => {
  expect((await POST(request('Bearer disposable-worker-bearer', { ...body, localCreated: true }), context())).status).toBe(400);
  expect(setRecovery).not.toHaveBeenCalled();
  const result = await POST(request('Bearer disposable-worker-bearer'), context());
  expect(result.status).toBe(200); expect(setRecovery).toHaveBeenCalledWith('plan-a', body);
  expect(await result.json()).toMatchObject({ recovery: { state: 'armed' } });
});
it('reports a bounded conflict without raw filesystem/token/command text', async () => {
  setRecovery.mockRejectedValueOnce(new Error('SECRET=private-command C:\\private\\file'));
  const result = await POST(request('Bearer disposable-worker-bearer'), context());
  expect(result.status).toBe(409); expect(await result.text()).not.toMatch(/SECRET|private-command|private\\file/);
});
