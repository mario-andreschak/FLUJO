/** @jest-environment node */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

jest.mock('@/backend/services/mcp/shippedServers', () => ({
  SHIPPED_MCP_SERVERS: [], shippedMcpAppRoot: () => '/unused',
}));
import { shippedWorkspacePackageRuntimeDigest } from '@/backend/services/mcp/shippedWorkspacePackages';

const assetDigest = '3eefc449c7ae47758ddfab2cf14ec761b9a86df3858a73e3ef11023ee85ef871';
const runtimeDigest = 'fac1c9538656538bb41b71b749b7082a5f02bf3174a1850aca5ba1820327e327';
let fixture: string;
let root: string;
let target: string;
let replacement: string;
const original = "export const value = 'original';\n";

beforeEach(async () => {
  fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-asset-read-'));
  root = path.join(fixture, 'package');
  target = path.join(root, 'dist/index.js');
  replacement = path.join(fixture, 'replaced-index.js');
  for (const [name, content] of Object.entries({
    LICENSE: 'MIT\n', 'README.md': 'documentation\n',
    'dist/index.js': original, 'dist/nested/helper.js': 'export const helper = true;\n',
    'package.json': '{"name":"@fixture/package","version":"1.0.0"}\n',
    'scripts/prepare.mjs': '// prepare\n', 'src/index.ts': '// source\n',
    '.flujo-template.json': JSON.stringify({ version: 1, assetSha256: assetDigest }),
  })) {
    const file = path.join(root, name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content);
  }
});

afterEach(async () => {
  jest.restoreAllMocks();
  await fs.rm(fixture, { recursive: true, force: true });
});

it('keeps the existing version-1 digest for stable real files', async () => {
  await expect(shippedWorkspacePackageRuntimeDigest(root)).resolves.toBe(runtimeDigest);
});

it('rejects a different file substituted after the pathname check even with identical bytes', async () => {
  const nativeLstat = fs.lstat.bind(fs);
  let replaced = false;
  jest.spyOn(fs, 'lstat').mockImplementation((async (file, options) => {
    const checked = await nativeLstat(file, options as never);
    if (String(file) === target && !replaced) {
      replaced = true;
      await fs.rename(target, replacement);
      await fs.writeFile(target, original);
    }
    return checked;
  }) as typeof fs.lstat);
  await expect(shippedWorkspacePackageRuntimeDigest(root)).rejects.toThrow('changed before');
  expect(replaced).toBe(true);
});

it('rejects a pathname replacement after opening and closes the admitted descriptor', async () => {
  const nativeOpen = fs.open.bind(fs);
  let close: jest.SpyInstance | undefined;
  jest.spyOn(fs, 'open').mockImplementation(async (file, flags, mode) => {
    const handle = await nativeOpen(file, flags, mode);
    if (String(file) === target) {
      close = jest.spyOn(handle, 'close');
      await fs.rename(target, replacement);
      await fs.writeFile(target, original);
    }
    return handle;
  });
  await expect(shippedWorkspacePackageRuntimeDigest(root)).rejects.toThrow('changed');
  expect(close).toHaveBeenCalledTimes(1);
});

it('rejects edits to the admitted file during the descriptor read', async () => {
  const nativeOpen = fs.open.bind(fs);
  jest.spyOn(fs, 'open').mockImplementation(async (file, flags, mode) => {
    const handle = await nativeOpen(file, flags, mode);
    if (String(file) === target) {
      const nativeRead = handle.readFile.bind(handle);
      jest.spyOn(handle, 'readFile').mockImplementation((async () => {
        const bytes = await nativeRead();
        await fs.appendFile(target, '// concurrent edit\n');
        return bytes;
      }) as typeof handle.readFile);
    }
    return handle;
  });
  await expect(shippedWorkspacePackageRuntimeDigest(root)).rejects.toThrow('changed while');
});

it('closes the admitted descriptor when its read fails', async () => {
  const nativeOpen = fs.open.bind(fs);
  let close: jest.SpyInstance | undefined;
  jest.spyOn(fs, 'open').mockImplementation(async (file, flags, mode) => {
    const handle = await nativeOpen(file, flags, mode);
    if (String(file) === target) {
      close = jest.spyOn(handle, 'close');
      jest.spyOn(handle, 'readFile').mockRejectedValue(new Error('fixture read failure'));
    }
    return handle;
  });
  await expect(shippedWorkspacePackageRuntimeDigest(root)).rejects.toThrow('fixture read failure');
  expect(close).toHaveBeenCalledTimes(1);
});

it('refuses a non-file descriptor before reading and closes it', async () => {
  const nativeOpen = fs.open.bind(fs);
  const readFile = jest.fn(), close = jest.fn(async () => {});
  jest.spyOn(fs, 'open').mockImplementation(async (file, flags, mode) => String(file) === target
    ? { stat: async () => ({ isFile: () => false }), readFile, close } as never
    : nativeOpen(file, flags, mode));
  await expect(shippedWorkspacePackageRuntimeDigest(root)).rejects.toThrow('changed before');
  expect(readFile).not.toHaveBeenCalled();
  expect(close).toHaveBeenCalledTimes(1);
});

it('keeps supported hard-linked regular assets without changing their digest', async () => {
  await fs.link(target, path.join(fixture, 'hard-linked-index.js'));
  expect((await fs.lstat(target)).nlink).toBeGreaterThan(1);
  await expect(shippedWorkspacePackageRuntimeDigest(root)).resolves.toBe(runtimeDigest);
});
