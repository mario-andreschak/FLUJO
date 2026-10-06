import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import type { MCPServerConfig } from '@/shared/types/mcp';

let mockWorkspace = '';
const mockLoadConfigs = jest.fn();
const mockUpdateConfig = jest.fn();
const mockConnect = jest.fn();
const mockPrepareRegistry = jest.fn();
const mockAfterMarkerParentCheck = jest.fn();
jest.mock('@/backend/services/workspace/backupRestoreFs', () => {
  const actual = jest.requireActual<typeof import('@/backend/services/workspace/backupRestoreFs')>('@/backend/services/workspace/backupRestoreFs');
  return {
    ...actual,
    assertLinkFreeFileParent: async (...args: Parameters<typeof actual.assertLinkFreeFileParent>) => {
      await actual.assertLinkFreeFileParent(...args);
      await mockAfterMarkerParentCheck(...args);
    },
  };
});
jest.mock('simple-git', () => ({ __esModule: true, simpleGit: jest.fn() }));
jest.mock('@/utils/workspace', () => ({ getWorkspaceDataDir: () => mockWorkspace }));
jest.mock('@/backend/services/packages/buildPackage', () => ({ mapInstallOrigin: jest.fn(), resolveDependencies: jest.fn() }));
jest.mock('@/backend/services/mcp', () => ({ mcpService: {
  loadServerConfigs: (...args: unknown[]) => mockLoadConfigs(...args),
  updateServerConfig: (...args: unknown[]) => mockUpdateConfig(...args),
  connectServer: (...args: unknown[]) => mockConnect(...args),
} }));
jest.mock('@/backend/services/mcp/githubInstall', () => ({ prepareGithubServerRuntime: jest.fn() }));
jest.mock('@/backend/services/mcp/registryInstall', () => ({
  prepareRegistryServerRuntime: (...args: unknown[]) => mockPrepareRegistry(...args),
}));
jest.mock('@/backend/services/mcp/shippedServers', () => ({ createShippedServerConfig: jest.fn(), shippedDescriptorForConfig: jest.fn() }));
jest.mock('@/backend/services/mcp/shippedWorkspacePackages', () => ({ ensureShippedWorkspacePackages: jest.fn(), shippedWorkspacePackageRuntimeDigest: jest.fn() }));
import { reinstallWorkspaceMcpServers, type WorkspaceMcpTransferPlan } from '@/backend/services/packages/workspaceMcpTransfer';

const sourceRoot = path.join(os.tmpdir(), 'flujo-marker-source');
async function preparedFixture(disabled = false) {
  const original: MCPServerConfig = {
    name: 'marker-fixture', transport: 'stdio', command: 'npx',
    args: ['--yes', '@fixture/server@1.2.3'], rootPath: path.join(sourceRoot, 'mcp-servers', 'registry'),
    env: { TOKEN: 'private-fixture-credential' }, disabled, _buildCommand: '', _installCommand: '',
  };
  const plan: WorkspaceMcpTransferPlan = { formatVersion: 1, sourceWorkspaceRoot: sourceRoot, servers: [{
    name: original.name, kind: 'registry', sourceRootPath: original.rootPath,
    installOrigin: { sourceType: 'registry', ref: 'fixture/server' },
  }] };
  mockLoadConfigs.mockResolvedValue([original]);
  expect((await reinstallWorkspaceMcpServers(plan)).ok).toBe(true);
  const restored = mockUpdateConfig.mock.calls[0][1] as MCPServerConfig;
  mockLoadConfigs.mockResolvedValue([restored]);
  mockUpdateConfig.mockClear();
  mockConnect.mockClear();
  mockPrepareRegistry.mockClear();
  const directory = path.join(mockWorkspace, 'userdata', 'mcp-runtime', 'clone-preparation');
  const names = await fs.readdir(directory);
  expect(names).toHaveLength(1);
  const marker = path.join(directory, names[0]);
  const content = await fs.readFile(marker, 'utf8');
  return { plan, restored, marker, content };
}

function observeMarkerHandles(marker: string, reads: jest.SpyInstance[] = []) {
  const realOpen = fs.open.bind(fs);
  const closed: jest.SpyInstance[] = [];
  jest.spyOn(fs, 'open').mockImplementation(async (filename, flags, mode) => {
    const handle = await realOpen(filename, flags, mode);
    if (String(filename) === marker) {
      closed.push(jest.spyOn(handle, 'close'));
      reads.push(jest.spyOn(handle, 'read'));
    }
    return handle;
  });
  return () => {
    expect(closed).toHaveLength(1);
    expect(closed[0]).toHaveBeenCalledTimes(1);
  };
}

