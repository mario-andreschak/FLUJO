import { createCodexAppServerThread } from '@/backend/services/model/adapters/codexAppServerThread';
import path from 'node:path';
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
  jest.mocked(startOwnedCodexAppServer).mockReset().mockImplementation(async input => {
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

const forkResponse = () => ({ thread: { id: 'child-thread', sessionId: 'root-session', forkedFromId: 'parent-thread',
  turns: [{ id: 'parent-turn', status: 'completed' }] }, model: 'model', cwd: path.resolve('/managed'),
  approvalPolicy: 'never', sandbox: { type: 'readOnly' } });

it.each(['shared tree', 'new tree'])('forks through the completed boundary with the ordinary policy (%s)', async tree => {
  const response = forkResponse();
  if (tree === 'new tree') response.thread.sessionId = response.thread.id;
  request.mockImplementation(async method => method === 'thread/fork' ? response
    : method === 'turn/start' ? { turn: { id: 'turn-1', status: 'inProgress' } } : {});
  const thread = make({ fork: { threadId: 'parent-thread', lastTurnId: 'parent-turn', sessionId: 'root-session' } });
  const events = await begin(thread);
  expect(request).toHaveBeenCalledWith('thread/fork', expect.objectContaining({ threadId: 'parent-thread', lastTurnId: 'parent-turn',
    approvalPolicy: 'never', sandbox: 'read-only', ephemeral: false, developerInstructions: 'Trusted flow instructions' }));
  expect(request.mock.calls.some(([method]) => method === 'thread/start' || method === 'thread/resume')).toBe(false);
  send('turn/completed', { threadId: 'child-thread', turn: { id: 'turn-1', status: 'completed' } });
  for await (const _event of events) { /* Drain the confirmed terminal. */ }
  await thread.close();
  expect(thread.completedTurnId()).toBe('turn-1');
  expect(thread.nativeSessionId()).toBe(response.thread.sessionId);
});

it.each(['lineage', 'same thread', 'in progress', 'later turn', 'session', 'approval', 'sandbox', 'cwd', 'model', 'missing model'])
('rejects a fork with changed %s before any inference or tool turn', async condition => {
  const response = forkResponse();
  if (condition === 'lineage') response.thread.forkedFromId = 'different-parent';
  if (condition === 'same thread') response.thread.id = 'parent-thread';
  if (condition === 'in progress') response.thread.turns[0].status = 'inProgress';
  if (condition === 'later turn') response.thread.turns.push({ id: 'later-turn', status: 'completed' });
  if (condition === 'session') response.thread.sessionId = 'different-session';
  if (condition === 'approval') response.approvalPolicy = 'on-request';
  if (condition === 'sandbox') response.sandbox.type = 'dangerFullAccess';
  if (condition === 'cwd') response.cwd = path.resolve('/different');
  if (condition === 'model') response.model = 'different-model';
  if (condition === 'missing model') Reflect.deleteProperty(response, 'model');
  request.mockImplementation(async method => method === 'thread/fork' ? response : {});
  const thread = make({ fork: { threadId: 'parent-thread', lastTurnId: 'parent-turn', sessionId: 'root-session' } });
  const { events } = await thread.runStreamed('replacement', {});
  await expect(events.next()).rejects.toThrow(/fork/);
  expect(request.mock.calls.filter(([method]) => method === 'turn/start')).toHaveLength(0);
  expect(thread.completedTurnId()).toBeUndefined();
  expect(stop).toHaveBeenCalledTimes(1);
});

it('closes an uncertain fork acknowledgement without replay or a fresh-thread fallback', async () => {
  request.mockImplementation(async method => {
    if (method === 'thread/fork') throw new Error('fork response lost');
    return {};
  });
  const thread = make({ fork: { threadId: 'parent-thread', lastTurnId: 'parent-turn' } });
  const { events } = await thread.runStreamed('replacement', {});
  await expect(events.next()).rejects.toThrow('fork response lost');
  expect(request.mock.calls.filter(([method]) => method === 'thread/fork')).toHaveLength(1);
  expect(request.mock.calls.some(([method]) => ['thread/start', 'thread/resume', 'turn/start'].includes(method))).toBe(false);
  expect(stop).toHaveBeenCalledTimes(1);
});

it('does not expose a completed fork checkpoint while MCP work is unresolved', async () => {
  const thread = make(), events = await begin(thread);
  send('item/started', { item: { id: 'tool-1', type: 'mcpToolCall', server: 'flujo', tool: 'write', status: 'inProgress' } });
  send('turn/completed', { turn: { id: 'turn-1', status: 'completed' } });
  await events.next();
  await expect(events.next()).rejects.toThrow('unresolved MCP work');
  expect(thread.completedTurnId()).toBeUndefined();
  expect(stop).toHaveBeenCalledTimes(1);
});
it('applies native-tool denial before the app-server child starts', async () => {
  const thread = make({ config: { features: { shell_tool: false, code_mode_host: false, multi_agent: false } }, onQuestion: jest.fn() });
  const events = await begin(thread);
  expect(jest.mocked(startOwnedCodexAppServer).mock.calls[0][0].args).toEqual([
    '-c', 'features.shell_tool=false', '-c', 'features.code_mode_host=false', '-c', 'features.multi_agent=false',
    '-c', 'web_search="disabled"', '-c', 'tools.view_image=false',
    '-c', 'tools.experimental_request_user_input.enabled=true',
    '-c', 'features.default_mode_request_user_input=true', 'app-server',
  ]);
  await events.return(undefined); await thread.close();
});
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
  expect(collected.map(event => event.type)).toEqual(['item.updated', 'item.completed', 'turn.completed']);
  expect(collected[0]).toMatchObject({ item: { text: 'Hi there' } });
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

it('retains branded registration close proof when admission rejects before returning a child', async () => {
  let closed!: () => void;
  const proof = new Promise<void>(resolve => { closed = resolve; });
  const failure = new AggregateError([new Error('admission'), new Error('unconfirmed drain')], 'unconfirmed owned process');
  jest.mocked(startOwnedCodexAppServer).mockImplementationOnce(async input => {
    await input.register({ close: proof } as Parameters<typeof input.register>[0]);
    throw failure;
  });
  const thread = make(), { events } = await thread.runStreamed('input', {});
  await expect(events.next()).rejects.toBe(failure);
  expect(thread.whenClosed()).toBe(proof);
  closed(); await expect(thread.whenClosed()).resolves.toBeUndefined();
});

it('routes only an opted-in direct question for the owned active turn', async () => {
  const question = jest.fn(async () => ({ answers: { choice: { answers: ['Blue'] } } }));
  const thread = make({ onQuestion: question }), events = await begin(thread);
  const callback = jest.mocked(startOwnedCodexAppServer).mock.calls.at(-1)![0].onRequest!;
  const signal = new AbortController().signal;
  const params = { threadId: 'thread-1', turnId: 'turn-1', itemId: 'question-item', questions: [] };
  await expect(callback({ id: 'question-1', method: 'item/tool/requestUserInput', params }, signal))
    .resolves.toEqual({ answers: { choice: { answers: ['Blue'] } } });
  expect(question).toHaveBeenCalledWith([], signal);
  expect(request).toHaveBeenCalledWith('initialize', expect.objectContaining({ capabilities: { experimentalApi: true } }));
  await expect(callback({ id: 'wrong-thread', method: 'item/tool/requestUserInput', params: { ...params, threadId: 'other' } }, signal)).rejects.toThrow('active FLUJO turn');
  await expect(callback({ id: 'wrong-turn', method: 'item/tool/requestUserInput', params: { ...params, turnId: 'old-turn' } }, signal)).rejects.toThrow('active FLUJO turn');
  await expect(callback({ id: 'shell', method: 'item/commandExecution/requestApproval', params }, signal)).rejects.toThrow('not enabled');
  expect(question).toHaveBeenCalledTimes(1);
  send('turn/completed', { turn: { id: 'turn-1', status: 'completed' } });
  await events.next();
  await expect(callback({ id: 'stale', method: 'item/tool/requestUserInput', params }, signal)).rejects.toThrow('active FLUJO turn');
  await thread.close();
});

it('refuses a deferred answer and coalesced stale request once their turn terminates', async () => {
  let answer!: (value: unknown) => void;
  const question = jest.fn(() => new Promise(resolve => { answer = resolve; }));
  const thread = make({ onQuestion: question }), events = await begin(thread);
  const callback = jest.mocked(startOwnedCodexAppServer).mock.calls.at(-1)![0].onRequest!;
  const params = { threadId: 'thread-1', turnId: 'turn-1', itemId: 'input', questions: [] };
  const pending = callback({ id: 'question-1', method: 'item/tool/requestUserInput', params }, new AbortController().signal);
  send('turn/completed', { turn: { id: 'turn-1', status: 'completed' } });
  // Arrival revokes input authority before the iterator consumes the terminal.
  expect(thread.canSteer()).toBe(false);
  await expect(callback({ id: 'question-2', method: 'item/tool/requestUserInput', params }, new AbortController().signal)).rejects.toThrow('active FLUJO turn');
  answer({ answers: { color: { answers: ['Blue'] } } });
  await expect(pending).rejects.toThrow('turn ended');
  expect(question).toHaveBeenCalledTimes(1);
  await events.next();
  await thread.close();
});

const asyncQuestion = { id: 'async-question', type: 'agentMessage', text: 'Which color?\n- Blue\n- Green',
  delivery: 'async', phase: 'final_answer', questions: [{ title: 'Which color?', options: ['Blue', 'Green'] }] };
function distinctTurnIds() {
  const original = request.getMockImplementation()!;
  let starts = 0;
  request.mockImplementation((method, ...args) => method === 'turn/start'
    ? Promise.resolve({ turn: { id: `turn-${++starts}`, status: 'inProgress' } }) : original(method, ...args));
}
function trackInterrupt() {
  let entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const original = request.getMockImplementation()!;
  request.mockImplementation((method, ...args) => { if (method === 'turn/interrupt') entered(); return original(method, ...args); });
  return ready;
}
const blueAnswer = { action: 'answer' as const, text: 'Actual user answer: Blue' };

it('requires a matching terminal and fresh ownership before submitting the actual async answer', async () => {
  distinctTurnIds();
  const interrupted = trackInterrupt();
  let answer!: (value: typeof blueAnswer) => void, entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const onAsyncQuestion = jest.fn(() => { entered(); return new Promise<typeof blueAnswer>(resolve => { answer = resolve; }); });
  const beforeContinuation = jest.fn(async () => {}), observed = jest.fn();
  const thread = make({ onAsyncQuestion, onUsage: observed, beforeContinuation }), events = await begin(thread);
  send('item/started', { item: asyncQuestion }); send('item/completed', { item: asyncQuestion });
  const next = events.next(); await interrupted;
  expect(request).toHaveBeenCalledWith('turn/interrupt', { threadId: 'thread-1', turnId: 'turn-1' }, 5000);
  expect(onAsyncQuestion).not.toHaveBeenCalled();
  expect(thread.canSteer()).toBe(false); expect(await thread.steer('unrelated correction')).toBe(false);
  send('thread/tokenUsage/updated', { tokenUsage: usage });
  send('turn/completed', { turn: { id: 'turn-1', status: 'interrupted' } }); await ready;
  expect(request.mock.calls.filter(([method]) => method === 'turn/start')).toHaveLength(1);
  answer(blueAnswer);
  expect((await next).value?.type).toBe('turn.started');
  expect(beforeContinuation).toHaveBeenCalledTimes(1);
  expect(request.mock.calls.filter(([method]) => method === 'turn/start')).toHaveLength(2);
  expect(request).toHaveBeenLastCalledWith('turn/start', expect.objectContaining({ input: [{ type: 'text', text: blueAnswer.text }] }));
  expect(onAsyncQuestion).toHaveBeenCalledTimes(1);
  send('thread/tokenUsage/updated', { tokenUsage: usage }); // Late prior-turn totals.
  send('item/completed', { turnId: 'turn-2', item: { id: 'final-2', type: 'agentMessage', text: 'Blue', phase: 'final_answer' } });
  send('thread/tokenUsage/updated', { turnId: 'turn-2', tokenUsage: { ...usage, total: { ...usage.total, inputTokens: 150 } } });
  send('turn/completed', { turn: { id: 'turn-2', status: 'completed' } });
  const collected = []; for await (const event of events) collected.push(event);
  expect(collected.map(event => event.type)).toEqual(['item.completed', 'turn.completed']);
  expect(collected[0]).toMatchObject({ item: { text: 'Blue' } });
  expect(thread.usage()?.input_tokens).toBe(150); expect(observed).toHaveBeenCalledTimes(2);
  await thread.close();
});

it.each(['failed', 'invalid'])('refuses asynchronous input after a %s terminal', async status => {
  const interrupted = trackInterrupt(), onAsyncQuestion = jest.fn();
  const thread = make({ onAsyncQuestion }), events = await begin(thread);
  send('item/completed', { item: asyncQuestion }); const next = events.next(); await interrupted;
  send('turn/completed', { turn: { id: 'turn-1', status } });
  await expect(next).rejects.toThrow('valid terminal'); expect(onAsyncQuestion).not.toHaveBeenCalled();
  expect(request.mock.calls.filter(([method]) => method === 'turn/start')).toHaveLength(1);
  expect(stop).toHaveBeenCalledTimes(1);
});

it.each(['stop', 'connection'])('drains an asynchronous question on %s after its interrupted terminal', async reason => {
  const interrupted = trackInterrupt();
  let entered!: () => void, questionSignal!: AbortSignal;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const controller = new AbortController();
  const thread = make({ onAsyncQuestion: (_questions, signal) => { questionSignal = signal; entered(); return new Promise(() => {}); } });
  const events = await begin(thread, controller.signal);
  send('item/completed', { item: asyncQuestion }); const next = events.next(); await interrupted;
  send('turn/completed', { turn: { id: 'turn-1', status: 'interrupted' } }); await ready;
  if (reason === 'stop') controller.abort(); else close();
  await expect(next).rejects.toBeDefined(); expect(questionSignal.aborted).toBe(true);
  expect(request.mock.calls.filter(([method]) => method === 'turn/start')).toHaveLength(1);
});

it('rejects an unapproved native operation before admitting the asynchronous question', async () => {
  const interrupted = trackInterrupt(), onAsyncQuestion = jest.fn();
  const thread = make({ onAsyncQuestion }), events = await begin(thread);
  send('item/completed', { item: asyncQuestion }); const next = events.next(); await interrupted;
  send('item/started', { item: { id: 'native-wait', type: 'collabAgentToolCall', tool: 'wait' } });
  await expect(next).rejects.toThrow('unsupported item (collabAgentToolCall)');
  expect(onAsyncQuestion).not.toHaveBeenCalled();
  expect(request.mock.calls.filter(([method]) => method === 'turn/start')).toHaveLength(1);
});

it('ends an explicit decline without another provider turn', async () => {
  const interrupted = trackInterrupt(), onAsyncQuestion = jest.fn(async () => ({ action: 'decline' as const }));
  const thread = make({ onAsyncQuestion }), events = await begin(thread);
  send('item/completed', { item: asyncQuestion }); const next = events.next(); await interrupted;
  send('turn/completed', { turn: { id: 'turn-1', status: 'interrupted' } });
  expect((await next).value?.type).toBe('turn.completed');
  expect(onAsyncQuestion).toHaveBeenCalledTimes(1);
  expect(request.mock.calls.filter(([method]) => method === 'turn/start')).toHaveLength(1);
  await events.return(undefined); await thread.close();
});

it.each(['superseded', 'stop-after-fence'])('refuses answer continuation on %s after the human wait', async reason => {
  const interrupted = trackInterrupt(), controller = new AbortController();
  const beforeContinuation = jest.fn(async () => { if (reason === 'superseded') throw new Error('superseded owner'); controller.abort(); });
  const thread = make({ onAsyncQuestion: async () => blueAnswer, beforeContinuation }), events = await begin(thread, controller.signal);
  send('item/completed', { item: asyncQuestion }); const next = events.next(); await interrupted;
  send('turn/completed', { turn: { id: 'turn-1', status: 'interrupted' } });
  await expect(next).rejects.toBeDefined(); expect(beforeContinuation).toHaveBeenCalledTimes(1);
  expect(request.mock.calls.filter(([method]) => method === 'turn/start')).toHaveLength(1);
});

it('bounds an acknowledged interrupt without matching terminal proof', async () => {
  jest.useFakeTimers();
  try {
    const interrupted = trackInterrupt(), onAsyncQuestion = jest.fn();
    const thread = make({ onAsyncQuestion }), events = await begin(thread);
    send('item/completed', { item: asyncQuestion }); const next = events.next(); await interrupted;
    const failure = expect(next).rejects.toThrow('no confirmed terminal');
    await jest.advanceTimersByTimeAsync(5000); await failure;
    expect(onAsyncQuestion).not.toHaveBeenCalled(); expect(stop).toHaveBeenCalledTimes(1);
    expect(request.mock.calls.filter(([method]) => method === 'turn/start')).toHaveLength(1);
  } finally { jest.useRealTimers(); }
});

it('accepts matching completed proof after a received interrupt race rejection', async () => {
  distinctTurnIds();
  const original = request.getMockImplementation()!;
  request.mockImplementation((method, ...args) => {
    if (method === 'turn/interrupt') { send('turn/completed', { turn: { id: 'turn-1', status: 'completed' } }); return Promise.reject(new CodexAppServerRpcError(-32600)); }
    return original(method, ...args);
  });
  const onAsyncQuestion = jest.fn(async () => blueAnswer), thread = make({ onAsyncQuestion }), events = await begin(thread);
  send('item/completed', { item: asyncQuestion });
  expect((await events.next()).value?.type).toBe('turn.started'); expect(onAsyncQuestion).toHaveBeenCalledTimes(1);
  expect(request.mock.calls.filter(([method]) => method === 'turn/start')).toHaveLength(2);
  await events.return(undefined); await thread.close();
});

it('does not submit an answer after an uncertain interrupt acknowledgement', async () => {
  const original = request.getMockImplementation()!;
  request.mockImplementation((method, ...args) => method === 'turn/interrupt' ? Promise.reject(new Error('lost interrupt acknowledgement')) : original(method, ...args));
  const onAsyncQuestion = jest.fn(), thread = make({ onAsyncQuestion }), events = await begin(thread);
  send('item/completed', { item: asyncQuestion });
  await expect(events.next()).rejects.toThrow('lost interrupt acknowledgement'); expect(onAsyncQuestion).not.toHaveBeenCalled();
  expect(request.mock.calls.filter(([method]) => method === 'turn/start')).toHaveLength(1); expect(stop).toHaveBeenCalledTimes(1);
});

it('enforces the configured turn limit before creating another question continuation', async () => {
  const onAsyncQuestion = jest.fn(), thread = make({ onAsyncQuestion, maxTurns: 1 }), events = await begin(thread);
  send('item/completed', { item: asyncQuestion }); await expect(events.next()).rejects.toThrow('flow turn limit');
  expect(onAsyncQuestion).not.toHaveBeenCalled(); expect(request.mock.calls.filter(([method]) => method === 'turn/start')).toHaveLength(1);
});

it('refuses async questions with an unresolved MCP effect and without a bound local executor', async () => {
  const onAsyncQuestion = jest.fn(), thread = make({ onAsyncQuestion }), events = await begin(thread);
  send('item/started', { item: { id: 'effect', type: 'mcpToolCall', server: 'flujo', tool: 'example', status: 'inProgress' } });
  expect((await events.next()).value?.type).toBe('item.started'); send('item/completed', { item: asyncQuestion });
  await expect(events.next()).rejects.toThrow('overlapping'); expect(onAsyncQuestion).not.toHaveBeenCalled();
  const unbound = make(), otherEvents = await begin(unbound); send('item/completed', { item: asyncQuestion });
  await expect(otherEvents.next()).rejects.toThrow('not enabled');
});


it('bounds a long streamed reply without queueing ignored diagnostic notifications', async () => {
  const thread = make(), events = await begin(thread);
  for (let index = 0; index < 3000; index++) {
    send('codex/event/agent_message_delta', { delta: 'duplicate' });
    send('item/agentMessage/delta', { itemId: 'long-message', delta: 'word ' });
  }
  send('turn/completed', { turn: { id: 'turn-1', status: 'completed' } });
  const collected = []; for await (const event of events) collected.push(event);
  expect(collected).toHaveLength(2);
  expect(collected[0]).toMatchObject({ type: 'item.updated', item: { text: 'word '.repeat(3000) } });
  expect(collected[1].type).toBe('turn.completed');
  await thread.close();
});
