/**
 * Lost connections, steering and compaction carry on the ordinary Codex
 * thread, against fake app-server processes FLUJO can start one after another.
 * The recorded real-Codex cases live in codexAppServerProtocolReplay.test.ts.
 */
import { createCodexAppServerThread, CODEX_CONTINUE_AFTER_DROP } from '@/backend/services/model/adapters/codexAppServerThread';
import { startOwnedCodexAppServer, CodexAppServerRpcError } from '@/backend/services/model/adapters/codexAppServerProcess';

jest.mock('@/backend/services/model/adapters/codexAppServerProcess', () => ({
  ...jest.requireActual('@/backend/services/model/adapters/codexAppServerProcess'),
  startOwnedCodexAppServer: jest.fn(), assertCodexOwnedProcessRegistration: jest.fn(),
}));

type Handler = (method: string, params: Record<string, unknown>, process: FakeProcess) => unknown;
type FakeProcess = { emit(method: string, params: Record<string, unknown>): void; drop(): void; sent: [string, Record<string, unknown>][] };
const unavailable = () => new Error('Owned Codex app-server transport is unavailable.');
const usage = { total: { inputTokens: 10, outputTokens: 2 }, last: { inputTokens: 10, outputTokens: 2 } };
let processes: FakeProcess[];
/** One handler per process FLUJO starts; a handler may drop its process. */
function fakeProcesses(...handlers: Handler[]) {
  processes = [];
  jest.mocked(startOwnedCodexAppServer).mockReset().mockImplementation(async input => {
    const handler = handlers[processes.length];
    if (!handler) throw new Error('FLUJO started an unexpected Codex process.');
    let ended = false, finish!: () => void;
    const close = new Promise<void>(resolve => { finish = () => { ended = true; resolve(); }; });
    const fake: FakeProcess = {
      sent: [],
      emit: (method, params) => { if (!ended) input.onNotification({ method, params: { threadId: 'thread-1', ...params } }); },
      drop: finish,
    };
    processes.push(fake);
    return {
      stop: jest.fn(async () => finish()), notify: jest.fn(), registration: { close, requestStop: finish },
      request: async (method: string, params: Record<string, unknown>) => {
        if (ended) throw unavailable();
        fake.sent.push([method, params]);
        // Like the real transport, a lost connection fails every pending request.
        const answer = await Promise.race([handler(method, params, fake), close.then(() => { throw unavailable(); })]);
        if (ended) throw unavailable();
        return answer;
      },
    } as unknown as Awaited<ReturnType<typeof startOwnedCodexAppServer>>;
  });
}
/** Answers every handshake and resume; `turns` is the newest-turns page. */
const base = (turns: unknown[] = []): Handler => method => {
  if (method === 'initialize') return { userAgent: 'flujo_conversation/0.166.0 (test)' };
  if (method === 'thread/resume' || method === 'thread/start') return { thread: { id: 'thread-1', turns: [] }, model: 'model' };
  if (method === 'thread/turns/list') return { data: [...turns].reverse(), nextCursor: null };
  return undefined;
};
const make = (extra: Partial<Parameters<typeof createCodexAppServerThread>[0]> = {}) => createCodexAppServerThread({
  executable: 'owned-cli', env: { NODE_ENV: 'test' }, config: {}, options: { model: 'model', workingDirectory: '/managed' },
  developerInstructions: 'Trusted', resumeThreadId: 'thread-1', serviceTier: 'default', onUsage: jest.fn(), ...extra,
});
async function drain(thread: ReturnType<typeof make>, prompt = 'input') {
  const { events } = await thread.runStreamed(prompt, {});
  const seen: { type: string; item?: { text?: string } }[] = [];
  for await (const event of events) seen.push(event as typeof seen[number]);
  return seen;
}
const completeTurn = (fake: FakeProcess, turnId: string, text: string) => setImmediate(() => {
  fake.emit('item/completed', { turnId, item: { id: `msg-${turnId}`, type: 'agentMessage', text } });
  fake.emit('turn/completed', { turn: { id: turnId, status: 'completed' } });
});
const turnStarts = () => processes.flatMap(process => process.sent.filter(([method]) => method === 'turn/start').map(([, params]) => params));

