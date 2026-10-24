import { createOwnedCodexThread } from '@/backend/services/model/adapters/codexOwnedThread';
import type { NativeOriginalProcessHost } from '@/backend/execution/flow/handlers/nativeOriginalHost';
import { startOwnedCodexAppServer } from '@/backend/services/model/adapters/codexAppServerProcess';

jest.mock('@/backend/execution/flow/handlers/nativeOriginalHost', () => ({
  assertNativeOriginalProcessHost: jest.fn(), nativeOriginalUsesPersonaTools: () => true,
}));
jest.mock('@/backend/services/model/adapters/codexAppServerProcess', () => ({ startOwnedCodexAppServer: jest.fn() }));

const start = jest.mocked(startOwnedCodexAppServer);
const absent = Symbol('absent');
function protocol(cacheWrite: unknown = absent, echo: { threadId?: string; turnId?: string; type?: string } = {}, deferred = false) {
  const outputCurrent = jest.fn(async () => {});
  const host = { assertTurnBudget: jest.fn(async () => {}), beforeFirstPrompt: jest.fn(async () => {}),
    assertOutputCurrent: outputCurrent } as unknown as NativeOriginalProcessHost;
  let releaseOutput: (() => void) | undefined, closeProcess!: () => void;
  const close = new Promise<void>(resolve => { closeProcess = resolve; });
  start.mockImplementation(async input => {
    const notify = (method: string, params: Record<string, unknown>) => input.onNotification?.({ method, params });
    return { registration: { exit: Promise.resolve({ code: 0, signal: null }), close },
      stop: jest.fn(async () => { closeProcess(); }), notify: jest.fn(), request: jest.fn(async method => {
        if (method === 'initialize') return {};
        if (method === 'thread/start') return { model: 'gpt-6-luna', thread: { id: 'thread' } };
        const scope = { threadId: 'thread', turnId: 'turn' };
        releaseOutput = () => {
        notify('turn/started', { threadId: 'thread', turn: { id: 'turn' } });
        notify('item/started', { ...scope, ...echo, item: { id: 'echo', type: echo.type ?? 'userMessage',
          content: [{ type: 'text', text: 'INPUT_ECHO_SENTINEL' }] } });
        notify('item/completed', { ...scope, item: { id: 'assistant', type: 'agentMessage', text: 'READY' } });
        notify('thread/tokenUsage/updated', { ...scope, tokenUsage: { total: {
          inputTokens: 7, outputTokens: 2, cachedInputTokens: 0, reasoningOutputTokens: 0,
          ...(cacheWrite === absent ? {} : { cacheWriteInputTokens: cacheWrite }),
        } } });
        notify('turn/completed', { threadId: 'thread', turn: { id: 'turn', status: 'completed' } });
        };
        if (!deferred) releaseOutput();
        return { turn: { id: 'turn' } };
      }) } as unknown as Awaited<ReturnType<typeof startOwnedCodexAppServer>>;
  });
  const thread = createOwnedCodexThread({ host, env: { NODE_ENV: 'test' }, config: {}, executable: process.execPath,
    options: { model: 'gpt-6-luna', workingDirectory: process.cwd() }, maxTurns: 1 });
  const collect = async () => {
    const { events } = await thread.runStreamed('Reply READY', {});
    const frames = [];
    for await (const event of events) frames.push(event);
    return frames;
  };
  return { collect, outputCurrent, releaseOutput: () => releaseOutput!(), closeProcess };
}

beforeEach(() => start.mockReset());

it('keeps a silent live turn running while periodically checking its owner', async () => {
  jest.useFakeTimers();
  try {
    const pending = protocol(absent, {}, true);
    const result = pending.collect().then(frames => ({ frames }), error => ({ error }));
    await jest.advanceTimersByTimeAsync(60001);
    expect(pending.outputCurrent).toHaveBeenCalledTimes(2);
    pending.releaseOutput();
    expect(await result).toMatchObject({ frames: expect.arrayContaining([expect.objectContaining({ type: 'turn.completed' })]) });
  } finally { jest.useRealTimers(); }
});

it('still stops a silent turn when its owned process closes or its authority is revoked', async () => {
  jest.useFakeTimers();
  try {
    const closed = protocol(absent, {}, true);
    const closing = closed.collect().catch(error => error);
    await jest.advanceTimersByTimeAsync(1);
    closed.closeProcess();
    expect(await closing).toEqual(expect.objectContaining({ message: 'Native Codex Original protocol is held.' }));
    const revoked = protocol(absent, {}, true);
    revoked.outputCurrent.mockRejectedValueOnce(new Error('owner revoked'));
    const revoking = revoked.collect().catch(error => error);
    await jest.advanceTimersByTimeAsync(30001);
    expect(await revoking).toEqual(expect.objectContaining({ message: 'owner revoked' }));
  } finally { jest.useRealTimers(); }
});

it.each([absent, 3])('ignores the bound input echo and maps only output with valid usage (%s)', async cacheWrite => {
  const { collect, outputCurrent } = protocol(cacheWrite);
  const frames = await collect();
  expect(JSON.stringify(frames)).not.toContain('INPUT_ECHO_SENTINEL');
  expect(frames).toContainEqual(expect.objectContaining({ type: 'item.completed', item: expect.objectContaining({ text: 'READY' }) }));
  expect(frames.at(-1)).toMatchObject({ type: 'turn.completed', usage: {
    input_tokens: 7, output_tokens: 2, cache_write_input_tokens: cacheWrite === absent ? 0 : 3,
  } });
  expect(outputCurrent).toHaveBeenCalledTimes(5);
});

it.each([null, '0', -1, 0.5])('refuses an invalid explicitly supplied cache-write counter (%s)', async cacheWrite => {
  await expect(protocol(cacheWrite).collect()).rejects.toThrow('protocol is held');
});

it.each([{ threadId: 'foreign' }, { turnId: 'foreign' }])('checks the input echo ownership before ignoring it (%j)', async echo => {
  await expect(protocol(absent, echo).collect()).rejects.toThrow('protocol is held');
});

it.each(['commandExecution', 'collabAgentToolCall', 'contextCompaction', 'unknown'])('continues to hold unapproved native items (%s)', async type => {
  await expect(protocol(absent, { type }).collect()).rejects.toThrow('protocol is held');
});

it('rechecks current authority before ignoring the input echo', async () => {
  const { collect, outputCurrent } = protocol();
  outputCurrent.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('authority held'));
  await expect(collect()).rejects.toThrow('authority held');
});
