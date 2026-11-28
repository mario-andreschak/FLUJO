/**
 * Replays what the bundled Codex CLI really sent over app-server stdio
 * (recorded by scripts/record-codex-protocol.mjs against a local fixture
 * provider, no account) through FLUJO's ordinary conversation thread.
 * A Codex update must be re-recorded; the first test below enforces that.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createCodexAppServerThread, CODEX_CONTINUE_AFTER_DROP } from '@/backend/services/model/adapters/codexAppServerThread';
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

/** Ends a process in the recording: the recorder stopped Codex there. */
const KILLED: Frame[] = [{ direction: 'in', message: { method: '<killed>' } }];
const unavailable = () => new Error('Owned Codex app-server transport is unavailable.');
/** Fake app-server processes that answer FLUJO from the recording, in order:
 * one entry per process FLUJO starts. Recorded client ids are mapped to the
 * ids FLUJO actually sends, so FLUJO finds its own inputs after a reconnect. */
function replayProcesses(...processes: (string | Frame[])[][]) {
  const sent: Message[] = [];
  const ids = new Map<string, string>();
  const mapped = <T,>(value: T): T => {
    let text = JSON.stringify(value);
    for (const [recorded, actual] of ids) text = text.split(recorded).join(actual);
    return JSON.parse(text) as T;
  };
  const stops: jest.Mock[] = [];
  let started = 0;
  jest.mocked(startOwnedCodexAppServer).mockReset().mockImplementation(async input => {
    const frames = (processes[started++] ?? []).flatMap(name => typeof name === 'string' ? session(name) : name);
    let cursor = 0, ended = false, finish!: () => void;
    const close = new Promise<void>(resolve => { finish = () => { ended = true; resolve(); }; });
    const isRequest = (frame: Frame) => frame.direction === 'out' && frame.message.id !== undefined && frame.message.method;
    const deliver = ({ direction, message }: Frame) => {
      if (message.method === '<killed>') finish();
      else if (!ended && direction === 'in' && message.method && message.id === undefined) input.onNotification(mapped(message) as Parameters<typeof input.onNotification>[0]);
    };
    const flush = () => { for (; cursor < frames.length && !isRequest(frames[cursor]); cursor++) deliver(frames[cursor]); };
    const stop = jest.fn(async () => { flush(); finish(); });
    stops.push(stop);
    return {
      stop, notify: jest.fn(), registration: { close, requestStop: finish },
      request: async (method: string, params: Record<string, unknown>) => {
        if (ended) throw unavailable();
        sent.push({ method, params });
        flush();
        const frame = frames[cursor];
        if (!frame || frame.message.method !== method) throw new Error(`Unrecorded request ${method}`);
        const recordedId = frame.message.params?.clientUserMessageId;
        if (typeof recordedId === 'string' && typeof params?.clientUserMessageId === 'string') ids.set(recordedId, params.clientUserMessageId);
        const id = frame.message.id;
        let answer: Message | undefined;
        for (cursor++; cursor < frames.length && !isRequest(frames[cursor]); cursor++) {
          const { direction, message } = frames[cursor];
          if (direction === 'in' && message.id === id && !message.method) { answer = message; cursor++; break; }
          deliver(frames[cursor]);
          if (ended) throw unavailable();
        }
        setImmediate(flush);
        if (!answer) throw new Error(`No recorded answer to ${method}`);
        if (answer.error) throw new CodexAppServerRpcError(answer.error.code);
        return mapped(answer.result);
      },
    } as unknown as Awaited<ReturnType<typeof startOwnedCodexAppServer>>;
  });
  return { sent, stops, processes: () => started };
}
const replay = (...names: (string | Frame[])[]) => replayProcesses(names);
const make = (extra: Partial<Parameters<typeof createCodexAppServerThread>[0]> = {}) => createCodexAppServerThread({
  executable: 'bundled-codex', env: { NODE_ENV: 'test' }, config: { features: { shell_tool: false } }, options,
  developerInstructions: 'You are the FLUJO protocol recording fixture.', serviceTier: 'default', onUsage: jest.fn(), ...extra,
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
  const { sent, stops } = replay('start');
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
  expect(sent.find(message => message.method === 'thread/start')!.params).toMatchObject({ serviceTier: 'default' });
  expect(result('start', 'thread/start')).toMatchObject({ serviceTier: 'default' });
  for (const method of ['thread/start', 'turn/start']) {
    expect(Object.keys(sent.find(message => message.method === method)!.params!).sort())
      .toEqual(Object.keys(outbound('start', method).params!).sort());
  }
  await thread.close();
  expect(stops).toHaveLength(1);
  expect(stops[0]).toHaveBeenCalledTimes(1);
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
  // Resume asks for no inline history and reads the newest turns page instead.
  for (const method of ['thread/resume', 'thread/turns/list']) {
    expect(Object.keys(sent.find(message => message.method === method)!.params!).sort())
      .toEqual(Object.keys(outbound('resume', method).params!).sort());
  }
  expect(sent.find(message => message.method === 'thread/resume')!.params).toMatchObject({ excludeTurns: true });
  expect((result('resume', 'thread/resume').thread as { turns: unknown[] }).turns).toEqual([]);

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
  replay(handshake(), 'fork');
  const thread = make({ fork: { threadId: threadId.id, lastTurnId: firstTurnId, sessionId: threadId.sessionId } });
  const { events } = await thread.runStreamed('After the fork.', {});
  expect((await events.next()).value).toMatchObject({ type: 'thread.started' });
  const forked = result('fork', 'thread/fork').thread as { id: string; sessionId: string; turns: unknown[] };
  expect(thread.nativeSessionId()).toBe(forked.sessionId);
  // The boundary check reads the paged turn list, not deprecated inline history.
  expect(forked.turns).toEqual([]);
  // Only the fork itself was recorded; FLUJO goes on to its own turn.
  await expect(events.next()).rejects.toThrow('Unrecorded request turn/start');
  await thread.close();
});

