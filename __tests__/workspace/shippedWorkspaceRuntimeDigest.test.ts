/** @jest-environment node */
import fs from 'node:fs/promises';
import path from 'node:path';

jest.mock('node:fs/promises', () => ({
  __esModule: true,
  default: { lstat: jest.fn(), readdir: jest.fn(), readFile: jest.fn() },
}));
jest.mock('@/backend/services/mcp/shippedServers', () => ({
  SHIPPED_MCP_SERVERS: [], shippedMcpAppRoot: () => '/unused',
}));

import { shippedWorkspacePackageRuntimeDigest } from '@/backend/services/mcp/shippedWorkspacePackages';

// Golden values from the existing version-1 format, including directory entries
// and nested runtime files. Changing traversal or framing must not change them.
const assetDigest = '3eefc449c7ae47758ddfab2cf14ec761b9a86df3858a73e3ef11023ee85ef871';
const runtimeDigest = 'fac1c9538656538bb41b71b749b7082a5f02bf3174a1850aca5ba1820327e327';
const root = path.resolve('/synthetic/package');
const marker = '.flujo-template.json';
const mockFs = jest.mocked(fs);
let files: Map<string, string>;
let reads: Map<string, number>;
let links: Set<string>;
let mutateOnSecondRuntimeRead: boolean;

function relative(file: unknown): string {
  return path.relative(root, String(file)).split(path.sep).join('/');
}

beforeEach(() => {
  jest.resetAllMocks();
  files = new Map(Object.entries({
    LICENSE: 'MIT\n', 'README.md': 'documentation\n',
    'dist/index.js': "export const value = 'original';\n",
    'dist/nested/helper.js': 'export const helper = true;\n',
    'package.json': '{"name":"@fixture/package","version":"1.0.0"}\n',
    'scripts/prepare.mjs': '// prepare\n', 'src/index.ts': '// source\n',
    [marker]: JSON.stringify({ version: 1, assetSha256: assetDigest }),
    'node_modules/ignored.js': 'dependency contents', '.git/ignored': 'Git contents',
  }));
  reads = new Map(); links = new Set(); mutateOnSecondRuntimeRead = false;
  mockFs.lstat.mockImplementation(async file => {
    const name = relative(file);
    const directory = !name || [...files.keys()].some(key => key.startsWith(`${name}/`));
    if (!directory && !files.has(name)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    return { isDirectory: () => directory, isFile: () => files.has(name), isSymbolicLink: () => links.has(name) } as never;
  });
  mockFs.readdir.mockImplementation(async file => {
    const name = relative(file), prefix = name ? `${name}/` : '';
    // Deliberately unsorted: the on-disk directory order is not the digest order.
    return [...new Set([...files.keys()].filter(key => key.startsWith(prefix))
      .map(key => key.slice(prefix.length).split('/')[0]))].reverse() as never;
  });
  mockFs.readFile.mockImplementation((async (file, encoding) => {
    const name = relative(file), count = (reads.get(name) ?? 0) + 1;
    reads.set(name, count);
    const content = name === 'dist/index.js' && mutateOnSecondRuntimeRead && count > 1
      ? "export const value = 'unverified edit';\n" : files.get(name);
    if (content === undefined) throw new Error(`Unexpected read: ${name}`);
    return encoding === 'utf8' ? content : Buffer.from(content);
  }) as typeof fs.readFile);
});

it('keeps the version-1 runtime digest and reads each admitted asset once', async () => {
  await expect(shippedWorkspacePackageRuntimeDigest(root)).resolves.toBe(runtimeDigest);
  for (const name of ['LICENSE', 'README.md', 'dist/index.js', 'dist/nested/helper.js', 'package.json', 'scripts/prepare.mjs', 'src/index.ts']) {
    expect(reads.get(name)).toBe(1);
  }
});

it('does not return a digest of runtime bytes supplied only by a second unverified read', async () => {
  // The old two-pass implementation verifies the original bytes, then returns
  // a digest containing this edit. Such a recipe cannot restore the verified
  // bundled build. Both outputs must instead derive from the same observation.
  mutateOnSecondRuntimeRead = true;
  await expect(shippedWorkspacePackageRuntimeDigest(root)).resolves.toBe(runtimeDigest);
  expect(reads.get('dist/index.js')).toBe(1);
});

it('keeps the runtime digest for a packaged distribution without editable sources', async () => {
  for (const name of ['LICENSE', 'README.md', 'src/index.ts']) files.delete(name);
  files.set(marker, JSON.stringify({ version: 1, assetSha256: runtimeDigest }));
  await expect(shippedWorkspacePackageRuntimeDigest(root)).resolves.toBe(runtimeDigest);
});

it('ignores dependency and Git metadata as the original format requires', async () => {
  files.set('node_modules/ignored.js', 'changed dependencies');
  files.set('.git/ignored', 'changed metadata');
  await expect(shippedWorkspacePackageRuntimeDigest(root)).resolves.toBe(runtimeDigest);
  expect(reads.has('node_modules/ignored.js')).toBe(false);
  expect(reads.has('.git/ignored')).toBe(false);
});

it.each(['dist/index.js', 'dist/nested/helper.js', 'scripts/prepare.mjs', 'package.json', 'src/index.ts', 'README.md', 'LICENSE'])
  ('rejects edits to %s against the original full-asset provenance', async name => {
    files.set(name, 'workspace edit');
    await expect(shippedWorkspacePackageRuntimeDigest(root)).rejects.toThrow('local changes');
  });

it.each(['dist', 'dist/index.js', 'src/index.ts'])('rejects a linked asset %s', async name => {
  links.add(name);
  await expect(shippedWorkspacePackageRuntimeDigest(root)).rejects.toThrow('unsupported linked asset');
});

it('rejects a linked package root before reading provenance', async () => {
  links.add('');
  await expect(shippedWorkspacePackageRuntimeDigest(root)).rejects.toThrow('must not be a symlink');
  expect(reads.size).toBe(0);
});

it('rejects a linked provenance marker before reading it', async () => {
  links.add(marker);
  await expect(shippedWorkspacePackageRuntimeDigest(root)).rejects.toThrow('no template provenance');
  expect(reads.size).toBe(0);
});

it('rejects missing provenance', async () => {
  files.delete(marker);
  await expect(shippedWorkspacePackageRuntimeDigest(root)).rejects.toThrow('no template provenance');
});

it('rejects malformed provenance', async () => {
  files.set(marker, '{');
  await expect(shippedWorkspacePackageRuntimeDigest(root)).rejects.toThrow('provenance is invalid');
});

it('rejects an unsupported marker version without inspecting assets', async () => {
  files.set(marker, JSON.stringify({ version: 2, assetSha256: assetDigest }));
  await expect(shippedWorkspacePackageRuntimeDigest(root)).rejects.toThrow('local changes');
  expect([...reads.keys()]).toEqual([marker]);
});
