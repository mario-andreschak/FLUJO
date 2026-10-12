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

describe('plannedExecutionsService.previewSchedule', () => {
  it.each([
    { valid: true, nextRuns: ['2026-10-12T09:00:00.000Z', '2026-10-13T09:00:00.000Z'] },
    { valid: true, nextRuns: [] },
    { valid: false, error: 'Invalid cron expression', nextRuns: [] },
    { valid: false, nextRuns: [] },
  ])('preserves a genuine API result %j', async (body) => {
    fetchMock.mockResolvedValue(Response.json(body));

    const result = await plannedExecutionsService.previewSchedule('0 9 * * *', 'America/Bogota');

    expect(result).toEqual(body);
    expect(result).not.toHaveProperty('unavailable');
    expect(fetchMock).toHaveBeenCalledWith('/api/planned-executions/preview-schedule', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cron: '0 9 * * *', timezone: 'America/Bogota' }),
      signal: expect.any(AbortSignal),
    });
  });

  it('marks an HTTP failure as unavailable before reading its response body', async () => {
    const response = new Response('Service unavailable', { status: 503 });
    const decode = jest.spyOn(response, 'json');
    fetchMock.mockResolvedValue(response);

    await expect(plannedExecutionsService.previewSchedule('0 9 * * *')).resolves.toEqual({
      valid: false, unavailable: true, error: 'HTTP 503', nextRuns: [],
    });
    expect(decode).not.toHaveBeenCalled();
  });

  it('distinguishes a network failure from an invalid schedule', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));

    await expect(plannedExecutionsService.previewSchedule('0 9 * * *')).resolves.toEqual({
      valid: false, unavailable: true, error: 'Failed to fetch', nextRuns: [],
    });
  });

  it('marks unreadable JSON as unavailable', async () => {
    fetchMock.mockResolvedValue(new Response('not JSON'));

    await expect(plannedExecutionsService.previewSchedule('0 9 * * *')).resolves.toEqual({
      valid: false, unavailable: true, error: expect.any(String), nextRuns: [],
    });
  });

  it.each([
    ['null', null],
    ['missing fields', {}],
    ['missing validity', { nextRuns: [] }],
    ['a string validity', { valid: 'true', nextRuns: [] }],
    ['missing upcoming runs', { valid: true }],
    ['non-array upcoming runs', { valid: true, nextRuns: {} }],
    ['a numeric run', { valid: true, nextRuns: [1791795600000] }],
    ['a null run', { valid: true, nextRuns: [null] }],
    ['an unreadable date', { valid: true, nextRuns: ['not a date'] }],
    ['an empty date', { valid: true, nextRuns: [''] }],
    ['an out-of-range date', { valid: true, nextRuns: ['2026-13-01T09:00:00.000Z'] }],
    ['an invalid later date', { valid: true, nextRuns: ['2026-10-12T09:00:00.000Z', 'broken'] }],
    ['a non-string error', { valid: false, error: { message: 'Invalid cron' }, nextRuns: [] }],
    ['a null error', { valid: false, error: null, nextRuns: [] }],
  ])('marks %s as unavailable instead of passing malformed data to the editor', async (_label, body) => {
    fetchMock.mockResolvedValue(Response.json(body));

    await expect(plannedExecutionsService.previewSchedule('0 9 * * *')).resolves.toEqual({
      valid: false, unavailable: true, error: 'Invalid schedule preview response', nextRuns: [],
    });
  });
});

describe('plannedExecutionsService.previewSchedule request deadline', () => {
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
      const response = Response.json({ valid: true, nextRuns: [] });
      jest.spyOn(response, 'json').mockImplementation(decode);
      fetchMock.mockResolvedValue(response);
    }
    let settled = false;
    const result = plannedExecutionsService.previewSchedule('0 9 * * *').then((value) => {
      settled = true;
      return value;
    });
    const signal = fetchMock.mock.calls[0]?.[1]?.signal;

    await jest.advanceTimersByTimeAsync(29_999);
    expect(settled).toBe(false);
    if (stage === 'response body') expect(decode).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(1);

    expect(settled).toBe(true);
    expect(await result).toEqual({
      valid: false, unavailable: true, error: timeoutMessage, nextRuns: [],
    });
    expect(signal?.aborted).toBe(true);
    expect(jest.getTimerCount()).toBe(0);
  });

  it.each(['success', 'failure'])('clears the deadline after %s without a later abort', async (outcome) => {
    if (outcome === 'success') {
      fetchMock.mockResolvedValue(Response.json({ valid: true, nextRuns: [] }));
    } else {
      fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    }

    await expect(plannedExecutionsService.previewSchedule('0 9 * * *')).resolves.toEqual(
      outcome === 'success'
        ? { valid: true, nextRuns: [] }
        : { valid: false, unavailable: true, error: 'Failed to fetch', nextRuns: [] },
    );
    expect(jest.getTimerCount()).toBe(0);

    await jest.advanceTimersByTimeAsync(30_000);

    expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(false);
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