const handshake = () => session('start').slice(0, session('start').findIndex(frame => frame.message.method === 'thread/start'));
const turnStarts = (sent: Message[]) => sent.filter(message => message.method === 'turn/start');
const finalText = (events: Awaited<ReturnType<typeof drain>>) => events.filter(event => event.type === 'item.completed')
  .map(event => (event as { item: { text?: string } }).item.text).at(-1);

it('passes FLUJO\'s output schema with the turn; the recording proves Codex hands it to the model', async () => {
  const { sent } = replay('structured');
  const schema = (outbound('structured', 'turn/start').params as { outputSchema: Record<string, unknown> }).outputSchema;
  const thread = make({ resumeThreadId: threadId.id, outputSchema: schema });
  const events = await drain(thread, 'Answer as JSON.');
  expect(turnStarts(sent)[0].params).toMatchObject({ outputSchema: schema });
  expect(JSON.parse(finalText(events)!)).toEqual({ answer: expect.stringMatching(/^Fixture reply \d+\.$/) });
  await thread.close();
});

it('after a connection lost before Codex saved the input, confirms it is missing, then sends it exactly once more', async () => {
  const { sent, stops, processes } = replayProcesses(['drop-before-record', KILLED], ['drop-before-record-reconnect']);
  const thread = make({ resumeThreadId: threadId.id });
  const events = await drain(thread, 'Input lost with the connection.');
  expect(processes()).toBe(2);
  // Same input, same client id: Codex was asked first and had no such turn.
  const starts = turnStarts(sent);
  expect(starts).toHaveLength(2);
  expect(starts[1].params).toEqual(starts[0].params);
  expect(sent.filter(message => message.method === 'thread/turns/list').at(-1)!.params).toMatchObject({ itemsView: 'full' });
  expect(events.at(-1)?.type).toBe('turn.completed');
  expect(finalText(events)).toMatch(/^Fixture reply \d+\.$/);
  expect(thread.usageUnknown()).toBe(false);
  expect(stops[0]).toHaveBeenCalled();
  await thread.close();
});

it('after a connection lost mid-answer, finds the saved turn by its client id and continues it without resending the input', async () => {
  const { sent, processes } = replayProcesses(['drop-mid-answer', KILLED], ['drop-mid-answer-reconnect']);
  const thread = make({ resumeThreadId: threadId.id });
  const events = await drain(thread, 'FLUJO_FIXTURE_HANG');
  expect(processes()).toBe(2);
  const starts = turnStarts(sent);
  expect(starts.map(message => (message.params!.input as { text: string }[])[0].text))
    .toEqual(['FLUJO_FIXTURE_HANG', CODEX_CONTINUE_AFTER_DROP]);
  expect(starts[1].params!.clientUserMessageId).not.toBe(starts[0].params!.clientUserMessageId);
  expect(events.at(-1)?.type).toBe('turn.completed');
  expect(finalText(events)).toMatch(/^Fixture reply \d+\.$/);
  await thread.close();
});

it('re-sends FLUJO\'s standing instructions and receipts when Codex compacts on its own, and Codex takes them', async () => {
  const { sent } = replay('compaction');
  const carry = '[FLUJO context kept after compaction]\nNever delete files.';
  const onCompactionCarryLost = jest.fn();
  const compactionCarry = jest.fn(() => carry);
  const thread = make({ compactionCarry, onCompactionCarryLost });
  expect((await drain(thread, 'Never delete files.')).at(-1)?.type).toBe('turn.completed');
  expect(compactionCarry).not.toHaveBeenCalled();
  const events = await drain(thread, 'Keep going.');
  expect(events.at(-1)?.type).toBe('turn.completed');
  expect(sent.find(message => message.method === 'turn/steer')!.params).toMatchObject({ input: [{ type: 'text', text: carry }] });
  expect(compactionCarry).toHaveBeenCalledTimes(1);
  // Codex recorded the carry as a user message in the same turn: it was kept.
  expect(onCompactionCarryLost).not.toHaveBeenCalled();
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
