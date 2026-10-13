import { createCodexAppServerThread } from '@/backend/services/model/adapters/codexAppServerThread';
import { startOwnedCodexAppServer, CodexAppServerRpcError } from '@/backend/services/model/adapters/codexAppServerProcess';
import { parseCodexProtocolUsage } from '@/backend/services/model/adapters/codexProtocol';
import { mapCodexUsage, subtractCodexUsage } from '@/backend/services/model/adapters/codexUsage';
import { watchSteering, UncertainSteeringSubmissionError } from '@/backend/services/model/adapters/liveSteering';
jest.mock('@/backend/services/model/adapters/codexAppServerProcess', () => ({
  ...jest.requireActual('@/backend/services/model/adapters/codexAppServerProcess'),
  startOwnedCodexAppServer: jest.fn(), assertCodexOwnedProcessRegistration: jest.fn(),
}));
let emit: (message: { method: string; params: unknown }) => void;
let close: () => void;
let request: jest.Mock, stop: jest.Mock;
const usage = { total: { inputTokens: 100, outputTokens: 40, cachedInputTokens: 60, reasoningOutputTokens: 20 },
  last: { inputTokens: 80, outputTokens: 30 }, modelContextWindow: 200000 };
const send = (method: string, params: Record<string, unknown>) => emit({ method, params: { threadId: 'thread-1', turnId: 'turn-1', ...params } });
beforeEach(() => {
  const closed = new Promise<void>(resolve => { close = resolve; });
  stop = jest.fn(async () => { close(); });
  request = jest.fn(async method => {
    if (method === 'thread/start' || method === 'thread/resume') return { thread: { id: 'thread-1' }, model: 'model' };
    if (method === 'turn/start') return { turn: { id: 'turn-1', status: 'inProgress' } };
    if (method === 'turn/steer') return { turnId: 'turn-1' };
    return {};
  });
  jest.mocked(startOwnedCodexAppServer).mockImplementation(async input => {
    emit = input.onNotification;
    return { request, stop, notify: jest.fn(), registration: { close: closed } } as unknown as Awaited<ReturnType<typeof startOwnedCodexAppServer>>;
  });
});
const make = (extra: Partial<Parameters<typeof createCodexAppServerThread>[0]> = {}) => createCodexAppServerThread({
  executable: 'owned-cli', env: { NODE_ENV: 'test' }, config: { features: { shell_tool: false } },
  options: { model: 'model', workingDirectory: '/managed' }, developerInstructions: 'Trusted flow instructions', onUsage: jest.fn(), ...extra,
});
async function begin(thread: ReturnType<typeof make>, signal?: AbortSignal) {
  const { events } = await thread.runStreamed('new input only', { signal });
  await events.next(); await events.next();
  return events;
}
it('resumes over RPC, streams true deltas, preserves token subsets and completes exactly once', async () => {
  const observed = jest.fn(), thread = make({ resumeThreadId: 'thread-1', onUsage: observed });
  const events = await begin(thread);
  expect(request).toHaveBeenCalledWith('thread/resume', expect.objectContaining({ threadId: 'thread-1', developerInstructions: 'Trusted flow instructions' }));
  expect(request).toHaveBeenCalledWith('turn/start', expect.objectContaining({ input: [{ type: 'text', text: 'new input only' }] }));
  send('item/agentMessage/delta', { itemId: 'message-1', delta: 'Hi ' });
  send('item/agentMessage/delta', { itemId: 'message-1', delta: 'there' });
  send('item/completed', { item: { id: 'message-1', type: 'agentMessage', text: 'Hi there' } });
  send('thread/tokenUsage/updated', { tokenUsage: usage });
  send('turn/completed', { turn: { id: 'turn-1', status: 'completed' } });
  const collected = []; for await (const event of events) collected.push(event);
  expect(collected.map(event => event.type)).toEqual(['item.updated', 'item.updated', 'item.completed', 'turn.completed']);
  expect(observed).toHaveBeenCalledWith(expect.objectContaining({ reasoning_output_tokens: 20, cached_input_tokens: 60 }), expect.objectContaining({ contextWindow: 200000, promptTokens: 80 }));
  await thread.close(); expect(stop).toHaveBeenCalledTimes(1);
});
it('steers only the active turn and never starts a replacement after a received completion-race rejection', async () => {
  const thread = make(), events = await begin(thread);
  expect(await thread.steer('correction')).toBe(true);
  expect(request).toHaveBeenCalledWith('turn/steer', expect.objectContaining({ expectedTurnId: 'turn-1' }));
  request.mockRejectedValueOnce(new CodexAppServerRpcError(-32600));
  expect(await thread.steer('late correction')).toBe(false);
  expect(request.mock.calls.filter(([method]) => method === 'turn/start')).toHaveLength(1);
  await events.return(undefined); await thread.close();
});
it('closes an uncertain steering submission without retry or replacement', async () => {
  const thread = make(), events = await begin(thread);
  request.mockRejectedValueOnce(new Error('transport disappeared'));
  await expect(thread.steer('possibly accepted')).rejects.toThrow('transport disappeared');
  expect(stop).toHaveBeenCalled();
  expect(request.mock.calls.filter(([method]) => method === 'turn/start')).toHaveLength(1);
  await events.return(undefined);
});
it('interrupts and closes the owned turn on cancellation after partial output', async () => {
  const controller = new AbortController(), thread = make(), events = await begin(thread, controller.signal);
  send('item/agentMessage/delta', { itemId: 'partial', delta: 'Already visible' });
  expect((await events.next()).value).toMatchObject({ item: { text: 'Already visible' } });
  controller.abort();
  await expect(events.next()).rejects.toBeDefined();
  expect(request).toHaveBeenCalledWith('turn/interrupt', { threadId: 'thread-1', turnId: 'turn-1' }, 5000);
  expect(stop).toHaveBeenCalled();
});
it('does not classify failed or interrupted terminals as completion and rejects cross-turn output', async () => {
  for (const status of ['failed', 'interrupted']) {
    const thread = make(), events = await begin(thread);
    send('turn/completed', { turn: { id: 'turn-1', status } });
    expect((await events.next()).value?.type).toBe('turn.failed');
    await events.return(undefined); await thread.close();
  }
  const thread = make(), events = await begin(thread);
  send('item/agentMessage/delta', { turnId: 'other-turn', itemId: 'wrong', delta: 'bad' });
  await expect(events.next()).rejects.toThrow('different turn');
});
it('reconciles resumed totals including reasoning without counting subsets twice', () => {
  const parsed = parseCodexProtocolUsage(usage);
  expect(mapCodexUsage(subtractCodexUsage(parsed.total, { input_tokens: 20, output_tokens: 10, reasoning_output_tokens: 4 })))
    .toMatchObject({ promptTokens: 80, completionTokens: 30, totalTokens: 110, reasoningTokens: 16 });
  expect(() => parseCodexProtocolUsage({ ...usage, total: { ...usage.total, cachedInputTokens: 101 } })).toThrow('subset');
});
it('holds uncertain steering instead of returning possibly accepted input to the inbox', async () => {
  const batch = { messages: [], beforeSend: jest.fn(), acknowledge: jest.fn(), requeue: jest.fn() };
  const watcher = watchSteering({ source: { take: async () => batch, subscribe: () => () => {} },
    canDeliver: () => true, deliver: async () => { throw new UncertainSteeringSubmissionError(new Error('lost ack')); }, onError: jest.fn(),
  });
  await watcher.poll(); await watcher.stop();
  expect(batch.requeue).not.toHaveBeenCalled(); expect(batch.acknowledge).not.toHaveBeenCalled();
});
it('accepts automatic context-compaction items without transcript duplication', async () => {
  const thread = make(), events = await begin(thread);
  send('item/completed', { item: { id: 'compact-1', type: 'contextCompaction' } });
  send('turn/completed', { turn: { id: 'turn-1', status: 'completed' } });
  expect((await events.next()).value?.type).toBe('turn.completed');
  await events.return(undefined); await thread.close();
});
it('retains the protocol final-answer phase separately from commentary', async () => {
  const thread = make(), events = await begin(thread);
  send('item/completed', { item: { id: 'final', type: 'agentMessage', phase: 'final_answer', text: 'READY' } });
  expect((await events.next()).value).toMatchObject({ item: { phase: 'final_answer', text: 'READY' } });
  await events.return(undefined); await thread.close();
});
it('cancels owned startup before admission and drains it before reporting closure', async () => {
  let entered!: () => void;
  const admission = new Promise<void>(resolve => { entered = resolve; });
  jest.mocked(startOwnedCodexAppServer).mockImplementation(async input => {
    entered();
    await new Promise<void>((_resolve, reject) => input.signal!.addEventListener('abort', () => reject(new Error('admission cancelled')), { once: true }));
    throw new Error('unexpected admission');
  });
  const controller = new AbortController(), thread = make();
  const { events } = await thread.runStreamed('input', { signal: controller.signal });
  const first = events.next();
  await admission; controller.abort();
  await expect(first).rejects.toThrow('admission cancelled');
  await thread.close();
  expect(request).not.toHaveBeenCalled();
});
it('does not hide unconfirmed closure when admission and its process drain both fail', async () => {
  const failure = new AggregateError([new Error('admission'), new Error('close remains unconfirmed')], 'unconfirmed owned process');
  jest.mocked(startOwnedCodexAppServer).mockRejectedValueOnce(failure);
  const thread = make(), { events } = await thread.runStreamed('input', {});
  await expect(events.next()).rejects.toThrow('unconfirmed owned process');
  await expect(thread.close()).rejects.toThrow('unconfirmed owned process');
});
