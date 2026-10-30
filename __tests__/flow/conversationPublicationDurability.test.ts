import { constants, promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { appendFromBus, appendRawForState, replaceConversationTranscript, flushConversationLog,
  _setConversationLogDirForTests, latestSequence, readConversationLogForReplay, readConversationLog } from '@/backend/execution/flow/conversationLog';
import { persistConversationState } from '@/backend/execution/flow/persistConversationState';
import { FlowExecutor } from '@/backend/execution/flow/FlowExecutor';
import { getConversationPublicationDiagnostics, publishConversation } from '@/backend/execution/flow/conversationPublication';
import * as publication from '@/backend/execution/flow/conversationPublication';
import type { SharedState, SubflowInvocation } from '@/backend/execution/flow/types';
import type { FlujoChatMessage } from '@/shared/types/chat';
import type { StorageKey } from '@/shared/types/storage';
import type { ExecutionEvent } from '@/shared/types/execution/events';
import { fenceSubflowFold } from '@/backend/execution/flow/subflowFoldFence';
import { saveItem } from '@/utils/storage/backend';
import { persistSubflowParent } from '@/backend/execution/flow/subflowRecovery';
import { persistConversationSummary } from '@/backend/execution/flow/conversationSummaryStore';
import { executionEventBus } from '@/backend/execution/flow/engine/ExecutionEventBus';
import { runWithWorkspace } from '@/utils/workspace';

jest.mock('@/backend/execution/flow/FlowExecutor', () => ({ FlowExecutor: { conversationStates: jest.requireActual('@/backend/execution/flow/conversationStateRegistry').getConversationStates() } }));
jest.mock('@/backend/execution/flow/conversationSummaryStore', () => ({ persistConversationSummary: jest.fn(async () => {}) }));
jest.mock('@/backend/execution/flow/conversationPublication', () => ({ __esModule: true, ...jest.requireActual('@/backend/execution/flow/conversationPublication') }));
jest.mock('@/backend/services/workspace/workspaceMutationGate', () => ({
  withWorkspaceMutation: async (task: () => Promise<unknown>) => task(), assertWorkspaceMutationOwned: async () => {},
}));
jest.mock('@/backend/services/security/bundledFlujoWorkload', () => ({ assertBundledFlujoWorkloadEffectCurrent: async () => {} }));
jest.mock('@/utils/encryption/credentialMigrationState', () => ({ assertCredentialStoreReady: async () => {} }));
jest.mock('@/utils/workspace', () => ({ ...jest.requireActual('@/utils/workspace'), getWorkspaceDataDir: () => directory }));

let directory: string, previous: string;
let sequence = 0;
function gate() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }
const message = (id: string, content = id): FlujoChatMessage => ({ id, role: 'user', content, timestamp: 1 });
const state = (): SharedState => ({ conversationId: `publication-${sequence++}`, messages: [message('old')], flowId: 'flow',
  title: 'test', createdAt: 1, updatedAt: 1, trackingInfo: { executionId: 'x', startTime: 1, nodeExecutionTracker: [] } } as SharedState);
