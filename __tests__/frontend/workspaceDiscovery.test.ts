import { DISCOVERY_PATIENCE_MS, discoverWorkspaces, pauseAfterFailure } from '@/frontend/utils/workspaceDiscovery';

const ok = (names: string[]) => ({ ok: true, status: 200, json: async () => ({ workspaces: names.map((name) => ({ name })) }) });
const failing = (status = 500) => ({ ok: false, status, json: async () => ({}) });
const preparing = (retryAfter: string | null) => ({
  ok: false,
  status: 503,
  headers: { get: () => retryAfter },
  json: async () => ({ code: 'WORKSPACE_LAYOUT_PREPARING' }),
});

function clock() {
  let time = 0;
  const waits: number[] = [];
  return {
    now: () => time,
    wait: async (ms: number) => { waits.push(ms); time += ms; },
    waits,
  };
}

describe('discoverWorkspaces (#1427)', () => {
  it('waits through a slow start instead of giving up after a few quick failures', async () => {
    const { now, wait, waits } = clock();
    const onSlow = jest.fn();
    const request = jest.fn()
      .mockRejectedValueOnce(new Error('aborted'))
      .mockResolvedValueOnce(failing(500))
      .mockResolvedValueOnce(failing(502))
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValueOnce(failing(500))
      .mockResolvedValueOnce(ok(['default-workspace', 'team-b']));
    const outcome = await discoverWorkspaces({ request, wait, now, onSlow });
    expect(outcome).toEqual({ kind: 'ready', names: new Set(['default-workspace', 'team-b']) });
    expect(request).toHaveBeenCalledTimes(6);
    expect(waits).toEqual([250, 500, 1000, 2000, 4000]);
    expect(onSlow).toHaveBeenCalledTimes(5);
  });

  it('gives up only after the patience window, with pauses capped at five seconds', async () => {
    const { now, wait, waits } = clock();
    const request = jest.fn().mockResolvedValue(failing(500));
    expect(await discoverWorkspaces({ request, wait, now })).toEqual({ kind: 'unavailable' });
    expect(waits.reduce((sum, ms) => sum + ms, 0)).toBeGreaterThanOrEqual(DISCOVERY_PATIENCE_MS);
    expect(Math.max(...waits)).toBe(5000);
    expect(request.mock.calls.length).toBeLessThan(20);
  });

  it('keeps polling while the server migrates, and a migration resets the patience window', async () => {
    const { now, wait, waits } = clock();
    const onMigrating = jest.fn();
    const request = jest.fn()
      .mockResolvedValueOnce(failing(500))
      .mockResolvedValueOnce(preparing('0'))
      .mockResolvedValueOnce(preparing(null))
      .mockResolvedValueOnce(failing(500))
      .mockResolvedValueOnce(ok(['default-workspace']));
    // 2750 ms pass before the second failure; without the reset a 300 ms window would already be over.
    expect((await discoverWorkspaces({ request, wait, now, onMigrating, patienceMs: 300 })).kind).toBe('ready');
    expect(onMigrating).toHaveBeenCalledTimes(2);
    expect(waits).toEqual([250, 500, 2000, 250]);
  });

  it('stops at once for owner sign-in and when cancelled', async () => {
    const request = jest.fn().mockResolvedValue({ ok: false, status: 401, json: async () => ({}) });
    expect(await discoverWorkspaces({ request })).toEqual({ kind: 'owner-auth' });
    expect(request).toHaveBeenCalledTimes(1);

    let cancelled = false;
    const slow = jest.fn().mockResolvedValue(failing(500));
    const outcome = await discoverWorkspaces({
      request: slow,
      wait: async () => { cancelled = true; },
      isCancelled: () => cancelled,
    });
    expect(outcome).toEqual({ kind: 'cancelled' });
    expect(slow).toHaveBeenCalledTimes(1);
  });

  it('drops invalid workspace names from the answer', async () => {
    const request = jest.fn().mockResolvedValue(ok(['default-workspace', '../etc', 'CON']));
    expect(await discoverWorkspaces({ request })).toEqual({ kind: 'ready', names: new Set(['default-workspace']) });
  });

  it('grows the pause after each failure up to five seconds', () => {
    expect([1, 2, 3, 4, 5, 6, 12].map(pauseAfterFailure)).toEqual([250, 500, 1000, 2000, 4000, 5000, 5000]);
  });
});
