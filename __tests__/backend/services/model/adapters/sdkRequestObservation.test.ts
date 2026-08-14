import { observeSdkRequest } from '@/backend/services/model/adapters/types';

describe('observeSdkRequest', () => {
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

