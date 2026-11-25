/**
 * Replays what the bundled Codex CLI really sent over app-server stdio
 * (recorded by scripts/record-codex-protocol.mjs against a local fixture
 * provider, no account) through FLUJO's ordinary conversation thread.
 * A Codex update must be re-recorded; the first test below enforces that.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createCodexAppServerThread } from '@/backend/services/model/adapters/codexAppServerThread';
import { startOwnedCodexAppServer, CodexAppServerRpcError } from '@/backend/services/model/adapters/codexAppServerProcess';
import { MIN_ORDINARY_CODEX_CLI, codexServerVersion } from '@/backend/services/model/adapters/codexProtocol';
import { recordCodexRateLimitUpdate, normalizeCodexAllowance } from '@/backend/services/model/allowance/codex';
import { readAllowanceSnapshot, recordAllowanceSnapshot } from '@/backend/services/model/allowance/store';

jest.mock('@/backend/services/model/adapters/codexAppServerProcess', () => ({
  ...jest.requireActual('@/backend/services/model/adapters/codexAppServerProcess'),
  startOwnedCodexAppServer: jest.fn(), assertCodexOwnedProcessRegistration: jest.fn(),
}));
jest.mock('@/utils/workspace', () => ({ getWorkspaceDataDir: () => '/flujo-protocol-replay' }));

type Message = { id?: number | string; method?: string; params?: Record<string, unknown>; result?: Record<string, unknown>; error?: { code: number } };
type Frame = { direction: 'in' | 'out'; message: Message };
const recording = JSON.parse(readFileSync(path.join(__dirname, 'fixtures', 'codexAppServerProtocol.json'), 'utf8')) as {
  recordedWith: { cliVersion: string; sdkVersion: string }; sessions: { name: string; frames: Frame[] }[];
};
const session = (name: string) => recording.sessions.find(entry => entry.name === name)!.frames;
const outbound = (name: string, method: string) => session(name).find(frame => frame.direction === 'out' && frame.message.method === method)!.message;
const result = (name: string, method: string) => {
  const id = outbound(name, method).id;
  return session(name).find(frame => frame.direction === 'in' && frame.message.id === id && !frame.message.method)!.message.result!;
};
const threadId = result('start', 'thread/start').thread as { id: string; sessionId: string };
const firstTurnId = (result('start', 'turn/start').turn as { id: string }).id;
const options = { model: 'flujo-fixture-model', workingDirectory: '<WORKSPACE>', modelReasoningEffort: 'low' as const };

/** A fake app-server process that answers FLUJO from the recording, in order. */
function replay(...names: (string | Frame[])[]) {
  const frames = names.flatMap(name => typeof name === 'string' ? session(name) : name);
  const sent: Message[] = [];
  let cursor = 0, emit!: (message: Message) => void, closed!: () => void;
  const close = new Promise<void>(resolve => { closed = resolve; });
  const isRequest = (frame: Frame) => frame.direction === 'out' && frame.message.id !== undefined && frame.message.method;
  const flush = () => {
    for (; cursor < frames.length && !isRequest(frames[cursor]); cursor++) {
      const { direction, message } = frames[cursor];
      if (direction === 'in' && message.method && message.id === undefined) emit(message);
    }
  };
  const stop = jest.fn(async () => { flush(); closed(); });
  jest.mocked(startOwnedCodexAppServer).mockReset().mockImplementation(async input => {
    emit = message => input.onNotification(message as Parameters<typeof input.onNotification>[0]);
    return {
      stop, notify: jest.fn(), registration: { close },
      request: async (method: string, params: Record<string, unknown>) => {
        sent.push({ method, params });
        flush();
        const frame = frames[cursor];
        if (!frame || frame.message.method !== method) throw new Error(`Unrecorded request ${method}`);
        const id = frame.message.id;
        let answer: Message | undefined;
        for (cursor++; cursor < frames.length && !isRequest(frames[cursor]); cursor++) {
          const { direction, message } = frames[cursor];
          if (direction !== 'in') continue;
          if (message.id === id && !message.method) { answer = message; cursor++; break; }
          if (message.method && message.id === undefined) emit(message);
        }
        setImmediate(flush);
        if (!answer) throw new Error(`No recorded answer to ${method}`);
        if (answer.error) throw new CodexAppServerRpcError(answer.error.code);
        return answer.result;
      },
    } as unknown as Awaited<ReturnType<typeof startOwnedCodexAppServer>>;
  });
  return { sent, stop };
}
const make = (extra: Partial<Parameters<typeof createCodexAppServerThread>[0]> = {}) => createCodexAppServerThread({
  executable: 'bundled-codex', env: { NODE_ENV: 'test' }, config: { features: { shell_tool: false } }, options,
  developerInstructions: 'You are the FLUJO protocol recording fixture.', onUsage: jest.fn(), ...extra,
});
async function drain(thread: ReturnType<typeof make>, prompt: string) {
  const { events } = await thread.runStreamed(prompt, {});
  const collected = [];
  for await (const event of events) collected.push(event);
  return collected;
}