beforeEach(async () => {
  jest.clearAllMocks();
  mockAfterMarkerParentCheck.mockReset();
  mockWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-marker-read-'));
  mockUpdateConfig.mockResolvedValue({ success: true });
  mockConnect.mockResolvedValue({ success: true });
  mockPrepareRegistry.mockResolvedValue({ config: { transport: 'stdio', command: 'npx', args: ['ignored-new-version'] } });
});
afterEach(async () => {
  jest.restoreAllMocks();
  if (path.dirname(mockWorkspace) !== path.resolve(os.tmpdir()) || !path.basename(mockWorkspace).startsWith('flujo-marker-read-')) {
    throw new Error('Unexpected marker fixture cleanup target.');
  }
  await fs.rm(mockWorkspace, { recursive: true, force: true });
});

it('reuses a valid marker without registry access or a pathname content read, preserving private config', async () => {
  const fixture = await preparedFixture();
  const expectClosed = observeMarkerHandles(fixture.marker);
  const pathnameReads = jest.spyOn(fs, 'readFile');
  mockPrepareRegistry.mockRejectedValue(new Error('Registry network unavailable'));
  expect((await reinstallWorkspaceMcpServers(fixture.plan)).ok).toBe(true);
  expect(mockPrepareRegistry).not.toHaveBeenCalled();
  expect(mockConnect).toHaveBeenCalledTimes(1);
  expect(mockUpdateConfig.mock.calls[0][1]).toEqual(fixture.restored);
  expect(pathnameReads.mock.calls.some(([filename]) => String(filename) === fixture.marker)).toBe(false);
  expect(fixture.content).not.toContain('private-fixture-credential');
  expectClosed();
});

it.each(['growth-in-place', 'oversized-replacement', 'hardlink-replacement'] as const)(
  'refuses %s after marker inspection before saving or connecting the runtime', async (replacement) => {
    const fixture = await preparedFixture();
    const expectClosed = observeMarkerHandles(fixture.marker);
    const realLstat = fs.lstat.bind(fs);
    let replaced = false;
    jest.spyOn(fs, 'lstat').mockImplementation(async (filename, options) => {
      const stats = await realLstat(filename, options);
      if (String(filename) === fixture.marker && !replaced) {
        replaced = true;
        if (replacement === 'growth-in-place') {
          await fs.appendFile(fixture.marker, ' '.repeat(100_000));
        } else {
          const other = path.join(mockWorkspace, 'replacement.json');
          await fs.writeFile(other, fixture.content + (replacement === 'oversized-replacement' ? ' '.repeat(100_000) : ''));
          if (replacement === 'oversized-replacement') await fs.rename(other, fixture.marker);
          else { await fs.unlink(fixture.marker); await fs.link(other, fixture.marker); }
        }
      }
      return stats;
    });
    const result = await reinstallWorkspaceMcpServers(fixture.plan);
    expect(replaced).toBe(true);
    expect(result).toEqual({ ok: false, servers: [{
      name: 'marker-fixture', status: 'failed', error: 'Could not read the worker MCP preparation marker.',
    }] });
    expect(mockPrepareRegistry).not.toHaveBeenCalled();
    expect(mockUpdateConfig).not.toHaveBeenCalled();
    expect(mockConnect).not.toHaveBeenCalled();
    expectClosed();
  },
);

it.each(['oversized', 'hardlinked'] as const)('refuses a preexisting %s marker and closes its descriptor', async (kind) => {
  const fixture = await preparedFixture();
  if (kind === 'oversized') await fs.appendFile(fixture.marker, ' '.repeat(100_000));
  else await fs.link(fixture.marker, path.join(mockWorkspace, 'marker-alias.json'));
  const expectClosed = observeMarkerHandles(fixture.marker);
  expect((await reinstallWorkspaceMcpServers(fixture.plan)).ok).toBe(false);
  expect(mockPrepareRegistry).not.toHaveBeenCalled();
  expect(mockUpdateConfig).not.toHaveBeenCalled();
  expect(mockConnect).not.toHaveBeenCalled();
  expectClosed();
});

