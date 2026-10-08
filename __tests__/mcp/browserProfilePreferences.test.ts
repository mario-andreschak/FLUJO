import { constants, type BigIntStats } from 'node:fs';
import path from 'node:path';

const mockOpen = jest.fn();
const mockLstat = jest.fn();
const mockStat = jest.fn();
const mockReadFile = jest.fn();
const mockRealpath = jest.fn();
const mockLaunch = jest.fn();
jest.mock('node:fs', () => {
  const actual = jest.requireActual('node:fs');
  return {
    ...actual,
    promises: {
      ...actual.promises,
      open: (...args: unknown[]) => mockOpen(...args),
      lstat: (...args: unknown[]) => mockLstat(...args),
      stat: (...args: unknown[]) => mockStat(...args),
      readFile: (...args: unknown[]) => mockReadFile(...args),
      realpath: (...args: unknown[]) => mockRealpath(...args),
    },
  };
});
jest.mock('patchright', () => ({
  chromium: { launch: (...args: unknown[]) => mockLaunch(...args), launchPersistentContext: (...args: unknown[]) => mockLaunch(...args) },
}));

import { browserExtensions } from '../../mcp-servers/browser/src/runtime';

const savedEnv = { ...process.env };
const profile = path.resolve('synthetic-browser-profile');
const preferencesPath = path.join(profile, 'Default', 'Preferences');
const preferencesText = JSON.stringify({
  extensions: { settings: {
    enabled: { manifest: { name: 'Extension', version: '1.2' }, state: 1 },
    fallback: { manifest: {}, state: 0 },
    invalid: { manifest: [] },
  } },
});

function metadata(overrides: Partial<BigIntStats> = {}): BigIntStats {
  return {
    dev: BigInt(1), ino: BigInt('9007199254740993'), nlink: BigInt(1),
    size: BigInt(Buffer.byteLength(preferencesText)), mtimeNs: BigInt(1), ctimeNs: BigInt(1),
    mode: BigInt(0o100600), uid: BigInt(1), gid: BigInt(1),
    isFile: () => true, isSymbolicLink: () => false,
    ...overrides,
  } as BigIntStats;
}

let bytes: Buffer;
let admittedSize: number;
let consumed: number;
let handle: { stat: jest.Mock; read: jest.Mock; close: jest.Mock };

beforeEach(() => {
  jest.resetAllMocks();
  process.env.FLUJO_BROWSER_PROFILE_DIR = profile;
  delete process.env.FLUJO_BROWSER_EXTENSION_DIRS;
  bytes = Buffer.from(preferencesText);
  admittedSize = bytes.length;
  consumed = 0;
  handle = {
    stat: jest.fn().mockResolvedValue(metadata()),
    read: jest.fn(async (buffer: Buffer, offset: number, length: number, position: number) => {
      const bytesRead = Math.min(length, Math.max(0, bytes.length - position));
      bytes.copy(buffer, offset, position, position + bytesRead);
      consumed += bytesRead;
      return { bytesRead, buffer };
    }),
    close: jest.fn().mockResolvedValue(undefined),
  };
  mockOpen.mockResolvedValue(handle);
  mockLstat.mockResolvedValue(metadata());
});

afterEach(() => {
  process.env = { ...savedEnv };
  expect(mockLaunch).not.toHaveBeenCalled();
  expect(mockStat.mock.calls.some(([filename]) => filename === preferencesPath)).toBe(false);
  expect(mockReadFile.mock.calls.some(([filename]) => filename === preferencesPath)).toBe(false);
  expect(handle.read.mock.calls.every(([, offset, length, position]) =>
    offset === position && offset + length <= admittedSize + 1 && length <= 1024 * 1024,
  )).toBe(true);
  expect(consumed).toBeLessThanOrEqual(admittedSize + 1);
  expect(handle.close).toHaveBeenCalledTimes(handle.stat.mock.calls.length > 0 ? 1 : 0);
});

async function expectUnavailable() {
  const result = await browserExtensions();
  expect(result).toMatchObject({ success: true, profile, installed: [], configuredUnpacked: [], activeExtensionIds: [] });
  expect(JSON.stringify(result)).not.toContain('private-filesystem-detail');
}

