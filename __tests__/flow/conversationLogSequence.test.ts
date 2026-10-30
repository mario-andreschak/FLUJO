jest.mock('node:fs', () => {
  const actual = jest.requireActual('node:fs');
  return { ...actual, openSync: jest.fn(actual.openSync), fstatSync: jest.fn(actual.fstatSync),
    readSync: jest.fn(actual.readSync), closeSync: jest.fn(actual.closeSync) };
});

import { openSync, fstatSync, readSync, closeSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { scanConversationLogSequence, requireAllocatableSequence, CONVERSATION_SEQUENCE_SCAN_LIMITS } from '@/backend/execution/flow/conversationLogSequence';

const disk = jest.requireActual<typeof import('node:fs')>('node:fs');
let directory: string;
let filename: string;
beforeAll(() => { directory = disk.mkdtempSync(path.join(os.tmpdir(), 'flujo-sequence-scan-')); filename = path.join(directory, 'history.jsonl'); });
beforeEach(() => {
  jest.mocked(openSync).mockReset().mockImplementation(disk.openSync);
  jest.mocked(fstatSync).mockReset().mockImplementation(disk.fstatSync);
  jest.mocked(readSync).mockReset().mockImplementation(disk.readSync);
  jest.mocked(closeSync).mockReset().mockImplementation(disk.closeSync);
});
afterEach(() => jest.restoreAllMocks());
afterAll(() => disk.rmSync(directory, { recursive: true, force: true }));
function scan(content: string, bufferBytes = 7) {
  disk.writeFileSync(filename, content);
  return scanConversationLogSequence(filename, { bufferBytes });
}

it('scans every complete root in file order and preserves max7,3 legacy bootstrap', () => {
  expect(scan('{"seq":-1}\n{"seq":7}\n{"seq":3}\n')).toBe(7);
  expect(scan('{"nested":{"seq":999},"text":"\\\"seq\\\":888","seq":8}\n[ {"seq":777} ]\n')).toBe(8);
});

it.each([1, 2, 3, 7, 64])('validates escaped keys, Unicode and last-property-wins across %i-byte chunks', buffer => {
  const content = '{"s\\u0065q":2,"seq":8,"seq":"shadowed"}\n'
    + '{"seq":3,"seq":null}\n{"seq":4,"seq":{"seq":999}}\n'
    + '{"seq":1,"\\u0073\\u0065\\u0071":9,"text":"😀é\\uD800\\n"}\n';
  expect(scan(content, buffer)).toBe(9);
});

it.each([
  '{"seq":99} trailing', '{"seq":99,}', '{"seq":99,"x":[1,]}', '{"seq":99,"x":01}',
  '{"seq":99,"x":1.}', '{"seq":99,"x":truefalse}', '{"seq":99,"x":"bad\\q"}',
  '{"seq":99,"x":"bad\tcontrol"}', '{"seq":99,"x":{"a" 1}}', '{"seq":99',
])('ignores the entire malformed line rather than accepting an early sequence: %s', invalid => {
  expect(scan(`{"seq":4}\n${invalid}\n`)).toBe(4);
});

it('does not retain whole lines/keys/strings or invoke JSON.parse/readFileSync', () => {
  disk.writeFileSync(filename, '{"' + 'k'.repeat(150_000) + '":"' + 'x'.repeat(8 * 1024 * 1024) + '","seq":12}\n');
  const parse = jest.spyOn(JSON, 'parse').mockImplementation(() => { throw new Error('whole-root parser forbidden'); });
  expect(scanConversationLogSequence(filename)).toBe(12);
  expect(parse).not.toHaveBeenCalled();
  expect(jest.mocked(readSync).mock.calls.every(([, buffer]) => (buffer as Uint8Array).byteLength <= CONVERSATION_SEQUENCE_SCAN_LIMITS.bufferBytes)).toBe(true);
  expect(openSync).toHaveBeenCalledTimes(1);
  const descriptor = jest.mocked(openSync).mock.results[0].value;
  expect(jest.mocked(readSync).mock.calls.every(([fd]) => fd === descriptor)).toBe(true);
  expect(jest.mocked(fstatSync).mock.calls.every(([fd]) => fd === descriptor)).toBe(true);
  expect(closeSync).toHaveBeenCalledWith(descriptor);
});

it('scans a line with more than a million JSON tokens by default (no work limit unless configured)', () => {
  disk.writeFileSync(filename, `{"seq":4}\n{"seq":5,"values":[${'0,'.repeat(1_100_000)}0]}\n`);
  expect(scanConversationLogSequence(filename)).toBe(5);
});

it('refuses configured depth/token/time work limits instead of returning a partial high-water mark', () => {
  disk.writeFileSync(filename, '{"seq":7}\n{"seq":9,"nested":[[[[0]]]]}\n');
  expect(() => scanConversationLogSequence(filename, { maxDepth: 3 })).toThrow(expect.objectContaining({ code: 'CONVERSATION_SEQUENCE_SCAN_LIMIT' }));
  disk.writeFileSync(filename, '{"seq":9,"values":[0,1,2,3]}');
  expect(() => scanConversationLogSequence(filename, { maxTokensPerLine: 4 })).toThrow(expect.objectContaining({ code: 'CONVERSATION_SEQUENCE_SCAN_LIMIT' }));
  let time = 0;
  expect(() => scanConversationLogSequence(filename, { maxMilliseconds: 1, now: () => time++ })).toThrow(expect.objectContaining({ code: 'CONVERSATION_SEQUENCE_SCAN_LIMIT' }));
  expect(closeSync).toHaveBeenCalledTimes(3);
});

it('bounds numeric tokens while honoring final duplicate values and exact safe-integer arithmetic', () => {
  expect(scan('{"seq":9007199254740992,"seq":5}\n{"seq":1e309,"seq":false}\n{"seq":6.0e0}')).toBe(6);
  for (const value of ['9007199254740992', '1e309', '1.5']) {
    expect(() => scan(`{"seq":${value}}`)).toThrow(expect.objectContaining({ code: 'CONVERSATION_SEQUENCE_EXHAUSTED' }));
  }
  expect(() => scan('{"seq":1e' + '0'.repeat(129) + '}')).toThrow(expect.objectContaining({ code: 'CONVERSATION_SEQUENCE_SCAN_LIMIT' }));
  expect(() => requireAllocatableSequence(Number.MAX_SAFE_INTEGER - 1)).not.toThrow();
  for (const value of [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN, 0.5, -1]) {
    expect(() => requireAllocatableSequence(value)).toThrow(expect.objectContaining({ code: 'CONVERSATION_SEQUENCE_EXHAUSTED' }));
  }
});

it('only treats an absent pathname as an empty log', () => {
  expect(scanConversationLogSequence(path.join(directory, 'absent.jsonl'))).toBe(-1);
  jest.mocked(openSync).mockImplementationOnce(() => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); });
  expect(() => scanConversationLogSequence(filename)).toThrow(expect.objectContaining({ code: 'CONVERSATION_SEQUENCE_IO' }));
  expect(closeSync).not.toHaveBeenCalled();
});

