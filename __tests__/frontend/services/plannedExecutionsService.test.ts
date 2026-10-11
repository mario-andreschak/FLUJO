import { plannedExecutionsService } from '@/frontend/services/plannedExecutions';

jest.mock('@/utils/logger', () => ({
  createLogger: () => ({ warn: jest.fn() }),
}));

let fetchMock: jest.SpiedFunction<typeof fetch>;

beforeEach(() => {
  fetchMock = jest.spyOn(globalThis, 'fetch');
});

afterEach(() => {
  fetchMock.mockRestore();
});

describe('plannedExecutionsService.list with throwOnError', () => {
  it('rejects an HTTP failure before reading its response body', async () => {
    fetchMock.mockResolvedValue(new Response('Service unavailable', { status: 503 }));

    await expect(plannedExecutionsService.list({ throwOnError: true })).rejects.toThrow('HTTP 503');
    expect(fetchMock).toHaveBeenCalledWith('/api/planned-executions', {
      signal: expect.any(AbortSignal),
    });
  });

  it('propagates a network failure instead of reporting an empty schedule', async () => {
    const failure = new TypeError('Failed to fetch');
    fetchMock.mockRejectedValue(failure);

    await expect(plannedExecutionsService.list({ throwOnError: true })).rejects.toBe(failure);
  });

  it('rejects an unreadable JSON response', async () => {
    fetchMock.mockResolvedValue(new Response('not JSON'));

    await expect(plannedExecutionsService.list({ throwOnError: true })).rejects.toMatchObject({ name: 'SyntaxError' });
  });

  it.each([
    ['null', null],
    ['missing fields', {}],
    ['missing executions', { paused: false }],
    ['missing pause state', { executions: [] }],
    ['a string pause state', { paused: 'false', executions: [] }],
    ['a numeric pause state', { paused: 0, executions: [] }],
    ['a non-array execution list', { paused: true, executions: {} }],
  ])('rejects %s without treating it as an empty schedule', async (_label, body) => {
    fetchMock.mockResolvedValue(Response.json(body));

    await expect(plannedExecutionsService.list({ throwOnError: true })).rejects.toThrow(
      'Invalid planned executions response',
    );
  });

  it.each([false, true])('accepts a genuinely empty schedule with paused=%s', async (paused) => {
    const body = { paused, executions: [] };
    fetchMock.mockResolvedValue(Response.json(body));

    await expect(plannedExecutionsService.list({ throwOnError: true })).resolves.toEqual(body);
  });

  it('preserves entries and additional API fields without validating entry details', async () => {
    const body = {
      paused: true,
      executions: [{ execution: { id: 'weekly-check' }, status: { running: false }, lastRun: null }],
      nextPage: null,
    };
    fetchMock.mockResolvedValue(Response.json(body));

    await expect(plannedExecutionsService.list({ throwOnError: true })).resolves.toEqual(body);
  });
});

describe('plannedExecutionsService.list compatibility', () => {
  it.each([undefined, {}, { throwOnError: false }])(
    'keeps the empty fallback for an HTTP failure with options %j',
    async (options) => {
      fetchMock.mockResolvedValue(new Response('Service unavailable', { status: 503 }));

      await expect(plannedExecutionsService.list(options)).resolves.toEqual({ paused: false, executions: [] });
    },
  );

  it('keeps the empty fallback for network failures', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));

    await expect(plannedExecutionsService.list()).resolves.toEqual({ paused: false, executions: [] });
  });

  it('keeps the empty fallback for unreadable JSON', async () => {
    fetchMock.mockResolvedValue(new Response('not JSON'));

    await expect(plannedExecutionsService.list()).resolves.toEqual({ paused: false, executions: [] });
  });

  it('keeps successful legacy payloads unchanged', async () => {
    const body = { executions: [] };
    fetchMock.mockResolvedValue(Response.json(body));

    await expect(plannedExecutionsService.list()).resolves.toEqual(body);
    expect(fetchMock).toHaveBeenCalledWith('/api/planned-executions');
  });
});

const boundedRequests = [
  { name: 'strict list', read: true, run: () => plannedExecutionsService.list({ throwOnError: true }) },
  { name: 'delete', read: false, run: () => plannedExecutionsService.delete('weekly-check') },
  { name: 'setPaused', read: false, run: () => plannedExecutionsService.setPaused(true) },
];
const timeoutMessage = 'The request took too long. Please try again.';

describe.each(boundedRequests)('$name request deadline', ({ read, run }) => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it.each(['fetch', 'response body'])('aborts a stalled %s after 30 seconds', async (stage) => {
    const decode = jest.fn(() => new Promise<never>(() => {}));
    if (stage === 'fetch') {
      fetchMock.mockReturnValue(new Promise<Response>(() => {}));
    } else {
      const response = Response.json({}, { status: read ? 200 : 503 });
      jest.spyOn(response, 'json').mockImplementation(decode);
      fetchMock.mockResolvedValue(response);
    }
    let settled = false;
    const result = run().then(
      (value) => { settled = true; return { value }; },
      (error) => { settled = true; return { error }; },
    );
    const signal = fetchMock.mock.calls[0]?.[1]?.signal;

    await jest.advanceTimersByTimeAsync(29_999);
    expect(settled).toBe(false);
    expect(signal?.aborted).toBe(false);
    if (stage === 'response body') expect(decode).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(1);

    expect(await result).toEqual(read
      ? { error: new Error(timeoutMessage) }
      : { value: { success: false, error: timeoutMessage } });
    expect(signal?.aborted).toBe(true);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('clears the deadline after success without aborting the completed request', async () => {
    fetchMock.mockResolvedValue(read
      ? Response.json({ paused: true, executions: [] })
      : new Response(null, { status: 204 }));

    await expect(run()).resolves.toEqual(read
      ? { paused: true, executions: [] }
      : { success: true });
    expect(jest.getTimerCount()).toBe(0);

    await jest.advanceTimersByTimeAsync(30_000);

    expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(false);
  });

  it('clears the deadline after failure without a later abort', async () => {
    const failure = new TypeError('Failed to fetch');
    fetchMock.mockRejectedValue(failure);

    expect(await run().catch((error) => error)).toEqual(read
      ? failure
      : { success: false, error: failure.message });
    expect(jest.getTimerCount()).toBe(0);

    await jest.advanceTimersByTimeAsync(30_000);

    expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(false);
  });
});