it('refuses a marker link encountered during acquisition when open follows the leaf', async () => {
  const fixture = await preparedFixture();
  const other = path.join(mockWorkspace, 'linked-marker-target.json');
  await fs.writeFile(other, fixture.content);
  const realOpen = fs.open.bind(fs);
  const realLstat = fs.lstat.bind(fs);
  const realReadFile = fs.readFile.bind(fs);
  const closed = jest.fn();
  const descriptorRead = jest.fn();
  const pathnameRead = jest.fn();
  let linked = false;
  // Emulate leaf-following open without requiring symlink privileges. The
  // returned descriptor is real; named-link metadata must stop all byte reads.
  jest.spyOn(fs, 'open').mockImplementation(async (...args) => {
    if (String(args[0]) !== fixture.marker) return realOpen(...args);
    linked = true;
    const handle = await realOpen(other, 'r');
    const realClose = handle.close.bind(handle);
    jest.spyOn(handle, 'read').mockImplementation(descriptorRead);
    jest.spyOn(handle, 'close').mockImplementation(async () => { closed(); await realClose(); });
    return handle;
  });
  jest.spyOn(fs, 'lstat').mockImplementation(async (...args) => {
    const stats = await realLstat(...args);
    return String(args[0]) === fixture.marker && linked
      ? Object.create(stats, { isSymbolicLink: { value: () => true }, isFile: { value: () => false } })
      : stats;
  });
  jest.spyOn(fs, 'readFile').mockImplementation(async (...args) => {
    if (String(args[0]) !== fixture.marker) return realReadFile(...args);
    linked = true;
    pathnameRead();
    return realReadFile(other, args[1]);
  });
  const result = await reinstallWorkspaceMcpServers(fixture.plan);
  expect(linked).toBe(true);
  expect(result).toEqual({ ok: false, servers: [{
    name: 'marker-fixture', status: 'failed', error: 'Could not read the worker MCP preparation marker.',
  }] });
  expect(descriptorRead).not.toHaveBeenCalled();
  expect(pathnameRead).not.toHaveBeenCalled();
  expect(closed).toHaveBeenCalledTimes(1);
  expect(mockPrepareRegistry).not.toHaveBeenCalled();
  expect(mockUpdateConfig).not.toHaveBeenCalled();
  expect(mockConnect).not.toHaveBeenCalled();
});

it.each(['growth', 'identity-replacement'] as const)('refuses %s after validation while keeping the read bounded', async (change) => {
  const fixture = await preparedFixture();
  const reads: jest.SpyInstance[] = [];
  const expectClosed = observeMarkerHandles(fixture.marker, reads);
  let changed = false;
  mockAfterMarkerParentCheck.mockImplementation(async (...args: [string, string]) => {
    if (args[1] === fixture.marker && !changed) {
      changed = true;
      if (change === 'growth') await fs.appendFile(fixture.marker, ' '.repeat(100_000));
      else {
        const other = path.join(mockWorkspace, 'read-time-marker.json');
        await fs.writeFile(other, fixture.content);
        await fs.rename(other, fixture.marker);
      }
    }
  });
  expect((await reinstallWorkspaceMcpServers(fixture.plan)).ok).toBe(false);
  expect(changed).toBe(true);
  expect(reads).toHaveLength(1);
  expect(reads[0].mock.calls.length).toBeGreaterThan(0);
  const completedReads = await Promise.all(reads[0].mock.results.map(result => result.value));
  expect(completedReads.reduce((bytes, result) => bytes + result.bytesRead, 0)).toBeLessThanOrEqual(Buffer.byteLength(fixture.content) + 1);
  expect(Math.max(...reads[0].mock.calls.map(args => Number(args[2])))).toBeLessThanOrEqual(Buffer.byteLength(fixture.content) + 1);
  expect(mockPrepareRegistry).not.toHaveBeenCalled();
  expect(mockUpdateConfig).not.toHaveBeenCalled();
  expect(mockConnect).not.toHaveBeenCalled();
  expectClosed();
});

it('closes the marker descriptor after a read failure without disclosing the read error', async () => {
  const fixture = await preparedFixture();
  const realOpen = fs.open.bind(fs);
  const closed = jest.fn();
  jest.spyOn(fs, 'open').mockImplementation(async (...args) => {
    const handle = await realOpen(...args);
    if (String(args[0]) === fixture.marker) {
      const realClose = handle.close.bind(handle);
      jest.spyOn(handle, 'close').mockImplementation(async () => { closed(); await realClose(); });
      jest.spyOn(handle, 'read').mockRejectedValue(new Error('private-read-error-detail'));
    }
    return handle;
  });
  const result = await reinstallWorkspaceMcpServers(fixture.plan);
  expect(result.servers[0]).toEqual({ name: 'marker-fixture', status: 'failed', error: 'Could not read the worker MCP preparation marker.' });
  expect(JSON.stringify(result)).not.toContain('private-read-error-detail');
  expect(closed).toHaveBeenCalledTimes(1);
  expect(mockUpdateConfig).not.toHaveBeenCalled();
  expect(mockConnect).not.toHaveBeenCalled();
});

