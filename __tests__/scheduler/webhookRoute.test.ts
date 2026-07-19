/**
 * Tests for the inbound webhook trigger route (/api/webhooks/[id]).
 *
 * The scheduler service is mocked at the module boundary; the route's own
 * logic — 404 masking, token auth, localhost guard, body handling, 202
 * fire-and-forget — runs for real against standard Request objects.
 */
import type { NextRequest } from 'next/server';
import type { PlannedExecution } from '@/shared/types/plannedExecution';
import { POST } from '@/app/api/webhooks/[id]/route';

const fireMock = jest.fn();
const getMock = jest.fn();
const isPausedMock = jest.fn();
const exclusiveGateForMock = jest.fn();

jest.mock('@/backend/services/scheduler', () => ({
  getSchedulerService: () => ({
    get: (...args: unknown[]) => getMock(...args),
    isPaused: (...args: unknown[]) => isPausedMock(...args),
    fire: (...args: unknown[]) => fireMock(...args),
    exclusiveGateFor: (...args: unknown[]) => exclusiveGateForMock(...args),
  }),
}));

jest.mock('@/backend/init', () => ({
  ensureBackendInitialized: jest.fn(async () => undefined),
}));

const execution = (overrides: Partial<PlannedExecution> = {}): PlannedExecution => ({
  id: 'exec-1',
  name: 'Hook',
  enabled: true,
  flowId: 'flow-1',
  prompt: 'Handle the event',
  trigger: { type: 'webhook', token: 'secret-token' },
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...overrides,
});

const call = (
  {
    id = 'exec-1',
    url = 'http://localhost:4200/api/webhooks/exec-1',
    headers = {},
    body,
  }: { id?: string; url?: string; headers?: Record<string, string>; body?: string } = {}
) => {
  const request = new Request(url, {
    method: 'POST',
    headers: { host: new URL(url).host, ...headers },
    body,
  }) as unknown as NextRequest;
  return POST(request, { params: Promise.resolve({ id }) });
};

beforeEach(() => {
  fireMock.mockReset().mockResolvedValue({ status: 'completed' });
  isPausedMock.mockReset().mockResolvedValue(false);
  getMock.mockReset().mockResolvedValue(execution());
  exclusiveGateForMock.mockReset().mockReturnValue(null);
});

describe('webhook route', () => {
  it('404s unknown ids and non-webhook executions alike', async () => {
    getMock.mockResolvedValueOnce(null);
    expect((await call()).status).toBe(404);

    getMock.mockResolvedValueOnce(
      execution({ trigger: { type: 'schedule', cron: '0 9 * * *' } })
    );
    expect((await call({ headers: { 'x-flujo-token': 'secret-token' } })).status).toBe(404);
    expect(fireMock).not.toHaveBeenCalled();
  });

  it('rejects a missing or wrong token with 401', async () => {
    expect((await call()).status).toBe(401);
    expect((await call({ headers: { 'x-flujo-token': 'wrong' } })).status).toBe(401);
    expect(fireMock).not.toHaveBeenCalled();
  });

  it('accepts the token via header and fires with the JSON body as context', async () => {
    const response = await call({
      headers: { 'x-flujo-token': 'secret-token', 'content-type': 'application/json' },
      body: JSON.stringify({ event: 'push' }),
    });
    expect(response.status).toBe(202);
    const payload = await response.json();
    expect(payload.accepted).toBe(true);
    expect(payload.runId).toBeTruthy();

    expect(fireMock).toHaveBeenCalledTimes(1);
    const [, firePayload, runId] = fireMock.mock.calls[0];
    expect(firePayload.kind).toBe('webhook');
    expect(firePayload.context.body).toEqual({ event: 'push' });
    expect(runId).toBe(payload.runId);
  });

  it('accepts the token via query parameter', async () => {
    const response = await call({
      url: 'http://localhost:4200/api/webhooks/exec-1?token=secret-token',
    });
    expect(response.status).toBe(202);
  });

  it('blocks non-localhost callers unless allowExternal is on', async () => {
    const external = {
      url: 'http://my-public-host:4200/api/webhooks/exec-1',
      headers: { 'x-flujo-token': 'secret-token' },
    };
    expect((await call(external)).status).toBe(403);

    getMock.mockResolvedValue(
      execution({ trigger: { type: 'webhook', token: 'secret-token', allowExternal: true } })
    );
    expect((await call(external)).status).toBe(202);
  });

  it('409s when the execution is off or the scheduler is paused', async () => {
    getMock.mockResolvedValueOnce(execution({ enabled: false }));
    expect((await call({ headers: { 'x-flujo-token': 'secret-token' } })).status).toBe(409);

    isPausedMock.mockResolvedValueOnce(true);
    expect((await call({ headers: { 'x-flujo-token': 'secret-token' } })).status).toBe(409);
    expect(fireMock).not.toHaveBeenCalled();
  });

  it('400s a declared-JSON body that does not parse', async () => {
    const response = await call({
      headers: { 'x-flujo-token': 'secret-token', 'content-type': 'application/json' },
      body: '{nope',
    });
    expect(response.status).toBe(400);
    expect(fireMock).not.toHaveBeenCalled();
  });

  it('passes a non-JSON body through as raw text', async () => {
    const response = await call({
      headers: { 'x-flujo-token': 'secret-token', 'content-type': 'text/plain' },
      body: 'hello world',
    });
    expect(response.status).toBe(202);
    expect(fireMock.mock.calls[0][1].context.body).toBe('hello world');
  });
});
