import { observeSdkRequest } from '@/backend/services/model/adapters/types';
import { FlowExecutionAuthorityError } from '@/backend/execution/flow/executionAuthority';
import { ConversationSequenceSafetyError } from '@/backend/execution/flow/conversationLogSequence';

describe('observeSdkRequest', () => {
  it('refuses physical dispatch when the immutable marker cannot obtain a safe sequence', async () => {
    const task = jest.fn(async () => 'physical dispatch');
    const failure = new ConversationSequenceSafetyError('CONVERSATION_SEQUENCE_EXHAUSTED', 'fixture');
    await expect(observeSdkRequest({ onSdkRequest: async () => { throw failure; } },
      { adapter: 'test', operation: 'create', request: {} }, task)).rejects.toBe(failure);
    expect(task).not.toHaveBeenCalled();
  });

  it('propagates a result-marker safety refusal after exactly one actual dispatch', async () => {
    const task = jest.fn(async () => 'physical result');
    const failure = new ConversationSequenceSafetyError('CONVERSATION_SEQUENCE_EXHAUSTED', 'fixture');
    const result = jest.fn(async () => { throw failure; });
    await expect(observeSdkRequest({ onSdkRequest: async () => 'actual-dispatch', onSdkRequestResult: result },
      { adapter: 'test', operation: 'create', request: {} }, task)).rejects.toBe(failure);
    expect(task).toHaveBeenCalledTimes(1);
    expect(result).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])('preserves a primary provider failure when result sequencing also fails (stream=%s)', async streaming => {
    const primary = new Error('Actual provider failure');
    const secondary = new ConversationSequenceSafetyError('CONVERSATION_SEQUENCE_EXHAUSTED', 'result marker');
    const outcome = jest.fn(async () => { throw secondary; });
    const observed = observeSdkRequest({ onSdkRequest: async () => 'actual-dispatch', onSdkRequestResult: outcome },
      { adapter: 'test', operation: 'create', request: {} }, async () => {
        if (!streaming) throw primary;
        return (async function* () { yield 'retained partial result'; throw primary; })();
      });
    if (streaming) {
      const stream = await observed;
      const received = [];
      await expect((async () => { for await (const value of stream!) received.push(value); })()).rejects.toBe(primary);
      expect(received).toEqual(['retained partial result']);
    } else await expect(observed).rejects.toBe(primary);
    expect(outcome).toHaveBeenCalledTimes(1);
  });
  it('stops before the provider call when archive admission loses execution authority', async () => {
    const task = jest.fn(async () => 'result');
    const lost = new FlowExecutionAuthorityError('Persona was deleted');
    await expect(observeSdkRequest(
      { onSdkRequest: async () => { throw lost; } },
      { adapter: 'test', operation: 'create', request: {} }, task,
    )).rejects.toBe(lost);
    expect(task).not.toHaveBeenCalled();
  });

  it('propagates lost authority after a completed provider call, but tolerates ordinary archive errors', async () => {
    const snapshot = { adapter: 'test', operation: 'create', request: {} };
    const lost = new FlowExecutionAuthorityError('Lease expired');
    await expect(observeSdkRequest({
      onSdkRequest: async () => 'dispatch_lost',
      onSdkRequestResult: async () => { throw lost; },
    }, snapshot, async () => 'result')).rejects.toBe(lost);
    await expect(observeSdkRequest({
      onSdkRequest: async () => { throw new Error('disk full'); },
    }, snapshot, async () => 'result')).resolves.toBe('result');
    await expect(observeSdkRequest({
      onSdkRequest: async () => 'dispatch_ordinary',
      onSdkRequestResult: async () => { throw new Error('disk full'); },
    }, snapshot, async () => 'result')).resolves.toBe('result');
  });

  it('keeps a streaming dispatch running until its iterator completes', async () => {
    const outcomes: string[] = [];
    const stream = await observeSdkRequest(
      {
        onSdkRequest: async () => 'dispatch_1',
        onSdkRequestResult: async ({ outcome }) => { outcomes.push(outcome); },
      },
      { adapter: 'test', operation: 'stream', request: { input: 'hello' } },
      async () => (async function* () {
        yield 'first';
        yield 'second';
      })(),
    );

    expect(outcomes).toEqual([]);
    const received: string[] = [];
    for await (const item of stream) received.push(item as string);

    expect(received).toEqual(['first', 'second']);
    expect(outcomes).toEqual(['completed']);
  });

  it('records an iterator failure once', async () => {
    const outcomes: string[] = [];
    const stream = await observeSdkRequest(
      {
        onSdkRequest: async () => 'dispatch_2',
        onSdkRequestResult: async ({ outcome }) => { outcomes.push(outcome); },
      },
      { adapter: 'test', operation: 'stream', request: {} },
      async () => (async function* () {
        yield 'partial';
        throw new Error('stream failed');
      })(),
    );

    await expect((async () => {
      for await (const _item of stream) {
        // consume
      }
    })()).rejects.toThrow('stream failed');
    expect(outcomes).toEqual(['error']);
  });
});