it('was recorded with the Codex CLI and SDK this checkout installs', () => {
  const installed = JSON.parse(readFileSync(path.join(process.cwd(), 'node_modules/@openai/codex/package.json'), 'utf8')).version;
  const declared = JSON.parse(readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')).dependencies['@openai/codex-sdk'];
  const current = `CLI ${installed}, SDK ${declared}`, recorded = `CLI ${recording.recordedWith.cliVersion}, SDK ${recording.recordedWith.sdkVersion}`;
  if (current !== recorded) {
    throw new Error(`Codex changed (${recorded} -> ${current}). Run "npm run record:codex-protocol", commit the new recording and fix what these tests then report.`);
  }
  expect(codexServerVersion(result('start', 'initialize'))).toBe(installed);
});

it('runs a new conversation on the recorded stream: true deltas, final answer, usage and plan limits', async () => {
  const { sent, stop } = replay('start');
  const onUsage = jest.fn(), onRateLimits = jest.fn();
  const thread = make({ onUsage, onRateLimits });
  const events = await drain(thread, 'Say the fixture reply.');
  // The user's own message is not echoed back; the two text deltas arrive together.
  expect(events.map(event => event.type)).toEqual(['thread.started', 'turn.started', 'item.started', 'item.updated', 'item.completed', 'turn.completed']);
  expect(events[3]).toMatchObject({ type: 'item.updated', item: { type: 'agent_message', text: 'Fixture reply 1.' } });
  expect(events[4]).toMatchObject({ type: 'item.completed', item: { type: 'agent_message', text: 'Fixture reply 1.' } });
  expect(onUsage).toHaveBeenCalledTimes(1);
  expect(onUsage).toHaveBeenCalledWith({ input_tokens: 120, output_tokens: 18, cached_input_tokens: 40, cache_write_input_tokens: 0, reasoning_output_tokens: 6 },
    expect.objectContaining({ promptTokens: 120, completionTokens: 18, contextWindow: 258400, contextWindowSource: 'runtime' }));
  expect(onRateLimits).toHaveBeenCalledWith(expect.objectContaining({ limitId: 'codex', primary: expect.objectContaining({ usedPercent: 42, windowDurationMins: 300 }) }));
  expect(thread.runtimeVersion()).toBe(recording.recordedWith.cliVersion);
  expect(thread.completedTurnId()).toBe(firstTurnId);
  // The recording exercised exactly the request shapes FLUJO sends, and the CLI accepted them.
  for (const method of ['thread/start', 'turn/start']) {
    expect(Object.keys(sent.find(message => message.method === method)!.params!).sort())
      .toEqual(Object.keys(outbound('start', method).params!).sort());
  }
  await thread.close();
  expect(stop).toHaveBeenCalledTimes(1);
});

it('resumes after a restart without counting the earlier turn, then explains a used-up plan in plain words', async () => {
  const { sent } = replay('resume', 'usage-limit');
  const onUsage = jest.fn(), onRateLimits = jest.fn();
  const thread = make({ resumeThreadId: threadId.id, onUsage, onRateLimits });
  const events = await drain(thread, 'Say the next fixture reply.');
  expect(events.at(-1)?.type).toBe('turn.completed');
  expect(events.find(event => event.type === 'item.completed')).toMatchObject({ item: { text: 'Fixture reply 2.' } });
  // The resumed turn's totals arrive again before turn/start; only the new turn reports.
  expect(onUsage).toHaveBeenCalledTimes(1);
  expect(onUsage.mock.calls[0][0]).toMatchObject({ input_tokens: 360, output_tokens: 36 });
  expect(Object.keys(sent.find(message => message.method === 'thread/resume')!.params!).sort())
    .toEqual(Object.keys(outbound('resume', 'thread/resume').params!).sort());

  const { events: limited } = await thread.runStreamed('FLUJO_FIXTURE_USAGE_LIMIT', {});
  const seen: string[] = [];
  await expect((async () => { for await (const event of limited) seen.push(event.type); })())
    .rejects.toThrow(/used up its Codex allowance for now\. Codex says: ".*try again at .*2029.*" FLUJO did not send the input again\./);
  expect(seen).toEqual(['thread.started', 'turn.started']);
  expect(onRateLimits.mock.calls.at(-1)![0]).toMatchObject({ primary: { usedPercent: 100 }, secondary: { usedPercent: 12 } });
  expect(sent.filter(message => message.method === 'turn/start')).toHaveLength(2);
});

it('accepts the recorded fork of a completed turn with lineage, policy and workspace intact', async () => {
  // The fork ran in the resumed process; a fresh FLUJO process first initializes.
  const handshake = session('start').slice(0, session('start').findIndex(frame => frame.message.method === 'thread/start'));
  replay(handshake, 'fork');
  const thread = make({ fork: { threadId: threadId.id, lastTurnId: firstTurnId, sessionId: threadId.sessionId } });
  const { events } = await thread.runStreamed('After the fork.', {});
  expect((await events.next()).value).toMatchObject({ type: 'thread.started' });
  const forked = result('fork', 'thread/fork').thread as { id: string; sessionId: string };
  expect(thread.nativeSessionId()).toBe(forked.sessionId);
  // Only the fork itself was recorded; FLUJO goes on to its own turn.
  await expect(events.next()).rejects.toThrow('Unrecorded request turn/start');
  await thread.close();
});

it('moves the allowance bar from the plan limits Codex sends during a run', () => {
  const key = 'replay-account';
  const limits = (name: string) => session(name).filter(frame => frame.message.method === 'account/rateLimits/updated')
    .map(frame => frame.message.params!.rateLimits);
  // A full reading names the bucket; the update during the run does not.
  recordAllowanceSnapshot(key, normalizeCodexAllowance({ rateLimitsByLimitId: { codex: { limitId: 'codex', limitName: 'Codex plan',
    primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: 1893456000 } } } }, '2026-11-25T10:00:00.000Z'));
  recordCodexRateLimitUpdate(key, limits('start')[0], '2026-11-25T10:01:00.000Z');
  expect(readAllowanceSnapshot(key, Date.parse('2026-11-25T10:02:00.000Z'))?.windows).toEqual([
    { id: 'codex:primary', label: 'Codex plan · 300 minutes', remainingPercent: 58, resetAt: '2030-01-01T00:00:00.000Z' },
    { id: 'codex:secondary', label: 'codex · 10080 minutes', remainingPercent: 88, resetAt: '2030-01-02T00:00:00.000Z' },
  ]);
  recordCodexRateLimitUpdate(key, limits('usage-limit')[0], '2026-11-25T10:03:00.000Z');
  expect(readAllowanceSnapshot(key, Date.parse('2026-11-25T10:04:00.000Z'))?.windows[0]).toMatchObject({ id: 'codex:primary', remainingPercent: 0 });
  recordCodexRateLimitUpdate(key, 'not a bucket');
  recordCodexRateLimitUpdate(key, { limitId: 'codex', primary: null, secondary: null });
  expect(readAllowanceSnapshot(key, Date.parse('2026-11-25T10:04:00.000Z'))?.windows[0]).toMatchObject({ remainingPercent: 0 });
});

it('names the oldest supported Codex consistently with the recorded program', () => {
  const [major, minor, patch] = recording.recordedWith.cliVersion.split('.').map(Number);
  const [minMajor, minMinor, minPatch] = MIN_ORDINARY_CODEX_CLI.split('.').map(Number);
  expect(major * 1e6 + minor * 1e3 + patch).toBeGreaterThanOrEqual(minMajor * 1e6 + minMinor * 1e3 + minPatch);
});
