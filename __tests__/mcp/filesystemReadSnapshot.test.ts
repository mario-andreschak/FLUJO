/** @jest-environment node */
// Keep the shipped tool and media detector real. Descriptor I/O is synthetic:
// no MCP process, host file, provider or private workspace is opened here.
import path from 'node:path';
import { constants, promises as fs } from 'node:fs';
import type { BigIntStats } from 'node:fs';

jest.mock('node:fs', () => {
  const actual = jest.requireActual<typeof import('node:fs')>('node:fs');
  return { ...actual, promises: { ...actual.promises, open: jest.fn(), stat: jest.fn(), readFile: jest.fn() } };
});
jest.mock('@flujo-ai/mcp-shared', () => ({
  createLogger: () => ({ warn: jest.fn(), debug: jest.fn() }),
  getDataDir: () => '/synthetic',
  loadEffectiveRoots: jest.fn(async () => ['/synthetic']),
}));
jest.mock('../../mcp-servers/filesystem/src/pathConfinement', () => ({
  confineFilesystemPath: jest.fn(async (file: string) => file),
}));
jest.mock('../../mcp-servers/filesystem/src/resources', () => ({ recordTouchedFile: jest.fn() }));

import { filesystemCallTool } from '../../mcp-servers/filesystem/src/tools';
import { confineFilesystemPath } from '../../mcp-servers/filesystem/src/pathConfinement';
import { recordTouchedFile } from '../../mcp-servers/filesystem/src/resources';

const fields = ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'mode', 'uid', 'gid', 'nlink'] as const;
const mediaCap = 32 * 1024 * 1024;
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const filename = path.resolve('/synthetic/read.txt');
const mockedOpen = jest.mocked(fs.open);
const mockedStat = jest.mocked(fs.stat);
const mockedReadFile = jest.mocked(fs.readFile);
const mockedConfinement = jest.mocked(confineFilesystemPath);

function metadata(size: number): BigIntStats {
  return {
    dev: BigInt(1), ino: BigInt('9007199254740992'), size: BigInt(size),
    mtimeNs: BigInt('9007199254740992'), ctimeNs: BigInt('9007199254740992'),
    mode: BigInt(0o100600), uid: BigInt(3), gid: BigInt(4), nlink: BigInt(1),
    isFile: () => true,
  } as BigIntStats;
}

function descriptor(body = Buffer.from('alpha\nneedle\nomega\n'), declared = body.length) {
  const admitted = metadata(declared);
  const handle = {
    stat: jest.fn(async () => ({ ...admitted })),
    read: jest.fn(async (buffer: Buffer, offset: number, length: number, position: number) => {
      const bytesRead = body.copy(buffer, offset, position, position + length);
      return { bytesRead, buffer };
    }),
    close: jest.fn(async () => undefined),
  };
  mockedOpen.mockResolvedValue(handle as unknown as Awaited<ReturnType<typeof fs.open>>);
  return { admitted, handle, body };
}

async function read(args: Record<string, unknown> = {}) {
  const result = await filesystemCallTool('read_file', { path: filename, ...args });
  const firstText = result.content.find(item => item.type === 'text') as { type: 'text'; text: string };
  return { result, payload: JSON.parse(firstText.text) as Record<string, unknown> };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockedOpen.mockReset();
  mockedConfinement.mockReset().mockImplementation(async file => file);
  mockedStat.mockReset().mockRejectedValue(new Error('Pathname stat must not admit read_file.'));
  mockedReadFile.mockReset().mockRejectedValue(new Error('Pathname readFile must not consume read_file.'));
});

