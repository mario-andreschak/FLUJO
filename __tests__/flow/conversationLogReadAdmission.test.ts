jest.mock('node:v8', () => { const actual = jest.requireActual('node:v8'); return { ...actual, getHeapStatistics: jest.fn(actual.getHeapStatistics) }; });
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import * as v8 from 'node:v8';
import { _setConversationLogDirForTests, readConversationLog, withConversationLogEvents, recoverMessagesFromLog } from '@/backend/execution/flow/conversationLog';
import type { SharedState } from '@/backend/execution/flow/types';
import { getConversationLogReadAdmission, withConversationLogReadAdmission, type ConversationReadReservation } from '@/backend/execution/flow/conversationLogReadAdmission';
let directory: string; let previous: string;
beforeEach(() => { jest.mocked(v8.getHeapStatistics).mockImplementation(jest.requireActual('node:v8').getHeapStatistics); });
beforeAll(async () => { directory = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-canonical-admission-')); previous = _setConversationLogDirForTests(directory); });
afterEach(() => { jest.restoreAllMocks(); expect(getConversationLogReadAdmission()).toEqual({ active: 0, bytes: 0 }); });
afterAll(async () => { _setConversationLogDirForTests(previous); await fs.rm(directory, { recursive: true, force: true }); });
const entry = (seq: number, text = '') => ({ type: 'run:start', conversationId: 'canonical', seq, timestamp: seq, flowId: text || 'f' });
const write = (id: string, text: string) => fs.writeFile(path.join(directory, `${id}.jsonl`), text);
it('preserves all events/order and giant UTF-8 lines across buffers while skipping malformed tail only', async () => {
  const events = [entry(0, '\u754c'.repeat(80000)), ...Array.from({ length: 1500 }, (_, i) => entry(i + 1))];
  const bytes = events.map(event => JSON.stringify(event)).join('\n') + '\n{"unfinished":';
  await write('canonical', bytes);
  expect(await readConversationLog('canonical')).toEqual(events);
  expect(await fs.readFile(path.join(directory, 'canonical.jsonl'), 'utf8')).toBe(bytes);
});
it('rejects memory pressure from descriptor metadata before allocation/read and closes it', async () => {
  const heap = v8.getHeapStatistics();
  jest.spyOn(v8, 'getHeapStatistics').mockReturnValue({ ...heap, heap_size_limit: heap.used_heap_size + 64 * 1024 * 1024 });
  const read = jest.fn(); const close = jest.fn(async () => {});
  jest.spyOn(fs, 'open').mockResolvedValueOnce({ stat: async () => ({ isFile: () => true, size: 100 }), read, close } as never);
  await expect(readConversationLog('pressure')).rejects.toMatchObject({ code: 'CONVERSATION_LOG_READ_MEMORY', status: 503 });
  expect(read).not.toHaveBeenCalled(); expect(close).toHaveBeenCalledTimes(1);
});
it('holds admission through asynchronous projection and bounds distinct simultaneous histories', async () => {
  await Promise.all([0, 1, 2, 3, 4].map(i => write(`parallel${i}`, JSON.stringify(entry(i)) + '\n')));
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  let entered = 0; let ready!: () => void; const enteredAll = new Promise<void>(resolve => { ready = resolve; });
  const reads = [0, 1, 2, 3].map(i => withConversationLogEvents(`parallel${i}`, async events => {
    if (++entered === 4) ready(); await gate;
    expect(getConversationLogReadAdmission().active).toBeGreaterThan(0); return events?.[0].seq;
  }));
  await enteredAll; expect(getConversationLogReadAdmission().active).toBe(4);
  try {
    await expect(readConversationLog('parallel4')).rejects.toMatchObject({ code: 'CONVERSATION_LOG_READ_BUSY', status: 429 });
    expect(await fs.readFile(path.join(directory, 'parallel4.jsonl'), 'utf8')).toBe(JSON.stringify(entry(4)) + '\n');
  } finally { release(); }
  expect(await Promise.all(reads)).toEqual([0, 1, 2, 3]);
});
it('releases on projection failure without swallowing consumer errno codes', async () => {
  await write('failure', JSON.stringify(entry(1)));
  const failure = Object.assign(new Error('consumer failed'), { code: 'ECONSUMER' });
  await expect(withConversationLogEvents('failure', async () => { throw failure; })).rejects.toBe(failure);
  expect(await readConversationLog('failure')).toEqual([entry(1)]);
});
it('reads only the same-descriptor size snapshot when another writer appends', async () => {
  await write('growing', JSON.stringify(entry(1)) + '\n');
  const open = fs.open.bind(fs);
  jest.spyOn(fs, 'open').mockImplementationOnce(async (...args) => {
    const handle = await open(...args); const stat = handle.stat.bind(handle);
    jest.spyOn(handle, 'stat').mockImplementationOnce(async () => {
      const snapshot = await stat(); await fs.appendFile(path.join(directory, 'growing.jsonl'), JSON.stringify(entry(2)) + '\n'); return snapshot;
    }); return handle;
  });
  expect(await readConversationLog('growing')).toEqual([entry(1)]);
  expect(await readConversationLog('growing')).toEqual([entry(1), entry(2)]);
});
it('rejects shrink instead of projecting partial history and releases reservation', async () => {
  const close = jest.fn(async () => {});
  jest.spyOn(fs, 'open').mockResolvedValueOnce({ stat: async () => ({ isFile: () => true, size: 100 }), read: async () => ({ bytesRead: 0 }), close } as never);
  await expect(readConversationLog('shrinking')).rejects.toThrow('changed during reading'); expect(close).toHaveBeenCalledTimes(1);
});
it('keeps the legacy read-I/O fallback and releases the reservation', async () => {
  jest.spyOn(console, 'error').mockImplementation(() => {});
  const close = jest.fn(async () => {});
  jest.spyOn(fs, 'open').mockResolvedValueOnce({ stat: async () => ({ isFile: () => true, size: 100 }), read: async () => { throw Object.assign(new Error('disk'), { code: 'EIO' }); }, close } as never);
  expect(await readConversationLog('io')).toBeUndefined(); expect(close).toHaveBeenCalledTimes(1);
});

it('shares one root slot for nested recovery across four simultaneous hydrations', async () => {
  await Promise.all([0,1,2,3].map(i => write(`nested${i}`, JSON.stringify(entry(i)))));
  let release!: () => void; const gate = new Promise<void>(r => { release = r; });
  let entered = 0; let ready!: () => void; const all = new Promise<void>(r => { ready = r; });
  const roots = [0,1,2,3].map(i => withConversationLogReadAdmission(100, token => withConversationLogEvents(`nested${i}`, async events => {
    if (++entered === 4) ready(); await gate; return events?.[0].seq;
  }, token)));
  await all;
  expect(getConversationLogReadAdmission().active).toBe(4);
  release(); expect(await Promise.all(roots)).toEqual([0,1,2,3]);
});
it('rejects forged and expired token identities instead of bypassing root admission', async () => {
  await expect(withConversationLogReadAdmission(1, async () => true, {} as ConversationReadReservation)).rejects.toThrow('invalid');
  let expired!: ConversationReadReservation;
  await withConversationLogReadAdmission(1, async token => { expired = token; });
  await expect(withConversationLogReadAdmission(1, async () => true, expired)).rejects.toThrow('expired');
});
it('retains root ownership until outstanding nested work settles, including a failed outer callback', async () => {
  let release!: () => void; const gate = new Promise<void>(r => { release = r; });
  let entered!: () => void; const ready = new Promise<void>(r => { entered = r; });
  const root = withConversationLogReadAdmission(1, async token => {
    void withConversationLogReadAdmission(1, async () => { entered(); await gate; }, token);
    throw new Error('outer failure');
  });
  const observed = expect(root).rejects.toThrow('outer failure');
  await ready; expect(getConversationLogReadAdmission().active).toBe(1);
  release(); await observed;
});

it('recovers full parent messages using an explicit snapshot reservation with all root slots occupied', async () => {
  await Promise.all([0,1,2,3].map(i => write(`recovery${i}`, JSON.stringify({ type: 'message', seq: 0, timestamp: 1, conversationId: `recovery${i}`, message: { id: `m${i}`, role: 'user', content: `history${i}`, timestamp: 1 } }))));
  let release!: () => void; const gate = new Promise<void>(r => { release = r; });
  let entered = 0; let ready!: () => void; const all = new Promise<void>(r => { ready = r; });
  const states = [0,1,2,3].map(i => ({ conversationId: `recovery${i}`, messages: [] } as unknown as SharedState));
  const roots = states.map(state => withConversationLogReadAdmission(100, async token => {
    if (++entered === 4) ready(); await gate; return recoverMessagesFromLog(state, token);
  }));
  await all; release(); expect(await Promise.all(roots)).toEqual([true,true,true,true]);
  expect(states.map(state => state.messages[0].content)).toEqual(['history0','history1','history2','history3']);
});
