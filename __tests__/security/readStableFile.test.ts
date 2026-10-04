import { promises as fs, constants, type BigIntStats } from 'node:fs';
import { readStableFile } from '@/utils/readStableFile';

jest.mock('node:fs', () => ({ ...jest.requireActual('node:fs'), promises: {
  lstat: jest.fn(), realpath: jest.fn(), open: jest.fn(),
} }));
const mockFs = fs as unknown as { lstat: jest.Mock; realpath: jest.Mock; open: jest.Mock };
const original = { dev: BigInt(1), ino: BigInt(2), size: BigInt(3), mtimeNs: BigInt(4), ctimeNs: BigInt(5), mode: BigInt(0o100600), uid: BigInt(6), gid: BigInt(7), nlink: BigInt(1),
  isFile: () => true, isSymbolicLink: () => false };
let body: Buffer;
let position: number;
let handle: { stat: jest.Mock; read: jest.Mock; close: jest.Mock };

beforeEach(() => {
  body = Buffer.from('abc'); position = 0;
  handle = { stat: jest.fn(async () => original), close: jest.fn(async () => undefined),
    read: jest.fn(async (buffer: Buffer, offset: number, length: number) => {
      const bytesRead = Math.min(2, length, body.length - position);
      body.copy(buffer, offset, position, position + bytesRead); position += bytesRead;
      return { bytesRead };
    }) };
  mockFs.lstat.mockReset().mockResolvedValue(original);
  mockFs.realpath.mockReset().mockResolvedValue('/fixture/file');
  mockFs.open.mockReset().mockResolvedValue(handle);
});

test('short reads complete on one descriptor and close it after checking identity', async () => {
  expect((await readStableFile('/fixture/file', 10)).toString()).toBe('abc');
  expect(mockFs.open).toHaveBeenCalledTimes(1);
  expect(mockFs.open).toHaveBeenCalledWith('/fixture/file', constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  expect(handle.read).toHaveBeenCalledTimes(3);
  expect(handle.stat).toHaveBeenCalledTimes(2);
  expect(handle.close).toHaveBeenCalledTimes(1);
});

test('opened-file policy receives exact metadata before the first content read', async () => {
  const validateOpenedFile = jest.fn((stat: Readonly<BigIntStats>, canonical: string) => {
    expect(stat).toBe(original);
    expect(canonical).toBe('/fixture/file');
    expect(handle.read).not.toHaveBeenCalled();
    return true;
  });
  expect((await readStableFile('/fixture/file', 10, { validateOpenedFile })).toString()).toBe('abc');
  expect(validateOpenedFile).toHaveBeenCalledTimes(1);
  expect(handle.close).toHaveBeenCalledTimes(1);
});

test.each(['deny', 'throw'])('opened-file policy %s closes without reading content', async kind => {
  await expect(readStableFile('/fixture/file', 10, { validateOpenedFile: () => {
    if (kind === 'throw') throw new Error('synthetic caller policy denied');
    return false;
  } })).rejects.toThrow(kind === 'throw' ? 'synthetic caller policy denied' : 'File read unavailable');
  expect(handle.read).not.toHaveBeenCalled();
  expect(handle.close).toHaveBeenCalledTimes(1);
});

test.each(['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'mode', 'uid', 'gid', 'nlink'])
('descriptor drift in %s is denied', async field => {
  handle.stat.mockResolvedValueOnce(original).mockResolvedValueOnce({ ...original, [field]: BigInt(999) });
  await expect(readStableFile('/fixture/file', 10)).rejects.toThrow('File read unavailable');
  expect(handle.close).toHaveBeenCalledTimes(1);
});

test('path replacement between admission and open is denied before content reading', async () => {
  handle.stat.mockResolvedValue({ ...original, ino: BigInt(99) });
  await expect(readStableFile('/fixture/file', 10)).rejects.toThrow('File read unavailable');
  expect(handle.read).not.toHaveBeenCalled();
  expect(handle.close).toHaveBeenCalledTimes(1);
});

test('replacement of the requested path after the descriptor read is denied', async () => {
  mockFs.lstat.mockResolvedValueOnce(original).mockResolvedValueOnce({ ...original, ino: BigInt(99) });
  await expect(readStableFile('/fixture/file', 10)).rejects.toThrow('File read unavailable');
});

test('a changed resolved target is denied', async () => {
  mockFs.realpath.mockResolvedValueOnce('/fixture/file').mockResolvedValueOnce('/fixture/other');
  await expect(readStableFile('/fixture/file', 10)).rejects.toThrow('File read unavailable');
});

test('a target replaced behind the descriptor is denied', async () => {
  mockFs.lstat.mockResolvedValueOnce(original).mockResolvedValueOnce(original).mockResolvedValueOnce({ ...original, ino: BigInt(99) });
  await expect(readStableFile('/fixture/file', 10)).rejects.toThrow('File read unavailable');
});

test('oversized input is denied before allocation or reading and closes its descriptor', async () => {
  handle.stat.mockResolvedValue({ ...original, size: BigInt(11) });
  await expect(readStableFile('/fixture/file', 10)).rejects.toThrow('File read unavailable');
  expect(handle.read).not.toHaveBeenCalled();
  expect(handle.close).toHaveBeenCalledTimes(1);
});

test.each([Buffer.from('ab'), Buffer.from('abcd')])('shortened or growing content is denied', async bytes => {
  body = bytes;
  await expect(readStableFile('/fixture/file', 10)).rejects.toThrow('File read unavailable');
  expect(handle.close).toHaveBeenCalledTimes(1);
});

test('read failure still closes the descriptor', async () => {
  handle.read.mockRejectedValue(new Error('synthetic unavailable read'));
  await expect(readStableFile('/fixture/file', 10)).rejects.toThrow('synthetic unavailable read');
  expect(handle.close).toHaveBeenCalledTimes(1);
});

test('symlinks are denied before opening by default', async () => {
  mockFs.lstat.mockResolvedValue({ ...original, isFile: () => false, isSymbolicLink: () => true });
  await expect(readStableFile('/fixture/file', 10)).rejects.toThrow('File read unavailable');
  expect(mockFs.open).not.toHaveBeenCalled();
});

test('explicit host configuration symlink compatibility still requires stable link and target identities', async () => {
  const link = { ...original, ino: BigInt(123), size: BigInt(20), isFile: () => false, isSymbolicLink: () => true };
  mockFs.lstat.mockResolvedValueOnce(link).mockResolvedValueOnce(link).mockResolvedValueOnce(original);
  expect((await readStableFile('/fixture/link', 10, { allowSymbolicLink: true })).toString()).toBe('abc');
});