it('refuses an unknown opened-file identity before reading bytes and closes the descriptor', async () => {
  const fixture = await preparedFixture();
  const realOpen = fs.open.bind(fs);
  const closed = jest.fn();
  const readAttempted = jest.fn();
  jest.spyOn(fs, 'open').mockImplementation(async (...args) => {
    const handle = await realOpen(...args);
    if (String(args[0]) === fixture.marker) {
      const realStat = handle.stat.bind(handle);
      const realClose = handle.close.bind(handle);
      jest.spyOn(handle, 'stat').mockImplementation(async (options) => Object.create(await realStat(options), { ino: { value: BigInt(0) } }));
      jest.spyOn(handle, 'read').mockImplementation(readAttempted);
      jest.spyOn(handle, 'close').mockImplementation(async () => { closed(); await realClose(); });
    }
    return handle;
  });
  expect((await reinstallWorkspaceMcpServers(fixture.plan)).ok).toBe(false);
  expect(readAttempted).not.toHaveBeenCalled();
  expect(closed).toHaveBeenCalledTimes(1);
  expect(mockUpdateConfig).not.toHaveBeenCalled();
  expect(mockConnect).not.toHaveBeenCalled();
});

it('closes the descriptor when marker JSON is malformed and retains the fixed caller error', async () => {
  const fixture = await preparedFixture();
  await fs.writeFile(fixture.marker, '{"unclosed":');
  const expectClosed = observeMarkerHandles(fixture.marker);
  const result = await reinstallWorkspaceMcpServers(fixture.plan);
  expect(result.servers[0]).toEqual({ name: 'marker-fixture', status: 'failed', error: 'Could not read the worker MCP preparation marker.' });
  expect(mockUpdateConfig).not.toHaveBeenCalled();
  expect(mockConnect).not.toHaveBeenCalled();
  expectClosed();
});

it('retains missing-marker preparation and reconnect behavior', async () => {
  const fixture = await preparedFixture();
  await fs.unlink(fixture.marker);
  expect((await reinstallWorkspaceMcpServers(fixture.plan)).ok).toBe(true);
  expect(mockPrepareRegistry).toHaveBeenCalledTimes(1);
  expect(mockConnect).toHaveBeenCalledTimes(1);
});

it('reprepares a well-formed marker whose recipe identity does not match', async () => {
  const fixture = await preparedFixture();
  await fs.writeFile(fixture.marker, JSON.stringify({ ...JSON.parse(fixture.content), recipeHash: 'different-recipe' }));
  const expectClosed = observeMarkerHandles(fixture.marker);
  expect((await reinstallWorkspaceMcpServers(fixture.plan)).ok).toBe(true);
  expect(mockPrepareRegistry).toHaveBeenCalledTimes(1);
  expect(mockConnect).toHaveBeenCalledTimes(1);
  expectClosed();
});

it('accepts a stable marker rewritten before acquisition', async () => {
  const fixture = await preparedFixture();
  await fs.writeFile(fixture.marker, JSON.stringify(JSON.parse(fixture.content), null, 2));
  const expectClosed = observeMarkerHandles(fixture.marker);
  expect((await reinstallWorkspaceMcpServers(fixture.plan)).ok).toBe(true);
  expect(mockPrepareRegistry).not.toHaveBeenCalled();
  expect(mockConnect).toHaveBeenCalledTimes(1);
  expectClosed();
});

it('preserves disabled cached runtimes without reconnecting or reinstalling them', async () => {
  const fixture = await preparedFixture(true);
  const expectClosed = observeMarkerHandles(fixture.marker);
  expect(await reinstallWorkspaceMcpServers(fixture.plan)).toEqual({ ok: true, servers: [{ name: 'marker-fixture', status: 'disabled' }] });
  expect(mockPrepareRegistry).not.toHaveBeenCalled();
  expect(mockConnect).not.toHaveBeenCalled();
  expectClosed();
});