const logPath = (value: SharedState) => path.join(directory, `${value.conversationId}.jsonl`);
const snapshotPath = (value: SharedState) => path.join(directory, 'db', 'conversations', `${value.conversationId}.json`);
const events = async (value: SharedState): Promise<ExecutionEvent[]> => (await fs.readFile(logPath(value), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
beforeAll(async () => { directory = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-publication-')); previous = _setConversationLogDirForTests(directory); });
afterEach(() => {
  jest.restoreAllMocks(); FlowExecutor.conversationStates.clear();
  jest.mocked(persistConversationSummary).mockReset().mockResolvedValue(undefined);
  expect(getConversationPublicationDiagnostics()).toMatchObject({ writers: 0, allocationBytes: 0, retainedBytes: 0, chains: 0 });
});
afterAll(async () => { _setConversationLogDirForTests(previous); await fs.rm(directory, { recursive: true, force: true }); });

it('captures bus messages before authority waits and keeps submission sequence order', async () => {
  const value = state(), blocked = gate();
  value.executionAuthority = { assertCurrent: async () => blocked.promise } as SharedState['executionAuthority'];
  FlowExecutor.conversationStates.set(value.conversationId!, value);
  const first = { type: 'message', conversationId: value.conversationId!, seq: 0, timestamp: 1, message: message('first', 'before') } as ExecutionEvent;
  appendFromBus(first);
  (first as { message: FlujoChatMessage }).message.content = 'changed';
  appendFromBus({ type: 'message', conversationId: value.conversationId!, seq: 1, timestamp: 2, message: message('second') } as ExecutionEvent);
  blocked.release(); await flushConversationLog(value.conversationId!);
  expect((await events(value)).map(event => [event.seq, (event as { message: FlujoChatMessage }).message.content])).toEqual([[0, 'before'], [1, 'second']]);
});

it('captures the complete snapshot before authority waits', async () => {
  const value = state(), blocked = gate();
  value.executionAuthority = { assertCurrent: async () => blocked.promise } as SharedState['executionAuthority'];
  const saving = persistConversationState(`conversations/${value.conversationId}` as StorageKey, value);
  value.messages[0].content = 'changed while waiting';
  blocked.release(); await saving;
  expect(JSON.parse(await fs.readFile(snapshotPath(value), 'utf8')).messages[0].content).toBe('old');
});

it('coalesces four large live-parent checkpoints and acknowledges every lane outcome only after the trailing snapshot', async () => {
  const value = state(), entered = gate(), blocked = gate();
  value.status = 'running';
  value.messages = [message('parent', 'p'.repeat(2_000_000))];
  const laneInput = 'l'.repeat(5_600_000);
  const invocation: SubflowInvocation = { version: 1, id: 'visit', parentConversationId: value.conversationId!, parentNodeId: 'parent',
    status: 'running', depth: 0, showSteps: false, concurrencyLimit: 4, joinSeparator: '\n', errorStrategy: 'collect-all',
    createdAt: 1, updatedAt: 1, lanes: Array.from({ length: 8 }, (_, index) => ({ id: `lane-${index}`, index, count: 8,
      subflowId: 'child', conversationId: `child-${index}`, status: 'pending', attempt: 0, updatedAt: 1, input: { prompt: laneInput } })) };
  value.subflowInvocations = { visit: invocation };
  value.executionAuthority = { signal: new AbortController().signal, assertCurrent: async () => { entered.release(); await blocked.promise; } };
  const checkpoints: Array<Array<{ status: string; outputText?: string }>> = [];
  jest.mocked(persistConversationSummary).mockImplementation(async (_id, snapshot) => {
    checkpoints.push(snapshot.subflowInvocations!.visit.lanes.map(lane => ({ status: lane.status, outputText: lane.outputText })));
  });
  const before = getConversationPublicationDiagnostics();
  invocation.lanes[0].status = 'running';
  const pending = [persistSubflowParent(value)];
  await entered.promise;
  for (let index = 1; index < 4; index++) { invocation.lanes[index].status = 'running'; pending.push(persistSubflowParent(value)); }
  expect(getConversationPublicationDiagnostics().retainedBytes).toBeGreaterThan(93_600_000);
  expect(getConversationPublicationDiagnostics().retainedBytes).toBeLessThan(128 * 1024 * 1024);
  let acknowledged = 0;
  for (const promise of pending) void promise.then(() => { acknowledged++; });
  await new Promise(resolve => setImmediate(resolve)); expect(acknowledged).toBe(0);
  blocked.release(); await Promise.all(pending);
  expect(checkpoints).toHaveLength(2);
  expect(checkpoints[0].map(lane => lane.status)).toEqual(['running', ...Array(7).fill('pending')]);
  expect(checkpoints[1].map(lane => lane.status)).toEqual([...Array(4).fill('running'), ...Array(4).fill('pending')]);
  await Promise.all(invocation.lanes.slice(0, 4).map((lane, index) => {
    lane.status = 'completed'; lane.outputText = `owned-result-${index}`;
    return persistSubflowParent(value);
  }));
  expect(checkpoints.at(-1)!.slice(0, 4)).toEqual(Array.from({ length: 4 }, (_, index) => ({ status: 'completed', outputText: `owned-result-${index}` })));
  expect((await fs.stat(snapshotPath(value))).size).toBeGreaterThan(46_800_000);
  expect(FlowExecutor.conversationStates.get(value.conversationId!)).toBe(value);
  expect(typeof value.messages[0].content).toBe('string');
  expect(value.messages[0].content!.length).toBe(2_000_000);
  expect(invocation.lanes.every(lane => lane.input && 'prompt' in lane.input && lane.input.prompt === laneInput)).toBe(true);
  expect(getConversationPublicationDiagnostics()).toMatchObject({ owners: before.owners, fences: before.fences, writers: 0, retainedBytes: 0, allocationBytes: 0 });
}, 30_000);

it('writes a new cohort for progress arriving after the last dirty check but before publisher settlement', async () => {
  const value = state(), finishedLoop = gate(), blockedSettlement = gate();
  value.status = 'running';
  const realPublish = jest.requireActual<typeof publication>('@/backend/execution/flow/conversationPublication').publishConversation;
  let pauseFirstCohort = true;
  const pauseAfterTask: typeof publishConversation = (key, payload, task, omitRootKeys, prepare) => realPublish(key, payload, async owned => {
    const result = await task(owned);
    // Pause only the first outer cohort after its loop returns. The actual
    // publisher, snapshot captures and filesystem writes remain in use.
    if (payload === null && pauseFirstCohort) {
      pauseFirstCohort = false;
      finishedLoop.release();
      await blockedSettlement.promise;
    }
    return result;
  }, omitRootKeys, prepare);
  jest.spyOn(publication, 'publishConversation').mockImplementation(pauseAfterTask);
  const before = getConversationPublicationDiagnostics();
  const first = persistSubflowParent(value);
  let late: Promise<void> | undefined, acknowledged = false;
  try {
    await finishedLoop.promise;
    expect(JSON.parse(await fs.readFile(snapshotPath(value), 'utf8')).messages).toHaveLength(1);
    value.messages.push(message('late-lane-outcome'));
    late = persistSubflowParent(value);
    void late.then(() => { acknowledged = true; });
    await new Promise(resolve => setImmediate(resolve));
    expect(acknowledged).toBe(false);
  } finally {
    blockedSettlement.release();
    await Promise.all([first, late]);
  }
  expect(JSON.parse(await fs.readFile(snapshotPath(value), 'utf8')).messages.map((item: FlujoChatMessage) => item.id))
    .toEqual(['old', 'late-lane-outcome']);
  expect(persistConversationSummary).toHaveBeenCalledTimes(2);
  expect(getConversationPublicationDiagnostics()).toMatchObject({ owners: before.owners, fences: before.fences, writers: 0, retainedBytes: 0, allocationBytes: 0 });
});

it('releases a coalesced parent cohort on definite storage failure and retries its latest owned progress', async () => {
  const value = state(), entered = gate(), blocked = gate(), primary = Object.assign(new Error('checkpoint disk full'), { code: 'ENOSPC' });
  value.status = 'running';
  value.executionAuthority = { signal: new AbortController().signal, assertCurrent: async () => { entered.release(); await blocked.promise; } };
  const before = getConversationPublicationDiagnostics();
  // A persistent failure outlasts the transient retries.
  const rename = jest.spyOn(fs, 'rename').mockRejectedValue(primary);
  const first = persistSubflowParent(value); await entered.promise;
  value.messages.push(message('later-outcome'));
  const second = persistSubflowParent(value);
  const results = Promise.allSettled([first, second]); blocked.release();
  const settled = await results;
  expect(settled).toEqual([expect.objectContaining({ status: 'rejected', reason: expect.objectContaining({ code: 'CONVERSATION_PUBLICATION_IO', cause: primary }) }),
    expect.objectContaining({ status: 'rejected', reason: expect.objectContaining({ code: 'CONVERSATION_PUBLICATION_IO', cause: primary }) })]);
  expect(getConversationPublicationDiagnostics()).toMatchObject({ owners: before.owners, fences: before.fences, allocationBytes: 0 });
  rename.mockRestore();
  jest.mocked(persistConversationSummary).mockImplementation(async () => {});
  await persistSubflowParent(value);
  expect(JSON.parse(await fs.readFile(snapshotPath(value), 'utf8')).messages.map((item: FlujoChatMessage) => item.id)).toEqual(['old', 'later-outcome']);
});

it('rejects a coalesced parent from another workspace before publishing cache or timestamp changes', async () => {
  const value = state(), entered = gate(), blocked = gate();
  value.status = 'running';
  value.executionAuthority = { signal: new AbortController().signal, assertCurrent: async () => { entered.release(); await blocked.promise; } };
  const first = persistSubflowParent(value); await entered.promise;
  const before = value.updatedAt;
  const set = jest.spyOn(FlowExecutor.conversationStates, 'set');
  const open = jest.spyOn(fs, 'open');
  try {
    await runWithWorkspace('different-checkpoint-workspace', async () => {
      await expect(persistSubflowParent(value)).rejects.toMatchObject({ code: 'flow_execution_authority_lost' });
    });
    expect(set).not.toHaveBeenCalled(); expect(open).not.toHaveBeenCalled();
    expect(value.updatedAt).toBe(before);
  } finally { blocked.release(); await first; }
});

it('accepts a bus marker behind any number of queued publications and persists it once they drain', async () => {
  const value = state(), blocked = gate(), before = getConversationPublicationDiagnostics();
  FlowExecutor.conversationStates.set(value.conversationId!, value);
  const pending = Array.from({ length: 200 }, () => publishConversation('queued-bus-capacity', null, async () => blocked.promise));
  const listener = jest.fn(), unsubscribe = executionEventBus.subscribe(value.conversationId!, listener);
  try {
    expect(() => executionEventBus.emitterFor(value.conversationId!)({ type: 'model:dispatch', turn: {} } as never)).not.toThrow();
    expect(listener).toHaveBeenCalledTimes(1);
  } finally { unsubscribe(); blocked.release(); await Promise.all(pending); }
  await flushConversationLog(value.conversationId!);
  expect((await events(value)).map(event => event.type)).toEqual(['model:dispatch']);
  expect(getConversationPublicationDiagnostics()).toMatchObject({ owners: before.owners, fences: before.fences, writers: 0, retainedBytes: 0, allocationBytes: 0 });
});

it('refuses a replacement capture before reserving sequence space or changing durable history', async () => {
  const value = state(); await appendRawForState(value, [{ type: 'message', message: value.messages[0] }]);
  const before = await fs.readFile(logPath(value), 'utf8');
  const highWater = await latestSequence(value.conversationId!);
  await expect(replaceConversationTranscript(value, new Array(262_145) as FlujoChatMessage[]))
    .rejects.toMatchObject({ code: 'CONVERSATION_PUBLICATION_DATA' });
  expect(await latestSequence(value.conversationId!)).toBe(highWater);
  expect(await fs.readFile(logPath(value), 'utf8')).toBe(before);
  expect(value.messages[0].id).toBe('old');
});


it('preserves exact authority errors raised inside the rewrite intent and atomic snapshot writer', async () => {
  const value = state(); await appendRawForState(value, [{ type: 'message', message: value.messages[0] }]);
  const original = await fs.readFile(logPath(value), 'utf8');
  const failure = new Error('current Activity was lost');
  value.executionAuthority = { signal: new AbortController().signal, assertCurrent: async () => { throw failure; } };
  await expect(replaceConversationTranscript(value, [message('replacement')])).rejects.toBe(failure);
  expect(await fs.readFile(logPath(value), 'utf8')).toBe(original);
  let checks = 0;
  await expect(saveItem(`conversations/${value.conversationId}` as StorageKey, { messages: value.messages }, async () => {
    if (++checks === 3) throw failure; // After the temp descriptor has opened.
  })).rejects.toBe(failure);
  expect(value.messages[0].id).toBe('old');
});

it('streams a 2M parent plus eight 5.6M lanes through replacement and its durable snapshot within unchanged bounds', async () => {
  const value = state(); await appendRawForState(value, [{ type: 'message', message: value.messages[0] }]);
  // Logical JSON is 46.8M characters; immutable aliases keep source allocation small.
  const lane = 'l'.repeat(5_600_000);
  const replacement = [message('parent', 'p'.repeat(2_000_000)),
    ...Array.from({ length: 8 }, (_, index) => message(`lane-${index}`, lane))];
  const open = fs.open.bind(fs);
  let peakRetained = 0;
  jest.spyOn(fs, 'open').mockImplementation((...args) => {
    peakRetained = Math.max(peakRetained, getConversationPublicationDiagnostics().retainedBytes);
    return open(...args);
  });
  await replaceConversationTranscript(value, replacement);
  expect(peakRetained).toBeGreaterThan(187_200_000);
  expect(peakRetained).toBeLessThan(256 * 1024 * 1024);
  for (const filename of [logPath(value), snapshotPath(value)]) {
    const handle = await fs.open(filename, 'r');
    try {
      const size = (await handle.stat()).size;
      expect(size).toBeGreaterThan(46_800_000);
      expect(size).toBeLessThan(46_810_000);
      const tail = Buffer.alloc(1024);
      await handle.read(tail, 0, tail.length, size - tail.length);
      expect(tail.toString()).toContain('timestamp');
    } finally { await handle.close(); }
  }
  expect(value.messages).toHaveLength(9);
  expect(value.messages[8].content).toBe(lane);
  expect(Object.isFrozen(value.messages)).toBe(false);
}, 30_000);

it('serializes replacement, snapshot, and later appends with monotonic SSE cursors', async () => {
  const value = state(); await appendRawForState(value, [{ type: 'message', message: value.messages[0] }]);
  const blocked = gate(), entered = gate(), rename = fs.rename.bind(fs);
  jest.spyOn(fs, 'rename').mockImplementation(async (from, to) => { if (String(to) === snapshotPath(value)) { entered.release(); await blocked.promise; } await rename(from, to); });
  const replacing = replaceConversationTranscript(value, [message('replacement', 'x'.repeat(150_000))]);
  await entered.promise;
  const appending = appendRawForState(value, [{ type: 'message', message: message('later') }]);
  blocked.release(); await Promise.all([replacing, appending]);
  const records = await events(value), seqs = records.map(event => event.seq);
  expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
  expect(records.map(event => event.type)).toEqual(['message', 'message:removed', 'message', 'message']);
  const resumed = await readConversationLogForReplay(value.conversationId!, seqs[2] + 1);
  expect(resumed.events?.map(event => event.seq)).toEqual([seqs[3]]);
  expect(await latestSequence(value.conversationId!)).toBe(seqs[3]);
});

it('rolls back only the owned suffix after a definitely precommit snapshot failure, then admits the waiting append', async () => {
  const value = state(); await appendRawForState(value, [{ type: 'message', message: value.messages[0] }]);
  const failure = Object.assign(new Error('disk full'), { code: 'ENOSPC' });
  jest.spyOn(fs, 'rename').mockRejectedValue(failure);
  const replacing = replaceConversationTranscript(value, [message('replacement')]);
  const appending = appendRawForState(value, [{ type: 'message', message: message('later') }]);
  await expect(replacing).rejects.toMatchObject({ code: 'CONVERSATION_PUBLICATION_IO', cause: failure }); await appending;
  expect(value.messages.map(item => item.id)).toEqual(['old']);
  expect((await events(value)).map(event => (event as { message: FlujoChatMessage }).message.id)).toEqual(['old', 'later']);
});

it('seals the reserved rewrite cursor in its final event so a cold restart scan retains it', async () => {
  const value = state(); await appendRawForState(value, [{ type: 'message', message: value.messages[0] }]);
  await replaceConversationTranscript(value, [message('replacement')]);
  const records = await events(value), last = records.at(-1)!.seq;
  expect(await latestSequence(value.conversationId!)).toBe(last);
  _setConversationLogDirForTests(directory);
  expect(await latestSequence(value.conversationId!)).toBe(last);
  await appendRawForState(value, [{ type: 'message', message: message('after-restart') }]);
  expect((await readConversationLogForReplay(value.conversationId!, last + 1)).events?.map(event => event.seq)).toEqual([last + 1]);
});

it('retains the winning transcript and log when rename commits and its acknowledgement throws', async () => {
  const value = state(); await appendRawForState(value, [{ type: 'message', message: value.messages[0] }]);
  const failure = new Error('lost acknowledgement'), rename = fs.rename.bind(fs);
  jest.spyOn(fs, 'rename').mockImplementation(async (from, to) => { await rename(from, to); throw failure; });
  await expect(replaceConversationTranscript(value, [message('replacement')])).rejects.toMatchObject({ code: 'CONVERSATION_PUBLICATION_IO', cause: failure });
  expect(value.messages.map(item => item.id)).toEqual(['replacement']);
  expect(JSON.parse(await fs.readFile(snapshotPath(value), 'utf8')).messages[0].id).toBe('replacement');
  expect((await events(value)).map(event => event.type)).toEqual(['message', 'message:removed', 'message']);
});

it('streams large historical content when collecting replacement tombstones', async () => {
  const value = state(); value.messages = [message('old', '\u0000'.repeat(80_000))];
  await appendRawForState(value, [{ type: 'message', message: value.messages[0] }]);
  await replaceConversationTranscript(value, [message('replacement')]);
  expect((await events(value)).filter(event => event.type === 'message:removed')).toMatchObject([{ messageId: 'old' }]);
});

it('does not accept an equal-size inode witness whose bytes changed after an ambiguous rename', async () => {
  const value = state(); await appendRawForState(value, [{ type: 'message', message: value.messages[0] }]);
  const rename = fs.rename.bind(fs);
  jest.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
    await rename(from, to);
    const handle = await fs.open(to, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    try {
      const info = await handle.stat();
      expect(info.isFile()).toBe(true);
      expect(info.size).toBeLessThan(1024 * 1024);
      await handle.writeFile('x'.repeat(info.size));
    } finally { await handle.close(); }
    throw new Error('ambiguous acknowledgement');
  });
  await expect(replaceConversationTranscript(value, [message('replacement')])).rejects.toMatchObject({ code: 'CONVERSATION_PUBLICATION_UNCERTAIN' });
  expect((await events(value)).map(event => event.type)).toEqual(['message', 'message:removed', 'message']);
  expect(value.messages[0].id).toBe('replacement');
});

it('reports unknown rename outcomes without truncating the log, then lets the next append heal the conversation', async () => {
  const value = state(); await appendRawForState(value, [{ type: 'message', message: value.messages[0] }]);
  const rename = fs.rename.bind(fs);
  jest.spyOn(fs, 'rename').mockImplementation(async from => { await rename(from, `${from}.unknown`); throw new Error('unknown commit'); });
  await expect(replaceConversationTranscript(value, [message('replacement')])).rejects.toMatchObject({ code: 'CONVERSATION_PUBLICATION_UNCERTAIN' });
  expect(value.messages[0].id).toBe('replacement');
  expect((await events(value)).map(event => event.type)).toEqual(['message', 'message:removed', 'message']);
  // The conversation is not blocked: the retained intent is reclaimed.
  await appendRawForState(value, [{ type: 'message', message: message('after-uncertain') }]);
  expect((await events(value)).map(event => event.type)).toEqual(['message', 'message:removed', 'message', 'message']);
  await expect(fs.access(path.join(directory, 'db', 'conversation-publications', `${value.conversationId}.json`))).rejects.toMatchObject({ code: 'ENOENT' });
});

async function leaveCrashedIntent(value: SharedState, record: object, ageMs = 0): Promise<string> {
  const intent = path.join(directory, 'db', 'conversation-publications', `${value.conversationId}.json`);
  await fs.mkdir(path.dirname(intent), { recursive: true });
  await fs.writeFile(intent, JSON.stringify(record));
  if (ageMs) { const at = new Date(Date.now() - ageMs); await fs.utimes(intent, at, at); }
  return intent;
}

it('reclaims a crashed earlier process intent and isolates its torn record on its own line', async () => {
  const value = state(), partial = '{"type":"model:dispatch","seq":0';
  await fs.writeFile(logPath(value), partial);
  const intent = await leaveCrashedIntent(value, { version: 1, token: 'prior-process' }, 60 * 60_000);
  await appendRawForState(value, [{ type: 'message', message: message('later') }]);
  const text = await fs.readFile(logPath(value), 'utf8');
  expect(text.startsWith(`${partial}\n{`)).toBe(true);
  // The production reader skips the torn line and keeps the new event intact.
  expect((await readConversationLog(value.conversationId))!.map(event => event.type === 'message' && event.message.id)).toEqual(['later']);
  await expect(fs.access(intent)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('reclaims a recent intent whose writer process has exited', async () => {
  const value = state();
  await leaveCrashedIntent(value, { version: 2, token: 'dead', startedAt: Date.now(), pid: 2_147_483_646, process: 'gone' });
  await appendRawForState(value, [{ type: 'message', message: message('after-crash') }]);
  expect((await events(value)).map(event => event.type === 'message' && event.message.id)).toEqual(['after-crash']);
});

it('reconciles the existing fold owner before inspecting an invalid stale capture', async () => {
  const value = state();
  (value.messages[0] as unknown as { cycle: unknown }).cycle = value.messages;
  fenceSubflowFold(value, async () => { value.messages = [message('durable-winner')]; });
  await persistConversationState(`conversations/${value.conversationId}` as StorageKey, value);
  expect(JSON.parse(await fs.readFile(snapshotPath(value), 'utf8')).messages[0].id).toBe('durable-winner');
});

it('handles partial writes without encoding a whole JSON string', async () => {
  const value = state(), open = fs.open.bind(fs);
  jest.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
    const handle = await open(...args);
    if (String(args[0]) === logPath(value)) {
      const write = handle.write.bind(handle);
      jest.spyOn(handle, 'write').mockImplementation((async (buffer: Buffer, offset: number, length: number, position: number) =>
        write(buffer, offset, Math.min(127, length), position)) as typeof handle.write);
    }
    return handle;
  });
  const content = '🌈'.repeat(20_000);
  await appendRawForState(value, [{ type: 'message', message: message('large', content) }]);
  expect((await events(value))[0]).toMatchObject({ message: { content } });
});

it('preserves the primary snapshot failure when rollback also fails', async () => {
  const value = state(); await appendRawForState(value, [{ type: 'message', message: value.messages[0] }]);
  const primary = Object.assign(new Error('snapshot full'), { code: 'ENOSPC' });
  jest.spyOn(fs, 'rename').mockRejectedValue(primary);
  const open = fs.open.bind(fs);
  jest.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
    const handle = await open(...args);
    if (String(args[0]) === logPath(value)) jest.spyOn(handle, 'truncate').mockRejectedValue(new Error('rollback failed'));
    return handle;
  });
  await expect(replaceConversationTranscript(value, [message('replacement')])).rejects.toMatchObject({ code: 'CONVERSATION_PUBLICATION_IO', cause: primary });
  expect(value.messages[0].id).toBe('replacement');
  expect((await events(value)).map(event => event.type)).toEqual(['message', 'message:removed', 'message']);
});

it('releases a snapshot close uncertainty slot and never rolls back its log', async () => {
  const value = state(); await appendRawForState(value, [{ type: 'message', message: value.messages[0] }]);
  const open = fs.open.bind(fs);
  jest.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
    const handle = await open(...args);
    if (String(args[0]).startsWith(`${snapshotPath(value)}.tmp.`)) {
      const close = handle.close.bind(handle);
      jest.spyOn(handle, 'close').mockImplementation(async () => { await close(); throw new Error('close acknowledgement lost'); });
    }
    return handle;
  });
  await expect(replaceConversationTranscript(value, [message('replacement')])).rejects.toMatchObject({ code: 'CONVERSATION_PUBLICATION_UNCERTAIN' });
  expect((await events(value)).map(event => event.type)).toEqual(['message', 'message:removed', 'message']);
  expect(value.messages[0].id).toBe('replacement');
  expect(getConversationPublicationDiagnostics().quarantinedWriterSlots).toBe(0);
});
