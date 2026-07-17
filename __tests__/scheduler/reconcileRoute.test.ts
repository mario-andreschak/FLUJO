/**
 * Tests for POST /api/planned-executions/reconcile (issue #113).
 *
 * The scheduler service is mocked at the module boundary; the route's own logic
 * — delegate to reconcile(), echo the pause state, never touch `paused` — runs
 * for real. assertUnlocked and backend init are stubbed to the unlocked/no-op
 * path.
 */
const assertUnlockedMock = jest.fn(async () => null);
jest.mock('@/utils/encryption/lockGate', () => ({
  assertUnlocked: (...a: unknown[]) => assertUnlockedMock(...(a as [])),
}));

jest.mock('@/backend/init', () => ({
  ensureBackendInitialized: jest.fn(async () => undefined),
}));

const reconcileMock = jest.fn(async () => undefined);
const isPausedMock = jest.fn(async () => false);
const setPausedMock = jest.fn(async () => undefined);
jest.mock('@/backend/services/scheduler', () => ({
  getSchedulerService: () => ({
    reconcile: (...a: unknown[]) => reconcileMock(...a),
    isPaused: (...a: unknown[]) => isPausedMock(...a),
    setPaused: (...a: unknown[]) => setPausedMock(...a),
  }),
}));

import { POST } from '@/app/api/planned-executions/reconcile/route';

beforeEach(() => {
  assertUnlockedMock.mockReset().mockResolvedValue(null);
  reconcileMock.mockReset().mockResolvedValue(undefined);
  isPausedMock.mockReset().mockResolvedValue(false);
  setPausedMock.mockReset().mockResolvedValue(undefined);
});

describe('reconcile route', () => {
  it('reconciles and returns 200 { ok:true, paused } without changing pause state', async () => {
    const response = await POST();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ ok: true, paused: false });

    expect(reconcileMock).toHaveBeenCalledTimes(1);
    // The route must NEVER touch the pause state (the whole point of #113).
    expect(setPausedMock).not.toHaveBeenCalled();
  });

  it('echoes the paused state so a caller knows nothing was armed', async () => {
    isPausedMock.mockResolvedValueOnce(true);
    const response = await POST();
    const body = await response.json();
    expect(body).toEqual({ ok: true, paused: true });
    expect(setPausedMock).not.toHaveBeenCalled();
  });

  it('returns the 423 lock response when the store is locked', async () => {
    const locked = new Response(JSON.stringify({ error: 'encryption_locked' }), { status: 423 });
    assertUnlockedMock.mockResolvedValueOnce(locked as never);
    const response = await POST();
    expect(response.status).toBe(423);
    expect(reconcileMock).not.toHaveBeenCalled();
  });
});
