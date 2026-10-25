import * as syncFs from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { allocateSeq, _setConversationLogDirForTests } from '@/backend/execution/flow/conversationLog';

// These controls use only the predecessor's public API. The exact old module
// must fail on the bounded-memory/numeric/key-count boundary, not a missing API.
let directory: string, previous: string;
beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-sequence-boundary-'));
  previous = _setConversationLogDirForTests(directory);
});
afterEach(async () => {
  jest.restoreAllMocks();
  _setConversationLogDirForTests(previous);
  await fs.rm(directory, { recursive: true, force: true });
});

it('cold bootstrap never calls a whole-file reader or complete-root JSON parser', async () => {
  await fs.writeFile(path.join(directory, 'bounded.jsonl'), '{"text":"' + 'x'.repeat(2 * 1024 * 1024) + '","seq":17}\n{"seq":3}\n');
  const read = jest.spyOn(syncFs, 'readFileSync').mockImplementation(() => { throw new Error('whole-file read forbidden'); });
  const parse = jest.spyOn(JSON, 'parse').mockImplementation(() => { throw new Error('whole-root parse forbidden'); });
  const sequence = allocateSeq('bounded');
  expect(read.mock.calls.length).toBe(0);
  expect(parse.mock.calls.length).toBe(0);
  expect(sequence).toBe(18);
});

it('refuses unsafe persisted arithmetic instead of repeatedly allocating the same number', async () => {
  await fs.writeFile(path.join(directory, 'unsafe.jsonl'), '{"seq":9007199254740992}\n');
  expect(() => allocateSeq('unsafe')).toThrow(expect.objectContaining({ code: 'CONVERSATION_SEQUENCE_EXHAUSTED' }));
});

it('refuses the 4097th newly owned key and preserves an existing transient high-water mark', () => {
  for (let index = 0; index < 4096; index++) expect(allocateSeq(`transient-${index}`)).toBe(0);
  expect(() => allocateSeq('refused-new-owner')).toThrow(expect.objectContaining({ code: 'CONVERSATION_SEQUENCE_REGISTRY_FULL' }));
  expect(allocateSeq('transient-0')).toBe(1);
});
