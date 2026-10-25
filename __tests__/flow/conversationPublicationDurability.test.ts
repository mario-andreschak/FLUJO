import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { appendFromBus, appendRawForState, replaceConversationTranscript, flushConversationLog,
  _setConversationLogDirForTests, latestSequence, readConversationLogForReplay } from '@/backend/execution/flow/conversationLog';
import { persistConversationState } from '@/backend/execution/flow/persistConversationState';
import { FlowExecutor } from '@/backend/execution/flow/FlowExecutor';
import { getConversationPublicationDiagnostics } from '@/backend/execution/flow/conversationPublication';
import type { SharedState } from '@/backend/execution/flow/types';
import type { FlujoChatMessage } from '@/shared/types/chat';
import type { StorageKey } from '@/shared/types/storage';
import type { ExecutionEvent } from '@/shared/types/execution/events';
import { fenceSubflowFold } from '@/backend/execution/flow/subflowFoldFence';

jest.mock('@/backend/execution/flow/FlowExecutor', () => ({ FlowExecutor: { conversationStates: new Map() } }));
jest.mock('@/backend/execution/flow/conversationSummaryStore', () => ({ persistConversationSummary: jest.fn(async () => {}) }));
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
    const info = await fs.stat(to);
    await fs.writeFile(to, 'x'.repeat(info.size));
    throw new Error('ambiguous acknowledgement');
  });
  await expect(replaceConversationTranscript(value, [message('replacement')])).rejects.toMatchObject({ code: 'CONVERSATION_PUBLICATION_UNCERTAIN' });
  expect((await events(value)).map(event => event.type)).toEqual(['message', 'message:removed', 'message']);
  expect(value.messages[0].id).toBe('replacement');
});

it('fences unknown rename outcomes without truncating the log or overwriting the new live transcript', async () => {
  const value = state(); await appendRawForState(value, [{ type: 'message', message: value.messages[0] }]);
  const rename = fs.rename.bind(fs);
  jest.spyOn(fs, 'rename').mockImplementation(async from => { await rename(from, `${from}.unknown`); throw new Error('unknown commit'); });
  await expect(replaceConversationTranscript(value, [message('replacement')])).rejects.toMatchObject({ code: 'CONVERSATION_PUBLICATION_UNCERTAIN' });
  expect(value.messages[0].id).toBe('replacement');
  expect((await events(value)).map(event => event.type)).toEqual(['message', 'message:removed', 'message']);
  await expect(appendRawForState(value, [{ type: 'message', message: message('must-not-write') }])).rejects.toMatchObject({ code: 'CONVERSATION_PUBLICATION_UNCERTAIN' });
  expect(JSON.parse(await fs.readFile(path.join(directory, 'db', 'conversation-publications', `${value.conversationId}.json`), 'utf8'))).toMatchObject({ version: 1, conversationId: value.conversationId });
});

it('refuses an unfinished intent from an earlier process before appending to its partial record', async () => {
  const value = state(), partial = '{"type":"model:dispatch","seq":0';
  await fs.writeFile(logPath(value), partial);
  const intent = path.join(directory, 'db', 'conversation-publications', `${value.conversationId}.json`);
  await fs.mkdir(path.dirname(intent), { recursive: true });
  await fs.writeFile(intent, '{"version":1,"token":"prior-process"}');
  await expect(appendRawForState(value, [{ type: 'message', message: message('later') }])).rejects.toMatchObject({ code: 'CONVERSATION_PUBLICATION_UNCERTAIN' });
  expect(await fs.readFile(logPath(value), 'utf8')).toBe(partial);
  expect(await fs.readFile(intent, 'utf8')).toContain('prior-process');
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

it('quarantines a snapshot close uncertainty and never rolls back its log', async () => {
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
  expect(getConversationPublicationDiagnostics().quarantinedWriterSlots).toBe(1);
});