it('sends the speed tier with resume and a client id with every input', async () => {
  fakeProcesses((method, params, fake) => {
    if (method === 'turn/start') { completeTurn(fake, 'turn-1', 'done'); return { turn: { id: 'turn-1' } }; }
    return base()(method, params, fake);
  });
  await drain(make({ serviceTier: 'priority' }));
  expect(processes[0].sent.find(([method]) => method === 'thread/resume')![1]).toMatchObject({ serviceTier: 'priority', excludeTurns: true });
  expect(turnStarts()[0].clientUserMessageId).toEqual(expect.stringMatching(/^[0-9a-f-]{36}$/));
});

it('shows the answer of a turn Codex finished before the drop, sends nothing again and leaves its usage unknown', async () => {
  let clientId = '';
  fakeProcesses(
    (method, params, fake) => {
      if (method !== 'turn/start') return base()(method, params, fake);
      clientId = params.clientUserMessageId as string;
      setImmediate(() => fake.drop());
      return new Promise(() => {});
    },
    (method, params, fake) => base([{ id: 'turn-1', status: 'completed', items: [
      { type: 'userMessage', id: 'u1', clientId },
      { type: 'agentMessage', id: 'msg-1', text: 'Finished before the drop.', phase: 'final_answer' },
    ] }])(method, params, fake),
  );
  const thread = make();
  const events = await drain(thread);
  expect(turnStarts()).toHaveLength(1);
  expect(events.filter(event => event.type === 'item.completed').map(event => event.item?.text)).toEqual(['Finished before the drop.']);
  expect(events.at(-1)?.type).toBe('turn.completed');
  expect(thread.completedTurnId()).toBe('turn-1');
  expect(thread.usageUnknown()).toBe(true);
  await thread.close();
});

it('reports a turn that failed before the drop instead of continuing it', async () => {
  let clientId = '';
  fakeProcesses(
    (method, params, fake) => {
      if (method !== 'turn/start') return base()(method, params, fake);
      clientId = params.clientUserMessageId as string;
      setImmediate(() => fake.drop());
      return { turn: { id: 'turn-1' } };
    },
    (method, params, fake) => base([{ id: 'turn-1', status: 'failed', error: { message: 'limit', codexErrorInfo: 'usageLimitExceeded' },
      items: [{ type: 'userMessage', id: 'u1', clientId }] }])(method, params, fake),
  );
  const events = await drain(make());
  expect(turnStarts()).toHaveLength(1);
  expect(events.at(-1)).toMatchObject({ type: 'turn.failed', error: { message: expect.stringContaining('used up its Codex allowance') } });
});

it('stops after repeated drops without confirming, and never sends the input blindly', async () => {
  const dropping: Handler = (method, params, fake) => {
    if (method === 'turn/start') { setImmediate(() => fake.drop()); return new Promise(() => {}); }
    return base()(method, params, fake);
  };
  fakeProcesses(dropping, dropping, dropping);
  await expect(drain(make())).rejects.toThrow('could not confirm what Codex received. FLUJO did not send the input again.');
  // One input, then one resend per confirmed absence; the third drop is not followed by another send.
  expect(turnStarts()).toHaveLength(3);
  expect(new Set(turnStarts().map(params => params.clientUserMessageId)).size).toBe(1);
});

it('continues an interrupted turn on the new connection without the original input', async () => {
  let clientId = '';
  fakeProcesses(
    (method, params, fake) => {
      if (method !== 'turn/start') return base()(method, params, fake);
      clientId = params.clientUserMessageId as string;
      setImmediate(() => fake.drop());
      return { turn: { id: 'turn-1' } };
    },
    (method, params, fake) => {
      if (method === 'turn/start') { completeTurn(fake, 'turn-2', 'Continued.'); return { turn: { id: 'turn-2' } }; }
      return base([{ id: 'turn-1', status: 'interrupted', items: [{ type: 'userMessage', id: 'u1', clientId }] }])(method, params, fake);
    },
  );
  const events = await drain(make(), 'original input');
  expect(turnStarts().map(params => (params.input as { text: string }[])[0].text)).toEqual(['original input', CODEX_CONTINUE_AFTER_DROP]);
  expect(events.filter(event => event.type === 'item.completed').map(event => event.item?.text)).toEqual(['Continued.']);
});