it('accepts short reads but refuses early EOF or descriptor snapshot growth/shrink', () => {
  disk.writeFileSync(filename, '{"seq":17}\n');
  jest.mocked(readSync).mockImplementation(((fd: number, buffer: Buffer, offset: number, length: number, position: number) =>
    disk.readSync(fd, buffer, offset, Math.min(length, 2), position)) as typeof readSync);
  expect(scanConversationLogSequence(filename)).toBe(17);
  jest.mocked(readSync).mockReturnValueOnce(0);
  expect(() => scanConversationLogSequence(filename)).toThrow(expect.objectContaining({ code: 'CONVERSATION_SEQUENCE_CHANGED' }));
  jest.mocked(readSync).mockImplementation(disk.readSync);
  for (const delta of [BigInt(-1), BigInt(1)]) {
    jest.mocked(fstatSync).mockImplementationOnce(disk.fstatSync).mockImplementationOnce(((fd: number) => {
      const stat = disk.fstatSync(fd, { bigint: true });
      return Object.assign(stat, { size: stat.size + delta });
    }) as typeof fstatSync);
    expect(() => scanConversationLogSequence(filename)).toThrow(expect.objectContaining({ code: 'CONVERSATION_SEQUENCE_CHANGED' }));
  }
  expect(closeSync).toHaveBeenCalledTimes(4);
});

it('refuses nonregular descriptors and read failures, always closes, and keeps a completed scan despite a close failure', () => {
  disk.writeFileSync(filename, '{"seq":1}');
  jest.mocked(fstatSync).mockImplementationOnce(((fd: number) => {
    const stat = disk.fstatSync(fd, { bigint: true }); stat.isFile = () => false; return stat;
  }) as typeof fstatSync);
  expect(() => scanConversationLogSequence(filename)).toThrow(expect.objectContaining({ code: 'CONVERSATION_SEQUENCE_IO' }));
  jest.mocked(readSync).mockImplementationOnce(() => { throw Object.assign(new Error('disk read failed'), { code: 'EIO' }); });
  expect(() => scanConversationLogSequence(filename)).toThrow(expect.objectContaining({ code: 'CONVERSATION_SEQUENCE_IO' }));
  jest.mocked(closeSync).mockImplementationOnce(fd => { disk.closeSync(fd); throw new Error('close failed'); });
  expect(scanConversationLogSequence(filename)).toBe(1);
  expect(closeSync).toHaveBeenCalledTimes(3);
});

it('keeps reading the original descriptor when its pathname is replaced before the snapshot', () => {
  disk.writeFileSync(filename, '{"seq":7}\n');
  const moved = path.join(directory, 'opened-original.jsonl');
  jest.mocked(openSync).mockImplementationOnce(((file: string, flags: number) => {
    const descriptor = disk.openSync(file, flags);
    disk.renameSync(file, moved);
    disk.writeFileSync(file, '{"seq":999}\n');
    return descriptor;
  }) as typeof openSync);
  expect(scanConversationLogSequence(filename)).toBe(7);
  expect(openSync).toHaveBeenCalledTimes(1);
  expect(disk.readFileSync(filename, 'utf8')).toBe('{"seq":999}\n');
});

it('detects an actual in-place shrink without reopening or returning the parsed prefix', () => {
  disk.writeFileSync(filename, '{"seq":7}\n{"seq":99}\n');
  jest.mocked(readSync).mockImplementationOnce(((fd: number, buffer: Buffer, offset: number, _length: number, position: number) => {
    const count = disk.readSync(fd, buffer, offset, 10, position);
    disk.truncateSync(filename, 0);
    return count;
  }) as typeof readSync);
  expect(() => scanConversationLogSequence(filename)).toThrow(expect.objectContaining({ code: 'CONVERSATION_SEQUENCE_CHANGED' }));
  expect(openSync).toHaveBeenCalledTimes(1);
  expect(closeSync).toHaveBeenCalledTimes(1);
});
