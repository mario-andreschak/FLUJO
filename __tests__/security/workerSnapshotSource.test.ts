import { runWithWorkspace } from '@/utils/workspace';
import { setWorkerBootstrapStatus } from '@/backend/services/workspace/workerMode';

// Exercise the handler's independent admission boundary without disk/bootstrap
// setup. The real workspace ALS, bearer, exposure and readiness guards remain.
jest.mock('@/app/api/_workspace', () => ({ withWorkspaceRoute: (handler: unknown) => handler }));
jest.mock('@/backend/services/workspace/snapshotCoordinator', () => ({
  SnapshotCoordinatorError: class extends Error {},
  snapshotCoordinator: {
    begin: jest.fn(async () => ({ sessionId: 'synthetic-session', state: 'staging' })),
    info: jest.fn(async () => ({ capability: 'available' })),
  },
}));

import { POST } from '@/app/api/snapshot/begin/route';
import { GET } from '@/app/api/snapshot/info/route';
import { snapshotCoordinator } from '@/backend/services/workspace/snapshotCoordinator';
import { type NextRequest } from 'next/server';

const keys = ['FLUJO_WORKER_MODE', 'FLUJO_WORKER_SNAPSHOT_SOURCE', 'FLUJO_SNAPSHOT_CONTROL_TOKEN',
  'FLUJO_EXPOSURE_MODE', 'FLUJO_EXPOSURE_MODE_SOURCE', 'FLUJO_EXTRA_LOCAL_HOSTS',
  'FLUJO_RUNTIME_LOCAL_HOSTS'] as const;
const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
const token = 'synthetic-worker-snapshot-source-token';

function request(options: { host?: string; origin?: string; authenticated?: boolean; body?: string; method?: string } = {}): NextRequest {
  const method = options.method ?? 'POST';
  return new Request('http://source.internal/api/snapshot/begin?workspace=source', {
    method,
    headers: { host: options.host ?? 'source.internal:4200',
      ...(options.origin === undefined ? {} : { origin: options.origin }),
      ...(options.authenticated === false ? {} : { authorization: `Bearer ${token}` }) },
    ...(method === 'POST' ? { body: options.body ?? '{}' } : {}),
  }) as NextRequest;
}

describe('explicit private worker snapshot-source admission', () => {
  beforeEach(() => {
    for (const key of keys) delete process.env[key];
    process.env.FLUJO_WORKER_MODE = '1';
    process.env.FLUJO_WORKER_SNAPSHOT_SOURCE = '1';
    process.env.FLUJO_SNAPSHOT_CONTROL_TOKEN = token;
    process.env.FLUJO_EXPOSURE_MODE = 'network';
    global.__flujo_worker_bootstrap_status = undefined;
    setWorkerBootstrapStatus({ state: 'ready', workspace: 'source' });
    jest.clearAllMocks();
  });
  afterEach(() => {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    global.__flujo_worker_bootstrap_status = undefined;
  });

  async function denied(expected: number, selected = 'source', options: Parameters<typeof request>[0] = {}) {
    const req = request({ body: 'this body must not be read', ...options });
    const body = jest.spyOn(req, 'text');
    const response = await runWithWorkspace(selected, () => POST(req));
    expect(response.status).toBe(expected);
    expect(body).not.toHaveBeenCalled();
    expect(snapshotCoordinator.begin).not.toHaveBeenCalled();
  }

  it('captures the complete assigned workspace and keeps explicit flow selection separate', async () => {
    const full = await runWithWorkspace('source', () => POST(request()));
    expect(full.status).toBe(202);
    expect(snapshotCoordinator.begin).toHaveBeenLastCalledWith('source', {});
    const selected = await runWithWorkspace('source', () => POST(request({ body: '{"flowIds":["flow-a","flow-a"]}' })));
    expect(selected.status).toBe(202);
    expect(snapshotCoordinator.begin).toHaveBeenLastCalledWith('source', { flowIds: ['flow-a'] });
  });

  it('admits private IPv4 and an exact matching browser Origin', async () => {
    const response = await runWithWorkspace('source', () => POST(request({ host: '10.0.0.7:4200', origin: 'http://10.0.0.7:4200' })));
    expect(response.status).toBe(202);
  });

  it('requires the handler bearer even when the caller forges a loopback Host', async () => {
    await denied(401, 'source', { host: 'localhost:4200', authenticated: false });
  });
  it('rejects missing control-plane configuration before reading selection', async () => {
    delete process.env.FLUJO_SNAPSHOT_CONTROL_TOKEN;
    await denied(503);
  });
  it.each(['localhost', 'public', 'unknown'])('does not enable the source in %s exposure', async mode => {
    process.env.FLUJO_EXPOSURE_MODE = mode;
    await denied(403, 'source', { host: 'localhost:4200' });
  });
  it.each([undefined, 'unknown'])('cannot infer network exposure from a legacy hostname list (%s)', async mode => {
    if (mode === undefined) delete process.env.FLUJO_EXPOSURE_MODE;
    else process.env.FLUJO_EXPOSURE_MODE = mode;
    process.env.FLUJO_EXTRA_LOCAL_HOSTS = '.internal';
    await denied(403);
  });
  it.each(['restoring', 'locked', 'installing', 'error', 'not-started'] as const)
  ('blocks a %s worker before capture', async state => {
    setWorkerBootstrapStatus({ state });
    await denied(503);
  });
  it('requires a present assigned workspace even if bootstrap claims ready', async () => {
    setWorkerBootstrapStatus({ workspace: undefined });
    await denied(503);
  });
  it('cannot capture a different workspace selected in the real ALS context', async () => {
    await denied(404, 'other');
  });
  it.each([
    { host: 'attacker.example:4200' },
    { origin: 'http://attacker.example' },
    { origin: 'http://other.internal:4200' },
    { origin: 'null' },
  ])('retains network Host/Origin admission for %j', async options => {
    await denied(403, 'source', options);
  });
  it.each([undefined, '0', 'true'])('does not opt legacy workers in with %s', async flag => {
    if (flag === undefined) delete process.env.FLUJO_WORKER_SNAPSHOT_SOURCE;
    else process.env.FLUJO_WORKER_SNAPSHOT_SOURCE = flag;
    await denied(403);
  });
  it('does not turn a network-exposed desktop into a worker source', async () => {
    delete process.env.FLUJO_WORKER_MODE;
    await denied(403);
  });
  it('preserves the existing localhost desktop control token path', async () => {
    delete process.env.FLUJO_WORKER_MODE;
    process.env.FLUJO_EXPOSURE_MODE = 'localhost';
    const response = await runWithWorkspace('source', () => POST(request({ host: 'localhost:4200' })));
    expect(response.status).toBe(202);
  });
  it('preserves the legacy localhost worker path without a new opt-in', async () => {
    delete process.env.FLUJO_WORKER_SNAPSHOT_SOURCE;
    process.env.FLUJO_EXPOSURE_MODE = 'localhost';
    const response = await runWithWorkspace('source', () => POST(request({ host: 'localhost:4200' })));
    expect(response.status).toBe(202);
  });
  it('also protects snapshot information with the same readiness and workspace gates', async () => {
    const info = request({ method: 'GET' });
    expect((await runWithWorkspace('source', () => GET(info))).status).toBe(200);
    expect(snapshotCoordinator.info).toHaveBeenCalledWith('source');
    jest.clearAllMocks();
    expect((await runWithWorkspace('other', () => GET(info))).status).toBe(404);
    expect(snapshotCoordinator.info).not.toHaveBeenCalled();
  });
});