it('uses the admitted descriptor even when the pathname now names a different body', async () => {
  const { handle } = descriptor(Buffer.from('original'));
  mockedReadFile.mockResolvedValue(Buffer.from('replacement') as never);
  const { result, payload } = await read();
  expect(result.isError).toBeUndefined();
  expect(payload.content).toBe('original');
  expect(mockedReadFile).not.toHaveBeenCalled();
  expect(mockedStat).not.toHaveBeenCalled();
  expect(handle.close).toHaveBeenCalledTimes(1);
  expect(recordTouchedFile).toHaveBeenCalledWith(filename, 'read', 8);
  expect(mockedOpen).toHaveBeenCalledWith(filename, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
});

it('rejects an oversized text descriptor despite a smaller stale pathname stat', async () => {
  const { handle } = descriptor(Buffer.alloc(512, 0x61), 100_001);
  mockedStat.mockResolvedValue({ isFile: () => true, size: 8 } as never);
  const { result, payload } = await read();
  expect(result.isError).toBe(true);
  expect(payload.error).toMatch(/File is large/);
  expect(handle.read).toHaveBeenCalledTimes(1);
  expect(handle.close).toHaveBeenCalledTimes(1);
  expect(recordTouchedFile).not.toHaveBeenCalled();
});

it('rejects growth after admission while consuming at most admitted size plus one byte', async () => {
  const { handle, body } = descriptor(Buffer.from('original plus growth'), 8);
  const { result, payload } = await read();
  expect(result.isError).toBe(true);
  expect(payload.error).toMatch(/File changed/);
  expect(handle.read.mock.calls.map(call => call[2])).toEqual([8, 1]);
  expect(body.length).toBeGreaterThan(9);
  expect(handle.close).toHaveBeenCalledTimes(1);
  expect(recordTouchedFile).not.toHaveBeenCalled();
});

it('rejects shrinkage instead of returning a partial body', async () => {
  const { handle } = descriptor(Buffer.from('short'), 8);
  const { result, payload } = await read();
  expect(result.isError).toBe(true);
  expect(payload.error).toMatch(/File changed/);
  expect(handle.close).toHaveBeenCalledTimes(1);
});

it.each(fields)('rejects detectable %s changes before publishing any bytes', async field => {
  const { admitted, handle } = descriptor();
  handle.stat.mockResolvedValueOnce({ ...admitted }).mockResolvedValue({ ...admitted, [field]: admitted[field] + BigInt(1) });
  const { result, payload } = await read();
  expect(result.isError).toBe(true);
  expect(payload.error).toMatch(/File changed/);
  expect(recordTouchedFile).not.toHaveBeenCalled();
  expect(handle.close).toHaveBeenCalledTimes(1);
});

it('rejects a change after body consumption', async () => {
  const { admitted, handle } = descriptor();
  handle.stat.mockResolvedValueOnce({ ...admitted }).mockResolvedValueOnce({ ...admitted })
    .mockResolvedValue({ ...admitted, ctimeNs: admitted.ctimeNs + BigInt(1) });
  expect((await read()).result.isError).toBe(true);
  expect(recordTouchedFile).not.toHaveBeenCalled();
  expect(handle.close).toHaveBeenCalledTimes(1);
});

it('fills short header reads before classifying extensionless media', async () => {
  const { handle } = descriptor(png);
  handle.read.mockImplementation(async (buffer, offset, length, position) => {
    const bytesRead = png.copy(buffer, offset, position, position + Math.min(length, 2));
    return { bytesRead, buffer };
  });
  const { result, payload } = await read({ path: path.resolve('/synthetic/extensionless') });
  expect(result.isError).toBeUndefined();
  expect(result.content[0]).toMatchObject({ type: 'image', mimeType: 'image/png', data: png.toString('base64') });
  expect(payload.size).toBe(png.length);
  expect(handle.close).toHaveBeenCalledTimes(1);
});

it.each([
  {}, { pattern: '*' }, { pattern: 'needle' }, { from: 1, to: 1 },
])('retains the media cap for request %j', async args => {
  const body = Buffer.alloc(512); png.copy(body);
  const { handle } = descriptor(body, mediaCap + 1);
  const { result, payload } = await read({ path: path.resolve('/synthetic/extensionless'), ...args });
  expect(result.isError).toBe(true);
  expect(payload.error).toMatch(/Media file is too large/);
  expect(handle.read).toHaveBeenCalledTimes(1);
  expect(handle.close).toHaveBeenCalledTimes(1);
});

it.each([
  { pattern: '*' }, { pattern: 'needle' }, { from: 1, to: 1 },
])('preserves the explicit large-text opt-out %j', async args => {
  const body = Buffer.from('needle\n' + 'a'.repeat(100_001 - 7));
  const { handle } = descriptor(body);
  const { result, payload } = await read(args);
  expect(result.isError).toBeUndefined();
  expect(String(payload.content)).toContain('needle');
  expect(handle.close).toHaveBeenCalledTimes(1);
});

it('accepts a stable bare text file at the existing threshold', async () => {
  descriptor(Buffer.alloc(100_000, 0x61));
  expect((await read()).result.isError).toBeUndefined();
});

it('accepts an empty stable file', async () => {
  const { handle } = descriptor(Buffer.alloc(0));
  const { result, payload } = await read();
  expect(result.isError).toBeUndefined();
  expect(payload.content).toBe('');
  expect(handle.read.mock.calls.map(call => call[2])).toEqual([1]);
  expect(handle.close).toHaveBeenCalledTimes(1);
});

it.each([BigInt(-1), BigInt('9007199254740992')])('rejects invalid descriptor size %s without reading', async size => {
  const { admitted, handle } = descriptor();
  handle.stat.mockResolvedValue({ ...admitted, size });
  const { result, payload } = await read();
  expect(result.isError).toBe(true);
  expect(payload.error).toMatch(/size cannot be read safely/);
  expect(handle.read).not.toHaveBeenCalled();
  expect(handle.close).toHaveBeenCalledTimes(1);
});

it('rejects nonregular descriptors without reading', async () => {
  const { admitted, handle } = descriptor();
  handle.stat.mockResolvedValue({ ...admitted, isFile: () => false });
  expect((await read()).result.isError).toBe(true);
  expect(handle.read).not.toHaveBeenCalled();
  expect(handle.close).toHaveBeenCalledTimes(1);
});

it.each(['stat', 'read', 'close'] as const)('returns an error for descriptor %s failure', async operation => {
  const { handle } = descriptor();
  handle[operation].mockRejectedValueOnce(new Error(`synthetic ${operation} failure`));
  const { result, payload } = await read();
  expect(result.isError).toBe(true);
  expect(payload.error).toMatch(new RegExp(`synthetic ${operation} failure`));
  expect(handle.close).toHaveBeenCalledTimes(1);
  expect(recordTouchedFile).not.toHaveBeenCalled();
});

it('surfaces a missing-file open error', async () => {
  mockedOpen.mockRejectedValue(new Error('synthetic ENOENT'));
  expect((await read()).payload.error).toMatch(/synthetic ENOENT/);
});

it('preserves a root denial before opening the file', async () => {
  mockedConfinement.mockRejectedValue(new Error('outside configured filesystem roots'));
  expect((await read()).result.isError).toBe(true);
  expect(mockedOpen).not.toHaveBeenCalled();
});

it('preserves invalid-pattern validation before opening the file', async () => {
  expect((await read({ pattern: '[' })).payload.error).toMatch(/Invalid regular expression/);
  expect(mockedOpen).not.toHaveBeenCalled();
});

it('preserves line-range projection and content hashes', async () => {
  descriptor();
  const { result, payload } = await read({ from: 2, to: 2 });
  expect(result.isError).toBeUndefined();
  expect(payload).toMatchObject({ from: 2, to: 2, totalLines: 4, content: 'needle' });
  expect(payload.contentHash).toMatch(/^[a-f0-9]{64}$/);
});

it('preserves batch text results with a separate descriptor for each path', async () => {
  const a = descriptor(Buffer.from('first'));
  const b = descriptor(Buffer.from('second'));
  mockedOpen.mockReset().mockResolvedValueOnce(a.handle as never).mockResolvedValueOnce(b.handle as never);
  const result = await filesystemCallTool('read_file', { paths: [filename, path.resolve('/synthetic/second.txt')] });
  const payload = JSON.parse((result.content[0] as { text: string }).text);
  expect(payload.files.map((file: { content: string }) => file.content)).toEqual(['first', 'second']);
  expect(a.handle.close).toHaveBeenCalledTimes(1);
  expect(b.handle.close).toHaveBeenCalledTimes(1);
});