it('reads stable preferences from one descriptor and preserves extension summaries', async () => {
  const result = await browserExtensions();
  expect(result).toEqual({
    success: true, profile, configuredUnpacked: [], activeExtensionIds: [],
    installed: [
      { id: 'enabled', name: 'Extension', version: '1.2', enabled: true, source: 'profile' },
      { id: 'fallback', name: 'fallback', version: '', enabled: false, source: 'profile' },
    ],
    note: 'Extensions belong only to FLUJO\'s dedicated trusted profile. Unpacked directories are operator allowlisted; FLUJO never copies extensions from the personal Chrome profile.',
  });
  expect(mockOpen).toHaveBeenCalledTimes(1);
  expect(mockOpen).toHaveBeenCalledWith(preferencesPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  expect(handle.stat).toHaveBeenCalledTimes(2);
  expect(mockLstat).toHaveBeenCalledTimes(2);
  expect(consumed).toBe(admittedSize);
});

it('handles partial reads within the admitted size plus one sentinel', async () => {
  handle.read.mockImplementation(async (buffer: Buffer, offset: number, _length: number, position: number) => {
    const bytesRead = position < bytes.length ? 1 : 0;
    bytes.copy(buffer, offset, position, position + bytesRead);
    consumed += bytesRead;
    return { bytesRead, buffer };
  });
  expect((await browserExtensions()).installed).toHaveLength(2);
  expect(handle.read.mock.calls.length).toBeGreaterThan(2);
  expect(consumed).toBe(admittedSize);
});

it('retains configured unpacked extensions when profile preferences are unavailable', async () => {
  const directory = path.resolve('synthetic-unpacked-extension');
  process.env.FLUJO_BROWSER_EXTENSION_DIRS = directory;
  mockRealpath.mockResolvedValue(directory);
  mockStat.mockResolvedValue({ isDirectory: () => true });
  mockReadFile.mockResolvedValue(JSON.stringify({ manifest_version: 3, name: 'Configured', version: '2' }));
  handle.stat.mockRejectedValue(new Error('private-filesystem-detail'));
  expect(await browserExtensions()).toMatchObject({
    success: true, profile, installed: [], activeExtensionIds: [],
    configuredUnpacked: [{ directory, manifestVersion: 3, name: 'Configured', version: '2' }],
  });
  expect(mockReadFile).toHaveBeenCalledWith(path.join(directory, 'manifest.json'), 'utf8');
});

it.each([
  ['over limit', { size: BigInt(50_000_001) }],
  ['negative size', { size: BigInt(-1) }],
  ['directory', { isFile: () => false }],
  ['hardlink', { nlink: BigInt(2) }],
  ['unknown identity', { ino: BigInt(0) }],
  ['symbolic link', { isSymbolicLink: () => true }],
] as const)('omits %s preferences before reading any bytes', async (_label, overrides) => {
  handle.stat.mockResolvedValue(metadata(overrides));
  mockLstat.mockResolvedValue(metadata(overrides));
  await expectUnavailable();
  expect(handle.read).not.toHaveBeenCalled();
});

it('rejects a named identity mismatch without rounding bigint inode values', async () => {
  mockLstat.mockResolvedValue(metadata({ ino: BigInt('9007199254740992') }));
  await expectUnavailable();
  expect(handle.read).not.toHaveBeenCalled();
});

it.each(['growth', 'shrink', 'replacement', 'metadata'] as const)(
  'omits preferences after %s between admission and reading', async (kind) => {
    mockLstat.mockImplementationOnce(async () => {
      const admitted = metadata();
      if (kind === 'growth') {
        bytes = Buffer.concat([bytes, Buffer.from(' MORE BYTES')]);
        handle.stat.mockResolvedValue(metadata({ size: BigInt(bytes.length), mtimeNs: BigInt(2) }));
      } else if (kind === 'shrink') {
        bytes = Buffer.from('{}');
        handle.stat.mockResolvedValue(metadata({ size: BigInt(bytes.length), mtimeNs: BigInt(2) }));
      } else if (kind === 'replacement') {
        mockLstat.mockResolvedValue(metadata({ ino: BigInt(2) }));
      } else {
        handle.stat.mockResolvedValue(metadata({ ctimeNs: BigInt(2) }));
      }
      return admitted;
    });
    await expectUnavailable();
    expect(handle.read).toHaveBeenCalled();
  },
);

it.each(['stat', 'lstat', 'read', 'close'] as const)('omits preferences on a private %s failure and closes once', async (kind) => {
  const error = new Error('private-filesystem-detail');
  if (kind === 'lstat') mockLstat.mockRejectedValue(error);
  else handle[kind].mockRejectedValue(error);
  await expectUnavailable();
});

it('keeps missing preferences best effort without an acquired handle', async () => {
  mockOpen.mockRejectedValue(Object.assign(new Error('private-filesystem-detail'), { code: 'ENOENT' }));
  await expectUnavailable();
  expect(handle.stat).not.toHaveBeenCalled();
});

it.each(['', '{invalid JSON', '{}'])('keeps empty, invalid or absent settings best effort (%s)', async (text) => {
  bytes = Buffer.from(text);
  admittedSize = bytes.length;
  handle.stat.mockResolvedValue(metadata({ size: BigInt(bytes.length) }));
  mockLstat.mockResolvedValue(metadata({ size: BigInt(bytes.length) }));
  await expectUnavailable();
});
