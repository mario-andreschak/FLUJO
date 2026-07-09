/**
 * Tests for the URL-watch trigger: cron-scheduled fetches with hash-on-change
 * semantics — prime without firing, fire on changed content (with capped
 * content in context), surface HTTP/network problems as trigger errors, and
 * stop on dispose. fetch is injected; croner runs on fake timers.
 */
import { armUrlWatch } from '@/backend/services/scheduler/triggers/urlWatch';
import type { PlannedExecutionState } from '@/shared/types/plannedExecution';

const makeDeps = () => {
  let state: PlannedExecutionState = {};
  const fetchImpl = jest.fn();
  const deps = {
    fetchImpl: fetchImpl as unknown as typeof fetch,
    loadState: jest.fn(async () => state),
    saveState: jest.fn(async (patch: Partial<PlannedExecutionState>) => {
      state = { ...state, ...patch };
    }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    onFire: jest.fn(async (_payload: any) => ({ status: 'completed' as const })),
    onError: jest.fn(),
  };
  return { deps, fetchImpl, getState: () => state };
};

const htmlResponse = (body: string, status = 200) =>
  new Response(body, { status, headers: { 'content-type': 'text/html' } });

const config = { type: 'url-watch' as const, url: 'https://example.com/status', cron: '* * * * * *' };

// The check body is async; advancing fake timers only queues it.
const flush = async () => {
  // Generous drain: the fire path now awaits onFire → commit → saveState, a
  // deeper microtask chain than a bare check (#75).
  for (let i = 0; i < 30; i++) {
    await Promise.resolve();
  }
};

describe('armUrlWatch', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('primes on the immediate first fetch, fires when content changes', async () => {
    const { deps, fetchImpl, getState } = makeDeps();
    fetchImpl.mockResolvedValue(htmlResponse('version 1'));
    const trigger = armUrlWatch(config, deps);
    await flush();

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://example.com/status',
      expect.objectContaining({ redirect: 'follow' })
    );
    expect(deps.onFire).not.toHaveBeenCalled();
    expect(getState().lastHash).toBeTruthy();

    // Same content on the next tick: quiet.
    fetchImpl.mockResolvedValue(htmlResponse('version 1'));
    jest.advanceTimersByTime(1100);
    await flush();
    expect(deps.onFire).not.toHaveBeenCalled();

    // Changed content: fire with the content in context.
    fetchImpl.mockResolvedValue(htmlResponse('version 2'));
    jest.advanceTimersByTime(1100);
    await flush();
    expect(deps.onFire).toHaveBeenCalledTimes(1);
    const payload = deps.onFire.mock.calls[0][0];
    expect(payload.summary).toBe('Online content changed');
    expect(payload.context.url).toBe(config.url);
    expect(payload.context.content).toBe('version 2');

    trigger.dispose();
  });

  it('truncates huge content in the fire context', async () => {
    const { deps, fetchImpl } = makeDeps();
    fetchImpl.mockResolvedValueOnce(htmlResponse('small'));
    const trigger = armUrlWatch(config, deps);
    await flush();

    fetchImpl.mockResolvedValue(htmlResponse('x'.repeat(10_000)));
    jest.advanceTimersByTime(1100);
    await flush();
    const content = deps.onFire.mock.calls[0][0].context.content as string;
    expect(content.length).toBeLessThan(9000);
    expect(content).toMatch(/truncated, 10000 chars total/);

    trigger.dispose();
  });

  it('reports non-2xx and network failures as trigger errors, never fires', async () => {
    const { deps, fetchImpl, getState } = makeDeps();
    fetchImpl.mockResolvedValueOnce(htmlResponse('gone', 503));
    const trigger = armUrlWatch(config, deps);
    await flush();
    expect(deps.onError).toHaveBeenCalledWith('The URL answered with HTTP 503');
    expect(getState().lastHash).toBeUndefined(); // failed fetch never primes

    fetchImpl.mockRejectedValueOnce(new Error('getaddrinfo ENOTFOUND'));
    jest.advanceTimersByTime(1100);
    await flush();
    expect(deps.onError).toHaveBeenCalledWith('getaddrinfo ENOTFOUND');
    expect(deps.onFire).not.toHaveBeenCalled();

    trigger.dispose();
  });

  it('advances the baseline only after the run completes; retries a skipped/failed change (#75)', async () => {
    const { deps, fetchImpl, getState } = makeDeps();
    fetchImpl.mockResolvedValueOnce(htmlResponse('v1'));
    const trigger = armUrlWatch(config, deps);
    await flush(); // prime on 'v1'
    const primedHash = getState().lastHash;
    expect(primedHash).toBeTruthy();

    // Content changes; the fired run errors → baseline must NOT advance.
    // (Fresh Response per call — a Response body can only be read once.)
    (deps.onFire as jest.Mock).mockResolvedValueOnce({ status: 'error' });
    fetchImpl.mockImplementation(async () => htmlResponse('v2'));
    jest.advanceTimersByTime(1100);
    await flush();
    expect(deps.onFire).toHaveBeenCalledTimes(1);
    expect(getState().lastHash).toBe(primedHash); // unchanged
    expect(getState().pendingFailures).toBe(1);

    // Next check re-fires the same change; this time it completes.
    jest.advanceTimersByTime(1100);
    await flush();
    expect(deps.onFire).toHaveBeenCalledTimes(2);
    expect(getState().lastHash).not.toBe(primedHash); // committed after success
    expect(getState().pendingFailures).toBe(0);

    // Same content now: quiet.
    jest.advanceTimersByTime(1100);
    await flush();
    expect(deps.onFire).toHaveBeenCalledTimes(2);
    trigger.dispose();
  });

  it('gives up after 3 consecutive failed deliveries and drops the change (#75)', async () => {
    const { deps, fetchImpl, getState } = makeDeps();
    fetchImpl.mockResolvedValueOnce(htmlResponse('v1'));
    (deps.onFire as jest.Mock).mockResolvedValue({ status: 'error' });
    const trigger = armUrlWatch(config, deps);
    await flush(); // prime on 'v1'
    const primedHash = getState().lastHash;

    fetchImpl.mockImplementation(async () => htmlResponse('v2'));
    for (let i = 0; i < 3; i++) {
      jest.advanceTimersByTime(1100);
      await flush();
    }
    expect(deps.onFire).toHaveBeenCalledTimes(3);
    expect(getState().lastHash).not.toBe(primedHash); // committed anyway to stop the loop
    expect(getState().pendingFailures).toBe(0);
    expect(deps.onError).toHaveBeenCalledWith(expect.stringContaining('failed to process it 3'));
    trigger.dispose();
  });

  it('stops checking after dispose and exposes the next run time', async () => {
    const { deps, fetchImpl } = makeDeps();
    fetchImpl.mockResolvedValue(htmlResponse('a'));
    const trigger = armUrlWatch(config, deps);
    await flush();

    expect(trigger.nextRun && trigger.nextRun()).toBeTruthy();

    trigger.dispose();
    fetchImpl.mockClear();
    jest.advanceTimersByTime(5000);
    await flush();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
