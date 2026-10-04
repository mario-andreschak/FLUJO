import path from 'node:path';
import { promises as fs } from 'node:fs';
import { readOperatorPassphrase } from '@/utils/encryption/privateProfile';
import { readCredentialJson } from '@/utils/encryption/workspaceFiles';

const data = path.resolve('synthetic-reader-data');
const file = path.resolve('synthetic-operator-file');
jest.mock('@/utils/paths', () => ({ getDataDir: () => data }));
jest.mock('node:fs', () => ({ ...jest.requireActual('node:fs'), promises: {
  ...jest.requireActual('node:fs').promises, lstat: jest.fn(), realpath: jest.fn(), open: jest.fn(),
} }));
const mockFs = fs as unknown as { lstat: jest.Mock; realpath: jest.Mock; open: jest.Mock };
const operatorError = 'Operator encryption secret is unavailable or invalid';
const jsonError = 'Credential storage is invalid; restore a matching workspace backup';
let body: Buffer;
let position: number;
let stat: Record<string, unknown>;
let handle: { stat: jest.Mock; read: jest.Mock; close: jest.Mock };
let previousFile: string | undefined;

function prepare(kind: string) {
  body = Buffer.from(kind === 'operator' ? 'synthetic-private-passphrase-with-32-characters\n' : '{"fixture":"safe"}');
  position = 0;
  stat = { dev: BigInt(1), ino: BigInt('9007199254740992'), size: BigInt(body.length),
    mtimeNs: BigInt('9007199254740992000'), ctimeNs: BigInt('9007199254740992000'),
    mode: BigInt(0o100600), uid: BigInt(process.getuid?.() ?? 0), gid: BigInt(0), nlink: BigInt(1),
    isFile: () => true, isSymbolicLink: () => false };
  handle = { stat: jest.fn(async () => stat), close: jest.fn(async () => undefined),
    read: jest.fn(async (buffer: Buffer, offset: number, length: number) => {
      const bytesRead = Math.min(3, length, body.length - position);
      body.copy(buffer, offset, position, position + bytesRead); position += bytesRead;
      return { bytesRead };
    }) };
  mockFs.lstat.mockReset().mockImplementation(async () => stat);
  mockFs.realpath.mockReset().mockImplementation(async (candidate: string) => path.resolve(candidate));
  mockFs.open.mockReset().mockResolvedValue(handle);
}
const read = (kind: string) => kind === 'operator' ? readOperatorPassphrase() : readCredentialJson(file, 1024);
const errorFor = (kind: string) => kind === 'operator' ? operatorError : jsonError;

beforeEach(() => {
  previousFile = process.env.FLUJO_ENCRYPTION_PASSPHRASE_FILE;
  process.env.FLUJO_ENCRYPTION_PASSPHRASE_FILE = file;
});
afterEach(() => {
  if (previousFile === undefined) delete process.env.FLUJO_ENCRYPTION_PASSPHRASE_FILE;
  else process.env.FLUJO_ENCRYPTION_PASSPHRASE_FILE = previousFile;
});

test.each(['operator', 'json'])('%s completes bounded short reads with one closed descriptor', async kind => {
  prepare(kind);
  expect(await read(kind)).toEqual(kind === 'operator' ? body.toString().trimEnd() : { fixture: 'safe' });
  expect(handle.read.mock.calls.length).toBeGreaterThan(1);
  expect(mockFs.open).toHaveBeenCalledTimes(1);
  expect(handle.close).toHaveBeenCalledTimes(1);
  expect(handle.stat).toHaveBeenCalledWith({ bigint: true });
});

describe.each(['operator', 'json'])('%s descriptor identity', kind => {
  test.each(['ino', 'mtimeNs', 'ctimeNs', 'mode', 'uid', 'gid', 'nlink'])(
    'refuses pre-read %s drift without reading content', async field => {
      prepare(kind);
      const replacement = { ...stat, [field]: (stat[field] as bigint) + BigInt(1) };
      handle.stat.mockResolvedValue(replacement);
      await expect(read(kind)).rejects.toThrow(errorFor(kind));
      expect(handle.read).not.toHaveBeenCalled();
      expect(handle.close).toHaveBeenCalledTimes(1);
    },
  );
  test.each(['ino', 'mtimeNs', 'ctimeNs', 'mode', 'uid', 'gid', 'nlink'])(
    'refuses post-read %s drift with a fixed error', async field => {
      prepare(kind);
      handle.stat.mockResolvedValueOnce(stat).mockResolvedValueOnce({ ...stat, [field]: (stat[field] as bigint) + BigInt(1) });
      await expect(read(kind)).rejects.toThrow(errorFor(kind));
      expect(handle.close).toHaveBeenCalledTimes(1);
    },
  );
});

test('the unsafe inode predecessor cannot distinguish the injected identity change', () => {
  const original = BigInt('9007199254740992');
  expect(Number(original)).toBe(Number(original + BigInt(1)));
  expect(original).not.toBe(original + BigInt(1));
});

test('operator rejects multiple links before reading the secret', async () => {
  prepare('operator'); stat.nlink = BigInt(2);
  await expect(readOperatorPassphrase()).rejects.toThrow(operatorError);
  expect(handle.read).not.toHaveBeenCalled();
  expect(handle.close).toHaveBeenCalledTimes(1);
});

test.each(['mode', 'uid'])('operator enforces simulated POSIX %s policy before content reads', async field => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  const uid = Object.getOwnPropertyDescriptor(process, 'getuid');
  try {
    Object.defineProperty(process, 'platform', { ...platform, value: 'linux' });
    Object.defineProperty(process, 'getuid', { configurable: true, value: () => 42 });
    prepare('operator');
    stat[field] = field === 'mode' ? BigInt(0o100644) : BigInt(43);
    await expect(readOperatorPassphrase()).rejects.toThrow(operatorError);
    expect(handle.read).not.toHaveBeenCalled();
    expect(handle.close).toHaveBeenCalledTimes(1);
  } finally {
    Object.defineProperty(process, 'platform', platform);
    if (uid) Object.defineProperty(process, 'getuid', uid);
    else Reflect.deleteProperty(process, 'getuid');
  }
});

test('operator refuses a changed canonical path into the complete data tree before reading', async () => {
  prepare('operator');
  mockFs.realpath.mockImplementation(async (candidate: string) => candidate === file ? path.join(data, 'operator') : path.resolve(candidate));
  await expect(readOperatorPassphrase()).rejects.toThrow(operatorError);
  expect(handle.read).not.toHaveBeenCalled();
  expect(handle.close).toHaveBeenCalledTimes(1);
});

test('initial missing JSON is absent; missing after admission is invalid storage', async () => {
  prepare('json');
  const missing = Object.assign(new Error('synthetic private path'), { code: 'ENOENT' });
  mockFs.lstat.mockRejectedValueOnce(missing);
  expect(await readCredentialJson(file, 1024)).toBeUndefined();
  expect(mockFs.open).not.toHaveBeenCalled();
  mockFs.open.mockRejectedValueOnce(missing);
  await expect(readCredentialJson(file, 1024)).rejects.toThrow(jsonError);
});

test.each([Buffer.from('not-json synthetic private payload'), Buffer.from([0xc3, 0x28])])(
  'malformed JSON or UTF-8 preserves the fixed credential-storage diagnostic', async bytes => {
    prepare('json'); body = bytes; stat.size = BigInt(bytes.length);
    await expect(readCredentialJson(file, 1024)).rejects.toThrow(jsonError);
    expect(handle.close).toHaveBeenCalledTimes(1);
  },
);
