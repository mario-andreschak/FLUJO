import fs from 'node:fs';
import { readStableFileSync } from '@/utils/readStableFileSync';

jest.mock('node:fs', () => ({ ...jest.requireActual('node:fs'), lstatSync: jest.fn(), fstatSync: jest.fn(),
  openSync: jest.fn(), readSync: jest.fn(), closeSync: jest.fn(),
  realpathSync: Object.assign(jest.fn(), { native: jest.fn() }),
}));
const mocks = fs as unknown as { lstatSync: jest.Mock; fstatSync: jest.Mock; openSync: jest.Mock;
  readSync: jest.Mock; closeSync: jest.Mock; realpathSync: { native: jest.Mock } };
const admitted = { dev: BigInt(1), ino: BigInt('9007199254740992'), size: BigInt(3), mtimeNs: BigInt(4), ctimeNs: BigInt(5),
  mode: BigInt(0o100600), uid: BigInt(6), gid: BigInt(7), nlink: BigInt(1),
  isFile: () => true, isSymbolicLink: () => false };
let body: Buffer;

beforeEach(() => {
  body = Buffer.from('abc');
  mocks.lstatSync.mockReset().mockReturnValue(admitted);
  mocks.fstatSync.mockReset().mockReturnValue(admitted);
  mocks.realpathSync.native.mockReset().mockReturnValue('/fixture/file');
  mocks.openSync.mockReset().mockReturnValue(42);
  mocks.closeSync.mockReset();
  mocks.readSync.mockReset().mockImplementation((_fd, buffer: Buffer, offset: number, length: number, position: number) => {
    const count = Math.min(2, length, Math.max(0, body.length - position));
    body.copy(buffer, offset, position, position + count);
    return count;
  });
});

test('short reads complete through one bounded nonblocking descriptor and close it', () => {
  expect(readStableFileSync('/fixture/file', 10).toString()).toBe('abc');
  expect(mocks.openSync).toHaveBeenCalledTimes(1);
  expect(mocks.openSync).toHaveBeenCalledWith('/fixture/file', fs.constants.O_RDONLY
    | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
  expect(mocks.readSync).toHaveBeenCalledTimes(3);
  expect(mocks.closeSync).toHaveBeenCalledWith(42);
  expect(mocks.lstatSync).toHaveBeenCalledWith('/fixture/file', { bigint: true });
  expect(mocks.fstatSync).toHaveBeenCalledWith(42, { bigint: true });
});

test.each(['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'mode', 'uid', 'gid', 'nlink'])
('opened descriptor mismatch in %s denies before bytes', field => {
  mocks.fstatSync.mockReturnValue({ ...admitted, [field]: BigInt(999) });
  expect(() => readStableFileSync('/fixture/file', 10)).toThrow('File read unavailable');
  expect(mocks.readSync).not.toHaveBeenCalled();
  expect(mocks.closeSync).toHaveBeenCalledTimes(1);
});

test.each(['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'mode', 'uid', 'gid', 'nlink'])
('descriptor drift in %s denies after bytes', field => {
  mocks.fstatSync.mockReturnValueOnce(admitted).mockReturnValueOnce({ ...admitted, [field]: BigInt(999) });
  expect(() => readStableFileSync('/fixture/file', 10)).toThrow('File read unavailable');
  expect(mocks.closeSync).toHaveBeenCalledTimes(1);
});

test('distinct unsafe integer inode values do not collapse through Number conversion', () => {
  expect(Number(admitted.ino)).toBe(Number(BigInt('9007199254740993')));
  mocks.fstatSync.mockReturnValue({ ...admitted, ino: BigInt('9007199254740993') });
  expect(() => readStableFileSync('/fixture/file', 10)).toThrow('File read unavailable');
  expect(mocks.readSync).not.toHaveBeenCalled();
});

test.each([false, undefined, 'true'])('caller admission requires exact true (%s)', result => {
  const admission = jest.fn(() => result) as unknown as NonNullable<Parameters<typeof readStableFileSync>[2]>['validateOpenedFile'];
  expect(() => readStableFileSync('/fixture/file', 10, { validateOpenedFile: admission })).toThrow('File read unavailable');
  expect(mocks.readSync).not.toHaveBeenCalled();
  expect(mocks.closeSync).toHaveBeenCalledTimes(1);
});

test('throwing admission closes before any content read', () => {
  expect(() => readStableFileSync('/fixture/file', 10, { validateOpenedFile: () => { throw new Error('admission denied'); } }))
    .toThrow('admission denied');
  expect(mocks.readSync).not.toHaveBeenCalled();
  expect(mocks.closeSync).toHaveBeenCalledTimes(1);
});

test('admitted canonical path and exact bigint metadata reach the callback', () => {
  const admission = jest.fn(() => true);
  expect(readStableFileSync('/fixture/file', 10, { validateOpenedFile: admission }).toString()).toBe('abc');
  expect(admission).toHaveBeenCalledWith(admitted, '/fixture/file');
});

test.each(['requested', 'resolved'])('%s name replacement after bytes denies', target => {
  mocks.lstatSync.mockReturnValueOnce(admitted).mockReturnValueOnce(target === 'requested' ? { ...admitted, ino: BigInt(99) } : admitted)
    .mockReturnValueOnce({ ...admitted, ino: BigInt(99) });
  expect(() => readStableFileSync('/fixture/file', 10)).toThrow('File read unavailable');
  expect(mocks.closeSync).toHaveBeenCalledTimes(1);
});

test('canonical target redirection after bytes denies', () => {
  mocks.realpathSync.native.mockReturnValueOnce('/fixture/file').mockReturnValueOnce('/fixture/other');
  expect(() => readStableFileSync('/fixture/file', 10)).toThrow('File read unavailable');
});

test.each([Buffer.from('ab'), Buffer.from('abcd')])('truncation and growth are denied with bounded reads', bytes => {
  body = bytes;
  expect(() => readStableFileSync('/fixture/file', 10)).toThrow('File read unavailable');
  expect(mocks.readSync.mock.calls.reduce((sum, call) => sum + Math.min(2, call[3]), 0)).toBeLessThanOrEqual(6);
  expect(mocks.closeSync).toHaveBeenCalledTimes(1);
});

test('oversize admission rejects before allocation or reading', () => {
  mocks.lstatSync.mockReturnValue({ ...admitted, size: BigInt(11) });
  mocks.fstatSync.mockReturnValue({ ...admitted, size: BigInt(11) });
  expect(() => readStableFileSync('/fixture/file', 10)).toThrow('File read unavailable');
  expect(mocks.readSync).not.toHaveBeenCalled();
});

test('leaf symlinks and special files are denied before open', () => {
  mocks.lstatSync.mockReturnValue({ ...admitted, isFile: () => false, isSymbolicLink: () => true });
  expect(() => readStableFileSync('/fixture/link', 10)).toThrow('File read unavailable');
  expect(mocks.openSync).not.toHaveBeenCalled();
});

test('a read error still closes the admitted descriptor', () => {
  mocks.readSync.mockImplementation(() => { throw new Error('synthetic read failure'); });
  expect(() => readStableFileSync('/fixture/file', 10)).toThrow('synthetic read failure');
  expect(mocks.closeSync).toHaveBeenCalledTimes(1);
});
