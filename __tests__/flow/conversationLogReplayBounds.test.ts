import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { _setConversationLogDirForTests, readConversationLog, readConversationLogForReplay, SSE_LOG_REPLAY_LIMITS } from '@/backend/execution/flow/conversationLog';

let directory: string;
let previousDirectory: string;
beforeAll(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-sse-log-bounds-'));
  previousDirectory = _setConversationLogDirForTests(directory);
});
afterEach(() => { jest.restoreAllMocks(); });
afterAll(async () => {
  _setConversationLogDirForTests(previousDirectory);
  await fs.rm(directory, { recursive: true, force: true });
});
const entry = (seq: number) => ({ type: 'run:start', conversationId: 'bounded', seq, timestamp: seq, flowId: 'f' });
const write = (value: string) => fs.writeFile(path.join(directory, 'bounded.jsonl'), value);

it('reads a small durable projection in order without changing full-history behavior', async () => {
  await write([0, 1, 2].map(seq => JSON.stringify(entry(seq))).join('\n') + '\n');
  expect(await readConversationLogForReplay('bounded', 1)).toEqual({ events: [entry(1), entry(2)], limited: false });
  expect(await readConversationLog('bounded')).toEqual([entry(0), entry(1), entry(2)]);
});

it('rejects an oversized file from descriptor metadata before a read allocation', async () => {
  const read = jest.fn(); const close = jest.fn(async () => {});
  jest.spyOn(fs, 'open').mockResolvedValueOnce({ stat: async () => ({ isFile: () => true, size: SSE_LOG_REPLAY_LIMITS.maxBytes + 1 }), read, close } as never);
  expect(await readConversationLogForReplay('bounded', 0)).toEqual({ limited: true });
  expect(read).not.toHaveBeenCalled(); expect(close).toHaveBeenCalledTimes(1);
});

it.each([false, true])('rejects descriptor shrink/growth instead of replaying a partial view (growth=%s)', async grows => {
  const close = jest.fn(async () => {});
  let calls = 0;
  const read = jest.fn(async () => ({ bytesRead: calls++ === 0 ? grows ? 3 : 1 : 0 }));
  jest.spyOn(fs, 'open').mockResolvedValueOnce({ stat: async () => ({ isFile: () => true, size: 2 }), read, close } as never);
  expect(await readConversationLogForReplay('bounded', 0)).toEqual({ limited: true });
  expect(close).toHaveBeenCalledTimes(1);
});

it('refuses more than 1000 scanned lines without changing the canonical history reader', async () => {
  await write(Array.from({ length: 1001 }, (_, seq) => JSON.stringify(entry(seq))).join('\n') + '\n');
  expect(await readConversationLogForReplay('bounded', 0)).toEqual({ limited: true });
  expect(await readConversationLog('bounded')).toHaveLength(1001);
});

it('requests recovery for malformed replay while full history still tolerates a truncated tail', async () => {
  await write(JSON.stringify(entry(0)) + '\n{"unfinished":');
  expect(await readConversationLogForReplay('bounded', 0)).toEqual({ limited: true });
  expect(await readConversationLog('bounded')).toEqual([entry(0)]);
});

it('keeps the descriptor open until an in-flight native read settles after cancellation', async () => {
  const abort = new AbortController(); const close = jest.fn(async () => {});
  let complete!: (value: { bytesRead: number }) => void;
  const pending = new Promise<{ bytesRead: number }>(resolve => { complete = resolve; });
  let reading!: () => void;
  const enteredRead = new Promise<void>(resolve => { reading = resolve; });
  const read = jest.fn(() => { reading(); return pending; });
  jest.spyOn(fs, 'open').mockResolvedValueOnce({ stat: async () => ({ isFile: () => true, size: 10 }), read, close } as never);
  const result = readConversationLogForReplay('bounded', 0, abort.signal);
  await enteredRead;
  expect(read).toHaveBeenCalledTimes(1);
  abort.abort(new Error('cancelled'));
  expect(close).not.toHaveBeenCalled();
  complete({ bytesRead: 0 });
  await expect(result).rejects.toThrow('cancelled');
  expect(close).toHaveBeenCalledTimes(1);
});

it('rejects an already-aborted replay before opening a file', async () => {
  const open = jest.spyOn(fs, 'open'); const abort = new AbortController(); abort.abort(new Error('cancelled'));
  await expect(readConversationLogForReplay('bounded', 0, abort.signal)).rejects.toThrow('cancelled');
  expect(open).not.toHaveBeenCalled();
});

it('rejects non-regular descriptors and closes them without reading', async () => {
  const read = jest.fn(); const close = jest.fn(async () => {});
  jest.spyOn(fs, 'open').mockResolvedValueOnce({ stat: async () => ({ isFile: () => false, size: 0 }), read, close } as never);
  expect(await readConversationLogForReplay('bounded', 0)).toEqual({ limited: true });
  expect(read).not.toHaveBeenCalled(); expect(close).toHaveBeenCalledTimes(1);
});
