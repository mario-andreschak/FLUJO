import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let dataRoot: string;
jest.mock('@/utils/paths', () => ({ getDataDir: () => dataRoot }));
jest.mock('@/utils/workspace', () => ({ getCurrentWorkspace: () => 'worker' }));
jest.mock('@/backend/services/enduringAgents/runtimeLock', () => ({
  getRuntimeProcessIdentity: jest.fn(), isRuntimeProcessIdentityAlive: jest.fn(),
}));

import { getDetachedInstallationId } from '@/backend/services/subflowTasks/ownership';

const originalId = '12345678-1234-4234-9234-123456789abc';
const replacementId = 'abcdef12-1234-4234-9234-123456789abc';
const identity = (id = originalId) => JSON.stringify({ version: 1, id });
let directory: string;
let marker: string;

beforeEach(async () => {
  dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-installation-file-race-'));
  directory = path.join(dataRoot, '.flujo-detached-identity');
  marker = path.join(directory, 'identity.json');
  await fs.mkdir(directory);
  await fs.writeFile(marker, identity());
});

afterEach(async () => {
  jest.restoreAllMocks();
  await fs.rm(dataRoot, { recursive: true, force: true });
});

it('reads a valid installation identity through one descriptor and closes it', async () => {
  const open = fs.open.bind(fs);
  const closes: jest.Mock[] = [];
  jest.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
    const handle = await open(...args);
    handle.close = jest.fn(handle.close.bind(handle));
    closes.push(handle.close as jest.Mock);
    return handle;
  });
  expect(await getDetachedInstallationId()).toBe(originalId);
  expect(closes).toHaveLength(1);
  expect(closes[0]).toHaveBeenCalledTimes(1);
});

it('rejects a parent directory replaced after its lstat, before open', async () => {
  const replacement = path.join(dataRoot, 'replacement');
  await fs.mkdir(replacement);
  await fs.writeFile(path.join(replacement, 'identity.json'), identity(replacementId));
  const open = fs.open.bind(fs);
  jest.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
    await fs.rename(directory, path.join(dataRoot, 'original'));
    await fs.rename(replacement, directory);
    return open(...args);
  });
  await expect(getDetachedInstallationId()).rejects.toThrow('Invalid detached task installation identity');
});

it('rejects a parent swapped for a directory link before open', async () => {
  const target = path.join(dataRoot, 'link-target');
  await fs.mkdir(target);
  await fs.writeFile(path.join(target, 'identity.json'), identity(replacementId));
  const open = fs.open.bind(fs);
  jest.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
    await fs.rename(directory, path.join(dataRoot, 'original'));
    await fs.symlink(target, directory, 'junction');
    return open(...args);
  });
  await expect(getDetachedInstallationId()).rejects.toThrow('Invalid detached task installation identity');
});

it('rejects a pathname replaced after open instead of consuming its unchecked identity', async () => {
  const open = fs.open.bind(fs);
  let close: jest.Mock | undefined;
  jest.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
    const handle = await open(...args);
    close = jest.fn(handle.close.bind(handle));
    handle.close = close;
    await fs.rename(marker, path.join(directory, 'old.json'));
    await fs.writeFile(marker, identity(replacementId));
    return handle;
  });
  await expect(getDetachedInstallationId()).rejects.toThrow('Invalid detached task installation identity');
  expect(close).toHaveBeenCalledTimes(1);
});

it('bounds a file grown after fstat to 4097 bytes and closes on rejection', async () => {
  const open = fs.open.bind(fs);
  let maximumRead = 0;
  let totalRead = 0;
  let close: jest.Mock | undefined;
  jest.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
    const handle = await open(...args);
    const read = handle.read.bind(handle);
    jest.spyOn(handle, 'read').mockImplementation(async (...args: unknown[]) => {
      // The bounded reader uses this four-argument overload, not read(options).
      const [buffer, offset, length, position] = args as [Buffer, number, number, number];
      await fs.appendFile(marker, ' '.repeat(8192));
      maximumRead = Math.max(maximumRead, length);
      const result = await read(buffer, offset, length, position);
      totalRead += result.bytesRead;
      return result;
    });
    close = jest.fn(handle.close.bind(handle));
    handle.close = close;
    return handle;
  });
  await expect(getDetachedInstallationId()).rejects.toThrow('Invalid detached task installation identity');
  expect(maximumRead).toBe(4097);
  expect(totalRead).toBe(4097);
  expect(close).toHaveBeenCalledTimes(1);
});

it('rejects a hard-linked identity', async () => {
  await fs.link(marker, path.join(dataRoot, 'linked.json'));
  await expect(getDetachedInstallationId()).rejects.toThrow('Invalid detached task installation identity');
});

it.each([
  { label: 'malformed JSON', bytes: '{invalid json' },
  { label: 'invalid UUID', bytes: JSON.stringify({ version: 1, id: 'forged' }) },
  { label: 'oversized file', bytes: ' '.repeat(4097) },
])(
  'rejects $label and releases the descriptor', async ({ bytes }) => {
    await fs.writeFile(marker, bytes);
    const open = fs.open.bind(fs);
    let close: jest.Mock | undefined;
    jest.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await open(...args);
      close = jest.fn(handle.close.bind(handle));
      handle.close = close;
      return handle;
    });
    await expect(getDetachedInstallationId()).rejects.toThrow();
    expect(close).toHaveBeenCalledTimes(1);
  },
);
