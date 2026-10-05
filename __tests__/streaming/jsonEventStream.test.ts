const warnMock = jest.fn();
const debugMock = jest.fn();
jest.mock('@/utils/logger', () => ({
  createLogger: () => ({
    warn: (...args: unknown[]) => warnMock(...args),
    debug: (...args: unknown[]) => debugMock(...args),
    info: jest.fn(),
    error: jest.fn(),
  }),
}));

import { createJsonEventStreamResponse } from '@/backend/utils/jsonEventStream';

type Event = { type: string; message?: string };
const publicFailure = { type: 'error', message: 'Research failed. Please try again.' };

beforeEach(() => jest.clearAllMocks());

describe('JSON event stream failure projection', () => {
  it('keeps thrown secrets, stacks and causes out of the response and logger', async () => {
    const failure = Object.assign(new Error('Authorization: Bearer private-test-token'), {
      stack: 'Error at C:\\private\\credentials.json:12',
      cause: { apiKey: 'private-test-api-key' },
    });
    const errorEvent = jest.fn(() => publicFailure);
    const response = createJsonEventStreamResponse<Event>(async (emit) => {
      emit({ type: 'progress', message: 'Working' });
      throw failure;
    }, errorEvent);
    expect(await response.text()).toBe(
      '{"type":"progress","message":"Working"}\n'
      + `${JSON.stringify(publicFailure)}\n`,
    );
    expect(errorEvent).toHaveBeenCalledTimes(1);
    expect(errorEvent).toHaveBeenCalledWith();
    expect(warnMock.mock.calls).toEqual([['JSON event producer failed']]);
    expect(debugMock).not.toHaveBeenCalled();
  });

  it('does not inspect or coerce a thrown value', async () => {
    const inspect = jest.fn(() => { throw new Error('private coercion must not run'); });
    const failure = { get message() { return inspect(); }, toString: inspect };
    const response = createJsonEventStreamResponse<Event>(async () => { throw failure; }, () => publicFailure);
    expect(await response.text()).toBe(`${JSON.stringify(publicFailure)}\n`);
    expect(inspect).not.toHaveBeenCalled();
    expect(warnMock.mock.calls).toEqual([['JSON event producer failed']]);
  });

  it('preserves successful events and closes the stream', async () => {
    const errorEvent = jest.fn(() => publicFailure);
    const response = createJsonEventStreamResponse<Event>(async (emit) => {
      emit({ type: 'complete', message: 'Ready' });
    }, errorEvent);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.text()).toBe('{"type":"complete","message":"Ready"}\n');
    expect(errorEvent).not.toHaveBeenCalled();
    expect(warnMock).not.toHaveBeenCalled();
  });

  it('does not log private field names when encoding an event fails', async () => {
    const cyclic: Record<string, unknown> = {};
    cyclic['private-test-credential-field'] = cyclic;
    const response = createJsonEventStreamResponse(async (emit) => { emit(cyclic); }, () => publicFailure);
    expect(await response.text()).toBe('');
    expect(debugMock.mock.calls).toEqual([['JSON event enqueue failed; stream closed']]);
    expect(warnMock).not.toHaveBeenCalled();
  });

  it('propagates request cancellation to the producer', async () => {
    const requestAbort = new AbortController();
    let producerSignal: AbortSignal | undefined;
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const response = createJsonEventStreamResponse<Event>(async (_emit, signal) => {
      producerSignal = signal;
      await pending;
    }, () => publicFailure, { signal: requestAbort.signal });
    expect(producerSignal?.aborted).toBe(false);
    requestAbort.abort();
    expect(producerSignal?.aborted).toBe(true);
    release();
    expect(await response.text()).toBe('');
  });

  it('aborts the producer when the reader cancels and safely ignores later events', async () => {
    let producerSignal: AbortSignal | undefined;
    let release!: () => void;
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const finished = new Promise<void>((resolve) => { finish = resolve; });
    const response = createJsonEventStreamResponse<Event>(async (emit, signal) => {
      producerSignal = signal;
      await pending;
      emit({ type: 'complete', message: 'Late event' });
      finish();
    }, () => publicFailure);
    const reader = response.body!.getReader();
    await reader.cancel();
    expect(producerSignal?.aborted).toBe(true);
    release();
    await finished;
    expect(await reader.read()).toEqual({ done: true, value: undefined });
    expect(debugMock.mock.calls).toEqual([['JSON event enqueue failed; stream closed']]);
  });
});