it.each([[true, true], [false, false]])('settles a steer lost with the connection by looking it up (Codex has it: %s)', async (recorded, expected) => {
  let steerId = '', clientId = '';
  let steerSent!: () => void;
  const steering = new Promise<void>(resolve => { steerSent = resolve; });
  fakeProcesses(
    (method, params, fake) => {
      if (method === 'turn/start') { clientId = params.clientUserMessageId as string; return { turn: { id: 'turn-1' } }; }
      if (method === 'turn/steer') { steerId = params.clientUserMessageId as string; steerSent(); setImmediate(() => fake.drop()); return new Promise(() => {}); }
      return base()(method, params, fake);
    },
    (method, params, fake) => base([{ id: 'turn-1', status: 'completed', items: [
      { type: 'userMessage', id: 'u1', clientId },
      ...(recorded ? [{ type: 'userMessage', id: 'u2', clientId: steerId }] : []),
      { type: 'agentMessage', id: 'msg-1', text: 'Answered.' },
    ] }])(method, params, fake),
  );
  const thread = make();
  const { events } = await thread.runStreamed('input', {});
  await events.next(); await events.next();
  const draining = (async () => { for await (const _event of events) { /* drain */ } })();
  await new Promise(resolve => setImmediate(resolve));
  const steered = thread.steer('also this');
  await steering;
  expect(await steered).toBe(expected);
  await draining;
  expect(turnStarts()).toHaveLength(1);
  await thread.close();
});

it.each(['refused', 'never used'])('marks the thread unusable when Codex compacts and the carry is %s', async outcome => {
  const onCompactionCarryLost = jest.fn();
  fakeProcesses((method, params, fake) => {
    if (method === 'turn/start') {
      setImmediate(() => fake.emit('item/started', { turnId: 'turn-1', item: { id: 'c1', type: 'contextCompaction' } }));
      return { turn: { id: 'turn-1' } };
    }
    if (method === 'turn/steer') {
      setImmediate(() => completeTurn(fake, 'turn-1', 'done'));
      if (outcome === 'refused') throw new CodexAppServerRpcError(-32600);
      return { turnId: 'turn-1' };
    }
    return base()(method, params, fake);
  });
  const events = await drain(make({ compactionCarry: () => 'carry', onCompactionCarryLost }));
  expect(events.at(-1)?.type).toBe('turn.completed');
  expect(onCompactionCarryLost).toHaveBeenCalledTimes(1);
});

it('starts once more when the first start-up connection is lost before anything was sent', async () => {
  fakeProcesses(
    (method, params, fake) => {
      if (method === 'thread/resume') { setImmediate(() => fake.drop()); return new Promise(() => {}); }
      return base()(method, params, fake);
    },
    (method, params, fake) => {
      if (method === 'turn/start') { completeTurn(fake, 'turn-1', 'done'); return { turn: { id: 'turn-1' } }; }
      return base()(method, params, fake);
    },
  );
  const events = await drain(make());
  expect(processes).toHaveLength(2);
  expect(events.at(-1)?.type).toBe('turn.completed');
});

it('reads inline history from a Codex that ignores excludeTurns, and resumes when an older Codex has no turn list', async () => {
  fakeProcesses((method, params, fake) => {
    if (method === 'thread/resume') return { thread: { id: 'thread-1', turns: [{ id: 'old-turn', status: 'completed', items: [] }] }, model: 'model' };
    if (method === 'turn/start') {
      setImmediate(() => fake.emit('thread/tokenUsage/updated', { turnId: 'old-turn', tokenUsage: usage }));
      completeTurn(fake, 'turn-1', 'done');
      return { turn: { id: 'turn-1' } };
    }
    return base()(method, params, fake);
  });
  const onUsage = jest.fn();
  await drain(make({ onUsage }));
  expect(processes[0].sent.some(([method]) => method === 'thread/turns/list')).toBe(false);
  // The replayed totals of the earlier turn are not counted again.
  expect(onUsage).not.toHaveBeenCalled();

  fakeProcesses((method, params, fake) => {
    if (method === 'thread/turns/list') throw new CodexAppServerRpcError(-32601);
    if (method === 'turn/start') { completeTurn(fake, 'turn-1', 'done'); return { turn: { id: 'turn-1' } }; }
    return base()(method, params, fake);
  });
  expect((await drain(make())).at(-1)?.type).toBe('turn.completed');
});
