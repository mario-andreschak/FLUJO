import { NextRequest } from 'next/server';
import { proxy } from '@/proxy';
import { GET } from '@/app/api/worker/status/route';
import { assertWorkerRequestReady, setWorkerBootstrapStatus } from '@/backend/services/workspace/workerMode';

describe('worker HTTP ingress', () => {
  const oldMode = process.env.FLUJO_WORKER_MODE;
  const oldToken = process.env.FLUJO_SNAPSHOT_CONTROL_TOKEN;
  beforeEach(() => {
    process.env.FLUJO_WORKER_MODE = '1';
    process.env.FLUJO_SNAPSHOT_CONTROL_TOKEN = 'synthetic-private-control-token';
    global.__flujo_worker_bootstrap_status = undefined;
  });
  afterEach(() => {
    if (oldMode === undefined) delete process.env.FLUJO_WORKER_MODE;
    else process.env.FLUJO_WORKER_MODE = oldMode;
    if (oldToken === undefined) delete process.env.FLUJO_SNAPSHOT_CONTROL_TOKEN;
    else process.env.FLUJO_SNAPSHOT_CONTROL_TOKEN = oldToken;
    global.__flujo_worker_bootstrap_status = undefined;
  });
  function request(route: string, authenticated = false) {
    return new NextRequest(`http://worker.internal${route}`, { headers: {
      host: 'localhost:4200',
      ...(authenticated ? { authorization: 'Bearer synthetic-private-control-token' } : {}),
    } });
  }
  it.each(['/api/env', '/api/storage', '/v1/chat/completions', '/mcp-proxy/server', '/mcp-flows'])
  ('requires credentials on %s even with a loopback Host header', route => {
    setWorkerBootstrapStatus({ state: 'ready' });
    expect(proxy(request(route)).status).toBe(401);
    expect(proxy(request(route, true)).status).toBe(200);
  });
  it('blocks execution until startup completes while allowing authenticated MCP discovery', () => {
    setWorkerBootstrapStatus({ state: 'installing' });
    // Proxy authenticates using env only; readiness is checked in the route runtime.
    expect(proxy(request('/v1/chat/completions', true)).status).toBe(200);
    expect(assertWorkerRequestReady(request('/v1/chat/completions'), 'research')?.status).toBe(503);
    expect(assertWorkerRequestReady(request('/api/mcp/flujo/tools'), 'research')).toBeNull();
    expect(assertWorkerRequestReady(request('/api/mcp/flujo/flows'), 'research')?.status).toBe(503);
  });
  it('reports readiness and failure privately without requiring a loopback network peer', async () => {
    expect((await GET(request('/api/worker/status'))).status).toBe(401);
    setWorkerBootstrapStatus({ state: 'error', error: 'MCP dependency preparation failed.' });
    const unavailable = await GET(request('/api/worker/status', true));
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toMatchObject({ state: 'error' });
    setWorkerBootstrapStatus({ state: 'ready', error: undefined });
    expect((await GET(request('/api/worker/status', true))).status).toBe(200);
  });
});
