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
    onFire: jest.fn(),
    onError: jest.fn(),
  };
  return { deps, fetchImpl, getState: () => state };
};

const htmlResponse = (body: string, status = 200) =>
  new Response(body, { status, headers: { 'content-type': 'text/html' } });

const config = { type: 'url-watch' as const, url: 'https://example.com/status', cron: '* * * * * *' };

// The check body is async; advancing fake timers only queues it.
const flush = async () => {
  for (let i = 0; i < 10; i++) {
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
